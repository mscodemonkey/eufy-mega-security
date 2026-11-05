/**
 * Resolves the public web service region consumed by RTC signing.
 *
 * The Mega client owns request cancellation and its authenticated session. This
 * stateless boundary sends no credentials and returns only an allowlisted region,
 * leaving PHONE discovery and persisted account domains unchanged.
 */
import { readBoundedResponse } from "./bounded-response.js";

/**
 * Ask the web identity for its service region before sending a signing token.
 *
 * A PHONE estimate can name a different cluster for the same country. Unknown
 * domains, redirects and failed discovery are refused rather than used as token
 * destinations or silently replaced by the PHONE region.
 */
export async function discoverNvrServiceRegion(
  fetcher: typeof fetch,
  country: string,
  signal: AbortSignal,
): Promise<"us" | "eu" | "ie"> {
  signal.throwIfAborted();
  const host = country.toLowerCase() === "us" ? "mega-us-pr.eufy.com" : "mega-eu-pr.eufy.com";
  const response = await fetcher(`https://${host}/passport/estimate_domain`, {
    method: "POST",
    headers: { "content-type": "application/json", "app-name": "eufy_mega", "model-type": "WEB" },
    body: JSON.stringify({ ab: country.toLowerCase(), mode: 1 }),
    redirect: "manual",
    signal,
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("Video service region discovery failed");
  }
  const value: unknown = JSON.parse((await readBoundedResponse(response, 65_536, signal)).toString("utf8"));
  signal.throwIfAborted();
  if (typeof value !== "object" || value === null || !("code" in value) || value.code !== 0
      || !("data" in value) || typeof value.data !== "object" || value.data === null
      || !("domain" in value.data)) throw new Error("Video service region discovery failed");
  switch (value.data.domain) {
    case "mega-us-pr.eufy.com": return "us";
    case "mega-eu-pr.eufy.com": return "eu";
    case "mega-ie-pr.eufy.com": return "ie";
    default: throw new Error("Video service region discovery failed");
  }
}
