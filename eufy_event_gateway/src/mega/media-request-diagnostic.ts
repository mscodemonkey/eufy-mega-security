/**
 * Projects validated media requests into bounded, privacy-safe error details.
 * MegaClient owns requests and retries, and consumes these descriptions only
 * for terminal HTTP failures. This module retains no URLs or mutable state.
 */

/** Authenticated media endpoint allowlist shared by admission and diagnostics. */
export const MEDIA_HOST = /^security-app(?:-(?:eu|ie))?\.eufylife\.com$/;

/** Credential-free object-store allowlist shared by admission and diagnostics. */
export const MEDIA_OBJECT_HOST = /^zhixin-security-[a-z0-9]+(?:-[a-z0-9]+)*\.s3(?:\.[a-z]{2}(?:-[a-z0-9]+)+-\d)?\.amazonaws\.com$/;

const SAFE_SEGMENTS = new Set([
  "v1", "v2", "v3", "app", "image", "images", "picture", "pictures", "snapshot", "snapshots",
  "event", "events", "thumbnail", "thumbnails", "storage", "download", "file", "files", "get_image", "get_picture",
]);
const UNAVAILABLE = "unknown unavailable segments=0 q=absent";

/**
 * Describe the URL as sent, preserving only fixed route words and image suffixes.
 * The caller supplies an admitted URL. This never throws or emits host text,
 * private path values, query values, userinfo or fragments, even on bad input.
 */
export function mediaRequestDiagnostic(url: URL): string {
  try {
    if (!(url instanceof URL) || url.href.length > 2_048) return UNAVAILABLE;
    let host = "unknown";
    if (url.protocol === "https:" && !url.port) {
      if (MEDIA_HOST.test(url.hostname)) {
        host = url.hostname === "security-app.eufylife.com" ? "eufy-us"
          : url.hostname === "security-app-eu.eufylife.com" ? "eufy-eu" : "eufy-ie";
      } else if (MEDIA_OBJECT_HOST.test(url.hostname)) host = "object-store";
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const path = segments.slice(0, 8).map(segment => SAFE_SEGMENTS.has(segment) ? segment
      : `[redacted]${/\.(jpg|jpeg|png)$/.exec(segment)?.[0] ?? ""}`).join("/");
    return `${host} /${path}${segments.length > 8 ? "/[truncated]" : ""} segments=${segments.length} q=${url.search ? "present" : "absent"}`;
  } catch {
    return UNAVAILABLE;
  }
}
