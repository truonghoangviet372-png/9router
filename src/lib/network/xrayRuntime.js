import fs from "fs";
import net from "net";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { ensureXrayBinary } from "@/lib/network/xrayInstaller";

const isCloud = typeof caches !== "undefined" && typeof caches === "object";
const XRAY_DIR = path.join(DATA_DIR, "xray");
const XRAY_CONFIG_DIR = path.join(XRAY_DIR, "configs");
const XRAY_LOG_PREFIX = "[XrayRuntime]";
const STARTUP_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 2000;

const manager = global.__xrayRuntimeManager ??= {
  runtimes: new Map(),
  locks: new Map(),
  cleanupRegistered: false,
};

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function computeConfigHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isChildRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

async function allocateLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address !== "object") {
          return reject(new Error("Failed to allocate local port"));
        }
        resolve(address.port);
      });
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortOpen(port, child, timeoutMs = STARTUP_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isChildRunning(child)) {
      throw new Error("Xray process exited unexpectedly while starting");
    }

    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const done = (ok) => {
        socket.removeAllListeners();
        try { socket.destroy(); } catch { }
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(600, () => done(false));
    });

    if (connected) return;
    await wait(120);
  }

  throw new Error("Timed out waiting for local Xray proxy to become ready");
}

function buildXrayConfig({ localPort, outbound }) {
  const proxyOutbound = {
    ...outbound,
    tag: "proxy",
  };

  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "local-http",
        listen: "127.0.0.1",
        port: localPort,
        protocol: "http",
        settings: {},
      },
    ],
    outbounds: [
      proxyOutbound,
      { tag: "direct", protocol: "freedom" },
      { tag: "block", protocol: "blackhole" },
    ],
  };

  return config;
}

async function startRuntime(poolId, runtimeInput) {
  ensureDir(XRAY_CONFIG_DIR);

  const port = await allocateLocalPort();
  const config = buildXrayConfig({
    localPort: port,
    outbound: runtimeInput.xrayOutbound,
  });

  const configPath = path.join(XRAY_CONFIG_DIR, `${poolId}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const stderrLines = [];
  const xrayBinary = await ensureXrayBinary();
  const child = spawn(xrayBinary, ["run", "-c", configPath], {
    cwd: XRAY_DIR,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      stderrLines.push(line);
      if (stderrLines.length > 12) stderrLines.shift();
    });
  }

  try {
    await waitForPortOpen(port, child);
  } catch (error) {
    try { child.kill("SIGTERM"); } catch { }
    const stderrText = stderrLines.join(" | ");
    const reason = stderrText ? `${error.message}: ${stderrText}` : error.message;
    throw new Error(reason);
  }

  return {
    child,
    port,
    configPath,
    configHash: runtimeInput.configHash,
    startedAt: new Date().toISOString(),
  };
}

async function stopRuntime(runtime) {
  if (!runtime) return;
  const child = runtime.child;
  if (!child) return;
  if (!isChildRunning(child)) return;

  await new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { }
      done();
    }, STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });

    try { child.kill("SIGTERM"); } catch { done(); }
  });
}

function withPoolLock(poolId, task) {
  const previous = manager.locks.get(poolId) || Promise.resolve();
  const next = previous.then(task, task);
  manager.locks.set(poolId, next);
  return next.finally(() => {
    if (manager.locks.get(poolId) === next) {
      manager.locks.delete(poolId);
    }
  });
}

function registerCleanupHandlers() {
  if (manager.cleanupRegistered) return;
  manager.cleanupRegistered = true;

  const cleanup = () => {
    for (const runtime of manager.runtimes.values()) {
      try {
        runtime.child?.kill?.("SIGTERM");
      } catch { }
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

export async function ensureXrayProxyPoolRuntime(proxyPool) {
  if (isCloud) {
    throw new Error("Xray proxy pools are not supported in cloud runtime");
  }

  const poolId = normalizeString(proxyPool?.id);
  if (!poolId) throw new Error("Missing proxy pool id for Xray runtime");

  const xrayOutbound = proxyPool?.xrayOutbound;
  if (!xrayOutbound || typeof xrayOutbound !== "object") {
    throw new Error("Invalid Xray config: xrayOutbound is required");
  }

  registerCleanupHandlers();

  const configHash = computeConfigHash({
    xrayOutbound,
  });

  return withPoolLock(poolId, async () => {
    const existing = manager.runtimes.get(poolId);
    if (existing && existing.configHash === configHash && isChildRunning(existing.child)) {
      return {
        proxyUrl: `http://127.0.0.1:${existing.port}`,
        port: existing.port,
        pid: existing.child.pid || null,
        startedAt: existing.startedAt,
      };
    }

    if (existing) {
      await stopRuntime(existing);
      manager.runtimes.delete(poolId);
    }

    let runtime;
    try {
      runtime = await startRuntime(poolId, {
        configHash,
        xrayOutbound,
      });
    } catch (error) {
      throw error;
    }

    runtime.child.once("exit", (code, signal) => {
      const current = manager.runtimes.get(poolId);
      if (current?.child === runtime.child) {
        manager.runtimes.delete(poolId);
      }
      console.warn(`${XRAY_LOG_PREFIX} pool=${poolId} exited code=${code} signal=${signal}`);
    });

    manager.runtimes.set(poolId, runtime);

    return {
      proxyUrl: `http://127.0.0.1:${runtime.port}`,
      port: runtime.port,
      pid: runtime.child.pid || null,
      startedAt: runtime.startedAt,
    };
  });
}

export async function stopAllXrayProxyRuntimes() {
  const runtimes = [...manager.runtimes.values()];
  manager.runtimes.clear();
  for (const runtime of runtimes) {
    await stopRuntime(runtime);
  }
}
