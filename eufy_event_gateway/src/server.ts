/**
 * Implements the gateway's external HTTP contract.
 *
 * Home Assistant and diagnostic tools use this boundary for health, normalized
 * camera state, retained JPEGs, short-lived stream URLs, MP4 capture, SSE,
 * and safe diagnostics. The local authentication page is only a presentation
 * surface for an Eufy challenge already represented by the provider. This
 * module owns request authentication, response framing, and route selection;
 * it does not parse Mega payloads or open camera sockets.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GatewayConfig } from "./config.js";
import { GatewayState } from "./domain/gateway-state.js";
import type { GatewayEvent } from "./domain/types.js";
import { createLogger } from "./logging.js";
import { SimulatedProvider } from "./provider/simulated-provider.js";
import type { CameraProvider, CaptchaProvider } from "./provider/provider.js";
import { SnapshotStore } from "./storage/snapshot-store.js";
import { LiveStreamManager } from "./stream/live-stream-manager.js";

const logger = createLogger("gateway");

/**
 * Serves the gateway's public HTTP contract and optional local auth page.
 *
 * When an API token is configured, every `/api` request requires it except a
 * short-lived signed stream URL. `/health` remains readable so supervisors can
 * tell the difference between a process that is alive and one that is
 * connected to Eufy.
 */
export class GatewayServer {
  #server: Server | null = null;

  /** Assemble the server from shared state, storage, stream, and provider objects. */
  constructor(
    private readonly config: GatewayConfig,
    private readonly state: GatewayState,
    private readonly snapshots: SnapshotStore,
    private readonly streams: LiveStreamManager,
    private readonly provider: CameraProvider,
    private readonly simulatedProvider: SimulatedProvider | null,
    private readonly captchaProvider: CaptchaProvider | null = null,
  ) {}

  /** Bind the configured host and port and begin accepting requests. */
  async listen(): Promise<void> {
    const server = createServer((request, response) => void this.#route(request, response));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.host, resolve);
    });
  }

  /** Stop accepting requests and wait for the HTTP server to close. */
  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => this.#server?.close((error) => error ? reject(error) : resolve()));
    this.#server = null;
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (segments[0] === "api" && this.config.apiToken) {
        const streamAuthorized =
          request.method === "GET" &&
          segments[1] === "cameras" &&
          segments[3] === "live.h264" &&
          segments.length === 4 &&
          validateStreamToken(segments[2]!, url.searchParams.get("access_token"), this.config.apiToken);
        if (!streamAuthorized && !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) {
          return json(response, 401, { error: "Unauthorized" });
        }
      }

      if (request.method === "GET" && url.pathname === "/live") {
        return json(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/") return this.#authenticationPage(response);
      if (request.method === "POST" && url.pathname === "/") {
        const body = await readBody(request);
        const values = new URLSearchParams(body);
        if (values.has("answer")) return await this.#submitCaptchaValues(values, response);
        if (values.has("code")) return await this.#submitVerificationValues(values, response);
        return this.#authenticationPage(response, "The submitted authentication response was incomplete.");
      }
      if (request.method === "POST" && url.pathname === "/auth/captcha") {
        return await this.#submitCaptcha(request, response);
      }
      if (request.method === "POST" && url.pathname === "/auth/verification") {
        return await this.#submitVerification(request, response);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const connection = this.state.getConnection();
        return json(response, connection.state === "connected" ? 200 : 503, {
          status: connection.state === "connected" ? "ok" : "degraded",
          connection,
          cameraCount: this.state.listCameras().length,
          sensorCount: this.state.listSensors().length,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/cameras") {
        return json(response, 200, { cameras: this.state.listCameras() });
      }
      if (request.method === "GET" && url.pathname === "/api/stations") {
        return json(response, 200, { stations: this.state.listStations() });
      }
      if (request.method === "GET" && url.pathname === "/api/sensors") {
        return json(response, 200, { sensors: this.state.listSensors() });
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/push") {
        return json(response, 200, { events: this.state.listPushDiagnostics() });
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/inventory") {
        return json(response, 200, { devices: this.state.listInventoryDiagnostics() });
      }
      if (request.method === "GET" && url.pathname === "/api/camera-capabilities") {
        return json(response, 200, { devices: this.state.listCameraCapabilities() });
      }
      if (request.method === "GET" && url.pathname === "/api/device-capabilities") {
        return json(response, 200, { devices: this.state.listDeviceCapabilities() });
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "cameras" && segments.length === 3) {
        return this.#cameraJson(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "enabled" && segments.length === 4
      ) {
        return await this.#cameraEnabled(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "motion-detection" && segments.length === 4
      ) {
        return await this.#cameraMotionDetection(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "privacy" && segments.length === 4
      ) {
        return await this.#cameraPrivacy(request, segments[2]!, response);
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "stations" && segments.length === 3) {
        return this.#stationJson(segments[2]!, response);
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "stations" && segments.length === 4) {
        return await this.#stationCommand(request, segments[2]!, segments[3]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "stream-token" && segments.length === 4
      ) {
        return this.#streamToken(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "capture-snapshot" && segments.length === 4
      ) {
        return await this.#captureSnapshot(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "record.mp4" && segments.length === 4
      ) {
        return await this.#recordClip(request, segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "snapshot" && segments.length === 4
      ) {
        return await this.#snapshot(segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "live.h264" && segments.length === 4
      ) {
        return await this.#live(segments[2]!, response);
      }
      if (request.method === "GET" && url.pathname === "/api/events") return this.#events(request, response);
      if (request.method === "POST" && url.pathname === "/api/simulate/detection" && this.simulatedProvider) {
        const body = await readJson(request);
        this.simulatedProvider.detectMotion(typeof body.personName === "string" ? body.personName : null);
        return json(response, 202, { accepted: true });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(response, status, { error: safeError(error) });
    }
  }

  #authenticationPage(response: ServerResponse, message = ""): void {
    const challenge = this.captchaProvider?.getCaptchaChallenge() ?? null;
    const connection = this.state.getConnection();
    const content = challenge
      ? `<p>Eufy needs you to solve this one-time challenge.</p><img src="${captchaDataUri(challenge.image)}" alt="Eufy CAPTCHA"><form method="post" action=""><label for="answer">Characters shown</label><input id="answer" name="answer" required maxlength="32" autocomplete="off" autocapitalize="none"><button type="submit">Connect to Eufy</button></form>`
      : this.captchaProvider?.isVerificationRequired()
        ? `<p>Eufy sent a six-digit verification code to your account email.</p><form method="post" action=""><label for="code">Verification code</label><input id="code" name="code" required minlength="6" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"><button type="submit">Verify and connect</button></form>`
      : connection.state === "connected"
        ? `<p><strong>Connected to Eufy.</strong></p><p>The gateway is ready. Return to Home Assistant to review your cameras and entities.</p><a class="button" href="/config/integrations/integration/eufy_event_gateway" target="_top">View Eufy integration</a>`
        : `<p>No authentication challenge is waiting.</p><p>Current connection: <strong>${escapeHtml(connection.state)}</strong>${connection.detail ? `; ${escapeHtml(connection.detail)}` : ""}.</p>`;
    return html(response, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Eufy Mega Security</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#202124}main{border:1px solid #ddd;border-radius:12px;padding:1.5rem}img{display:block;max-width:100%;margin:1rem 0;border:1px solid #ddd}label,input,button{display:block;width:100%;box-sizing:border-box}input,button,.button{font:inherit;padding:.75rem;margin:.4rem 0 1rem}.button{display:inline-block;width:auto;border-radius:999px;background:#03a9f4;color:#fff;text-decoration:none}button{cursor:pointer}</style><main><h1>Eufy Mega Security</h1>${message ? `<p role="status">${escapeHtml(message)}</p>` : ""}${content}</main></html>`);
  }

  async #submitCaptcha(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    return this.#submitCaptchaValues(new URLSearchParams(body), response);
  }

  async #submitCaptchaValues(values: URLSearchParams, response: ServerResponse): Promise<void> {
    if (!this.captchaProvider) return this.#authenticationPage(response, "CAPTCHA authentication is unavailable.");
    const answer = values.get("answer")?.trim() ?? "";
    if (!answer || answer.length > 32) return this.#authenticationPage(response, "Enter the characters shown in the image.");
    try {
      await this.captchaProvider.submitCaptcha(answer);
      const nextChallenge = this.captchaProvider.getCaptchaChallenge();
      return this.#authenticationPage(
        response,
        captchaResultMessage(nextChallenge !== null),
      );
    } catch (error) {
      return this.#authenticationPage(response, `Eufy did not accept the answer: ${safeError(error)}`);
    }
  }

  async #submitVerification(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    return this.#submitVerificationValues(new URLSearchParams(body), response);
  }

  async #submitVerificationValues(values: URLSearchParams, response: ServerResponse): Promise<void> {
    if (!this.captchaProvider) return this.#authenticationPage(response, "Verification is unavailable.");
    const code = values.get("code")?.trim() ?? "";
    if (!/^\d{6}$/.test(code)) return this.#authenticationPage(response, "Enter the six-digit code Eufy sent you.");
    try {
      await this.captchaProvider.submitVerification(code);
      return this.#authenticationPage(response, "Verification accepted.");
    } catch (error) {
      return this.#authenticationPage(response, `Eufy did not accept the verification code: ${safeError(error)}`);
    }
  }

  #cameraJson(serial: string, response: ServerResponse): void {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    return json(response, 200, this.state.getCamera(serial));
  }

  async #cameraEnabled(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const identity = await this.provider.setCameraEnabled(serial, requiredBoolean(body.enabled));
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraMotionDetection(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const identity = await this.provider.setCameraMotionDetection(serial, requiredBoolean(body.enabled));
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraPrivacy(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const enabled = requiredBoolean(body.enabled);
    await this.provider.setCameraPrivacy(serial, enabled);
    return json(response, 200, { serial, accepted: true, requested: enabled, readback: null });
  }

  #stationJson(serial: string, response: ServerResponse): void {
    if (!this.state.hasStation(serial)) return json(response, 404, { error: "HomeBase not found" });
    return json(response, 200, this.state.getStation(serial));
  }

  async #stationCommand(
    request: IncomingMessage,
    serial: string,
    command: string,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.state.hasStation(serial)) return json(response, 404, { error: "HomeBase not found" });
    const body = await readJson(request);
    let station;
    if (command === "refresh") station = await this.provider.refreshStation(serial);
    else if (command === "guard-mode") station = await this.provider.setGuardMode(serial, requiredInteger(body.mode));
    else if (command === "alarm-volume") station = await this.provider.setAlarmVolume(serial, requiredInteger(body.value));
    else if (command === "prompt-volume") station = await this.provider.setPromptVolume(serial, requiredInteger(body.value));
    else if (command === "alarm-tone") station = await this.provider.setAlarmTone(serial, requiredInteger(body.value));
    else return json(response, 404, { error: "Not found" });
    this.state.registerStation(station);
    return json(response, 200, station);
  }

  async #snapshot(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const snapshot = await this.snapshots.read(serial);
    if (!snapshot) return json(response, 404, { error: "No snapshot captured yet" });
    response.writeHead(200, {
      "Content-Type": snapshot.info.contentType,
      "Content-Length": snapshot.data.length,
      "Cache-Control": "no-cache",
      ETag: `\"${snapshot.info.revision}\"`,
      "Last-Modified": new Date(snapshot.info.capturedAt).toUTCString(),
    });
    response.end(snapshot.data);
  }

  async #live(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "This camera was discovered through push events only; livestream control is unavailable" });
    }
    logger.info("camera_media_request", `model=${safeCameraModel(this.state.getCamera(serial).model)} operation=live_view`);
    await this.streams.addClient(serial, response);
  }

  #streamToken(serial: string, response: ServerResponse): void {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Livestream control is unavailable for this camera" });
    }
    const expiresAt = Math.floor(Date.now() / 1_000) + 120;
    const token = this.config.apiToken
      ? createStreamToken(serial, expiresAt, this.config.apiToken)
      : null;
    const path = `/api/cameras/${encodeURIComponent(serial)}/live.h264${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
    return json(response, 200, { path, expiresAt });
  }

  async #captureSnapshot(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Fresh snapshot capture is unavailable for this camera" });
    }
    logger.info("camera_media_request", `model=${safeCameraModel(this.state.getCamera(serial).model)} operation=capture_snapshot`);
    try {
      const snapshot = await this.streams.captureSnapshot(serial);
      return json(response, 200, { snapshot });
    } catch (error) {
      logger.warn("snapshot_capture_failed", `Fresh snapshot capture failed: ${safeError(error)}`);
      throw error;
    }
  }

  async #recordClip(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Clip recording is unavailable for this camera" });
    }
    const body = await readJson(request);
    const duration = body.duration;
    if (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > 120) {
      return json(response, 400, { error: "Recording duration must be between 1 and 120 seconds" });
    }
    try {
      const clip = await this.streams.recordClip(serial, duration as number);
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": clip.length,
        "Cache-Control": "no-store",
      });
      response.end(clip);
    } catch (error) {
      logger.warn("clip_recording_failed", `Camera clip recording failed: ${safeError(error)}`);
      throw error;
    }
  }

  #events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({
      cameras: this.state.listCameras(),
      stations: this.state.listStations(),
      sensors: this.state.listSensors(),
    })}\n\n`);
    const listener = (event: GatewayEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    this.state.on("event", listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.once("close", () => {
      clearInterval(heartbeat);
      this.state.off("event", listener);
    });
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  response.end(data);
}

function html(response: ServerResponse, status: number, body: string): void {
  const data = Buffer.from(body);
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  response.end(data);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Convert a Mega CAPTCHA payload into an image URI safe for the auth page. */
export function captchaDataUri(image: string): string {
  if (image.startsWith("data:image/")) return escapeHtml(image);
  return `data:image/jpeg;base64,${escapeHtml(image)}`;
}

/** Build the human-readable result shown after a CAPTCHA submission. */
export function captchaResultMessage(hasNextChallenge: boolean): string {
  return hasNextChallenge
    ? "Eufy did not accept that answer. Try the new challenge below."
    : "CAPTCHA accepted.";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected gateway error";
}

function requiredInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new SyntaxError("Expected an integer value");
  return value as number;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new SyntaxError("Expected a boolean value");
  return value;
}

function safeCameraModel(value: string): string {
  return /^T[0-9A-Z-]{3,12}$/.test(value) ? value : "unknown";
}

/** Validate a bearer header without leaking token material in an error path. */
export function isBearerAuthorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return equalSecret(header.slice(7), expectedToken);
}

/** Create a signed, camera-scoped token for the unauthenticated media URL. */
export function createStreamToken(serial: string, expiresAt: number, apiToken: string): string {
  const signature = createHmac("sha256", apiToken).update(`${serial}.${expiresAt}`).digest("base64url");
  return `${expiresAt}.${signature}`;
}

/** Check a stream token's camera, expiry, and HMAC signature. */
export function validateStreamToken(
  serial: string,
  token: string | null,
  apiToken: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number.parseInt(token.slice(0, separator), 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds || expiresAt > nowSeconds + 180) return false;
  return equalSecret(token, createStreamToken(serial, expiresAt, apiToken));
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
