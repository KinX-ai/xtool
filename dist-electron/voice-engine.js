/**
 * Voice Engine — Edge TTS (direct WebSocket implementation)
 *
 * Uses the Microsoft Edge Read Aloud TTS service directly via WebSocket,
 * bypassing edge-tts-node which is missing the required Cookie:muid header
 * and uses an outdated Chromium version that causes 403 errors.
 *
 * Voices: 322+ Microsoft Neural voices
 * Protocol: Same as Python edge-tts (rany2/edge-tts v7.2.7)
 *
 * Long text is automatically split into chunks (~3000 chars each),
 * generated concurrently (max 3 at a time), then concatenated with ffmpeg.
 */
const { app, ipcMain, dialog, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const { pipeline } = require("stream");

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = "2-" + CHROMIUM_FULL_VERSION;
const WIN_EPOCH = 11644473600;

// Clock skew correction (in seconds) adjusted automatically from Bing server Date header
let clockSkewSeconds = 0;

const SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA256_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA256_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0],
  [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5],
  [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3],
  [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1],
  [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;

function rol16(value) {
  value >>>= 0;
  return (((value << 16) | (value >>> 16)) >>> 0);
}

function wordsLe4Even(buf) {
  const rem = buf.length % 4;
  const padded = rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
  if (!padded.length) return [];
  const words = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(padded.readUInt32LE(i));
  }
  if (words.length % 2 !== 0) words.push(0);
  return words;
}

function sigma0(value) {
  value >>>= 0;
  return (((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3)) >>> 0);
}

function sigma1(value) {
  value >>>= 0;
  return (((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10)) >>> 0);
}

function bigSigma1(e) {
  e >>>= 0;
  return ((((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0);
}

function bigSigma0(a) {
  a >>>= 0;
  return ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0);
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index++) {
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t1 = (h + bigSigma1(e) + ch + constants[index] + words[index]) >>> 0;
    const t2 = (bigSigma0(a) + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words, firstWord = 16) {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2];
    const y = words[index - 15];
    words.push((sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]) >>> 0);
  }
}

function sha256Init(data7) {
  const words = new Array(14).fill(0);
  words.push(((data7[0] << 16) | (data7[1] << 8) | data7[2]) >>> 0);
  words.push(data7.readUInt32BE(3));
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value = (value + (index === 16 ? ((sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0) : sigma1(words[index - 2]))) >>> 0;
    }
    if (index - 7 >= 14) {
      value = (value + words[index - 7]) >>> 0;
    }
    if (index - 15 >= 14) {
      value = (value + (index === 29 ? ((sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0) : sigma0(words[index - 15]))) >>> 0;
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function sha256DigestCustom(data) {
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const padZeroLen = (((55 - length) % 64) + 64) % 64;
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(BigInt(length) * 8n, 0);
  const padded = Buffer.concat([tail, Buffer.from([0x80]), Buffer.alloc(padZeroLen), lenBuf]);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 64; i += 4) {
      words.push(padded.readUInt32BE(offset + i));
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) {
    out.writeUInt32BE(state[i], i * 4);
  }
  return out;
}

function cs64Digest(data, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ];
  const terms = CS64_COEFFICIENTS.map(([coeff], idx) => Math.imul(coeff, factors[idx % 2]) >>> 0);
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off >>> 0);
  const dataWords = wordsLe4Even(Buffer.concat([Buffer.from([0x00]), data]));
  for (let index = 0; index < dataWords.length; index++) {
    const word = dataWords[index];
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0;
    if (index === 0) {
      term = (term + (Math.imul(CS64_ADJUSTMENT0, factors[0]) >>> 0)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index], y = terms[index + 1];
    let t = rol16((offsets[index] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[index + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(rol16(state), 0x257E1D83) >>> 0;
    acc = (acc + state) >>> 0;
    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xA27416F5) >>> 0;
    t = Math.imul(rol16(t), 0xD38396FF) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const outBuf = Buffer.alloc(8);
  outBuf.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  outBuf.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return outBuf.toString("hex").toUpperCase();
}

// FFmpeg path — dev: build/ffmpeg/ffmpeg.exe, production: same dir as the main exe
const ffmpeg = require("fluent-ffmpeg");
if (app.isPackaged) {
  // Production — extraFiles "to": "." puts ffmpeg.exe next to the main exe
  ffmpeg.setFfmpegPath(path.join(path.dirname(app.getPath("exe")), "ffmpeg.exe"));
} else {
  // Development — inside build/ffmpeg/
  ffmpeg.setFfmpegPath(path.join(__dirname, "..", "build", "ffmpeg", "ffmpeg.exe"));
}

const MAX_CHUNK_LENGTH = 3000;     // characters per TTS chunk
const MAX_CONCURRENT_CHUNKS = 1;    // process chunks serially to avoid Edge TTS throttling
const CHUNK_TIMEOUT = 120000;       // 120s per chunk (Edge TTS can be slow sometimes)
const MAX_CHUNK_RETRIES = 2;        // retry failed chunks up to 2 times

const VOICE_LIST_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

function generateSecMsGecToken() {
  const nowSec = Math.floor(Date.now() / 1000 + clockSkewSeconds) + WIN_EPOCH;
  const roundedSec = nowSec - (nowSec % 300);
  const ticks = BigInt(roundedSec) * 10000000n;
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = sha256DigestCustom(data);
  const cs64 = cs64Digest(data, digest);
  return `${cs64}-${digest.toString("hex").toUpperCase()}`;
}

function generateMUID() {
  return crypto.randomBytes(16).toString("hex").toUpperCase();
}

function getWssUrl() {
  const gec = generateSecMsGecToken();
  const connId = crypto.randomBytes(16).toString("hex");
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connId}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

function getWssHeaders() {
  const muid = generateMUID();
  return {
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `muid=${muid};`,
  };
}

function generateSSML(voiceName, text, options = {}) {
  const rate = options.rate || "+0%";
  const volume = options.volume || "+0%";
  const pitch = options.pitch || "+0Hz";
  const locale = voiceName.split("-").slice(0, 2).join("-");
  const escapedText = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'><voice name='${voiceName}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapedText}</prosody></voice></speak>`;
}

/**
 * Synthesize text to audio file using Edge TTS WebSocket.
 * Returns a Promise that resolves with the output file path.
 */
function synthesizeToFile(text, voiceName, outputFile, options = {}, _retriedSkew = false) {
  return new Promise((resolve, reject) => {
    const WebSocket = require("ws");
    const url = getWssUrl();
    const headers = getWssHeaders();
    const requestId = crypto.randomBytes(16).toString("hex");

    const ws = new WebSocket(url, { headers });
    const audioChunks = [];
    let connected = false;
    let turnActive = false;
    let skewRetryTriggered = false;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Edge TTS WebSocket timeout (120s)"));
    }, CHUNK_TIMEOUT);

    ws.on("unexpected-response", (req, res) => {
      clearTimeout(timeout);
      const serverDateStr = res && res.headers && res.headers.date;
      if (serverDateStr && !_retriedSkew) {
        const serverEpochSec = Date.parse(serverDateStr) / 1000;
        if (!isNaN(serverEpochSec)) {
          const clientEpochSec = Date.now() / 1000 + clockSkewSeconds;
          clockSkewSeconds += (serverEpochSec - clientEpochSec);
          skewRetryTriggered = true;
          try { res.resume(); } catch (_) {}
          try { ws.close(); } catch (_) {}
          synthesizeToFile(text, voiceName, outputFile, options, true).then(resolve, reject);
          return;
        }
      }
      try { res.resume(); } catch (_) {}
      reject(new Error(`Edge TTS WebSocket error: Unexpected server response: ${res ? res.statusCode : "unknown"}`));
    });

    ws.onopen = () => {
      connected = true;
      // Send speech config
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n
{
  "context": {
    "synthesis": {
      "audio": {
        "metadataoptions": {
          "sentenceBoundaryEnabled": "false",
          "wordBoundaryEnabled": "false"
        },
        "outputFormat": "audio-24khz-48kbitrate-mono-mp3"
      }
    }
  }
}`;
      ws.send(configMsg);

      // Send SSML
      const ssml = generateSSML(voiceName, text, options);
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    };

    ws.onmessage = (msg) => {
      const data = msg.data;

      if (Buffer.isBuffer(data)) {
        // Binary message — contains audio data
        const headerLength = data.readUInt16BE(0);
        if (headerLength > data.length) return;
        const audioData = data.subarray(headerLength + 2);
        if (audioData.length > 0) {
          audioChunks.push(audioData);
        }
      } else if (typeof data === "string") {
        // Text message — turn.start, turn.end, etc.
        if (data.includes("Path:turn.start")) {
          turnActive = true;
        } else if (data.includes("Path:turn.end")) {
          turnActive = false;
          // Turn complete — write audio to file
          clearTimeout(timeout);
          ws.close();
          try {
            const combined = Buffer.concat(audioChunks);
            if (combined.length === 0) {
              reject(new Error("No audio data received from Edge TTS"));
              return;
            }
            fs.writeFileSync(outputFile, combined);
            const stats = fs.statSync(outputFile);
            resolve({ filePath: outputFile, fileSize: stats.size });
          } catch (e) {
            reject(e);
          }
        }
      }
    };

    ws.onerror = (err) => {
      if (skewRetryTriggered) return;
      clearTimeout(timeout);
      const msg = err.message || JSON.stringify(err) || "Unknown WebSocket error";
      reject(new Error(`Edge TTS WebSocket error: ${msg}`));
    };

    ws.onclose = () => {
      if (skewRetryTriggered) return;
      if (connected && audioChunks.length > 0 && !turnActive) {
        // Connection closed cleanly with audio data — try to recover
        clearTimeout(timeout);
        try {
          const combined = Buffer.concat(audioChunks);
          if (combined.length > 0 && !fs.existsSync(outputFile)) {
            fs.writeFileSync(outputFile, combined);
            const stats = fs.statSync(outputFile);
            resolve({ filePath: outputFile, fileSize: stats.size });
            return;
          }
        } catch (e) {
          // ignore, fall through to reject below
        }
      }
      // If we reach here, we couldn't recover — let the timeout handle rejection,
      // but if timeout already fired and was cleared, reject now.
      if (!turnActive) {
        clearTimeout(timeout);
        reject(new Error("Edge TTS WebSocket closed unexpectedly without completing"));
      }
    };
  });
}

/**
 * Split long text into smaller chunks, respecting sentence boundaries.
 * This prevents awkward mid-sentence cuts in the final audio.
 */
function splitText(text, maxLen = MAX_CHUNK_LENGTH) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    // If the remaining text fits in one chunk, take it all
    if (start + maxLen >= text.length) {
      chunks.push(text.substring(start));
      break;
    }

    // Find the last sentence boundary before maxLen
    const end = start + maxLen;
    let cut = text.lastIndexOf(". ", end);
    if (cut === -1 || cut < start) cut = text.lastIndexOf("! ", end);
    if (cut === -1 || cut < start) cut = text.lastIndexOf("?\n", end);
    if (cut === -1 || cut < start) cut = text.lastIndexOf(".\n", end);
    if (cut === -1 || cut < start) cut = text.lastIndexOf(".\r\n", end);
    if (cut === -1 || cut < start) cut = text.lastIndexOf("\n", end);
    // If no sentence boundary found, force split at maxLen
    if (cut === -1 || cut < start) cut = end;
    else cut += 1; // include the punctuation

    chunks.push(text.substring(start, cut).trim());
    start = cut;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Concatenate multiple MP3 files into one using fluent-ffmpeg concat demuxer.
 * This is nearly instantaneous since it only copies the raw audio frames (no re-encode).
 */
function concatAudioFiles(inputFiles, outputFile) {
  return new Promise((resolve, reject) => {
    // Create a temp list file for ffmpeg concat demuxer
    const listFile = outputFile.replace(/\.mp3$/, "") + "_list.txt";
    const escapedPaths = inputFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`);
    const listContent = escapedPaths.join("\n");
    fs.writeFileSync(listFile, listContent, "utf-8");

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy"])
      .on("end", () => {
        // Clean up the list file
        try { fs.unlinkSync(listFile); } catch (_) {}
        resolve(outputFile);
      })
      .on("error", (err) => {
        try { fs.unlinkSync(listFile); } catch (_) {}
        reject(new Error(`FFmpeg concat error: ${err.message}`));
      })
      .save(outputFile);
  });
}



/**
 * Process an array of items with a concurrency limit.
 * Each itemFn returns a Promise. At most `limit` promises run in parallel.
 */
async function runWithConcurrency(items, limit, itemFn) {
  const queue = [...items];
  const inFlight = new Set();

  while (queue.length > 0 || inFlight.size > 0) {
    // Fill up to the concurrency limit
    while (queue.length > 0 && inFlight.size < limit) {
      const item = queue.shift();
      const promise = itemFn(item).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }

    // Wait for at least one to finish
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }
}

class VoiceEngine {
  constructor() {
    this.outputDir = path.join(app.getPath("downloads"), "KinxVoice");
    this._ensureOutputDir();
    this._voicesCache = null;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  _ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Get all Edge TTS voices (322+ voices).
   * Uses HTTP GET (not WebSocket) — always works.
   */
  async getVoices() {
    if (this._voicesCache) return this._voicesCache;
    return new Promise((resolve) => {
      https.get(VOICE_LIST_URL, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const all = JSON.parse(body);
            this._voicesCache = all.filter((v) => v.Status === "GA");
            console.log(`[Voice] Loaded ${this._voicesCache.length} Edge TTS voices`);
            resolve(this._voicesCache);
          } catch (e) {
            console.error("[Voice] Failed to parse voices:", e.message);
            resolve([]);
          }
        });
      }).on("error", (e) => {
        console.error("[Voice] Failed to fetch voices:", e.message);
        resolve([]);
      });
    });
  }

  /**
   * Preview text (max 200 chars)
   */
  async preview(text, voiceShortName, options = {}) {
    const safeText = (text || "").substring(0, 200);
    if (!safeText) return null;
    const tempFile = path.join(this.outputDir, `_preview_${Date.now()}.mp3`);
    try {
      const result = await synthesizeToFile(safeText, voiceShortName, tempFile, options);
      return result.filePath;
    } catch (e) {
      console.error("[Voice] Preview error:", e.message);
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      return null;
    }
  }

  /**
   * Generate audio file from text using Edge TTS.
   * Long text is automatically split into chunks, generated separately
   * (max 3 concurrent), then concatenated with ffmpeg for speed and reliability.
   */
  async generate(text, voiceShortName, options = {}) {
    this.stopped = false;
    if (!text || !text.trim()) throw new Error("Text is empty");

    const chunks = splitText(text.trim());
    const fileName = `voice_${Date.now()}.mp3`;
    const outputFile = path.join(this.outputDir, fileName);

    // Single chunk: simple path (no ffmpeg overhead)
    if (chunks.length === 1) {
      try {
        const result = await synthesizeToFile(chunks[0], voiceShortName, outputFile, options);
        return {
          success: true,
          filePath: result.filePath,
          fileName: fileName,
          fileSize: result.fileSize,
          totalChunks: 1,
        };
      } catch (e) {
        console.error("[Voice] Generate error:", e.message);
        try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (_) {}
        throw new Error("TTS Error: " + e.message);
      }
    }

    // --- Multiple chunks: generate each, then concat ---
    console.log(`[Voice] Splitting text into ${chunks.length} chunks (~${MAX_CHUNK_LENGTH} chars each)`);

    const tempDir = path.join(this.outputDir, "_temp_" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    const tempFiles = [];
    let completedChunks = 0;
    const totalChunks = chunks.length;

    try {
      // Generate all chunks with concurrency limit + retry
      const chunkItems = chunks.map((chunkText, idx) => ({ idx, chunkText }));
      await runWithConcurrency(chunkItems, MAX_CONCURRENT_CHUNKS, async ({ idx, chunkText }) => {
        if (this.stopped) throw new Error("Stopped by user");
        const tempFile = path.join(tempDir, `chunk_${String(idx).padStart(4, "0")}.mp3`);
        tempFiles[idx] = tempFile;

        // Retry loop for robustness
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
          try {
            await synthesizeToFile(chunkText, voiceShortName, tempFile, options);
            lastError = null; // success
            break;
          } catch (e) {
            lastError = e;
            if (attempt < MAX_CHUNK_RETRIES) {
              console.log(`[Voice] Chunk ${idx + 1}/${totalChunks} failed (attempt ${attempt + 1}/${MAX_CHUNK_RETRIES + 1}), retrying in 2s...`);
              await new Promise((r) => setTimeout(r, 2000));
              // Clean up partial file before retry
              try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
            }
          }
        }
        if (lastError) {
          throw new Error(`Chunk ${idx + 1}/${totalChunks} failed after ${MAX_CHUNK_RETRIES + 1} attempts: ${lastError.message}`);
        }

        completedChunks++;
        // Notify progress to all windows
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("tts:chunk-progress", {
              completed: completedChunks,
              total: totalChunks,
              text: `Đang tạo giọng nói (${completedChunks}/${totalChunks})...`,
            });
          }
        });
      });

      console.log(`[Voice] All ${totalChunks} chunks generated, concatenating with ffmpeg...`);

      // Notify concatenation phase
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("tts:chunk-progress", {
            completed: totalChunks,
            total: totalChunks,
            text: "Đang ghép các đoạn âm thanh...",
          });
        }
      });

      // Concatenate all chunks into final output
      await concatAudioFiles(tempFiles, outputFile);

      // Clean up temp files
      for (const f of tempFiles) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
      }
      try { fs.rmdirSync(tempDir); } catch (_) {}

      const stats = fs.statSync(outputFile);
      console.log(`[Voice] ✅ Concatenation complete: ${outputFile} (${stats.size} bytes)`);

      return {
        success: true,
        filePath: outputFile,
        fileName: fileName,
        fileSize: stats.size,
        totalChunks: totalChunks,
      };
    } catch (e) {
      // Clean up on failure
      for (const f of tempFiles) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
      }
      try { if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch (_) {}
      try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (_) {}

      console.error("[Voice] Generate error (multi-chunk):", e.message);
      throw new Error("TTS Error: " + e.message);
    }
  }

  /**
   * Generate multiple texts as a batch with concurrency control.
   */
  async generateBatch(items, maxThreads = 3) {
    this.stopped = false;
    const results = [];
    let completed = 0;
    const total = items.length;

    await runWithConcurrency(items, maxThreads, async (item) => {
      if (this.stopped) return;
      try {
        const result = await this.generate(item.text, item.voiceCode, item.options || {});
        results.push({ id: item.id, ...result });
      } catch (e) {
        results.push({ id: item.id, success: false, error: e.message });
      }
      completed++;
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("tts:batch-progress", { completed, total });
        }
      });
    });

    return results;
  }



  async selectOutputDir() {
    const result = await dialog.showOpenDialog({
      title: "Chọn thư mục lưu audio",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: this.outputDir,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      this.outputDir = result.filePaths[0];
      this._ensureOutputDir();
      return this.outputDir;
    }
    return null;
  }

  getOutputDir() {
    return this.outputDir;
  }
}

let _sharedEngine = null;
function getVoiceEngine() {
  if (!_sharedEngine) _sharedEngine = new VoiceEngine();
  return _sharedEngine;
}

function registerVoiceIPC() {
  const engine = getVoiceEngine();

  ipcMain.handle("tts:get-voices", () => engine.getVoices());

  ipcMain.handle("tts:stop", () => {
    engine.stop();
    return { success: true };
  });

  ipcMain.handle("tts:generate", async (event, { text, voiceCode, options }) => {
    return await engine.generate(text, voiceCode, options);
  });

  ipcMain.handle("tts:preview", async (event, { text, voiceCode }) => {
    const filePath = await engine.preview(text, voiceCode);
    if (filePath) return { success: true, filePath };
    return { success: false, error: "Preview failed" };
  });

  ipcMain.handle("tts:generate-batch", async (event, { items, maxThreads }) => {
    return await engine.generateBatch(items, maxThreads);
  });

  ipcMain.handle("tts:set-output-dir", async () => {
    return await engine.selectOutputDir();
  });

  ipcMain.handle("tts:get-output-dir", () => engine.getOutputDir());

  ipcMain.handle("tts:open-output-dir", async () => {
    require("electron").shell.openPath(engine.getOutputDir());
    return engine.getOutputDir();
  });

  console.log("[Voice] ✅ Voice IPC handlers registered (Edge TTS — 322+ voices, auto-chunking for long text)");
}

module.exports = { registerVoiceIPC, VoiceEngine, getVoiceEngine };
