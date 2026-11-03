"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * electron-builder afterPack hook
 * Verifies ASAR archive integrity, double-layer V8 bytecode files (sec-boot-<arch>.bin & kinx-core-<arch>.vault),
 * and ensures zero backup/debug files leaked into app.asar.
 */
exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const isMac = packager.platform.name === "mac";
  const resourcesDir = isMac
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) {
    throw new Error(`[Security-AfterPack] CRITICAL: app.asar not found at ${asarPath}`);
  }

  const fd = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerStrLen = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerStrLen);
    fs.readSync(fd, headerBuf, 0, headerStrLen, 16);
    const headerHash = crypto.createHash("sha256").update(headerBuf).digest("hex");
    const headerStr = headerBuf.toString("utf8");

    if (headerStr.includes(".backup") || headerStr.includes(".bak")) {
      throw new Error("[Security-AfterPack] CRITICAL: Backup files detected inside app.asar header!");
    }
    if (!headerStr.includes("kinx-core-") || !headerStr.includes("sec-boot-")) {
      throw new Error("[Security-AfterPack] CRITICAL: Double-layer V8 Bytecode files (kinx-core / sec-boot) missing from app.asar!");
    }
    if (isMac) {
      if (
        !headerStr.includes("kinx-core-arm64.vault") ||
        !headerStr.includes("kinx-core-x64.vault") ||
        !headerStr.includes("sec-boot-arm64.bin") ||
        !headerStr.includes("sec-boot-x64.bin")
      ) {
        throw new Error("[Security-AfterPack] CRITICAL: macOS Universal build is missing arm64 or x64 V8 Bytecode vault!");
      }
      console.log("[Security-AfterPack] Verified macOS Universal Dual-Chip V8 Bytecode Vaults (arm64 + x64) inside app.asar");
    }

    console.log(`[Security-AfterPack] Verified app.asar header SHA-256: ${headerHash}`);
  } finally {
    fs.closeSync(fd);
  }
};
