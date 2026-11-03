"use strict";
/**
 * Double-Layer V8 Bytecode Compiler & AES-256-GCM Vault Builder (Multi-Arch: x64 & arm64)
 *
 * Layer A: Compiles all Main Process modules into V8 Bytecode (.jsc), compresses with Brotli (q=11),
 *          and encrypts each module with AES-256-GCM + PBKDF2-HMAC-SHA512 + HMAC-SHA256 into `kinx-core-<arch>.vault`.
 * Layer B: Compiles the obfuscated Security Bootstrapper & Vault Decryptor (`_sec_boot_stage.js`)
 *          ITSELF into Native V8 Bytecode (`sec-boot-<arch>.bin`), so NO key derivation or decryption logic
 *          exists in readable or deobfuscatable JavaScript anywhere in `app.asar`.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const v8 = require("v8");
const zlib = require("zlib");
const crypto = require("crypto");
const Module = require("module");

v8.setFlagsFromString("--no-lazy");
v8.setFlagsFromString("--no-flush-bytecode");

function compileSourceToV8Bytecode(rawCode, virtualFilename) {
  const cleanCode = rawCode.replace(/^#!.*/, "");
  const wrappedCode = Module.wrap(cleanCode);

  const script = new vm.Script(wrappedCode, {
    filename: virtualFilename,
    produceCachedData: true,
  });

  const bytecode = script.createCachedData();
  if (!bytecode || bytecode.length === 0) {
    throw new Error(`[V8-Compiler] Failed to produce V8 bytecode for ${virtualFilename}`);
  }

  const dummySource = '"' + "\u200b".repeat(Math.max(0, cleanCode.length - 2)) + '"';
  const dummyWrapped = Module.wrap(dummySource);
  if (dummyWrapped.length !== wrappedCode.length) {
    throw new Error(`[V8-Compiler] Length mismatch for ${virtualFilename}`);
  }

  const verifyScript = new vm.Script(dummyWrapped, {
    filename: virtualFilename,
    cachedData: bytecode,
  });

  if (verifyScript.cachedDataRejected) {
    throw new Error(`[V8-Compiler] V8 rejected cachedData during verification for ${virtualFilename}`);
  }

  return { bytecode, sourceLength: cleanCode.length };
}

const configPath = process.argv[2];
if (!configPath || !fs.existsSync(configPath)) {
  console.error("[V8-Compiler] Missing config path");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const {
  distElectronDir,
  modules,
  masterSecret,
  saltHex,
  fuseSignature,
  secBootStagePath,
  bootMaskKeyHex,
  targetArch,
} = config;

const archTag = targetArch || process.arch;
console.log(`[V8-Compiler] Running in V8=${process.versions.v8}, platform=${process.platform}, arch=${process.arch} (target=${archTag})`);

// 1. Compile & Encrypt inner application modules into kinx-core-<arch>.vault
const salt = Buffer.from(saltHex, "hex");
const v8Tag = String(process.versions.v8 || "").split(".")[0];
const keyMaterial = `${masterSecret}|${fuseSignature}|v8:${v8Tag}`;
const aesKey = crypto.pbkdf2Sync(keyMaterial, salt, 25000, 32, "sha512");
const hmacKey = crypto.pbkdf2Sync(keyMaterial + "|hmac", salt, 15000, 32, "sha256");

const vaultEntries = {};

for (const modName of modules) {
  const filePath = path.join(distElectronDir, `${modName}.js`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`[V8-Compiler] Module file not found: ${filePath}`);
  }

  const rawCode = fs.readFileSync(filePath, "utf8");
  const { bytecode, sourceLength } = compileSourceToV8Bytecode(rawCode, `kinx://vault/${modName}.jsc`);

  const compressed = zlib.brotliCompressSync(bytecode, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(Buffer.from(`${modName}:${sourceLength}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  vaultEntries[modName] = {
    len: sourceLength,
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    data: encrypted.toString("base64"),
  };

  console.log(
    `[V8-Compiler:${archTag}] [Layer-1] Compiled & Encrypted ${modName}.js -> V8 Bytecode (${bytecode.length} B) -> AES-256-GCM (${encrypted.length} B)`
  );
}

const payloadJson = Buffer.from(JSON.stringify(vaultEntries), "utf8");
const payloadCompressed = zlib.brotliCompressSync(payloadJson, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});

const maskedPayload = Buffer.allocUnsafe(payloadCompressed.length);
for (let i = 0; i < payloadCompressed.length; i++) {
  maskedPayload[i] = payloadCompressed[i] ^ aesKey[i % 32] ^ ((i * 53 + 19) & 0xff);
}

const hmac = crypto.createHmac("sha256", hmacKey).update(maskedPayload).digest();
const magic = Buffer.from("KINXVLT2", "ascii");
const finalVaultBuffer = Buffer.concat([magic, hmac, maskedPayload]);

const vaultOutPath = path.join(distElectronDir, `kinx-core-${archTag}.vault`);
fs.writeFileSync(vaultOutPath, finalVaultBuffer);
console.log(`[V8-Compiler:${archTag}] [Layer-1] Wrote encrypted vault: ${vaultOutPath} (${finalVaultBuffer.length} bytes)`);

// 2. Compile the obfuscated Security Bootstrapper & Vault Decryptor ITSELF into Native V8 Bytecode (sec-boot-<arch>.bin)
if (secBootStagePath && fs.existsSync(secBootStagePath)) {
  const secBootCode = fs.readFileSync(secBootStagePath, "utf8");
  const { bytecode: bootBytecode, sourceLength: bootSourceLen } = compileSourceToV8Bytecode(
    secBootCode,
    "kinx://boot/sec-boot.jsc"
  );

  const compressedBoot = zlib.brotliCompressSync(bootBytecode, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });

  const bootMaskKey = Buffer.from(bootMaskKeyHex, "hex");
  const maskedBoot = Buffer.allocUnsafe(compressedBoot.length);
  for (let i = 0; i < compressedBoot.length; i++) {
    maskedBoot[i] = compressedBoot[i] ^ bootMaskKey[i % bootMaskKey.length] ^ ((i * 73 + 41) & 0xff);
  }

  // Header: 4 bytes uint32LE (bootSourceLen) + maskedBoot
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bootSourceLen, 0);
  const finalBootBin = Buffer.concat([header, maskedBoot]);

  const bootBinOutPath = path.join(distElectronDir, `sec-boot-${archTag}.bin`);
  fs.writeFileSync(bootBinOutPath, finalBootBin);
  console.log(
    `[V8-Compiler:${archTag}] [Layer-2] Compiled Vault Decryptor to V8 Bytecode: ${bootBinOutPath} (${finalBootBin.length} bytes, srcLen=${bootSourceLen})`
  );
}

process.exit(0);
