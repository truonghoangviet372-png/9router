import { NextResponse } from "next/server";

const V2NODES_BASE = "https://www.v2nodes.com";
const DEFAULT_COUNTRY = "kr";
const REQUEST_TIMEOUT_MS = 12000;

let cachedPayload = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, "");
}

function extractServerPaths(html) {
  const matches = html.match(/\/servers\/\d+\//g) || [];
  return Array.from(new Set(matches));
}

function extractCleanConfigsFromServerPage(html) {
  const preBlocks = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi) || [];
  const configs = [];

  for (const block of preBlocks) {
    const clean = decodeHtmlEntities(stripHtml(block))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");

    if (/^type\s*:/im.test(clean)) {
      configs.push(clean);
    }
  }

  return configs;
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "User-Agent": "9router/1.0 (+https://github.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }

  return res.text();
}

async function collectCountryConfigs(countryCode) {
  const country = String(countryCode || DEFAULT_COUNTRY).trim().toLowerCase() || DEFAULT_COUNTRY;
  const listUrl = `${V2NODES_BASE}/country/${country}/`;
  const listHtml = await fetchText(listUrl);
  const paths = extractServerPaths(listHtml);

  const configs = [];
  const failedUrls = [];

  const pageResults = await Promise.all(paths.map(async (path) => {
    const serverUrl = `${V2NODES_BASE}${path}`;
    try {
      const pageHtml = await fetchText(serverUrl);
      return {
        serverUrl,
        configs: extractCleanConfigsFromServerPage(pageHtml),
      };
    } catch {
      return {
        serverUrl,
        configs: [],
        failed: true,
      };
    }
  }));

  for (const result of pageResults) {
    if (result.failed) {
      failedUrls.push(result.serverUrl);
      continue;
    }
    for (const cfg of result.configs) {
      configs.push({ sourceUrl: result.serverUrl, config: cfg });
    }
  }

  const seen = new Set();
  const dedupedConfigs = [];
  for (const item of configs) {
    if (seen.has(item.config)) continue;
    seen.add(item.config);
    dedupedConfigs.push(item);
  }

  return {
    country,
    listUrl,
    totalServerPages: paths.length,
    failedServerPages: failedUrls.length,
    failedUrls,
    configs: dedupedConfigs,
    importText: dedupedConfigs.map((item) => item.config).join("\n\n"),
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const country = searchParams.get("country") || DEFAULT_COUNTRY;
    const now = Date.now();

    if (cachedPayload && now - cacheAt < CACHE_TTL_MS && cachedPayload.country === country.toLowerCase()) {
      return NextResponse.json({ ...cachedPayload, cached: true });
    }

    const payload = await collectCountryConfigs(country);
    cachedPayload = payload;
    cacheAt = now;

    return NextResponse.json({ ...payload, cached: false });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to poll v2nodes: ${error?.message || "unknown error"}` },
      { status: 502 }
    );
  }
}
