import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

const CODEX_PROBE_URL = "https://chatgpt.com/backend-api/codex/responses";

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    const normalized = base64 + "=".repeat(padding);
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function parseIsoDate(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resolveExpiresAt(session, payload) {
  if (payload?.exp && Number.isFinite(payload.exp)) {
    return new Date(payload.exp * 1000).toISOString();
  }

  if (session?.expires && typeof session.expires === "string") {
    return parseIsoDate(session.expires);
  }

  return null;
}

function resolveEmail(session, payload) {
  return (
    session?.user?.email ||
    payload?.["https://api.openai.com/profile"]?.email ||
    payload?.email ||
    payload?.preferred_username ||
    null
  );
}

function resolveDisplayName(session, payload) {
  return session?.user?.name || payload?.name || null;
}

function resolveProviderSpecificData(session, payload) {
  const auth = payload?.["https://api.openai.com/auth"] || {};

  const data = {
    authMethod: "imported_session",
    source: "chatgpt_session",
    hasSessionToken: Boolean(session?.sessionToken),
    accountId: session?.account?.id || auth.chatgpt_account_id || null,
    planType: session?.account?.planType || auth.chatgpt_plan_type || null,
    idp: session?.user?.idp || payload?.auth_provider || null,
  };

  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));
}

function parseSessionInput(raw) {
  if (raw == null) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Allow direct JWT paste as fallback.
    if (trimmed.split(".").length === 3 && !trimmed.startsWith("{")) {
      return { accessToken: trimmed };
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      throw new InputError("Session payload must be valid JSON");
    }
  }

  if (typeof raw === "object") return raw;

  return null;
}

async function probeCodexAccessToken(accessToken) {
  try {
    const response = await fetch(CODEX_PROBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        originator: "codex-cli",
        "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
      },
      // Intentionally invalid payload to trigger cheap auth-gated response.
      body: JSON.stringify({ model: "gpt-5.3-codex", input: [], stream: false, store: false }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new InputError("Access token is invalid or expired");
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new Error("Failed to validate token against Codex endpoint");
  }
}

/**
 * POST /api/oauth/codex/import-session
 * Body:
 * - { session: object|string }
 *   or direct object payload equivalent to /api/auth/session response
 */
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      throw new InputError("Invalid or empty request body");
    }
    const input = body?.session ?? body;
    const session = parseSessionInput(input);

    if (!session || typeof session !== "object") {
      throw new InputError("Session payload is required");
    }

    const accessToken =
      (typeof session.accessToken === "string" && session.accessToken.trim()) ||
      (typeof session.access_token === "string" && session.access_token.trim()) ||
      "";

    if (!accessToken) {
      throw new InputError("Session must include accessToken");
    }

    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
      throw new InputError("Invalid accessToken format");
    }

    const expiresAt = resolveExpiresAt(session, payload);
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      throw new InputError("Access token is already expired");
    }

    await probeCodexAccessToken(accessToken);

    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken,
      refreshToken: typeof session.refreshToken === "string" ? session.refreshToken : null,
      expiresAt,
      email: resolveEmail(session, payload),
      displayName: resolveDisplayName(session, payload),
      providerSpecificData: resolveProviderSpecificData(session, payload),
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Codex session import error:", error);
    const status = error instanceof InputError ? 400 : 500;
    return NextResponse.json({ error: error.message || "Failed to import session" }, { status });
  }
}
