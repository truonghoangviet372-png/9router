import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

const IS_WINDOWS = os.platform() === "win32";
const BIN_DIR = path.join(DATA_DIR, "bin");
const LOCAL_BIN = path.join(BIN_DIR, IS_WINDOWS ? "xray.exe" : "xray");
const XRAY_RELEASE_BASE = "https://github.com/XTLS/Xray-core/releases";

let installPromise = null;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function envToBoolean(value, defaultValue) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function commandExists(command) {
  try {
    if (IS_WINDOWS) {
      execSync(`where ${command}`, { stdio: "ignore", windowsHide: true });
    } else {
      execSync(`command -v ${command}`, { stdio: "ignore", windowsHide: true });
    }
    return true;
  } catch {
    return false;
  }
}

function resolveSystemXrayPath() {
  try {
    const raw = IS_WINDOWS
      ? execSync("where xray", { encoding: "utf8", windowsHide: true })
      : execSync("command -v xray", { encoding: "utf8", windowsHide: true });
    const firstLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine || null;
  } catch {
    return null;
  }
}

function getAssetCandidates(platform, arch) {
  const map = {
    linux: {
      x64: ["Xray-linux-64.zip"],
      arm64: ["Xray-linux-arm64-v8a.zip", "Xray-linux-arm64.zip"],
      arm: ["Xray-linux-arm32-v7a.zip", "Xray-linux-arm32-v6.zip"],
    },
    darwin: {
      x64: ["Xray-macos-64.zip"],
      arm64: ["Xray-macos-arm64-v8a.zip", "Xray-macos-arm64.zip"],
    },
    win32: {
      x64: ["Xray-windows-64.zip"],
      ia32: ["Xray-windows-32.zip"],
      arm64: ["Xray-windows-arm64-v8a.zip", "Xray-windows-arm64.zip", "Xray-windows-64.zip"],
    },
  };

  const platformMap = map[platform];
  if (!platformMap) {
    throw new Error(`Unsupported platform for auto-install: ${platform}`);
  }

  const candidates = platformMap[arch] || platformMap.x64;
  if (!candidates || candidates.length === 0) {
    throw new Error(`Unsupported architecture for auto-install: ${platform}/${arch}`);
  }
  return candidates;
}

function resolveDownloadUrls() {
  const version = normalizeString(process.env.XRAY_VERSION) || "latest";
  const candidates = getAssetCandidates(os.platform(), os.arch());
  const prefix = version === "latest"
    ? `${XRAY_RELEASE_BASE}/latest/download`
    : `${XRAY_RELEASE_BASE}/download/${version}`;
  return candidates.map((assetName) => `${prefix}/${assetName}`);
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    const cleanup = (err) => {
      try { file.close(); } catch { }
      try { fs.unlinkSync(destination); } catch { }
      reject(err);
    };

    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirectUrl = response.headers.location;
        try { file.close(); } catch { }
        try { fs.unlinkSync(destination); } catch { }
        if (!redirectUrl) {
          reject(new Error(`Redirect without location for ${url}`));
          return;
        }
        downloadFile(redirectUrl, destination).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        cleanup(new Error(`Download failed (${response.statusCode}) for ${url}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destination)));
      file.on("error", cleanup);
    }).on("error", cleanup);
  });
}

function extractArchive(zipPath, extractDir) {
  ensureDir(extractDir);

  if (IS_WINDOWS) {
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: "pipe", windowsHide: true }
    );
    return;
  }

  if (commandExists("unzip")) {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe", windowsHide: true });
    return;
  }

  if (commandExists("python3")) {
    execSync(`python3 -m zipfile -e "${zipPath}" "${extractDir}"`, { stdio: "pipe", windowsHide: true });
    return;
  }

  if (commandExists("python")) {
    execSync(`python -m zipfile -e "${zipPath}" "${extractDir}"`, { stdio: "pipe", windowsHide: true });
    return;
  }

  throw new Error("No extractor found. Install unzip or python3 to extract xray archive.");
}

function findFileRecursive(rootDir, targetName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, targetName);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

function verifyXrayBinary(binaryPath) {
  if (!fs.existsSync(binaryPath)) return false;
  try {
    execSync(`"${binaryPath}" version`, { stdio: "pipe", windowsHide: true, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function installXrayBinary() {
  ensureDir(BIN_DIR);

  const installDir = path.join(DATA_DIR, "xray", "installer");
  ensureDir(installDir);

  const archivePath = path.join(installDir, `xray-${Date.now()}.zip`);
  const extractDir = path.join(installDir, `extract-${Date.now()}`);
  const urls = resolveDownloadUrls();

  let lastError = null;
  for (const url of urls) {
    try {
      await downloadFile(url, archivePath);
      extractArchive(archivePath, extractDir);

      const binaryName = IS_WINDOWS ? "xray.exe" : "xray";
      const extractedBinary = findFileRecursive(extractDir, binaryName);
      if (!extractedBinary) {
        throw new Error(`Cannot find ${binaryName} inside downloaded archive`);
      }

      fs.copyFileSync(extractedBinary, LOCAL_BIN);
      if (!IS_WINDOWS) fs.chmodSync(LOCAL_BIN, "755");

      if (!verifyXrayBinary(LOCAL_BIN)) {
        throw new Error("Downloaded xray binary failed verification");
      }

      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }
      try { fs.unlinkSync(archivePath); } catch { }

      return LOCAL_BIN;
    } catch (error) {
      lastError = error;
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }
      try { fs.unlinkSync(archivePath); } catch { }
    }
  }

  throw new Error(`Auto-install xray failed: ${lastError?.message || "unknown error"}`);
}

export function getPreferredXrayPath() {
  const envPath = normalizeString(process.env.XRAY_BIN);
  if (envPath) return envPath;

  const systemPath = resolveSystemXrayPath();
  if (systemPath) return systemPath;

  if (verifyXrayBinary(LOCAL_BIN)) return LOCAL_BIN;
  return null;
}

export async function ensureXrayBinary(options = {}) {
  const autoInstallEnabled = options?.autoInstall !== undefined
    ? options.autoInstall === true
    : envToBoolean(process.env.XRAY_AUTO_INSTALL, true);

  const envPath = normalizeString(process.env.XRAY_BIN);
  if (envPath) {
    if (!verifyXrayBinary(envPath)) {
      throw new Error(`XRAY_BIN is set but not usable: ${envPath}`);
    }
    return envPath;
  }

  const systemPath = resolveSystemXrayPath();
  if (systemPath && verifyXrayBinary(systemPath)) return systemPath;

  if (verifyXrayBinary(LOCAL_BIN)) return LOCAL_BIN;

  if (!autoInstallEnabled) {
    throw new Error("xray is not installed and XRAY_AUTO_INSTALL=false");
  }

  if (!installPromise) {
    installPromise = installXrayBinary().finally(() => {
      installPromise = null;
    });
  }

  return installPromise;
}
