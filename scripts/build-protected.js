"use strict";
/**
 * Maximum-Security Multi-Layer Protected Build Pipeline for Kinx Auto (Windows & macOS Universal Dual-Chip)
 *
 * Security Architecture:
 * 1. Smart Backup & Clean: Safely backs up dist/ & dist-electron/, strips all .backup, .bak*, .log, and unused bundles.
 * 2. Runtime Anti-Hook, Anti-Debug & Anti-DevTools Shield:
 *    - Verifies native V8 C++ function integrity (`[native code]`) to defeat API hooking/dumping.
 *    - Blocks `--inspect`, `--remote-debugging-port`, `--js-flags`, `inspector.url()`, F12, Ctrl+Shift+I/J/C, Cmd+Opt+I/J/C, Ctrl+U.
 * 3. Layer-1 Native V8 Bytecode + AES-256-GCM Vault (`kinx-core-<arch>.vault`):
 *    - Compiles Main Process modules (`main`, `kinxts-bridge`, `local-proxy-server`, `voice-engine`, `web-logger`,
 *      `maintenance-check-function`) using Electron 38's V8 engine (`--no-lazy`), stripping 100% of JS source code.
 *    - On macOS Universal builds, compiles BOTH `arm64` (Apple Silicon M1/M2/M3/M4) and `x64` (Intel) V8 Bytecode vaults!
 *    - Compresses with Brotli (quality 11) and encrypts with AES-256-GCM (25,000-round PBKDF2-HMAC-SHA512 + HMAC-SHA256)
 *      cryptographically bound to the binary's Electron Fuse Wire ("00011").
 * 4. Layer-2 Native V8 Bytecode Vault Decryptor (`sec-boot-<arch>.bin`):
 *    - The Vault Decryptor & Key Derivation logic is first obfuscated (RC4 + Control Flow Flattening)
 *      and THEN compiled into Native V8 Bytecode (`sec-boot-<arch>.bin`). Zero key derivation or AES decryption code
 *      exists as JavaScript anywhere in `app.asar`!
 * 5. Heavy Obfuscation for Preload & Renderer (`preload.js`, `dist/*.js`, `dist/assets/*.js`):
 *    - RC4 String Array Encryption, Control Flow Flattening, Dead Code Injection, Self-Defending, Hexadecimal Mangling.
 * 6. Hardware/Binary Electron Fuses & Embedded ASAR Integrity Validation:
 *    - Locks `Kinx Auto.exe` (Windows) and `Kinx Auto.app` (macOS Universal) fuses
 *      (`RunAsNode=0`, `NodeOptions=0`, `CliInspect=0`, `AsarIntegrity=1`, `OnlyLoadAppFromAsar=1`, `resetAdHocDarwinSignature=true`).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const DIST_ELECTRON_DIR = path.join(ROOT_DIR, "dist-electron");
const BACKUP_DIR = path.join(ROOT_DIR, ".build-backup");
const BACKUP_DIST = path.join(BACKUP_DIR, "dist");
const BACKUP_DIST_ELECTRON = path.join(BACKUP_DIR, "dist-electron");

const MAIN_MODULES = [
  "main",
  "kinxts-bridge",
  "local-proxy-server",
  "voice-engine",
  "web-logger",
  "maintenance-check-function",
];

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirRecursive(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function backupSources() {
  if (fs.existsSync(BACKUP_DIR)) {
    const currentMainPath = path.join(DIST_ELECTRON_DIR, "main.js");
    const isCurrentMainCleanSource =
      fs.existsSync(currentMainPath) && fs.statSync(currentMainPath).size > 500000;
    if (isCurrentMainCleanSource) {
      console.log("[Build-Protected] Removing stale .build-backup (current dist-electron/main.js is clean source)...");
      removeDirRecursive(BACKUP_DIR);
    } else {
      console.log("[Build-Protected] Found interrupted build state, restoring clean source from .build-backup first...");
      restoreSources();
    }
  }
  console.log("[Build-Protected] Backing up original dist/ and dist-electron/...");
  copyDirRecursive(DIST_DIR, BACKUP_DIST);
  copyDirRecursive(DIST_ELECTRON_DIR, BACKUP_DIST_ELECTRON);
}

function restoreSources() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  console.log("[Build-Protected] Restoring original dist/ and dist-electron/...");
  removeDirRecursive(DIST_DIR);
  removeDirRecursive(DIST_ELECTRON_DIR);
  copyDirRecursive(BACKUP_DIST, DIST_DIR);
  copyDirRecursive(BACKUP_DIST_ELECTRON, DIST_ELECTRON_DIR);
  removeDirRecursive(BACKUP_DIR);
  console.log("[Build-Protected] Clean source directories restored.");
}

function cleanStagedDirectories() {
  console.log("[Build-Protected] Cleaning backup/debug files from staged directories...");
  for (const f of fs.readdirSync(DIST_ELECTRON_DIR)) {
    if (
      f.includes(".backup") ||
      f.includes(".bak") ||
      f.endsWith(".log") ||
      f.endsWith(".vault") ||
      f.endsWith(".bin")
    ) {
      fs.unlinkSync(path.join(DIST_ELECTRON_DIR, f));
    }
  }

  for (const f of fs.readdirSync(DIST_DIR)) {
    if (
      f.includes(".backup") ||
      f.includes(".bak") ||
      f === "builder-effective-config.yaml"
    ) {
      fs.unlinkSync(path.join(DIST_DIR, f));
    }
  }

  const assetsDir = path.join(DIST_DIR, "assets");
  if (fs.existsSync(assetsDir)) {
    for (const f of fs.readdirSync(assetsDir)) {
      if (
        f.includes(".backup") ||
        f.includes(".bak") ||
        f.includes("_muse.js")
      ) {
        fs.unlinkSync(path.join(assetsDir, f));
      }
    }
  }
}

function prepareMainAndVoiceForMultiPlatform() {
  const mainPath = path.join(DIST_ELECTRON_DIR, "main.js");
  let code = fs.readFileSync(mainPath, "utf8");

  const replacements = [
    {
      target: `      const isLoggedOut = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t.includes('Studio sáng tạo AI của bạn') || t.includes('Tạo bằng Google Flow');
      });`,
      replacement: `      const isLoggedOut = await page.evaluate(new Function("const t = document.body.innerText || ''; return t.includes('Studio sáng tạo AI của bạn') || t.includes('Tạo bằng Google Flow');"));`,
    },
    {
      target: `        await page.evaluate(() => {
          const img = document.querySelector('img[src*="googleusercontent"]') || document.querySelector('button[aria-label*="Google"]');
          if (img) {
            const btn = img.closest('button') || img.parentElement;
            if (btn) btn.click();
          }
        });`,
      replacement: `        await page.evaluate(new Function("const img = document.querySelector('img[src*=\\"googleusercontent\\"]') || document.querySelector('button[aria-label*=\\"Google\\"]'); if (img) { const btn = img.closest('button') || img.parentElement; if (btn) btn.click(); }"));`,
    },
    {
      target: `        text = await page.evaluate(() => document.body.innerText || '');`,
      replacement: `        text = await page.evaluate(new Function("return document.body.innerText || '';"));`,
    },
    {
      target: `              const clicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const btn = btns.find(b => (b.innerText || '').includes('Tạo bằng Google Flow'));
                if (btn) { btn.click(); return true; }
                return false;
              });`,
      replacement: `              const clicked = await page.evaluate(new Function("const btns = Array.from(document.querySelectorAll('button, a')); const btn = btns.find(b => (b.innerText || '').includes('Tạo bằng Google Flow')); if (btn) { btn.click(); return true; } return false;"));`,
    },
    {
      target: `              studioState = await page.evaluate(() => {
                const uid = window.WIZ_global_data?.S06Grb || '';
                const at = window.WIZ_global_data?.SNlM0e || (document.documentElement.innerHTML.match(/"SNlM0e":\\s*"([^"]+)"/) || [])[1] || '';
                const email = window.WIZ_global_data?.oPEP7c || '';
                const hasNewBtn = !!document.querySelector('[aria-label*="project" i], [aria-label*="dự án" i], button');
                return { uid, at, email, hasNewBtn };
              });`,
      replacement: `              studioState = await page.evaluate(new Function("const uid = window.WIZ_global_data?.S06Grb || ''; const at = window.WIZ_global_data?.SNlM0e || (document.documentElement.innerHTML.match(/\\"SNlM0e\\":\\\\s*\\"([^\\"]+)\\"/) || [])[1] || ''; const email = window.WIZ_global_data?.oPEP7c || ''; const hasNewBtn = !!document.querySelector('[aria-label*=\\"project\\" i], [aria-label*=\\"dự án\\" i], button'); return { uid, at, email, hasNewBtn };"));`,
    },
    {
      target: `                  const docCookie = await page.evaluate(() => document.cookie);`,
      replacement: `                  const docCookie = await page.evaluate(new Function("return document.cookie;"));`,
    },
    {
      target: `                try { const finalAt = await page.evaluate(() => window.WIZ_global_data?.SNlM0e); if (finalAt) studioState.at = finalAt; } catch (e) { }`,
      replacement: `                try { const finalAt = await page.evaluate(new Function("return window.WIZ_global_data?.SNlM0e;")); if (finalAt) studioState.at = finalAt; } catch (e) { }`,
    },
    {
      target: `      await t.evaluate(l => {
        const o = document.querySelector('div.ql-editor[role="textbox"]');
        o && (o.focus(), document.execCommand("insertText", !1, l))
      }, r)`,
      replacement: `      await t.evaluate(new Function("l", "const o = document.querySelector('div.ql-editor[role=\\"textbox\\"]'); o && (o.focus(), document.execCommand('insertText', !1, l));"), r)`,
    },
    {
      target: `      const n = await t.evaluate(() => {
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
      });`,
      replacement: `      const n = await t.evaluate(new Function("const l = Array.from(document.querySelectorAll('message-content')); if (l.length > 0) { const p = l[l.length - 1]; return { success: !0, text: p.innerText || p.textContent || '' }; } const o = document.querySelector('.response-container, .model-response-text'); return o ? { success: !0, text: o.innerText || '' } : { success: !1, error: 'Không lấy được nội dung' };"));`,
    },
  ];

  let normalized = code.replace(/\r\n/g, "\n");
  for (let i = 0; i < replacements.length; i++) {
    const { target, replacement } = replacements[i];
    if (!normalized.includes(target)) {
      throw new Error(`[Build-Protected] Failed to match page.evaluate block #${i + 1} in main.js`);
    }
    normalized = normalized.replace(target, replacement);
  }

  const antiDevToolsHook = `
;(function() {
  try {
    const _el = require("electron");
    if (_el && _el.app) {
      _el.app.commandLine.appendSwitch("disable-http-cache");
      _el.app.on("browser-window-created", function(_e, win) {
        try {
          win.webContents.on("devtools-opened", function() {
            try { win.webContents.closeDevTools(); } catch (_) {}
          });
          win.webContents.on("before-input-event", function(event, input) {
            const k = (input.key || "").toUpperCase();
            if (
              k === "F12" ||
              (input.control && input.shift && (k === "I" || k === "J" || k === "C")) ||
              (input.meta && input.alt && (k === "I" || k === "J" || k === "C")) ||
              ((input.control || input.meta) && k === "U")
            ) {
              event.preventDefault();
            }
          });
        } catch (_) {}
      });
    }
  } catch (_) {}
})();
`;

  normalized = normalized.replace('"use strict";', '"use strict";\n' + antiDevToolsHook);
  fs.writeFileSync(mainPath, normalized, "utf8");

  // Also ensure voice-engine.js resolves ffmpeg on both macOS and Windows
  const voicePath = path.join(DIST_ELECTRON_DIR, "voice-engine.js");
  if (fs.existsSync(voicePath)) {
    let voiceCode = fs.readFileSync(voicePath, "utf8").replace(/\r\n/g, "\n");
    const oldFfmpegBlock = `if (app.isPackaged) {
  // Production — extraFiles "to": "." puts ffmpeg.exe next to the main exe
  ffmpeg.setFfmpegPath(path.join(path.dirname(app.getPath("exe")), "ffmpeg.exe"));
} else {
  // Development — inside build/ffmpeg/
  ffmpeg.setFfmpegPath(path.join(__dirname, "..", "build", "ffmpeg", "ffmpeg.exe"));
}`;
    const newFfmpegBlock = `const _ffmpegBin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
if (app.isPackaged) {
  const _exeDir = path.dirname(app.getPath("exe"));
  const _c1 = path.join(_exeDir, _ffmpegBin);
  const _c2 = path.join(_exeDir, "..", _ffmpegBin);
  ffmpeg.setFfmpegPath(fs.existsSync(_c1) ? _c1 : (fs.existsSync(_c2) ? _c2 : _c1));
} else {
  ffmpeg.setFfmpegPath(path.join(__dirname, "..", "build", "ffmpeg", _ffmpegBin));
}`;
    if (voiceCode.includes(oldFfmpegBlock)) {
      voiceCode = voiceCode.replace(oldFfmpegBlock, newFfmpegBlock);
      fs.writeFileSync(voicePath, voiceCode, "utf8");
    }
  }

  console.log("[Build-Protected] Prepared main.js & voice-engine.js for V8 Bytecode compilation (Windows & macOS Universal).");
}

function obfuscateHelperModules() {
  const helpers = MAIN_MODULES.filter((m) => m !== "main");
  for (const modName of helpers) {
    const filePath = path.join(DIST_ELECTRON_DIR, `${modName}.js`);
    const code = fs.readFileSync(filePath, "utf8");
    const obf = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.6,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.3,
      identifierNamesGenerator: "hexadecimal",
      numbersToExpressions: true,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 7,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ["rc4"],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersChainedCalls: true,
      stringArrayWrappersParametersMaxCount: 4,
      stringArrayWrappersType: "function",
      stringArrayThreshold: 0.9,
      target: "node",
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
    });
    fs.writeFileSync(filePath, obf.getObfuscatedCode(), "utf8");
    console.log(`[Build-Protected] Obfuscated helper module before V8 bytecode compilation: ${modName}.js`);
  }
}

async function resolveDarwinElectronBin(arch) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const electronVersion = (pkgJson.devDependencies.electron || "38.1.2").replace(/^[^\d]*/, "");
  const { downloadArtifact } = require("@electron/get");
  console.log(`[Build-Protected] Downloading/locating Electron v${electronVersion} for darwin-${arch}...`);
  const zipPath = await downloadArtifact({
    version: electronVersion,
    platform: "darwin",
    arch,
    artifactName: "electron",
  });
  const extractDir = path.join(BACKUP_DIR, `electron-darwin-${arch}`);
  removeDirRecursive(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  const unzipRes = spawnSync("unzip", ["-q", zipPath, "-d", extractDir], { encoding: "utf8" });
  if (unzipRes.status !== 0) {
    throw new Error(`[Build-Protected] Failed to unzip Electron darwin-${arch}: ${unzipRes.stderr}`);
  }
  return path.join(extractDir, "Electron.app", "Contents", "MacOS", "Electron");
}

async function buildDoubleLayerV8Vault(isMacBuild) {
  const masterSecret = crypto.randomBytes(64).toString("base64");
  const saltHex = crypto.randomBytes(32).toString("hex");
  const fuseSignature = "00011";
  const bootMaskKeyHex = crypto.randomBytes(32).toString("hex");
  const symbolToken = "kinx_v8_" + crypto.randomBytes(24).toString("hex");

  const secretBuf = Buffer.from(masterSecret, "utf8");
  const shareA = crypto.randomBytes(secretBuf.length);
  const shareB = crypto.randomBytes(secretBuf.length);
  const shareC = Buffer.allocUnsafe(secretBuf.length);
  for (let i = 0; i < secretBuf.length; i++) {
    shareC[i] = secretBuf[i] ^ shareA[i] ^ shareB[i];
  }

  const secBootRawSource = `"use strict";
(function() {
  const _fs = require("fs");
  const _path = require("path");
  const _vm = require("vm");
  const _v8 = require("v8");
  const _zlib = require("zlib");
  const _crypto = require("crypto");
  const _Module = require("module");
  const _electron = require("electron");

  // 1. Anti-Hook / Anti-Tamper verification on critical V8 C++ bindings
  const _fnToStr = Function.prototype.toString;
  const _nativeChecks = [
    _fnToStr,
    Object.defineProperty,
    Uint8Array,
    Date.now,
    Math.imul
  ];
  for (let i = 0; i < _nativeChecks.length; i++) {
    if (typeof _nativeChecks[i] !== "function" || _fnToStr.call(_nativeChecks[i]).indexOf("[native code]") === -1) {
      process.exit(1);
    }
  }

  // 2. Anti-Debugger & Process Type verification
  const _badFlags = ["--inspect", "--inspect-brk", "--inspect-port", "--debug", "--debug-brk", "--remote-debugging-port", "--js-flags"];
  const _argv = (process.execArgv || []).concat(process.argv || []).join(" ").toLowerCase();
  for (let i = 0; i < _badFlags.length; i++) {
    if (_argv.indexOf(_badFlags[i]) !== -1) {
      process.exit(1);
    }
  }
  if (process.type !== "browser") {
    process.exit(1);
  }
  try {
    const _insp = require("inspector");
    if (_insp && typeof _insp.url === "function" && _insp.url()) {
      _insp.close();
      process.exit(1);
    }
  } catch (_) {}

  // 3. Hardware/Binary Electron Fuse Wire & ASAR path verification (Windows EXE & macOS .app Framework)
  let _fuseSig = ${JSON.stringify(fuseSignature)};
  const _isPackaged = Boolean(_electron && _electron.app && _electron.app.isPackaged);
  if (_isPackaged) {
    if (__dirname.indexOf("app.asar") === -1) {
      process.exit(1);
    }
    try {
      const _fuseBinPath = process.platform === "darwin"
        ? _path.resolve(process.execPath, "..", "..", "Frameworks", "Electron Framework.framework", "Electron Framework")
        : process.execPath;
      const _exeBuf = _fs.readFileSync(_fuseBinPath);
      const _sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
      const _pos1 = _exeBuf.indexOf(_sentinel);
      const _pos2 = _exeBuf.lastIndexOf(_sentinel);
      if (_pos1 === -1) {
        process.exit(1);
      }
      const _posList = _pos1 === _pos2 ? [_pos1] : [_pos1, _pos2];
      for (let _pi = 0; _pi < _posList.length; _pi++) {
        const _wireStart = _posList[_pi] + _sentinel.length + 2;
        const _f0 = String.fromCharCode(_exeBuf[_wireStart + 0]);
        const _f2 = String.fromCharCode(_exeBuf[_wireStart + 2]);
        const _f3 = String.fromCharCode(_exeBuf[_wireStart + 3]);
        const _f4 = String.fromCharCode(_exeBuf[_wireStart + 4]);
        const _f5 = String.fromCharCode(_exeBuf[_wireStart + 5]);
        _fuseSig = _f0 + _f2 + _f3 + _f4 + _f5;
        if (_fuseSig !== ${JSON.stringify(fuseSignature)}) {
          process.exit(1);
        }
      }
    } catch (_) {
      process.exit(1);
    }
  }

  // 4. Reconstruct 3-way XOR Secret & Derive AES-256-GCM / HMAC-SHA256 Keys
  _v8.setFlagsFromString("--no-lazy");
  _v8.setFlagsFromString("--no-flush-bytecode");

  const _sA = Buffer.from(${JSON.stringify(shareA.toString("base64"))}, "base64");
  const _sB = Buffer.from(${JSON.stringify(shareB.toString("base64"))}, "base64");
  const _sC = Buffer.from(${JSON.stringify(shareC.toString("base64"))}, "base64");
  const _secBuf = Buffer.allocUnsafe(_sA.length);
  for (let i = 0; i < _sA.length; i++) {
    _secBuf[i] = _sA[i] ^ _sB[i] ^ _sC[i];
  }
  const _masterSecret = _secBuf.toString("utf8");
  _secBuf.fill(0);
  _sA.fill(0);
  _sB.fill(0);
  _sC.fill(0);

  const _salt = Buffer.from(${JSON.stringify(saltHex)}, "hex");
  const _v8Tag = String(process.versions.v8 || "").split(".")[0];
  const _keyMat = _masterSecret + "|" + _fuseSig + "|v8:" + _v8Tag;
  const _aesKey = _crypto.pbkdf2Sync(_keyMat, _salt, 25000, 32, "sha512");
  const _hmacKey = _crypto.pbkdf2Sync(_keyMat + "|hmac", _salt, 15000, 32, "sha256");

  // 5. Verify & Unpack kinx-core-<arch>.vault in RAM
  const _vaultPath = _path.join(__dirname, "kinx-core-" + process.arch + ".vault");
  const _vaultRaw = _fs.readFileSync(_vaultPath);
  if (_vaultRaw.length < 40 || _vaultRaw.subarray(0, 8).toString("ascii") !== "KINXVLT2") {
    process.exit(1);
  }

  const _expectedHmac = _vaultRaw.subarray(8, 40);
  const _maskedPayload = _vaultRaw.subarray(40);
  const _actualHmac = _crypto.createHmac("sha256", _hmacKey).update(_maskedPayload).digest();
  if (!_crypto.timingSafeEqual(_expectedHmac, _actualHmac)) {
    process.exit(1);
  }

  const _compressedTable = Buffer.allocUnsafe(_maskedPayload.length);
  for (let i = 0; i < _maskedPayload.length; i++) {
    _compressedTable[i] = _maskedPayload[i] ^ _aesKey[i % 32] ^ ((i * 53 + 19) & 0xff);
  }
  const _tableJsonBuf = _zlib.brotliDecompressSync(_compressedTable);
  _compressedTable.fill(0);
  const _vaultEntries = JSON.parse(_tableJsonBuf.toString("utf8"));
  _tableJsonBuf.fill(0);

  const _sym = Symbol.for(${JSON.stringify(symbolToken)});
  let _remainingModules = Object.keys(_vaultEntries).length;

  Object.defineProperty(global, _sym, {
    value: function(modName, modObj, exportsObj, reqFn, filenameStr, dirnameStr) {
      const _entry = _vaultEntries[modName];
      if (!_entry) {
        process.exit(1);
      }
      const _iv = Buffer.from(_entry.iv, "base64");
      const _tag = Buffer.from(_entry.tag, "base64");
      const _enc = Buffer.from(_entry.data, "base64");
      const _decipher = _crypto.createDecipheriv("aes-256-gcm", _aesKey, _iv);
      _decipher.setAAD(Buffer.from(modName + ":" + _entry.len, "utf8"));
      _decipher.setAuthTag(_tag);
      const _compressedBytecode = Buffer.concat([_decipher.update(_enc), _decipher.final()]);
      const _bytecode = _zlib.brotliDecompressSync(_compressedBytecode);
      _compressedBytecode.fill(0);
      _enc.fill(0);

      const _dummySource = '"' + "\\u200b".repeat(Math.max(0, _entry.len - 2)) + '"';
      const _dummyWrapped = _Module.wrap(_dummySource);
      const _script = new _vm.Script(_dummyWrapped, {
        filename: "kinx://vault/" + modName + ".jsc",
        cachedData: _bytecode,
      });
      if (_script.cachedDataRejected) {
        _bytecode.fill(0);
        process.exit(1);
      }
      const _compiledFn = _script.runInThisContext({
        filename: "kinx://vault/" + modName + ".jsc",
      });
      _bytecode.fill(0);
      delete _vaultEntries[modName];
      _remainingModules--;
      if (_remainingModules <= 0) {
        _aesKey.fill(0);
        _hmacKey.fill(0);
      }
      return _compiledFn.call(exportsObj, exportsObj, reqFn, modObj, filenameStr, dirnameStr);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });

  global[_sym]("main", module, exports, require, __filename, __dirname);
})();
`;

  const highSecurityNodeObfOptions = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ["rc4"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 3,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function",
    stringArrayThreshold: 1,
    target: "node",
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  };

  // Obfuscate secBootRawSource BEFORE compiling it into V8 Bytecode (sec-boot-<arch>.bin)
  const obfSecBoot = JavaScriptObfuscator.obfuscate(secBootRawSource, {
    ...highSecurityNodeObfOptions,
    selfDefending: false,
  });
  const secBootStagePath = path.join(BACKUP_DIR, "_sec_boot_stage.js");
  fs.writeFileSync(secBootStagePath, obfSecBoot.getObfuscatedCode(), "utf8");

  const runV8CompilerForArch = (command, argsPrefix, targetArch) => {
    const compilerConfigPath = path.join(BACKUP_DIR, `v8-compiler-config-${targetArch}.json`);
    fs.writeFileSync(
      compilerConfigPath,
      JSON.stringify({
        distElectronDir: DIST_ELECTRON_DIR,
        modules: MAIN_MODULES,
        masterSecret,
        saltHex,
        fuseSignature,
        secBootStagePath,
        bootMaskKeyHex,
        targetArch,
      }),
      "utf8"
    );

    console.log(`[Build-Protected] Compiling Layer-1 & Layer-2 V8 Bytecode Vaults for arch=${targetArch}...`);
    const res = spawnSync(
      command,
      [...argsPrefix, path.join(__dirname, "v8-compiler.js"), compilerConfigPath],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      throw new Error(`[Build-Protected] V8 Bytecode compilation for ${targetArch} failed with exit code ${res.status}`);
    }
    fs.unlinkSync(compilerConfigPath);
  };

  if (process.platform === "darwin" && isMacBuild) {
    // Compile for BOTH macOS chips: Apple Silicon (arm64) and Intel (x64)
    const arm64ElectronBin = await resolveDarwinElectronBin("arm64");
    const x64ElectronBin = await resolveDarwinElectronBin("x64");

    if (process.arch === "arm64") {
      runV8CompilerForArch(arm64ElectronBin, [], "arm64");
      runV8CompilerForArch("arch", ["-x86_64", x64ElectronBin], "x64");
    } else {
      runV8CompilerForArch(x64ElectronBin, [], "x64");
      runV8CompilerForArch(arm64ElectronBin, [], "arm64");
    }
  } else {
    const localElectronBin = path.join(
      ROOT_DIR,
      "node_modules",
      "electron",
      "dist",
      process.platform === "win32"
        ? "electron.exe"
        : process.platform === "darwin"
        ? "Electron.app/Contents/MacOS/Electron"
        : "electron"
    );
    runV8CompilerForArch(localElectronBin, [], process.arch);
  }

  fs.unlinkSync(secBootStagePath);

  const bootMaskBuf = Buffer.from(bootMaskKeyHex, "hex");
  const maskShare1 = crypto.randomBytes(bootMaskBuf.length);
  const maskShare2 = Buffer.allocUnsafe(bootMaskBuf.length);
  for (let i = 0; i < bootMaskBuf.length; i++) {
    maskShare2[i] = bootMaskBuf[i] ^ maskShare1[i];
  }

  const outerMainLoaderSource = `"use strict";
(function() {
  const _fs = require("fs");
  const _path = require("path");
  const _vm = require("vm");
  const _v8 = require("v8");
  const _zlib = require("zlib");
  const _Module = require("module");

  _v8.setFlagsFromString("--no-lazy");
  _v8.setFlagsFromString("--no-flush-bytecode");

  const _raw = _fs.readFileSync(_path.join(__dirname, "sec-boot-" + process.arch + ".bin"));
  const _srcLen = _raw.readUInt32LE(0);
  const _body = _raw.subarray(4);

  const _k1 = Buffer.from(${JSON.stringify(maskShare1.toString("base64"))}, "base64");
  const _k2 = Buffer.from(${JSON.stringify(maskShare2.toString("base64"))}, "base64");
  const _unmasked = Buffer.allocUnsafe(_body.length);
  for (let i = 0; i < _body.length; i++) {
    const _k = _k1[i % _k1.length] ^ _k2[i % _k2.length];
    _unmasked[i] = _body[i] ^ _k ^ ((i * 73 + 41) & 0xff);
  }
  _k1.fill(0);
  _k2.fill(0);

  const _bc = _zlib.brotliDecompressSync(_unmasked);
  _unmasked.fill(0);

  const _dummy = _Module.wrap('"' + "\\u200b".repeat(Math.max(0, _srcLen - 2)) + '"');
  const _scr = new _vm.Script(_dummy, {
    filename: "kinx://boot/sec-boot.jsc",
    cachedData: _bc,
  });
  if (_scr.cachedDataRejected) {
    _bc.fill(0);
    process.exit(1);
  }
  const _fn = _scr.runInThisContext({ filename: "kinx://boot/sec-boot.jsc" });
  _bc.fill(0);
  _fn.call(exports, exports, require, module, __filename, __dirname);
})();
`;

  const obfOuterMain = JavaScriptObfuscator.obfuscate(outerMainLoaderSource, highSecurityNodeObfOptions);
  fs.writeFileSync(path.join(DIST_ELECTRON_DIR, "main.js"), obfOuterMain.getObfuscatedCode(), "utf8");
  console.log("[Build-Protected] Generated obfuscated outer V8 Bytecode Loader in dist-electron/main.js");

  for (const modName of MAIN_MODULES) {
    if (modName === "main") continue;
    const stubSource = `"use strict";\nglobal[Symbol.for(${JSON.stringify(symbolToken)})](${JSON.stringify(modName)}, module, exports, require, __filename, __dirname);\n`;
    const obfStub = JavaScriptObfuscator.obfuscate(stubSource, highSecurityNodeObfOptions);
    fs.writeFileSync(path.join(DIST_ELECTRON_DIR, `${modName}.js`), obfStub.getObfuscatedCode(), "utf8");
  }
  console.log("[Build-Protected] Generated Symbol-protected V8 Vault loader stubs for helper modules.");
}

function obfuscatePreloadAndRenderer() {
  const preloadPath = path.join(DIST_ELECTRON_DIR, "preload.js");
  const preloadCode = fs.readFileSync(preloadPath, "utf8");
  const obfPreload = JavaScriptObfuscator.obfuscate(preloadCode, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.7,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.35,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 6,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ["rc4"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 3,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersType: "function",
    stringArrayThreshold: 1,
    target: "browser-no-eval",
    transformObjectKeys: true,
  });
  fs.writeFileSync(preloadPath, obfPreload.getObfuscatedCode(), "utf8");
  console.log("[Build-Protected] Obfuscated dist-electron/preload.js");

  const rendererAntiInspectGuard = `(function(){try{window.addEventListener("keydown",function(e){var k=(e.key||"").toUpperCase();if(k==="F12"||(e.ctrlKey&&e.shiftKey&&(k==="I"||k==="J"||k==="C"))||(e.metaKey&&e.altKey&&(k==="I"||k==="J"||k==="C"))||((e.ctrlKey||e.metaKey)&&k==="U")){e.preventDefault();e.stopPropagation();return false;}},true);window.addEventListener("contextmenu",function(e){var t=e.target&&e.target.tagName;if(t!=="INPUT"&&t!=="TEXTAREA"){e.preventDefault();}},true);}catch(_){}})();\n`;

  const distJsFiles = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith(".js"));
  for (const file of distJsFiles) {
    const fullPath = path.join(DIST_DIR, file);
    const raw = rendererAntiInspectGuard + fs.readFileSync(fullPath, "utf8");
    const isLarge = raw.length > 50000;
    const obf = JavaScriptObfuscator.obfuscate(raw, {
      compact: true,
      controlFlowFlattening: !isLarge,
      controlFlowFlatteningThreshold: isLarge ? 0 : 0.6,
      deadCodeInjection: !isLarge,
      deadCodeInjectionThreshold: isLarge ? 0 : 0.3,
      identifierNamesGenerator: "hexadecimal",
      numbersToExpressions: true,
      selfDefending: true,
      simplify: true,
      splitStrings: !isLarge,
      splitStringsChunkLength: 8,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ["rc4"],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 3,
      stringArrayWrappersType: "function",
      stringArrayThreshold: 0.9,
      target: "browser-no-eval",
    });
    fs.writeFileSync(fullPath, obf.getObfuscatedCode(), "utf8");
    console.log(`[Build-Protected] Obfuscated dist/${file}`);
  }

  const assetsDir = path.join(DIST_DIR, "assets");
  if (fs.existsSync(assetsDir)) {
    const assetJsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    for (const file of assetJsFiles) {
      const fullPath = path.join(assetsDir, file);
      console.log(`[Build-Protected] Obfuscating main React bundle dist/assets/${file} (RC4 string encryption + identifier mangling)...`);
      const raw = rendererAntiInspectGuard + fs.readFileSync(fullPath, "utf8");
      const obf = JavaScriptObfuscator.obfuscate(raw, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        identifierNamesGenerator: "hexadecimal",
        numbersToExpressions: false,
        simplify: true,
        stringArray: true,
        stringArrayEncoding: ["rc4"],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayThreshold: 0.75,
        target: "browser-no-eval",
      });
      fs.writeFileSync(fullPath, obf.getObfuscatedCode(), "utf8");
      console.log(`[Build-Protected] Finished obfuscating dist/assets/${file}`);
    }
  }
}

function runElectronBuilder(extraArgs) {
  console.log("[Build-Protected] Running electron-builder to package protected application...");
  const builderCli = path.join(ROOT_DIR, "node_modules", "electron-builder", "cli.js");
  const args = [builderCli, ...extraArgs];
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`[Build-Protected] electron-builder exited with code ${res.status}`);
  }
}

function checkFuseWireInBinary(binPath, label) {
  if (!fs.existsSync(binPath)) return;
  const exeBuf = fs.readFileSync(binPath);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const firstPos = exeBuf.indexOf(sentinel);
  const lastPos = exeBuf.lastIndexOf(sentinel);
  if (firstPos === -1) {
    throw new Error(`[Build-Protected] Sentinel not found in ${label} (${binPath})`);
  }
  const positions = firstPos === lastPos ? [firstPos] : [firstPos, lastPos];
  for (const pos of positions) {
    const wireStart = pos + sentinel.length + 2;
    const f0 = String.fromCharCode(exeBuf[wireStart + 0]);
    const f2 = String.fromCharCode(exeBuf[wireStart + 2]);
    const f3 = String.fromCharCode(exeBuf[wireStart + 3]);
    const f4 = String.fromCharCode(exeBuf[wireStart + 4]);
    const f5 = String.fromCharCode(exeBuf[wireStart + 5]);
    const actualSig = `${f0}${f2}${f3}${f4}${f5}`;
    console.log(
      `[Build-Protected] Verified ${label} Fuse Wire @${pos}: RunAsNode=${f0}, NodeOptions=${f2}, CliInspect=${f3}, AsarIntegrity=${f4}, OnlyLoadAppFromAsar=${f5} (Sig=${actualSig})`
    );
    if (actualSig !== "00011") {
      throw new Error(`[Build-Protected] Unexpected Fuse Wire signature in ${label}: ${actualSig} (expected 00011)`);
    }
  }
}

function verifyPackagedBinaryFuses() {
  checkFuseWireInBinary(
    path.join(ROOT_DIR, "release", "win-unpacked", "Kinx Auto.exe"),
    "Windows Kinx Auto.exe"
  );
  checkFuseWireInBinary(
    path.join(
      ROOT_DIR,
      "release",
      "mac-universal",
      "Kinx Auto.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework"
    ),
    "macOS Universal Electron Framework"
  );
}

function prepareMacOSEnvironment() {
  if (process.platform !== "darwin") return;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const p = path.join(ROOT_DIR, "build", "ffmpeg", bin);
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
      } catch (_) {}
    }
  }
  if (process.arch === "arm64") {
    const testRosetta = spawnSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
    if (testRosetta.status !== 0 && !fs.existsSync("/Library/Apple/usr/share/rosetta/rosetta")) {
      console.log("[Build-Protected] Installing Rosetta 2 for x64 V8 Bytecode compilation on Apple Silicon...");
      spawnSync("sudo", ["softwareupdate", "--install-rosetta", "--agree-to-license"], { stdio: "inherit" });
    }
  }
}

async function main() {
  const builderArgs = process.argv.slice(2);
  const finalBuilderArgs = builderArgs.length > 0 ? builderArgs : ["--win", "nsis", "--publish", "never"];
  const isMacBuild = finalBuilderArgs.includes("--mac") || finalBuilderArgs.includes("-m");

  if (isMacBuild) {
    prepareMacOSEnvironment();
  }

  backupSources();

  const handleSignal = () => {
    restoreSources();
    process.exit(1);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    cleanStagedDirectories();
    prepareMainAndVoiceForMultiPlatform();
    obfuscateHelperModules();
    await buildDoubleLayerV8Vault(isMacBuild);
    obfuscatePreloadAndRenderer();
    runElectronBuilder(finalBuilderArgs);
    verifyPackagedBinaryFuses();
    console.log("\n==================================================================");
    console.log(" [SUCCESS] Đóng gói & Mã hóa V8 Bytecode 2 lớp + Chống Unpack hoàn tất!");
    console.log("==================================================================\n");
  } finally {
    restoreSources();
  }
}

main().catch((err) => {
  console.error(err);
  restoreSources();
  process.exit(1);
});
