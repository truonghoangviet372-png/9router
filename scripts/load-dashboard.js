#!/usr/bin/env node

const { Agent, setGlobalDispatcher } = require("undici");

setGlobalDispatcher(new Agent({
  connections: 256,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
}));

function parseArgs(argv) {
  const out = {
    url: "https://9router-production-c3a1.up.railway.app/dashboard",
    requests: 500,
    concurrency: 20,
    timeoutMs: 10_000,
    redirect: "manual",
    progressMs: 2_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--url" && next) {
      out.url = next;
      i += 1;
    } else if ((arg === "-n" || arg === "--requests") && next) {
      out.requests = Number.parseInt(next, 10);
      i += 1;
    } else if ((arg === "-c" || arg === "--concurrency") && next) {
      out.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if ((arg === "-t" || arg === "--timeout") && next) {
      out.timeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--redirect" && next) {
      out.redirect = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(out.requests) || out.requests <= 0) {
    throw new Error("--requests must be a positive integer");
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive integer (ms)");
  }

  return out;
}

function printHelp() {
  console.log(`\nLoad test /dashboard\n\nUsage:\n  node scripts/load-dashboard.js [options]\n\nOptions:\n  --url <url>            Target URL (default: Railway /dashboard)\n  -n, --requests <n>     Total requests (default: 500)\n  -c, --concurrency <n>  Concurrent workers (default: 20)\n  -t, --timeout <ms>     Per-request timeout in ms (default: 10000)\n  --redirect <mode>      fetch redirect mode: follow|manual|error (default: manual)\n  -h, --help             Show this help\n\nExamples:\n  node scripts/load-dashboard.js -n 1000 -c 50\n  node scripts/load-dashboard.js --url https://your-app/dashboard -n 300 -c 10\n`);
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function run() {
  const cfg = parseArgs(process.argv.slice(2));
  const total = cfg.requests;

  const statusCounts = new Map();
  const errorCounts = new Map();
  const latencies = [];

  let started = 0;
  let completed = 0;
  let ok = 0;
  let failed = 0;

  const startTime = nowMs();

  const progressTimer = setInterval(() => {
    const elapsedSec = Math.max(0.001, (nowMs() - startTime) / 1000);
    const rps = (completed / elapsedSec).toFixed(2);
    process.stdout.write(`\rprogress: ${completed}/${total} | ok=${ok} fail=${failed} | ${rps} req/s`);
  }, cfg.progressMs);

  async function oneRequest() {
    const reqStart = nowMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const res = await fetch(cfg.url, {
        method: "GET",
        redirect: cfg.redirect,
        signal: controller.signal,
        headers: {
          "cache-control": "no-cache",
          pragma: "no-cache",
          "user-agent": "9router-load-test/1.0",
        },
      });

      const latency = nowMs() - reqStart;
      latencies.push(latency);

      const statusKey = String(res.status);
      statusCounts.set(statusKey, (statusCounts.get(statusKey) || 0) + 1);

      if (res.status >= 200 && res.status < 400) {
        ok += 1;
      } else {
        failed += 1;
      }

      if (res.body) {
        try {
          await res.body.cancel();
        } catch {
          // ignore
        }
      }
    } catch (err) {
      failed += 1;
      const key = err && err.name ? err.name : "FetchError";
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);

      const latency = nowMs() - reqStart;
      latencies.push(latency);
    } finally {
      clearTimeout(timeout);
      completed += 1;
    }
  }

  async function worker() {
    while (true) {
      const idx = started;
      started += 1;
      if (idx >= total) return;
      await oneRequest();
    }
  }

  const workers = Array.from({ length: Math.min(cfg.concurrency, total) }, () => worker());
  await Promise.all(workers);

  clearInterval(progressTimer);
  process.stdout.write("\n");

  const elapsedMs = Math.max(1, nowMs() - startTime);
  const elapsedSec = elapsedMs / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;

  const statusLines = [...statusCounts.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, count]) => `  ${code}: ${count}`)
    .join("\n") || "  (none)";

  const errorLines = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n") || "  (none)";

  console.log("\n=== Load Test Result ===");
  console.log(`URL:          ${cfg.url}`);
  console.log(`Requests:     ${total}`);
  console.log(`Concurrency:  ${cfg.concurrency}`);
  console.log(`Timeout:      ${cfg.timeoutMs} ms`);
  console.log(`Elapsed:      ${elapsedSec.toFixed(2)} s`);
  console.log(`Throughput:   ${(completed / elapsedSec).toFixed(2)} req/s`);
  console.log(`Success:      ${ok}`);
  console.log(`Failed:       ${failed}`);
  console.log(`\nLatency (ms):`);
  console.log(`  min: ${sorted.length ? sorted[0].toFixed(2) : "0.00"}`);
  console.log(`  avg: ${avg.toFixed(2)}`);
  console.log(`  p50: ${percentile(sorted, 50).toFixed(2)}`);
  console.log(`  p90: ${percentile(sorted, 90).toFixed(2)}`);
  console.log(`  p95: ${percentile(sorted, 95).toFixed(2)}`);
  console.log(`  p99: ${percentile(sorted, 99).toFixed(2)}`);
  console.log(`  max: ${sorted.length ? sorted[sorted.length - 1].toFixed(2) : "0.00"}`);
  console.log(`\nStatus codes:\n${statusLines}`);
  console.log(`\nErrors:\n${errorLines}`);

  if (failed > 0) {
    process.exitCode = 2;
  }
}

run().catch((err) => {
  console.error("Load test failed:", err.message);
  process.exit(1);
});
