/**
 * Defines the process configuration boundary for the standalone gateway.
 *
 * Docker, the Home Assistant app supervisor, and local shells all provide
 * strings. This module is the one place that parses those strings into typed
 * ports, paths, provider selections, credentials, and media limits. Every
 * downstream component receives the result of this validation rather than
 * re-reading `process.env`, which keeps configuration policy testable and
 * prevents the HTTP and Eufy layers from drifting apart.
 */
import { resolve } from "node:path";

/** Fully validated settings used by the running gateway process. */
export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly provider: "eufy" | "simulated";
  readonly streamGraceMilliseconds: number;
  readonly maxStreamSeconds: number;
  readonly apiToken: string | null;

  /** Opt-in private evidence session; requires bearer authentication even on loopback. */
  readonly captureFailedEventImages: boolean;
  readonly eufy: {
    readonly username: string | null;
    readonly password: string | null;
    readonly country: string;
    readonly verifyCode?: string;
  };
}

/**
 * Reads gateway settings from an environment-like object.
 *
 * @param environment Values to read. Tests pass a plain object here so they
 * can exercise validation without modifying the process environment.
 * @returns Normalized paths, numbers, provider selection, and credentials.
 * @throws Error when a public listener has no API token or a numeric setting
 * is not a positive integer.
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = environment.EUFY_GATEWAY_PROVIDER === "simulated" ? "simulated" : "eufy";
  const verifyCode = nonEmpty(environment.EUFY_VERIFY_CODE);
  const host = environment.EUFY_GATEWAY_HOST ?? "127.0.0.1";
  const apiToken = nonEmpty(environment.EUFY_GATEWAY_API_TOKEN);
  const captureFailedEventImages = captureBoolean(environment.EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES);
  if (captureFailedEventImages && !apiToken) {
    throw new Error("Failed event-image capture requires EUFY_GATEWAY_API_TOKEN");
  }
  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error("EUFY_GATEWAY_API_TOKEN is required when the gateway is not bound to loopback");
  }
  if (apiToken && apiToken.length < 32) {
    throw new Error("EUFY_GATEWAY_API_TOKEN must be at least 32 characters");
  }
  return {
    host,
    port: positiveInteger(environment.EUFY_GATEWAY_PORT, 3218),
    dataDirectory: resolve(environment.EUFY_GATEWAY_DATA_DIR ?? "./data"),
    provider,
    streamGraceMilliseconds: positiveInteger(environment.EUFY_GATEWAY_STREAM_GRACE_SECONDS, 10) * 1_000,
    maxStreamSeconds: positiveInteger(environment.EUFY_GATEWAY_MAX_STREAM_SECONDS, 120),
    apiToken,
    captureFailedEventImages,
    eufy: {
      username: nonEmpty(environment.EUFY_USERNAME),
      password: nonEmpty(environment.EUFY_PASSWORD),
      country: (environment.EUFY_COUNTRY ?? "AU").toUpperCase(),
      ...(verifyCode ? { verifyCode } : {}),
    },
  };
}

function captureBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES must be true or false");
}

/** Returns whether a listener is restricted to the local machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}
