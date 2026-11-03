/**
 * Kinxts Bridge — launches kinxts.exe, proxies IPC to its HTTP API.
 * Requires: app ready, http, child_process, fs, path.
 * Loaded by main.js via require("./kinxts-bridge").
 */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');

const API_HOST = '127.0.0.1';
const API_PORT = 7860;
const API_BASE = `http://${API_HOST}:${API_PORT}`;
const POLL_MS = 2000;
const OUTPUT_DIR = path.join(app.getPath('downloads'), 'KinxVoice');
let convDir = OUTPUT_DIR;

// Per-platform download URLs (used only when kinxts binary is missing)
const DOWNLOAD_URLS = {
  win32: 'https://tai.tainguyenweb.com/Kinxtsexe',
  darwin: 'https://tai.tainguyenweb.com/Kinxtsmos',
};

let proc = null;           // child process handle
let online = false;        // API reachable
let modelLoaded = false;   // model loaded in memory
let loading = false;       // downloading/loading model
let triedDownload = false; // only auto-download once per session

/* ── helpers ─────────────────────────────────────────────────────────────── */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getExeDir() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'kinxts');
    if (fs.existsSync(p)) return p;
    return path.dirname(app.getPath('exe'));
  }
  // Dev: relative to project root
  const devDir = process.platform === 'darwin' ? 'vieneu-tts-api' : path.join('vieneu-tts-api');
  return path.join(__dirname, '..', 'VieNeu-TTS', 'source_build', 'dist', devDir);
}

function getExePath() {
  const base = process.platform === 'darwin' ? 'kinxts' : 'kinxts.exe';
  return path.join(getExeDir(), base);
}

function getHFHome() {
  return path.join(app.getPath('userData'), 'kinxts_cache');
}

function broadcast() {
  const state = { online, modelLoaded, loading };
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('kinxts:status', state);
  });
}

/* ── HTTP helpers (no extra deps) ────────────────────────────────────────── */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', ...headers };
    if (typeof body === 'string') h['Content-Type'] = 'application/json';
    const req = http.request(url, { method: 'POST', headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostMultipart(url, fields, fileField, fileData, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----Kinxts' + Date.now();
    const parts = [];

    for (const [name, value] of Object.entries(fields)) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    const header = Buffer.from(parts.join(''));
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([header, fileHeader, fileData, footer]);

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ── binary download (auto-fetch kinxts when missing) ────────────────────── */

function downloadKinxts() {
  return new Promise((resolve, reject) => {
    const url = DOWNLOAD_URLS[process.platform];
    if (!url) return reject(new Error('Unsupported platform: ' + process.platform));
    ensureDir(getExeDir());
    const target = getExePath();
    const tmp = target + '.tmp';
    const lib = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(tmp);
    const req = lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy();
        return downloadKinxtsFrom(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        file.destroy();
        fs.unlinkSync(tmp);
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, target);
          console.log('[Kinxts] Downloaded ve:', target);
          resolve();
        });
      });
    });
    req.on('error', e => {
      try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
  });
}

function downloadKinxtsFrom(url) {
  return new Promise((resolve, reject) => {
    ensureDir(getExeDir());
    const target = getExePath();
    const tmp = target + '.tmp';
    const lib = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(tmp);
    const req = lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy();
        return downloadKinxtsFrom(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        file.destroy();
        try { fs.unlinkSync(tmp); } catch {}
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, target);
          console.log('[Kinxts] Downloaded ve:', target);
          resolve();
        });
      });
    });
    req.on('error', e => {
      try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
  });
}

/* ── lifecycle ───────────────────────────────────────────────────────────── */

async function downloadModel() {
  if (triedDownload) return;
  triedDownload = true;

  loading = true;
  broadcast();
  try {
    console.log('[Kinxts] Triggering model load/download on startup...');
    const res = await httpPost(`${API_BASE}/api/model/download`, '{}');
    console.log('[Kinxts] Model download/load response:', res.status, res.data.toString().slice(0, 200));
    try {
      await httpGet(`${API_BASE}/api/voices`);
    } catch {}
  } catch (e) {
    console.error('[Kinxts] Model download/load error:', e.message);
  } finally {
    loading = false;
    broadcast();
  }
}

async function pollStatus() {
  if (!proc || proc.killed) return;
  try {
    const s = await httpGet(`${API_BASE}/api/status`);
    online = true;
    modelLoaded = !!s.model_loaded;
    if (modelLoaded) loading = false;
    broadcast();
    if (!modelLoaded && !triedDownload) downloadModel();
  } catch {
    online = false;
    modelLoaded = false;
    setTimeout(pollStatus, POLL_MS);
    return;
  }
  setTimeout(pollStatus, POLL_MS);
}

async function start() {
  const exe = getExePath();
  ensureDir(getExeDir());
  if (!fs.existsSync(exe)) {
    console.log('[Kinxts] exe chua co, dang tai ve tu dong...');
    loading = true; broadcast();
    try {
      await downloadKinxts();
    } catch (e) {
      console.error('[Kinxts] Tai exe that bai:', e.message);
      loading = false; broadcast();
      return;
    } finally {
      loading = false;
    }
  } else {
    console.log('[Kinxts] exe co san:', exe);
  }
  console.log('[Kinxts] Starting:', exe);
  ensureDir(OUTPUT_DIR);

  // Clear leftover kinxts.exe from older sessions (PyInstaller grandchildren
  // used to survive app quit). Without this, a stale server holds port 7860
  // and the fresh instance exits immediately (-1).
  if (process.platform === 'win32') {
    try { execSync('taskkill /IM kinxts.exe /T /F', { stdio: 'ignore' }); } catch (e) { /* none running */ }
  }

  const env = { ...process.env, HF_HOME: getHFHome(), HF_HUB_CACHE: getHFHome() };
  if (process.platform === 'darwin') {
    try { execSync(`chmod +x "${exe}"`); } catch (e) {}
    try { execSync(`xattr -dr com.apple.quarantine "${exe}"`); } catch (e) {}
  }

  proc = spawn(exe, [], {
    detached: false,
    cwd: getExeDir(),
    stdio: 'ignore',
    env,
    windowsHide: true,
  });

  proc.on('error', e => {
    console.error('[Kinxts] spawn error:', e.message);
    online = false; broadcast();
  });

  proc.on('exit', code => {
    console.log('[Kinxts] exited:', code);
    proc = null; online = false; modelLoaded = false; triedDownload = false; broadcast();
  });

  // Start polling after a short delay to let the server start
  setTimeout(pollStatus, 3000);
}

// Kill the kinxts process tree. kinxts.exe is a PyInstaller onefile
// bootloader that spawns a grandchild Python server process; a plain
// proc.kill() only signals the bootloader and orphans the server.
function stop() {
  if (proc && !proc.killed) {
    console.log('[Kinxts] Stopping');
    // Windows: kill the whole tree FIRST, while the PyInstaller bootloader is
    // still alive. proc.kill() first would orphan the grandchild server
    // (it detaches from the tree), so taskkill /T can no longer reach it
    // and a stale kinxts.exe keeps port 7860 after app quit.
    if (process.platform === 'win32' && proc.pid) {
      try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); }
      catch (e) { /* already gone */ }
    }
    try { proc.kill(); } catch {}
  }
  // macOS: sweep any orphaned kinxts grandchild processes
  if (process.platform === 'darwin') {
    try { execSync('pkill -f kinxts', { stdio: 'ignore' }); } catch {}
  }
  cleanupTemp();
  proc = null;
}

// PyInstaller onefile extracts into %TEMP%\_MEIxxxxxx and only removes it on
// graceful exit. Since we force-kill the bootloader (taskkill /T /F), that
// cleanup never runs, so stale _MEI* folders (each ~386MB) accumulate and fill
// the disk. Remove any _MEI* from older sessions after the tree is dead.
function cleanupTemp() {
  if (process.platform !== 'win32') return;
  try {
    const os = require('os');
    const fsx = fs.readdirSync(os.tmpdir());
    for (const name of fsx) {
      if (name.startsWith('_MEI')) {
        try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); }
        catch (e) { /* folder in use by a process we can't kill */ }
      }
    }
  } catch (e) { /* tmpdir unreadable */ }
}

/* ── IPC handlers (renderer → main → kinxts API) ────────────────────────── */

function register() {
  // Lifecycle hooks (also start immediately if app already ready)
  if (app.isReady()) start();
  else app.on('ready', start);
  app.on('before-quit', stop);

  // Safety net: process.on('exit') fires even if before-quit doesn't
  // (e.g. user kills Electron via Task Manager or OS signal)
  process.on('exit', () => {
    if (proc && !proc.killed) {
      if (process.platform === 'win32' && proc.pid) {
        try { require('child_process').spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']); } catch {}
      }
      try { proc.kill(); } catch {}
    }
    // Sweep any orphaned grandchild process (taskkill Windows / pkill macOS)
    if (process.platform === 'win32') {
      try { require('child_process').spawnSync('taskkill', ['/IM', 'kinxts.exe', '/T', '/F']); } catch {}
    } else if (process.platform === 'darwin') {
      try { require('child_process').spawnSync('pkill', ['-f', 'kinxts']); } catch {}
    }
    cleanupTemp();
  });

  // Status (synchronous, cached)
  ipcMain.handle('kinxts:status', () => ({ online, modelLoaded, loading }));

  // TTS: text → WAV file
  ipcMain.handle('kinxts:tts', async (_ev, { text, voice, temperature, speed }) => {
    ensureDir(OUTPUT_DIR);
    const fileName = `kinxts_${Date.now()}.wav`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    const res = await httpPost(`${API_BASE}/api/tts`, { text, voice, temperature, speed });
    if (res.status !== 200) throw new Error(`Kinxts API error ${res.status}`);
    fs.writeFileSync(filePath, res.data);
    return { success: true, filePath, fileName, fileSize: res.data.length };
  });

  // Clone: text + ref audio → WAV file
  ipcMain.handle('kinxts:clone', async (_ev, { text, refAudioPath, refAudioBase64, denoise, temperature }) => {
    ensureDir(OUTPUT_DIR);
    let fileData;
    if (refAudioBase64) fileData = Buffer.from(refAudioBase64, 'base64');
    else if (refAudioPath) fileData = fs.readFileSync(refAudioPath);
    else throw new Error('No reference audio provided');

    const fileName = `kinxts_clone_${Date.now()}.wav`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    const fields = { text: text || '' };
    if (denoise !== undefined) fields.denoise = String(denoise);
    if (temperature !== undefined) fields.temperature = String(temperature);

    const res = await httpPostMultipart(
      `${API_BASE}/api/clone`,
      fields,
      'ref_audio',
      fileData,
      'ref.wav',
    );
    if (res.status !== 200) throw new Error(`Kinxts clone error ${res.status}`);
    fs.writeFileSync(filePath, res.data);
    return { success: true, filePath, fileName, fileSize: res.data.length };
  });

  // Batch: multiple texts → array of base64 WAVs
  ipcMain.handle('kinxts:batch', async (_ev, { texts, voice, temperature }) => {
    const res = await httpPost(`${API_BASE}/api/batch`, { texts, voice, temperature });
    if (res.status !== 200) throw new Error(`Kinxts batch error ${res.status}`);
    return JSON.parse(res.data.toString());
  });

  // Batch TTS for STR: sends all texts in one request → consistent voice.
  // If refAudioBase64 supplied → clone voice, one shared speaker embedding
  // for every text → locks timbre across segments.
  // Returns array of { filePath, index } matching segment order.
  ipcMain.handle('kinxts:batchTts', async (_ev, { texts, voice, temperature, refAudioBase64, refAudioPath }) => {
    ensureDir(OUTPUT_DIR);
    const body = { texts, temperature };
    if (refAudioBase64) body.ref_audio = refAudioBase64;
    else if (refAudioPath && fs.existsSync(refAudioPath)) body.ref_audio = fs.readFileSync(refAudioPath).toString('base64');
    else body.voice = voice;
    const res = await httpPost(`${API_BASE}/api/batch`, body);
    if (res.status !== 200) throw new Error(`Kinxts batch error ${res.status}`);
    const json = JSON.parse(res.data.toString());
    if (!json.success) throw new Error('Batch TTS failed');

    const results = [];
    for (const item of (json.results || [])) {
      const wavBuf = Buffer.from(item.audio_base64, 'base64');
      const fileName = `str_batch_${item.index}_${Date.now()}.wav`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      fs.writeFileSync(filePath, wavBuf);
      results.push({ filePath, index: item.index });
    }
    return { success: true, results };
  });

  // Stream: text → streaming WAV file (downloads full then saves)
  ipcMain.handle('kinxts:stream', async (_ev, { text, voice, temperature }) => {
    ensureDir(OUTPUT_DIR);
    const fileName = `kinxts_stream_${Date.now()}.wav`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    const qs = new URLSearchParams({ text, voice: voice || '', temperature: String(temperature || 1.0) });
    const url = `${API_BASE}/api/stream?${qs}`;
    const res = await httpGetBuffer(url);
    if (!res) throw new Error('Kinxts stream failed');
    fs.writeFileSync(filePath, res);
    return { success: true, filePath, fileName, fileSize: res.length };
  });

  /* ── WAV helpers (concatenate per-line PCM into one file) ────────────────── */
  function parseWavHeader(buf) {
    // Minimal RIFF/WAVE parse: return contiguous PCM (data chunk) + meta.
    const isRiff = buf.length >= 12 &&
      buf.readUInt32LE(0) === 0x46464952 &&   // 'RIFF'
      buf.readUInt32LE(8) === 0x45564157;     // 'WAVE'
    let sampleRate = 22050, channels = 1, bits = 16;
    if (!isRiff) return { pcm: buf, sampleRate, channels, bitsPerSample: bits };
    let pcmOffset = 44, pcmLen = buf.length - 44;
    let i = 12;
    while (i + 8 <= buf.length) {
      const id = buf.toString('ascii', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'fmt ' && i + 24 <= buf.length) {
        channels = buf.readUInt16LE(i + 10);
        sampleRate = buf.readUInt32LE(i + 12);
        bits = buf.readUInt16LE(i + 22);
      } else if (id === 'data') {
        pcmOffset = i + 8;
        pcmLen = Math.min(size, buf.length - pcmOffset);
        break;
      }
      i += 8 + size + (size % 2);
    }
    return { pcm: buf.subarray(pcmOffset, pcmOffset + pcmLen), sampleRate, channels, bitsPerSample: bits };
  }

  function isRiffWav(buf) {
    return !!buf && buf.length >= 12 &&
      buf.readUInt32LE(0) === 0x46464952 &&  // 'RIFF'
      buf.readUInt32LE(8) === 0x45564157;    // 'WAVE'
  }

  /** Resample 16-bit mono PCM from one sample rate to another (linear interp). */
  function resamplePcm(pcm, fromSr, toSr) {
    if (fromSr === toSr) return pcm;
    const src = pcm.length / 2;
    const ratio = toSr / fromSr;
    const dst = Math.floor(src * ratio);
    const out = Buffer.alloc(dst * 2);
    for (let i = 0; i < dst; i++) {
      const pos = i / ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, src - 1);
      const frac = pos - i0;
      const s0 = pcm.readInt16LE(i0 * 2);
      const s1 = pcm.readInt16LE(i1 * 2);
      out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
    }
    return out;
  }

  function concatWavFromPcm(pcmBufs, sampleRate, silenceBytes) {
    const sil = Buffer.alloc(Math.max(0, silenceBytes));
    const gaps = Math.max(0, pcmBufs.length - 1);
    const total = pcmBufs.reduce((a, b) => a + b.length, 0) + gaps * sil.length;
    const out = Buffer.alloc(total);
    let off = 0;
    pcmBufs.forEach((b, i) => {
      b.copy(out, off); off += b.length;
      if (i < pcmBufs.length - 1) { sil.copy(out, off); off += sil.length; }
    });
    const blockAlign = 2; // mono, 16-bit
    const byteRate = sampleRate * blockAlign;
    const dataSize = out.length;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + dataSize, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);      // PCM
    h.writeUInt16LE(1, 22);      // mono
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(16, 34);     // bits
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(dataSize, 40);
    return Buffer.concat([h, out]);
  }

  // Conversation: multi-speaker script → WAV file.
  // The kinxts server has no /api/conversation. We orchestrate here: parse
  // "Name: text" script, synthesize each line via /api/tts (preset voice) or
  // /api/clone (clone: voice), concat PCM with a silence gap → single WAV.
  ipcMain.handle('kinxts:get-conv-dir', () => convDir);
  ipcMain.handle('kinxts:set-conv-dir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: convDir,
      title: 'Chọn thư mục lưu hội thoại',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      convDir = result.filePaths[0];
    }
    return convDir;
  });
  ipcMain.handle('kinxts:open-conv-dir', async () => {
    if (fs.existsSync(convDir)) await shell.openPath(convDir);
  });

  // Conversation: multi-speaker script → WAV file.
  ipcMain.handle('kinxts:conversation', async (_ev, { script, speakers, temperature, silenceDuration }) => {
    ensureDir(convDir);
    const fileName = `kinxts_conv_${Date.now()}.wav`;
    const filePath = path.join(convDir, fileName);

    const lines = [];
    script.split(/\r?\n/).forEach(raw => {
      const m = raw.trim().match(/^([^:：]+)[：:]\s*([\s\S]*)$/);
      if (m) lines.push({ char: m[1].trim(), text: m[2].trim() });
    });
    if (!lines.length) throw new Error('No "Name: text" lines found in script');

    const temp = typeof temperature === 'number' ? temperature : (parseFloat(temperature) || 1.0);
    const silenceDur = typeof silenceDuration === 'number' ? silenceDuration : (parseFloat(silenceDuration) || 0.5);
    const voiceMap = (speakers && typeof speakers === 'object') ? speakers : {};

    let voiceLib = [];
    try { voiceLib = readVoices(); } catch { voiceLib = []; }

    const pcmBufs = [];
    let sr = 48000;
    for (const ln of lines) {
      const voice = voiceMap[ln.char] || voiceMap[''] || '';
      let res;
      if (voice.startsWith('clone:')) {
        const id = voice.slice(6);
        const v = voiceLib.find(x => x.id === id);
        if (!v || !v.refAudioPath) throw new Error(`Saved voice not found for "${ln.char}"`);
        res = await httpPostMultipart(
          `${API_BASE}/api/clone`, { text: ln.text, temperature: String(temp) },
          'ref_audio', fs.readFileSync(v.refAudioPath), 'ref.wav',
        );
      } else {
        res = await httpPost(`${API_BASE}/api/tts`, {
          text: ln.text, voice: voice || undefined, temperature: temp,
        });
      }
      if (res.status !== 200 || !isRiffWav(res.data)) {
        const hint = (res.data && res.data.length < 400) ? res.data.toString().slice(0, 160) : `HTTP ${res.status}`;
        throw new Error(`${ln.char}: TTS failed (model not loaded? ${hint})`);
      }
      const parsed = parseWavHeader(res.data);
      sr = parsed.sampleRate || sr;
      pcmBufs.push(parsed.pcm);
    }

    const silenceBytes = Math.floor(sr * silenceDur * 2);
    const out = concatWavFromPcm(pcmBufs, sr, silenceBytes);
    fs.writeFileSync(filePath, out);

    // Auto-save the script alongside the audio (same basename, .txt)
    const scriptPath = filePath.replace(/\.wav$/i, '.txt');
    const scriptText = lines.map(ln => `${ln.char}: ${ln.text}`).join('\r\n');
    fs.writeFileSync(scriptPath, scriptText, 'utf-8');

    return { success: true, filePath, fileName, fileSize: out.length, scriptPath, scriptName: path.basename(scriptPath) };
  });

  // STR merge: take array of { filePath, startMs, endMs }, pad with silence
  // to match SRT timestamps, concat into single WAV file.
  ipcMain.handle('kinxts:str-merge-audio', async (_ev, { segments, outName }) => {
    if (!segments || !segments.length) throw new Error('No segments to merge');
    ensureDir(convDir);
    const fileName = outName || `str_voice_${Date.now()}.wav`;
    const filePath = path.join(convDir, fileName);

    // Read all segments, extract PCM, resample each to common 48kHz
    const TARGET_SR = 48000;
    const parsed = [];
    for (const seg of segments) {
      const buf = fs.readFileSync(seg.filePath);
      const p = parseWavHeader(buf);
      const pcm = resamplePcm(p.pcm, p.sampleRate || TARGET_SR, TARGET_SR);
      parsed.push({ pcm, startMs: seg.startMs, endMs: seg.endMs });
    }
    const sr = TARGET_SR;

    // Place segments — shift forward if audio would overlap next segment
    let adjustedMs = parsed.map(s => s.startMs); // mutable copy
    for (let i = 1; i < parsed.length; i++) {
      const prevEnd = adjustedMs[i - 1] + parsed[i - 1].pcm.length / 2 / sr * 1000;
      if (adjustedMs[i] < prevEnd) adjustedMs[i] = prevEnd + 10; // 10ms gap
    }
    // Recalc total from actual placed positions
    let totalMs = 0;
    for (let i = 0; i < parsed.length; i++) {
      const endMs = adjustedMs[i] + parsed[i].pcm.length / 2 / sr * 1000;
      if (endMs > totalMs) totalMs = endMs;
    }
    totalMs += 500;
    const totalSamples = Math.floor(sr * totalMs / 1000);
    const out = Buffer.alloc(totalSamples * 2);

    for (let i = 0; i < parsed.length; i++) {
      const startByte = Math.floor(sr * adjustedMs[i] / 1000) * 2;
      parsed[i].pcm.copy(out, startByte);
    }

    // Write WAV header + merged PCM
    const blockAlign = 2;
    const byteRate = sr * blockAlign;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + out.length, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);      // PCM
    h.writeUInt16LE(1, 22);      // mono
    h.writeUInt32LE(sr, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(16, 34);     // bits
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(out.length, 40);
    const wav = Buffer.concat([h, out]);
    fs.writeFileSync(filePath, wav);

    // Cleanup temp segment files
    for (const seg of segments) {
      try { fs.unlinkSync(seg.filePath); } catch {}
    }

    return { success: true, filePath, fileName, fileSize: wav.length };
  });

  // Extract PDF text
  ipcMain.handle('kinxts:extract-pdf', async (_ev, { pdfPath, pdfBase64 }) => {
    let fileData;
    if (pdfBase64) fileData = Buffer.from(pdfBase64, 'base64');
    else if (pdfPath) fileData = fs.readFileSync(pdfPath);
    else throw new Error('No PDF provided');
    const boundary = '----KinxtsPDF' + Date.now();
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([fileHeader, fileData, footer]);
    const result = await new Promise((resolve, reject) => {
      const req = http.request(`${API_BASE}/api/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (result.status !== 200) throw new Error(`Kinxts PDF error ${result.status}`);
    return JSON.parse(result.data.toString());
  });

  console.log('[Kinxts] ✅ Kinxts bridge ready — exe will start on app ready');
}

/* ── Voice library (persistent named clones) ─────────────────────────────── */
const VOICES_DIR = path.join(app.getPath('userData'), 'kinxts_voices');
const VOICES_JSON = path.join(VOICES_DIR, 'voices.json');

function readVoices() {
  try { return JSON.parse(fs.readFileSync(VOICES_JSON, 'utf8')); }
  catch { return []; }
}
function writeVoices(arr) {
  ensureDir(VOICES_DIR);
  fs.writeFileSync(VOICES_JSON, JSON.stringify(arr, null, 2));
}

ipcMain.handle('kinxts:list-voices', () => readVoices());

ipcMain.handle('kinxts:save-voice', async (_ev, { name, refAudioBase64 }) => {
  if (!refAudioBase64) throw new Error('No reference audio');
  ensureDir(VOICES_DIR);
  const id = 'v' + Date.now().toString(36);
  const refAudioPath = path.join(VOICES_DIR, id + '.wav');
  fs.writeFileSync(refAudioPath, Buffer.from(refAudioBase64, 'base64'));
  const entry = { id, name: name || ('Voice ' + id), refAudioPath, createdAt: new Date().toISOString() };
  const arr = readVoices();
  arr.push(entry);
  writeVoices(arr);
  return entry;
});

ipcMain.handle('kinxts:delete-voice', (_ev, { id }) => {
  const arr = readVoices().filter(v => v.id !== id);
  writeVoices(arr);
  try { fs.unlinkSync(path.join(VOICES_DIR, id + '.wav')); } catch {}
  return { success: true };
});

ipcMain.handle('kinxts:voice-ref', (_ev, { id }) => {
  const v = readVoices().find(x => x.id === id);
  return v ? { refAudioPath: v.refAudioPath } : null;
});

module.exports = { register };
