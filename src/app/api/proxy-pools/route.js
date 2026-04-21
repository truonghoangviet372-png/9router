import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";
import { buildXrayPoolConfigFromText } from "@/lib/network/xrayParser";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "xray"];

function normalizeXrayInput(body = {}) {
  const xrayConfig = typeof body?.xrayConfig === "string" ? body.xrayConfig.trim() : "";
  const xrayOutbound = body?.xrayOutbound && typeof body.xrayOutbound === "object" ? body.xrayOutbound : null;
  const xrayMeta = body?.xrayMeta && typeof body.xrayMeta === "object" ? body.xrayMeta : null;

  if (xrayOutbound) {
    const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    const fallbackMeta = xrayMeta || {};
    const protocol = String(fallbackMeta.protocol || "custom").trim() || "custom";
    const server = String(fallbackMeta.server || "node").trim() || "node";
    const portRaw = Number(fallbackMeta.port);
    const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : 0;

    return {
      xrayOutbound,
      xrayMeta: fallbackMeta,
      proxyUrl: proxyUrl || `xray://${protocol}@${server}:${port}`,
      suggestedName: typeof fallbackMeta.remark === "string" ? fallbackMeta.remark.trim() : "",
    };
  }

  if (!xrayConfig) {
    return { error: "Xray config text is required for xray proxy type" };
  }

  const parsed = buildXrayPoolConfigFromText(xrayConfig);
  if (parsed.error) {
    return { error: parsed.error };
  }

  return {
    xrayOutbound: parsed.xrayOutbound,
    xrayMeta: parsed.xrayMeta,
    proxyUrl: parsed.proxyUrl,
    suggestedName: parsed.suggestedName || "",
    xrayConfig,
  };
}

function normalizeProxyPoolInput(body = {}) {
  const requestedName = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (type === "xray") {
    const xrayInput = normalizeXrayInput(body);
    if (xrayInput.error) {
      return { error: xrayInput.error };
    }

    const fallbackName = [
      xrayInput.suggestedName,
      xrayInput.xrayMeta?.remark,
      `Xray ${xrayInput.xrayMeta?.protocol || "node"} ${xrayInput.xrayMeta?.server || ""}`.trim(),
    ].find((item) => typeof item === "string" && item.trim()) || "Xray Node";

    const name = requestedName || fallbackName;
    if (!name) {
      return { error: "Name is required" };
    }

    return {
      name,
      proxyUrl: xrayInput.proxyUrl,
      noProxy,
      isActive,
      strictProxy,
      type,
      xrayOutbound: xrayInput.xrayOutbound,
      xrayMeta: xrayInput.xrayMeta,
      xrayConfig: xrayInput.xrayConfig || null,
    };
  }

  if (!requestedName) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  return { name: requestedName, proxyUrl, noProxy, isActive, strictProxy, type };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return NextResponse.json({ proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));

    return NextResponse.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
