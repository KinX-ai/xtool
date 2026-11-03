"use strict";

const http = require("http");
const util = require("util");
const crypto = require("crypto");

const LOG_PORT = 9898;
const LOG_PASSWORD = "kinxadmin@";

// Mỗi lần khởi động sinh ra 1 salt ngẫu nhiên mới -> mọi cookie phiên trước đó bị vô hiệu lập tức
const CURRENT_BOOT_SALT = crypto.randomBytes(16).toString("hex");
const AUTH_SECRET_TOKEN = crypto
  .createHash("sha256")
  .update(LOG_PASSWORD + CURRENT_BOOT_SALT)
  .digest("hex");

const MAX_LOG_LINES = 3000;
const logHistory = [];
const sseClients = new Set();
let logCounter = 0;
let clearCookieHandler = null;

// Gán hàm xử lý xóa cache cookie từ main.js
function setClearCookieHandler(fn) {
  clearCookieHandler = fn;
}

// Escape HTML
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Strip ANSI terminal color codes
function stripAnsi(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*m/g, "");
}

// Convert ANSI color codes to styled HTML spans
function ansiToHtml(str) {
  const colorMap = {
    "30": "#6b7280",
    "31": "#ef4444",
    "32": "#22c55e",
    "33": "#eab308",
    "34": "#3b82f6",
    "35": "#a855f7",
    "36": "#06b6d4",
    "37": "#f3f4f6",
    "90": "#9ca3af",
    "91": "#f87171",
    "92": "#4ade80",
    "93": "#facc15",
    "94": "#60a5fa",
    "95": "#c084fc",
    "96": "#22d3ee",
    "97": "#ffffff",
  };

  const escaped = escapeHtml(str);
  let openSpan = false;
  const converted = escaped.replace(/\x1b\[([0-9;]*)m/g, (match, code) => {
    if (code === "0" || code === "") {
      if (openSpan) {
        openSpan = false;
        return "</span>";
      }
      return "";
    }
    const color = colorMap[code];
    if (color) {
      const prefix = openSpan ? "</span>" : "";
      openSpan = true;
      return `${prefix}<span style="color:${color}">`;
    }
    return "";
  });
  return openSpan ? converted + "</span>" : converted;
}

function pushLog(type, args, source = "main") {
  const now = new Date();
  const time =
    now.toLocaleTimeString("vi-VN", { hour12: false }) +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");

  const rawText = Array.isArray(args)
    ? args
        .map((arg) => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 4, colors: false })))
        .join(" ")
    : String(args || "");

  const cleanText = stripAnsi(rawText);
  const htmlText = ansiToHtml(rawText);

  const entry = {
    id: ++logCounter,
    time,
    type,
    source, // "main" or "frontend"
    text: cleanText,
    html: htmlText,
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_LINES) {
    logHistory.shift();
  }

  const sseData = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(sseData);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// Hook global console methods in Node (Main Process)
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
const origInfo = console.info ? console.info.bind(console) : origLog;

console.log = function (...args) {
  origLog(...args);
  pushLog("log", args, "main");
};
console.warn = function (...args) {
  origWarn(...args);
  pushLog("warn", args, "main");
};
console.error = function (...args) {
  origError(...args);
  pushLog("error", args, "main");
};
console.info = function (...args) {
  origInfo(...args);
  pushLog("info", args, "main");
};

// Hook Electron WebContents to capture all Frontend (Renderer) console messages
function attachToElectron(electronApp, ipcMain) {
  if (electronApp && typeof electronApp.on === "function") {
    electronApp.on("web-contents-created", (event, contents) => {
      contents.on("console-message", (event, level, message, line, sourceId) => {
        // level: 0 (verbose/debug), 1 (info), 2 (warn), 3 (error)
        const typeMap = { 0: "log", 1: "info", 2: "warn", 3: "error" };
        const type = typeMap[level] || "log";
        pushLog(type, message, "frontend");
      });
    });
  }

  if (ipcMain && typeof ipcMain.on === "function") {
    ipcMain.on("renderer:log", (event, payload) => {
      if (typeof payload === "string") {
        pushLog("log", payload, "frontend");
      } else if (payload && typeof payload === "object") {
        const type = payload.type || "log";
        const msg = payload.message || payload.text || JSON.stringify(payload);
        pushLog(type, msg, "frontend");
      }
    });
  }
}

// Parse cookies from request
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    let [name, ...rest] = cookie.split("=");
    name = name?.trim();
    if (!name) return;
    const value = rest.join("=").trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Check authentication
function isAuthenticated(req) {
  // 1. Check Cookie session
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.log_session === AUTH_SECRET_TOKEN) {
    return true;
  }
  // 2. Check query parameter: ?pass=kinxadmin@ or ?key=kinxadmin@
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const passParam =
      urlObj.searchParams.get("pass") ||
      urlObj.searchParams.get("key") ||
      urlObj.searchParams.get("password");
    if (passParam === LOG_PASSWORD) {
      return true;
    }
  } catch (_) {}

  // 3. Check Authorization header
  const authHeader = req.headers.authorization || "";
  if (authHeader.includes(LOG_PASSWORD) || authHeader.includes(AUTH_SECRET_TOKEN)) {
    return true;
  }

  return false;
}

// HTML Login Page Template
function renderLoginHtml(errorMessage = "") {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kinx Auto — Đăng nhập xem Log</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 20%, #1e293b 0%, #0b0f17 100%);
      color: #e2e8f0;
      font-family: 'JetBrains Mono', Consolas, monospace;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 12px;
      padding: 32px 28px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .icon-lock {
      width: 52px;
      height: 52px;
      margin: 0 auto 16px;
      background: rgba(59, 130, 246, 0.15);
      color: #3b82f6;
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }
    h1 {
      font-size: 18px;
      font-weight: 700;
      color: #f8fafc;
      margin-bottom: 6px;
    }
    p.subtitle {
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .form-group {
      position: relative;
      margin-bottom: 18px;
      text-align: left;
    }
    .form-group label {
      display: block;
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 6px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .input-wrapper {
      position: relative;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 13px;
      padding: 10px 38px 10px 12px;
      border-radius: 8px;
      outline: none;
      transition: all 0.2s;
    }
    input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.25);
    }
    .toggle-pass {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 15px;
      padding: 2px;
    }
    .toggle-pass:hover { color: #f1f5f9; }
    .btn-submit {
      width: 100%;
      background: #3b82f6;
      color: #ffffff;
      border: none;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 11px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-submit:hover {
      background: #2563eb;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 16px;
      display: ${errorMessage ? "block" : "none"};
      animation: shake 0.3s ease;
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-5px); }
      75% { transform: translateX(5px); }
    }
    footer {
      margin-top: 20px;
      font-size: 11px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-lock">🔐</div>
    <h1>Kinx Auto — Log Viewer</h1>
    <p class="subtitle">Vui lòng nhập mật khẩu quản trị để truy cập và xem trực tiếp Console Log.</p>

    <div id="error-box" class="alert-error">${escapeHtml(errorMessage)}</div>

    <form id="login-form" method="POST" action="/log/login">
      <div class="form-group">
        <label for="password-input">Mật khẩu</label>
        <div class="input-wrapper">
          <input type="password" id="password-input" name="password" placeholder="Nhập mật khẩu..." required autofocus autocomplete="current-password" />
          <button type="button" class="toggle-pass" id="toggle-eye" title="Hiện/ẩn mật khẩu">👁️</button>
        </div>
      </div>
      <button type="submit" class="btn-submit" id="submit-btn">Đăng nhập xem Log</button>
    </form>

    <footer>
      <span>Bảo mật hệ thống Kinx Auto</span>
    </footer>
  </div>

  <script>
    const form = document.getElementById('login-form');
    const passInput = document.getElementById('password-input');
    const toggleEye = document.getElementById('toggle-eye');
    const errorBox = document.getElementById('error-box');
    const submitBtn = document.getElementById('submit-btn');

    toggleEye.addEventListener('click', () => {
      if (passInput.type === 'password') {
        passInput.type = 'text';
        toggleEye.textContent = '🔒';
      } else {
        passInput.type = 'password';
        toggleEye.textContent = '👁️';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = passInput.value;
      if (!password) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Đang xác thực...';

      try {
        const res = await fetch('/log/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success) {
          sessionStorage.removeItem('kinx_force_logout');
          window.location.href = '/log';
        } else {
          errorBox.textContent = data.message || 'Mật khẩu không chính xác!';
          errorBox.style.display = 'block';
          passInput.value = '';
          passInput.focus();
        }
      } catch (err) {
        errorBox.textContent = 'Lỗi kết nối máy chủ: ' + err.message;
        errorBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Đăng nhập xem Log';
      }
    });
  </script>
</body>
</html>`;
}

// HTML Dashboard Template (supporting both Main and Frontend logs, with Cookie/Cache Clear)
function renderLogHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kinx Auto - Live Console Log</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0b0f17;
      color: #e2e8f0;
      font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.5;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #111827;
      border-bottom: 1px solid #1f2937;
      padding: 10px 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      user-select: none;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand h1 {
      font-size: 15px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: -0.3px;
    }
    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .badge-live .dot {
      width: 6px;
      height: 6px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 8px #22c55e;
      animation: pulse 1.8s infinite;
    }
    .badge-disconnected {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .badge-disconnected .dot {
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.3); }
    }
    .controls {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .search-box {
      position: relative;
    }
    .search-box input {
      background: #1e293b;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 12px;
      padding: 6px 28px 6px 10px;
      border-radius: 6px;
      width: 170px;
      outline: none;
      transition: all 0.2s;
    }
    .search-box input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
      width: 210px;
    }
    .search-box .clear-btn {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 14px;
      display: none;
    }
    .filter-btn-group {
      display: inline-flex;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      overflow: hidden;
    }
    .filter-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      padding: 6px 9px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover { color: #f1f5f9; background: #334155; }
    .filter-btn.active {
      background: #3b82f6;
      color: #ffffff;
    }
    .filter-source-btn.active {
      background: #8b5cf6;
      color: #ffffff;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s;
    }
    .btn:hover { background: #334155; color: #f8fafc; }
    .btn-warning {
      background: rgba(245, 158, 11, 0.15);
      border-color: rgba(245, 158, 11, 0.35);
      color: #fbbf24;
    }
    .btn-warning:hover {
      background: #d97706;
      border-color: #f59e0b;
      color: #ffffff;
    }
    .btn-danger:hover { background: #dc2626; color: #ffffff; border-color: #ef4444; }
    .auto-scroll-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #94a3b8;
      cursor: pointer;
      user-select: none;
    }
    .auto-scroll-label input {
      accent-color: #3b82f6;
      cursor: pointer;
    }
    #log-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 10px 14px;
      scroll-behavior: auto;
    }
    .log-line {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 2px 4px;
      border-radius: 4px;
      transition: background 0.1s;
      word-break: break-all;
      white-space: pre-wrap;
    }
    .log-line:hover {
      background: rgba(255, 255, 255, 0.03);
    }
    .log-time {
      color: #64748b;
      font-size: 11px;
      flex-shrink: 0;
      user-select: none;
      padding-top: 1px;
    }
    .log-source {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
      flex-shrink: 0;
      text-transform: uppercase;
      user-select: none;
    }
    .source-main {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .source-frontend {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }
    .log-type {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
      text-transform: uppercase;
      user-select: none;
    }
    .type-log { background: rgba(56, 189, 248, 0.12); color: #38bdf8; }
    .type-info { background: rgba(34, 197, 94, 0.12); color: #4ade80; }
    .type-warn { background: rgba(234, 179, 8, 0.15); color: #facc15; }
    .type-error { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .log-content {
      flex: 1;
      color: #f1f5f9;
    }
    .type-error .log-content { color: #fca5a5; font-weight: 500; }
    .type-warn .log-content { color: #fef08a; }
    footer {
      background: #0f172a;
      border-top: 1px solid #1e293b;
      padding: 6px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #64748b;
      user-select: none;
    }
    .footer-left { display: flex; gap: 14px; align-items: center; }
    .toast-copied {
      position: fixed;
      bottom: 35px;
      right: 20px;
      background: #22c55e;
      color: #ffffff;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.25s ease;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 999;
    }
    .toast-copied.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>Kinx Auto — Console Log Viewer</h1>
      <span id="conn-badge" class="badge-live"><span class="dot"></span> LIVE</span>
      <span style="font-size: 11px; color: #64748b;">(Port: ${LOG_PORT})</span>
    </div>
    <div class="controls">
      <!-- Nút Xóa Cache Cookie -->
      <button class="btn btn-warning" id="clear-cookies-btn" title="Chỉ xóa Cookie & phiên Flow, giữ nguyên dữ liệu tool">🧹 Xóa Cache Cookie</button>

      <!-- Lọc Nguồn Log -->
      <div class="filter-btn-group" title="Lọc nguồn log: Main (Terminal) hoặc Frontend (Giao diện App)">
        <button class="filter-btn filter-source-btn active" data-source="all">Tất cả</button>
        <button class="filter-btn filter-source-btn" data-source="main">💻 Main</button>
        <button class="filter-btn filter-source-btn" data-source="frontend">🌐 Frontend</button>
      </div>

      <!-- Lọc Mức Độ Log -->
      <div class="filter-btn-group" title="Lọc loại log">
        <button class="filter-btn filter-type-btn active" data-type="all">Tất cả</button>
        <button class="filter-btn filter-type-btn" data-type="log">Log</button>
        <button class="filter-btn filter-type-btn" data-type="warn">Cảnh báo</button>
        <button class="filter-btn filter-type-btn" data-type="error">Lỗi</button>
      </div>

      <!-- Ô Tìm Kiếm -->
      <div class="search-box">
        <input type="text" id="search-input" placeholder="🔍 Tìm kiếm..." />
        <button class="clear-btn" id="search-clear" title="Xóa tìm kiếm">&times;</button>
      </div>

      <label class="auto-scroll-label">
        <input type="checkbox" id="auto-scroll-chk" checked />
        <span>Tự cuộn</span>
      </label>
      <button class="btn" id="copy-btn" title="Sao chép toàn bộ log hiển thị">📋 Copy</button>
      <button class="btn" id="download-btn" title="Tải file .log">💾 Tải</button>
      <button class="btn btn-danger" id="clear-view-btn" title="Xóa hiển thị màn hình">🗑️ Xóa</button>
      <a href="/log/logout" class="btn" style="color: #f87171;" title="Đăng xuất khỏi phiên xem Log">🚪 Thoát</a>
    </div>
  </header>

  <div id="log-container"></div>

  <footer>
    <div class="footer-left">
      <span>Tổng log: <b id="total-count" style="color: #94a3b8;">0</b></span>
      <span>💻 Main: <b id="main-count" style="color: #60a5fa;">0</b></span>
      <span>🌐 Frontend: <b id="frontend-count" style="color: #c084fc;">0</b></span>
      <span>Hiển thị: <b id="visible-count" style="color: #38bdf8;">0</b></span>
    </div>
    <div>
      <span>Xem định dạng thô: <a href="/log/raw" target="_blank" style="color: #38bdf8; text-decoration: none;">/log/raw</a> | <a href="/log/json" target="_blank" style="color: #38bdf8; text-decoration: none;">/log/json</a></span>
    </div>
  </footer>

  <div id="toast" class="toast-copied">Đã sao chép vào bộ nhớ tạm!</div>

  <script>
    const container = document.getElementById('log-container');
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
    const filterSourceBtns = document.querySelectorAll('.filter-source-btn');
    const filterTypeBtns = document.querySelectorAll('.filter-type-btn');
    const autoScrollChk = document.getElementById('auto-scroll-chk');
    const copyBtn = document.getElementById('copy-btn');
    const downloadBtn = document.getElementById('download-btn');
    const clearViewBtn = document.getElementById('clear-view-btn');
    const clearCookiesBtn = document.getElementById('clear-cookies-btn');
    const connBadge = document.getElementById('conn-badge');
    const totalCountEl = document.getElementById('total-count');
    const mainCountEl = document.getElementById('main-count');
    const frontendCountEl = document.getElementById('frontend-count');
    const visibleCountEl = document.getElementById('visible-count');
    const toastEl = document.getElementById('toast');

    // Nếu phiên trước đó bị mất kết nối -> cưỡng chế đăng xuất và yêu cầu nhập lại mật khẩu
    if (sessionStorage.getItem('kinx_force_logout') === '1') {
      sessionStorage.removeItem('kinx_force_logout');
      fetch('/log/logout', { method: 'POST' }).finally(() => {
        window.location.reload();
      });
    }

    let allLogs = [];
    let currentFilterSource = 'all';
    let currentFilterType = 'all';
    let currentSearchTerm = '';
    let isUserScrolledUp = false;

    // Detect user manual scrolling
    container.addEventListener('scroll', () => {
      const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserScrolledUp = scrollBottom > 60;
    });

    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 2500);
    }

    function createLogLineElement(entry) {
      const line = document.createElement('div');
      line.className = 'log-line type-' + entry.type;
      line.dataset.type = entry.type;
      line.dataset.source = entry.source || 'main';
      line.dataset.id = entry.id;

      const timeEl = document.createElement('span');
      timeEl.className = 'log-time';
      timeEl.textContent = entry.time;

      const sourceEl = document.createElement('span');
      const isFront = (entry.source === 'frontend');
      sourceEl.className = 'log-source ' + (isFront ? 'source-frontend' : 'source-main');
      sourceEl.textContent = isFront ? 'FRONTEND' : 'MAIN';

      const tagEl = document.createElement('span');
      tagEl.className = 'log-type type-' + entry.type;
      tagEl.textContent = entry.type.toUpperCase();

      const contentEl = document.createElement('span');
      contentEl.className = 'log-content';
      contentEl.innerHTML = entry.html || entry.text;

      line.appendChild(timeEl);
      line.appendChild(sourceEl);
      line.appendChild(tagEl);
      line.appendChild(contentEl);

      return line;
    }

    function matchesFilter(entry) {
      const entrySource = entry.source || 'main';
      if (currentFilterSource !== 'all' && entrySource !== currentFilterSource) {
        return false;
      }
      if (currentFilterType !== 'all') {
        if (currentFilterType === 'log' && entry.type !== 'log' && entry.type !== 'info') return false;
        if (currentFilterType === 'warn' && entry.type !== 'warn') return false;
        if (currentFilterType === 'error' && entry.type !== 'error') return false;
      }
      if (currentSearchTerm) {
        return entry.text.toLowerCase().includes(currentSearchTerm);
      }
      return true;
    }

    function updateCounters() {
      let mainCount = 0;
      let frontCount = 0;
      for (const e of allLogs) {
        if (e.source === 'frontend') frontCount++;
        else mainCount++;
      }
      totalCountEl.textContent = allLogs.length;
      mainCountEl.textContent = mainCount;
      frontendCountEl.textContent = frontCount;
    }

    function renderAll() {
      container.innerHTML = '';
      let visible = 0;
      const frag = document.createDocumentFragment();

      for (const entry of allLogs) {
        if (matchesFilter(entry)) {
          frag.appendChild(createLogLineElement(entry));
          visible++;
        }
      }
      container.appendChild(frag);
      updateCounters();
      visibleCountEl.textContent = visible;

      if (autoScrollChk.checked && !isUserScrolledUp) {
        container.scrollTop = container.scrollHeight;
      }
    }

    function appendSingleLog(entry) {
      allLogs.push(entry);
      updateCounters();

      if (matchesFilter(entry)) {
        const el = createLogLineElement(entry);
        container.appendChild(el);
        visibleCountEl.textContent = parseInt(visibleCountEl.textContent || '0') + 1;

        if (autoScrollChk.checked && !isUserScrolledUp) {
          container.scrollTop = container.scrollHeight;
        }
      }
    }

    // Nút Xóa Cache Cookie
    clearCookiesBtn.addEventListener('click', async () => {
      if (!confirm('Bạn có muốn xóa Cache Cookie (giữ nguyên toàn bộ dữ liệu và tài khoản đăng nhập trên tool) không?')) {
        return;
      }
      clearCookiesBtn.disabled = true;
      clearCookiesBtn.textContent = '⏳ Đang xóa...';
      try {
        const res = await fetch('/log/clear-cookies', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('✅ ' + (data.message || 'Đã xóa sạch Cache Cookie!'));
        } else {
          showToast('❌ Lỗi: ' + (data.error || 'Không thể xóa'));
        }
      } catch (err) {
        showToast('❌ Lỗi kết nối: ' + err.message);
      } finally {
        clearCookiesBtn.disabled = false;
        clearCookiesBtn.textContent = '🧹 Xóa Cache Cookie';
      }
    });

    // Source Filter Tabs
    filterSourceBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterSourceBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilterSource = btn.dataset.source;
        renderAll();
      });
    });

    // Type Filter Tabs
    filterTypeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterTypeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilterType = btn.dataset.type;
        renderAll();
      });
    });

    // Search input
    searchInput.addEventListener('input', () => {
      currentSearchTerm = searchInput.value.trim().toLowerCase();
      searchClear.style.display = currentSearchTerm ? 'block' : 'none';
      renderAll();
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      currentSearchTerm = '';
      searchClear.style.display = 'none';
      renderAll();
      searchInput.focus();
    });

    // Clear view
    clearViewBtn.addEventListener('click', () => {
      allLogs = [];
      container.innerHTML = '';
      updateCounters();
      visibleCountEl.textContent = '0';
      showToast('Đã xóa hiển thị log màn hình');
    });

    // Copy logs
    copyBtn.addEventListener('click', () => {
      const visibleLines = Array.from(container.querySelectorAll('.log-line'))
        .map(el => {
          const t = el.querySelector('.log-time')?.textContent || '';
          const s = el.querySelector('.log-source')?.textContent || '';
          const tag = el.querySelector('.log-type')?.textContent || '';
          const c = el.querySelector('.log-content')?.textContent || '';
          return \`[\${t}] [\${s}] [\${tag}] \${c}\`;
        })
        .join('\\n');

      if (!visibleLines) {
        showToast('Không có log để sao chép');
        return;
      }
      navigator.clipboard.writeText(visibleLines).then(() => {
        showToast('Đã copy ' + container.children.length + ' dòng log!');
      });
    });

    // Download logs
    downloadBtn.addEventListener('click', () => {
      const text = allLogs
        .map(e => \`[\${e.time}] [\${(e.source || 'main').toUpperCase()}] [\${e.type.toUpperCase()}] \${e.text}\`)
        .join('\\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`kinx_console_\${Date.now()}.log\`;
      a.click();
    });

    // Server-Sent Events (SSE) connection: MẤT KẾT NỐI LẬP TỨC YÊU CẦU ĐĂNG NHẬP LẠI
    function connectSse() {
      const evtSource = new EventSource('/log/stream');

      evtSource.onopen = () => {
        connBadge.className = 'badge-live';
        connBadge.innerHTML = '<span class="dot"></span> LIVE';
      };

      evtSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data)) {
            allLogs = data;
            renderAll();
          } else if (data && data.id) {
            appendSingleLog(data);
          }
        } catch (err) {
          console.error('Error parsing SSE log:', err);
        }
      };

      // Khi mất kết nối (ngắt kết nối / server tắt / mạng ngắt) -> Bắt buộc đăng nhập lại
      evtSource.onerror = () => {
        connBadge.className = 'badge-live badge-disconnected';
        connBadge.innerHTML = '<span class="dot"></span> MẤT KẾT NỐI (Đang đăng xuất...)';
        evtSource.close();
        sessionStorage.setItem('kinx_force_logout', '1');
        // Hủy session ngay và đưa về trang đăng nhập
        fetch('/log/logout', { method: 'POST' }).finally(() => {
          setTimeout(() => {
            window.location.reload();
          }, 600);
        });
      };
    }

    // First load initial logs
    fetch('/log/json')
      .then(r => {
        if (r.status === 401) {
          window.location.reload();
          return;
        }
        return r.json();
      })
      .then(data => {
        allLogs = Array.isArray(data) ? data : [];
        renderAll();
        connectSse();
      })
      .catch(() => {
        window.location.reload();
      });
  </script>
</body>
</html>`;
}

// Read body helper
function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
      }
    });
    req.on("end", () => {
      resolve(body);
    });
  });
}

// Request Handler for Web Log Server
async function handleLogRequest(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Handle Logout: /log/logout (Hủy session cookie)
  if (pathname === "/log/logout" || pathname === "/logout") {
    res.setHeader(
      "Set-Cookie",
      "log_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
    );
    if (req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: true, message: "Đã hủy phiên đăng nhập log." }));
      return;
    }
    res.writeHead(302, { Location: "/log" });
    res.end();
    return;
  }

  // Handle Login submission: POST /log/login
  if (pathname === "/log/login" && req.method === "POST") {
    const rawBody = await readRequestBody(req);
    let enteredPass = "";

    try {
      const parsed = JSON.parse(rawBody);
      enteredPass = parsed.password || "";
    } catch (_) {
      // Fallback urlencoded
      const params = new URLSearchParams(rawBody);
      enteredPass = params.get("password") || "";
    }

    if (enteredPass === LOG_PASSWORD) {
      // KHÔNG lưu phiên lâu dài: Không dùng Max-Age hay Expires.
      // Chỉ là session cookie tạm thời trong phiên trình duyệt, khi đóng tab/mất kết nối sẽ bị hủy.
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `log_session=${AUTH_SECRET_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: false, message: "Mật khẩu không đúng! Vui lòng thử lại." }));
    }
    return;
  }

  // Check Authentication
  const authed = isAuthenticated(req);

  // If not authenticated:
  if (!authed) {
    // If requesting HTML page: show Login Form
    if (pathname === "/" || pathname === "/log" || pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLoginHtml());
      return;
    }
    // If API/Stream route: return 401 Unauthorized
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "Unauthorized",
        message: "Cần đăng nhập mật khẩu kinxadmin@ để truy cập log.",
      })
    );
    return;
  }

  // --- AUTHENTICATED ROUTES ---

  // 1. Web Viewer HTML: / or /log or /logs
  if (pathname === "/" || pathname === "/log" || pathname === "/logs") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderLogHtml());
    return;
  }

  // 2. Real-time Log Stream (SSE): /log/stream
  if (pathname === "/log/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    sseClients.add(res);

    // Send heartbeat to prevent proxy timeout
    const keepAliveTimer = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 20000);

    req.on("close", () => {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    });
    return;
  }

  // 3. Xóa Cache Cookie: POST /log/clear-cookies (Chỉ xóa cookie, không xóa dữ liệu tool)
  if (pathname === "/log/clear-cookies" && req.method === "POST") {
    let result = { success: true, message: "Đã xóa sạch Cache Cookie (giữ nguyên dữ liệu tool)!" };
    try {
      if (typeof clearCookieHandler === "function") {
        const resHandler = await clearCookieHandler();
        if (resHandler && typeof resHandler === "object") {
          result = { ...result, ...resHandler };
        }
      }
      origLog("[WebLogger] 🧹 Người dùng đã bấm Xóa Cache Cookie qua Web Log (giữ nguyên dữ liệu tool).");
    } catch (e) {
      result = { success: false, error: e.message };
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  // 4. Raw plain-text log: /log/raw
  if (pathname === "/log/raw") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    const text = logHistory
      .map((e) => `[${e.time}] [${(e.source || "main").toUpperCase()}] [${e.type.toUpperCase()}] ${e.text}`)
      .join("\n");
    res.end(text);
    return;
  }

  // 5. JSON array of logs: /log/json
  if (pathname === "/log/json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(logHistory));
    return;
  }

  // 6. Clear server history: POST /log/clear
  if (pathname === "/log/clear" && req.method === "POST") {
    logHistory.length = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Cleared" }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found. Truy cập /log để xem màn hình console.");
}

// Start standalone HTTP Server for logging on port 9898
function startWebLoggerServer() {
  const server = http.createServer((req, res) => {
    handleLogRequest(req, res).catch((err) => {
      origError("[WebLogger] Lỗi xử lý request:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error: " + err.message);
      }
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      origWarn(`[WebLogger] Cổng ${LOG_PORT} đang bận, thử cổng ${LOG_PORT + 1}...`);
      server.listen(LOG_PORT + 1, "0.0.0.0");
    } else {
      origError("[WebLogger] Lỗi khởi tạo web logger:", err.message);
    }
  });

  server.listen(LOG_PORT, "0.0.0.0", () => {
    origLog(
      `[WebLogger] 🚀 Xem log Terminal trực tiếp trên trình duyệt tại: http://localhost:${LOG_PORT}/log (Mật khẩu: ${LOG_PASSWORD})`
    );
  });

  return server;
}

const serverInstance = startWebLoggerServer();

module.exports = {
  LOG_PORT,
  LOG_PASSWORD,
  handleLogRequest,
  setClearCookieHandler,
  pushLog,
  attachToElectron,
  getHistory: () => logHistory,
  server: serverInstance,
};
