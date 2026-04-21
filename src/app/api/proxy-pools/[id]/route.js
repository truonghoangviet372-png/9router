import { NextResponse } from "next/server";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProxyPool,
} from "@/models";
import { buildXrayPoolConfigFromText } from "@/lib/network/xrayParser";

const VALID_PROXY_TYPES = ["http", "vercel", "xray"];

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeXrayUpdate(body = {}, existing = {}, { required = false } = {}) {
  const hasXrayConfig = hasOwn(body, "xrayConfig");
  const hasXrayOutbound = hasOwn(body, "xrayOutbound");
  const hasXrayMeta = hasOwn(body, "xrayMeta");
  const hasProxyUrl = hasOwn(body, "proxyUrl");
  const hasRelevantField = hasXrayConfig || hasXrayOutbound || hasXrayMeta || hasProxyUrl;

  if (!hasRelevantField && !required) return { updates: {} };

  let xrayOutbound = null;
  let xrayMeta = null;
  let proxyUrl = "";
  let xrayConfig = null;

  if (hasXrayOutbound) {
    if (!body.xrayOutbound || typeof body.xrayOutbound !== "object") {
      return { error: "xrayOutbound must be an object" };
    }

    xrayOutbound = body.xrayOutbound;
    xrayMeta = body?.xrayMeta && typeof body.xrayMeta === "object"
      ? body.xrayMeta
      : (existing?.xrayMeta || {});
    proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";

    if (!proxyUrl) {
      const protocol = String(xrayMeta?.protocol || "custom").trim() || "custom";
      const server = String(xrayMeta?.server || "node").trim() || "node";
      const portRaw = Number(xrayMeta?.port);
      const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : 0;
      proxyUrl = `xray://${protocol}@${server}:${port}`;
    }
  } else if (hasXrayConfig) {
    xrayConfig = typeof body?.xrayConfig === "string" ? body.xrayConfig.trim() : "";
    if (!xrayConfig) return { error: "xrayConfig is required" };
    const parsed = buildXrayPoolConfigFromText(xrayConfig);
    if (parsed.error) return { error: parsed.error };
    xrayOutbound = parsed.xrayOutbound;
    xrayMeta = parsed.xrayMeta;
    proxyUrl = parsed.proxyUrl;
  } else if (required) {
    if (!existing?.xrayOutbound || typeof existing.xrayOutbound !== "object") {
      return { error: "Missing Xray config. Provide xrayConfig text or xrayOutbound object." };
    }
    xrayOutbound = existing.xrayOutbound;
    xrayMeta = existing.xrayMeta || {};
    proxyUrl = existing.proxyUrl || "xray://custom@node:0";
  }

  const updates = {};
  if (xrayOutbound) updates.xrayOutbound = xrayOutbound;
  if (xrayMeta) updates.xrayMeta = xrayMeta;
  if (proxyUrl) updates.proxyUrl = proxyUrl;
  if (xrayConfig) updates.xrayConfig = xrayConfig;
  return { updates };
}

function normalizeProxyPoolUpdate(body = {}, existing = {}) {
  const updates = {};

  if (hasOwn(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return { error: "Name is required" };
    }
    updates.name = name;
  }

  if (hasOwn(body, "type")) {
    updates.type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";
  }

  const effectiveType = updates.type || existing.type || "http";

  if (effectiveType !== "xray" && hasOwn(body, "proxyUrl")) {
    const proxyUrlRaw = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    if (!proxyUrlRaw) {
      return { error: "Proxy URL is required" };
    }
    updates.proxyUrl = proxyUrlRaw;
  }

  if (hasOwn(body, "noProxy")) {
    updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  }

  if (hasOwn(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (hasOwn(body, "strictProxy")) {
    updates.strictProxy = body?.strictProxy === true;
  }

  if (effectiveType === "xray") {
    const xrayRequired = updates.type === "xray" && existing.type !== "xray";
    const xrayNormalized = normalizeXrayUpdate(body, existing, { required: xrayRequired });
    if (xrayNormalized.error) {
      return { error: xrayNormalized.error };
    }
    Object.assign(updates, xrayNormalized.updates);
  } else if (updates.type && existing.type === "xray") {
    updates.xrayOutbound = null;
    updates.xrayMeta = null;
    updates.xrayConfig = null;
    if (!updates.proxyUrl) {
      const fallbackProxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
      if (!fallbackProxyUrl) {
        return { error: "Proxy URL is required when switching away from xray type" };
      }
      updates.proxyUrl = fallbackProxyUrl;
    }
  }

  return { updates };
}

function countBoundConnections(connections = [], proxyPoolId) {
  return connections.filter((connection) => connection?.providerSpecificData?.proxyPoolId === proxyPoolId).length;
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    return NextResponse.json({ proxyPool });
  } catch (error) {
    console.log("Error fetching proxy pool:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 });
  }
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const normalized = normalizeProxyPoolUpdate(body, existing);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const updated = await updateProxyPool(id, normalized.updates);
    return NextResponse.json({ proxyPool: updated });
  } catch (error) {
    console.log("Error updating proxy pool:", error);
    return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 });
  }
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const connections = await getProviderConnections();
    const boundConnectionCount = countBoundConnections(connections, id);

    if (boundConnectionCount > 0) {
      return NextResponse.json(
        {
          error: "Proxy pool is currently in use",
          boundConnectionCount,
        },
        { status: 409 }
      );
    }

    await deleteProxyPool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}
