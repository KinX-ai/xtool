// ============================================
// LOCAL PROXY SERVER — trung gian Extension ↔ Cloudflare Workers
// Chạy trong Electron main process (KHÔNG tốn thêm process)
// Extension (proxy.js) → http://127.0.0.1:3010 → Cloudflare Workers → google.com
// ============================================
const http = require('http');

const LOCAL_PROXY_PORT = 3010;
const CF_WORKERS = [
    "https://proxy-01.vipsphi.workers.dev","https://proxy-02.vipsphi.workers.dev","https://proxy-03.vipsphi.workers.dev","https://proxy-04.vipsphi.workers.dev","https://proxy-05.vipsphi.workers.dev","https://proxy-06.vipsphi.workers.dev","https://proxy-07.vipsphi.workers.dev","https://proxy-08.vipsphi.workers.dev","https://proxy-09.vipsphi.workers.dev","https://proxy-10.vipsphi.workers.dev",
    "https://proxy-01.qtcland2018.workers.dev","https://proxy-02.qtcland2018.workers.dev","https://proxy-03.qtcland2018.workers.dev","https://proxy-04.qtcland2018.workers.dev","https://proxy-05.qtcland2018.workers.dev","https://proxy-06.qtcland2018.workers.dev","https://proxy-07.qtcland2018.workers.dev","https://proxy-08.qtcland2018.workers.dev","https://proxy-09.qtcland2018.workers.dev","https://proxy-10.qtcland2018.workers.dev",
    "https://proxy-01.huynhchieu0163.workers.dev","https://proxy-02.huynhchieu0163.workers.dev","https://proxy-03.huynhchieu0163.workers.dev","https://proxy-04.huynhchieu0163.workers.dev","https://proxy-05.huynhchieu0163.workers.dev","https://proxy-06.huynhchieu0163.workers.dev","https://proxy-07.huynhchieu0163.workers.dev","https://proxy-08.huynhchieu0163.workers.dev","https://proxy-09.huynhchieu0163.workers.dev","https://proxy-10.huynhchieu0163.workers.dev",
    "https://proxy-01.acc4proxy.workers.dev","https://proxy-02.acc4proxy.workers.dev","https://proxy-03.acc4proxy.workers.dev","https://proxy-04.acc4proxy.workers.dev","https://proxy-05.acc4proxy.workers.dev","https://proxy-06.acc4proxy.workers.dev","https://proxy-07.acc4proxy.workers.dev","https://proxy-08.acc4proxy.workers.dev","https://proxy-09.acc4proxy.workers.dev","https://proxy-10.acc4proxy.workers.dev",
    "https://proxy-01.acc5proxy.workers.dev","https://proxy-02.acc5proxy.workers.dev","https://proxy-03.acc5proxy.workers.dev","https://proxy-04.acc5proxy.workers.dev","https://proxy-05.acc5proxy.workers.dev","https://proxy-06.acc5proxy.workers.dev","https://proxy-07.acc5proxy.workers.dev","https://proxy-08.acc5proxy.workers.dev","https://proxy-09.acc5proxy.workers.dev","https://proxy-10.acc5proxy.workers.dev",
];
let workerRR = 0;

function createLocalProxyServer() {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, accept, content-type, priority');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        // [PNA] Chrome chặn fetch https public → http localhost nếu thiếu header này
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        try {
            if (req.url === '/health' || req.url === '/health?') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', port: LOCAL_PROXY_PORT }));
                return;
            }
            // /myip — IP hiện tại đi qua worker pool (dùng để test nhanh)
            if (req.url === '/myip' || req.url === '/myip?') {
                const w = CF_WORKERS[workerRR++ % CF_WORKERS.length];
                try {
                    const r = await fetch(`${w}?url=${encodeURIComponent('https://api.ipify.org?format=json')}`);
                    const txt = await r.text();
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ip: (() => { try { return JSON.parse(txt).ip; } catch { return txt.trim(); } })(), worker: w.replace('https://', '') }));
                } catch (e) {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            // Nhận 2 dạng:
            // - /?u=<raw full-url> từ declarativeNetRequest redirect (KHÔNG decode — giữ nguyên query string)
            // - /?url=<encoded> từ proxy.js
            let targetUrl = null;
            const uPos = req.url.indexOf('?u=');
            if (uPos >= 0) {
                let v = req.url.slice(uPos + 3); // lấy TẤT CẢ sau 'u=', kể cả &params của target
                if (!/^https?:\/\//i.test(v)) { try { v = decodeURIComponent(v); } catch (e) { } }
                targetUrl = v;
            } else {
                try { targetUrl = new URL(req.url, `http://127.0.0.1:${LOCAL_PROXY_PORT}`).searchParams.get('url'); } catch (e) { }
            }
            if (!targetUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing u/url parameter', usage: '/?u=https://target/...' }));
                return;
            }
            if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

            const bodyChunks = [];
            for await (const chunk of req) bodyChunks.push(chunk);
            const body = bodyChunks.length ? Buffer.concat(bodyChunks) : null;

            const worker = CF_WORKERS[workerRR++ % CF_WORKERS.length];
            const workerUrl = `${worker}?url=${encodeURIComponent(targetUrl)}`;
            const label = worker.replace('https://', '');

            const fwdHeaders = {};
            const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
            for (const [k, v] of Object.entries(req.headers)) if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
            // Giữ Referer/Origin gốc — recaptcha verify origin nên KHÔNG được đổi
            if (!fwdHeaders.referer && req.headers.referer) fwdHeaders.referer = req.headers.referer;

            const r = await fetch(workerUrl, {
                method: req.method,
                headers: fwdHeaders,
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
                redirect: 'manual',
            });

            res.writeHead(r.status, Object.fromEntries(
                [...r.headers.entries()].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(k.toLowerCase()))
            ));
            const buf = await r.arrayBuffer();
            res.end(Buffer.from(buf));
            console.log(`[LocalProxy] ${req.method} ${targetUrl.slice(0, 70)} → ${label} → ${r.status}`);

        } catch (e) {
            console.error('[LocalProxy] Error:', e.message);
            if (!res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') console.log(`[LocalProxy] Port ${LOCAL_PROXY_PORT} đã dùng (app cũ còn chạy?).`);
        else console.error('[LocalProxy] Server error:', e.message);
    });

    // API gọn cho main.js: lp.listen() / lp.close()
    return {
        listen: () => server.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
            console.log(`[LocalProxy] ✅ Extension trỏ http://127.0.0.1:${LOCAL_PROXY_PORT} → CF Workers`);
        }),
        close: (cb) => server.close(cb),
    };
}

module.exports = { createLocalProxyServer, LOCAL_PROXY_PORT };
