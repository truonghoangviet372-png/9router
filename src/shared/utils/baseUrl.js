const LOCAL_DEV_BASE_URL = "http://localhost:1455";

function trimTrailingSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Server-preferred base URL:
 * BASE_URL -> NEXT_PUBLIC_BASE_URL -> localhost fallback.
 */
export function getBaseUrl() {
  const rawBaseUrl =
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    LOCAL_DEV_BASE_URL;
  return trimTrailingSlash(rawBaseUrl);
}

/**
 * Server base URL with optional localhost:<port> fallback.
 */
export function getBaseUrlWithLocalPort(localPort) {
  const rawBaseUrl =
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    (localPort ? `http://localhost:${localPort}` : LOCAL_DEV_BASE_URL);
  return trimTrailingSlash(rawBaseUrl);
}

/**
 * Client-preferred base URL:
 * NEXT_PUBLIC_BASE_URL -> BASE_URL (build-time fallback) -> window origin -> localhost fallback.
 */
export function getClientBaseUrl() {
  const rawBaseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    (typeof window !== "undefined" ? window.location.origin : null) ||
    LOCAL_DEV_BASE_URL;
  return trimTrailingSlash(rawBaseUrl);
}

export function buildOAuthRedirectUri(callbackPath = "/callback", { client = false } = {}) {
  const normalizedPath = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const baseUrl = client ? getClientBaseUrl() : getBaseUrl();
  return `${baseUrl}${normalizedPath}`;
}
