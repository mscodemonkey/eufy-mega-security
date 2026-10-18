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
import { NvrLiveControlError, type NvrLiveControl } from "./provider/nvr-live-controls.js";
import { NvrPowerError, type NvrPowerRequest } from "./provider/nvr-power-trial.js";
import { NvrGuardError, type NvrGuardRequest } from "./provider/nvr-guard-trial.js";
import { nvrGuardTimeZone } from "./provider/nvr-guard-schedule.js";
import { T85V0StatusError } from "./provider/t85v0-status.js";
import { LocalMotionError } from "./stream/local-motion-trial.js";
import { C31IndexError } from "./stream/c31-recording-index.js";
import { CloudRecordingError } from "./stream/cloud-recordings.js";
import { DoorbellRtcError } from "./stream/doorbell-rtc-offer.js";
import { validateStoredMedia } from "./stream/stored-recordings.js";
import { isE30LockSettingChange } from "./domain/types.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BundleCapture, diagnosticTargets, type DiagnosticMedia } from "./diagnostics/bundle-capture.js";
import { diagnosticsPage } from "./diagnostics/page.js";
import type { EventImageCapture } from "./diagnostics/event-image-capture.js";
import { safeCameraModel } from "./domain/safe-camera-model.js";

import type { GatewayConfig } from "./config.js";
import { GatewayState } from "./domain/gateway-state.js";
import type { GatewayEvent } from "./domain/types.js";
import { createLogger, observeLogEvents } from "./logging.js";
import { parseModelControlTrial } from "./provider/model-control-trials.js";
import { E30LockError } from "./provider/e30-lock-protocol.js";
import { CameraSettingError, parseCameraSettingChange } from "./provider/camera-settings.js";
import { validateC31Preference } from "./provider/c31-preferences.js";
import { SimulatedProvider } from "./provider/simulated-provider.js";
import type { CameraProvider, CaptchaProvider } from "./provider/provider.js";
import { SnapshotStore } from "./storage/snapshot-store.js";
import { RecordingCache, recordingByteRange } from "./storage/recording-cache.js";
import { NvrTrialError } from "./stream/nvr-protocol.js";
import { c31TalkbackFrames } from "./stream/c31-talkback.js";
import { validateRecordingDate } from "./stream/stored-recordings.js";
import { validateCloudHistoryQuery } from "./mega/cloud-history.js";
import { CloudCalendarError, validateCloudCalendarQuery, type CloudCalendarQuery } from "./mega/cloud-calendar.js";
import { waitingImage } from "./mega/waiting-image.js";
import { LiveStreamManager } from "./stream/live-stream-manager.js";

const logger = createLogger("gateway");
const STREAM_TOKEN_LIFETIME_SECONDS = 10 * 60;
const STREAM_TOKEN_MAX_FUTURE_SECONDS = STREAM_TOKEN_LIFETIME_SECONDS + 60;

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
  #bundle: BundleCapture | null = null;
  #bundleCleanup: (() => void) | null = null;
  #sampleBundleTransport: (() => void) | null = null;
  readonly #recordings = new RecordingCache();
  readonly #recordingIndexJobs = new Set<AbortController>();
  readonly #cloudCalendarJobs = new Set<AbortController>();
  readonly #nvrTrialJobs = new Set<AbortController>();
  readonly #speakerJobs = new Map<string, AbortController>();
  readonly #recordingJobs = new Map<string, { promise: Promise<Buffer | null>; controller: AbortController; users: Set<ServerResponse> }>();

  /**
   * Assemble shared dependencies without opening sockets or starting capture.
   * The optional private capture is owned and closed by the composition root.
   */
  constructor(
    private readonly config: GatewayConfig,
    private readonly state: GatewayState,
    private readonly snapshots: SnapshotStore,
    private readonly streams: LiveStreamManager,
    private readonly provider: CameraProvider,
    private readonly simulatedProvider: SimulatedProvider | null,
    private readonly captchaProvider: CaptchaProvider | null = null,
    private readonly eventImageCapture: EventImageCapture | null = null,
    private readonly nvrTrialDeadlineMilliseconds = 82_000,
    private readonly cloudCalendarDeadlineMilliseconds = 30_000,
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
    for (const controller of this.#cloudCalendarJobs) controller.abort();
    for (const controller of this.#nvrTrialJobs) controller.abort();
    for (const controller of this.#recordingIndexJobs) controller.abort();
    this.#clearBundle();
    for (const controller of this.#speakerJobs.values()) controller.abort();
    for (const job of this.#recordingJobs.values()) job.controller.abort();
    this.#recordings.clear();
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => this.#server?.close((error) => error ? reject(error) : resolve()));
    this.#server = null;
  }

  /** Return the actual bound port, including ephemeral test listeners, or null while stopped. */
  get port(): number | null {
    const address = this.#server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  #clearBundle(): void {
    this.#bundleCleanup?.();
    this.#bundleCleanup = null;
    this.#sampleBundleTransport = null;
    this.#bundle?.clear();
    this.#bundle = null;
  }

  async #diagnosticBundle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (path === "/api/diagnostics/bundle/targets" && request.method === "GET") {
      return json(response, 200, { devices: diagnosticTargets(this.state) });
    }
    if (path === "/api/diagnostics/summary" && request.method === "GET") {
      const projection = new BundleCapture({ target: null, seconds: 30, media: false });
      try { return json(response, 200, projection.summary(this.state)); }
      finally { projection.clear(); }
    }
    if (path === "/api/diagnostics/bundle" && request.method === "POST") {
      const body: unknown = JSON.parse(await readBody(request));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("Invalid diagnostic selection");
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !["target", "seconds", "media", "consentPrivateMedia"].includes(key))) throw new SyntaxError("Unknown diagnostic option");
      if (value.seconds !== 30 && value.seconds !== 60) throw new SyntaxError("Choose 30 or 60 seconds");
      if (typeof value.media !== "boolean") throw new SyntaxError("Choose whether to include media");
      if (value.media && value.consentPrivateMedia !== true) throw new SyntaxError("Private media consent required");
      if (value.target !== null && typeof value.target !== "string") throw new SyntaxError("Choose a device or all devices");
      const target = value.target as string | null;
      if (target !== null && !diagnosticTargets(this.state).some((row) => row.serial === target)) return json(response, 404, { error: "Device not found" });
      if (this.#bundle?.status().state === "active") return json(response, 409, { error: "A diagnostic session is already active" });
      this.#clearBundle();
      const capture = new BundleCapture({ target, seconds: value.seconds, media: value.media });
      this.#bundle = capture;
      if (target !== null) {
        capture.select(target);
        const selectedCamera = this.state.listCameras().find((camera) => camera.serial === target);
        if (selectedCamera?.stationSerial) capture.select(selectedCamera.stationSerial);
        for (const camera of this.state.listCameras()) if (camera.stationSerial === target) capture.select(camera.serial);
      }
      capture.summary(this.state);
      const images = async (serial: string): Promise<void> => {
        if (!capture.options.media || !capture.includes(serial) || capture.status().state !== "active") return;
        for (const kind of ["snapshot", "event-image"] as const) {
          try {
            const sample = kind === "snapshot" ? await this.snapshots.read(serial) : await this.snapshots.readEvent(serial);
            if (sample?.info.contentType === "image/jpeg") capture.media({ serial, kind, codec: "jpeg", data: sample.data });
          } catch { capture.record("retained-image-unavailable", serial); }
        }
      };
      const events = (event: GatewayEvent): void => {
        capture.event(event);
        if (event.type === "snapshot-updated" || event.type === "event-image-updated") void images(event.cameraSerial);
      };
      const media = (sample: DiagnosticMedia): void => capture.media(sample);
      this.state.on("event", events);
      if (value.media) this.streams.on("diagnostic-media", media);
      const unsubscribe = observeLogEvents((component, event, level) => capture.record(`log:${component}:${event}`, undefined, level));
      const transport = (): void => {
        if (!this.provider.streamDiagnostic || capture.status().state !== "active") return;
        for (const camera of this.state.listCameras()) {
          if (!capture.includes(camera.serial)) continue;
          const diagnostic = this.provider.streamDiagnostic(camera.serial);
          if (diagnostic) capture.transport(camera.serial, diagnostic);
        }
      };
      this.#sampleBundleTransport = transport;
      transport();
      const transportTimer = setInterval(() => {
        if (capture.status().state !== "active") {
          this.#bundleCleanup?.();
          this.#bundleCleanup = null;
          this.#sampleBundleTransport = null;
          return;
        }
        transport();
      }, 1000);
      transportTimer.unref();
      this.#bundleCleanup = () => {
        clearInterval(transportTimer);
        this.state.off("event", events);
        if (value.media) this.streams.off("diagnostic-media", media);
        unsubscribe();
      };
      for (const camera of this.state.listCameras()) void images(camera.serial);
      return json(response, 201, capture.status());
    }
    if (path === "/api/diagnostics/bundle" && request.method === "GET") {
      return json(response, 200, this.#bundle?.status() ?? { state: "absent" });
    }
    if (path === "/api/diagnostics/bundle" && request.method === "DELETE") {
      this.#clearBundle();
      return json(response, 200, { state: "cleared" });
    }
    if (path === "/api/diagnostics/bundle/stop" && request.method === "POST") {
      this.#sampleBundleTransport?.();
      this.#bundle?.stop();
      this.#bundleCleanup?.();
      this.#bundleCleanup = null;
      return json(response, 200, this.#bundle?.status() ?? { state: "absent" });
    }
    if (path === "/api/diagnostics/bundle/export" && request.method === "POST") {
      this.#sampleBundleTransport?.();
      const data = this.#bundle?.archive(this.state);
      this.#bundleCleanup?.();
      this.#bundleCleanup = null;
      if (!data) return json(response, 410, { error: "No diagnostic session remains" });
      response.writeHead(200, { "content-type": "application/gzip", "content-length": data.length,
        "content-disposition": 'attachment; filename="eufy-diagnostics.json.gz"',
        "x-eufy-share-method": data.length > 20_000_000 ? "private-cloud-link" : "email-or-private-cloud-link" });
      response.end(data);
      return;
    }
    return json(response, 404, { error: "Not found" });
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/diagnostics" && request.method === "GET") {
        return html(response, 200, diagnosticsPage());
      }
      if (url.pathname.startsWith("/api/diagnostics/bundle") || url.pathname === "/api/diagnostics/summary") {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) {
          return json(response, 401, { error: "Unauthorized" });
        }
        return await this.#diagnosticBundle(request, response, url.pathname);
      }
      response.once("finish", () => {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] !== "api" || parts[1] === "diagnostics") return;
        const serial = parts[1] === "cameras" || parts[1] === "stations" || parts[1] === "sensors" ? parts[2] : undefined;

        // Never retain URLs, opaque recording IDs, body values or error text.
        const operation = parts[1] === "cameras" ? "camera-request" : parts[1] === "stations" ? "station-request" : "gateway-request";
        this.#bundle?.record(operation, serial, response.statusCode);
      });
      const capturePath = url.pathname === "/api/diagnostics/event-images" || url.pathname === "/api/diagnostics/event-images/export";
      if (capturePath) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) {
          return json(response, 401, { error: "Unauthorized" });
        }
        if (!this.config.captureFailedEventImages || !this.eventImageCapture) return json(response, 404, { error: "Not found" });
        if (url.pathname.endsWith("/export")) {
          if (request.method !== "POST") {
            response.setHeader("allow", "POST");
            return json(response, 405, { error: "Method not allowed" });
          }
          try { await readBody(request); } catch {
            return json(response, 413, { error: "Request body too large" });
          }
          const archive = this.eventImageCapture.archive();
          if (!archive) {
            const status = this.eventImageCapture.status();
            return json(response, status.state === "active" ? 409 : 410, { error: status.state === "active" ? "No failed image samples captured" : "Capture session ended" });
          }
          const body = JSON.stringify(archive);
          response.setHeader("content-disposition", 'attachment; filename="eufy-event-image-evidence.json"');
          response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          response.end(body);
          return;
        }
        if (request.method === "DELETE") this.eventImageCapture.close();
        else if (request.method !== "GET") {
          response.setHeader("allow", "GET, DELETE");
          return json(response, 405, { error: "Method not allowed" });
        }
        return json(response, 200, this.eventImageCapture.status());
      }
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const calendarRoute = request.method === "GET" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "cloud-calendar" && segments.length === 4;
      if (calendarRoute) response.setHeader("cache-control", "no-store");

      if (segments[0] === "api" && this.config.apiToken) {
        const streamAuthorized =
          request.method === "GET" &&
          segments[1] === "cameras" &&
          (segments[3] === "live.h264" || segments[3] === "live.ts") &&
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
      if (request.method === "GET" && url.pathname === "/api/locks") {
        return json(response, 200, { locks: this.config.experimentalE30Locks ? this.state.listLocks() : [] });
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "locks"
        && segments.length === 4 && (segments[3] === "refresh" || segments[3] === "state" || segments[3] === "settings")) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalE30Locks) return json(response, 409, { error: "Experimental E30 locks are disabled", code: "disabled" });
        if (!this.state.hasLock(segments[2]!)) return json(response, 404, { error: "Lock not found" });
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") return json(response, 415, { error: "Lock operations require application/json" });
        const body = await readJson(request);
        const writing = segments[3] === "state";
        const settings = segments[3] === "settings";
        if (settings ? !isE30LockSettingChange(body) : writing ? Object.keys(body).length !== 1 || typeof body.locked !== "boolean" : Object.keys(body).length !== 0) throw new SyntaxError("Invalid lock request");
        const controller = new AbortController();
        let dispatched = false;
        const abort = (): void => { if (!dispatched) controller.abort(); };
        request.once("aborted", abort); response.once("close", abort);
        try {
          const lock = settings && isE30LockSettingChange(body)
            ? await this.provider.setLockSetting?.(segments[2]!, body, controller.signal, () => { dispatched = true; })
            : writing
            ? await this.provider.setLockState?.(segments[2]!, body.locked as boolean, controller.signal, () => { dispatched = true; })
            : await this.provider.refreshLock?.(segments[2]!, controller.signal);
          if (!lock) throw new E30LockError("unavailable");
          if (!response.destroyed) json(response, 200, { lock });
        } catch (error) {
          const failure = error instanceof E30LockError ? error : new E30LockError(dispatched ? "outcome_unknown" : "unavailable");
          if (!response.destroyed) json(response, failure.code === "rate_limited" ? 429 : failure.code === "unavailable" ? 503 : 409,
            { error: failure.message, code: failure.code });
        } finally {
          request.removeListener("aborted", abort); response.removeListener("close", abort);
        }
        return;
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
      if (request.method === "GET" && url.pathname === "/api/diagnostics/event-delivery") {
        return json(response, 200, this.state.eventDeliveryDiagnostic());
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/inventory") {
        return json(response, 200, { devices: this.state.listInventoryDiagnostics() });
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/catalogue-evidence") {
        return json(response, 200, this.state.catalogueEvidence());
      }
      if (request.method === "GET" && url.pathname === "/api/camera-capabilities") {
        return json(response, 200, { devices: this.state.listCameraCapabilities() });
      }
      if (request.method === "GET" && url.pathname === "/api/device-capabilities") {
        return json(response, 200, { devices: this.state.listDeviceCapabilities() });
      }
      if (request.method === "POST" && segments.length === 4 && segments[0] === "api"
        && segments[1] === "cameras" && segments[3] === "speaker-audio") {
        const serial = segments[2]!;
        if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
        if (!this.state.getCamera(serial).talkbackSupported || !this.provider.playCameraAudio) return json(response, 409, { error: "Speaker playback unavailable" });
        if (this.#speakerJobs.has(serial)) return json(response, 409, { error: "Camera speaker is busy" });
        if (request.headers["content-type"]?.split(";", 1)[0] !== "audio/aac") throw new SyntaxError("Speaker audio requires audio/aac");
        const controller = new AbortController();
        this.#speakerJobs.set(serial, controller);
        const cancel = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", cancel);
        const cancelUpload = (): void => { request.destroy(); };
        controller.signal.addEventListener("abort", cancelUpload, { once: true });
        const uploadTimeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk);
            length += bytes.length;
            if (length > 320_000) throw new SyntaxError("Speaker audio exceeds its size limit");
            chunks.push(bytes);
          }
          clearTimeout(uploadTimeout);
          controller.signal.removeEventListener("abort", cancelUpload);
          const audio = Buffer.concat(chunks);
          c31TalkbackFrames(audio);
          await this.streams.withLiveSource(serial, async () => {
            await this.provider.playCameraAudio!(serial, audio, controller.signal);
          });
          return json(response, 200, { ok: true });
        } finally {
          clearTimeout(uploadTimeout);
          controller.signal.removeEventListener("abort", cancelUpload);
          response.off("close", cancel);
          controller.abort();
          this.#speakerJobs.delete(serial);
        }
      }
      if (segments[0] === "api" && segments[1] === "cameras" && segments[3] === "recordings") {
        return await this.#storedRecordings(request, response, segments, url);
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "cloud-recording-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalCloudRecordings || !this.provider.cloudRecordingTrial) {
          return json(response, 409, { error: "Experimental cloud recording tests are disabled" });
        }
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
          return json(response, 400, { error: "JSON private-media consent is required" });
        }
        const body = await readJson(request);
        if (body.consentPrivateMedia !== true || typeof body.recordId !== "string" || !body.recordId.length || body.recordId.length > 128
          || Object.keys(body).some(key => !["consentPrivateMedia", "recordId", "startTime", "endTime", "timezoneOffset"].includes(key))) {
          return json(response, 400, { error: "A selected recording and explicit private-media consent are required" });
        }
        const query = { startTime: body.startTime as number, endTime: body.endTime as number,
          timezoneOffset: body.timezoneOffset as number, count: 1000 };
        validateCloudHistoryQuery(query);
        if (this.#nvrTrialJobs.size) return json(response, 409, { error: "A private media test is already running" });
        const controller = new AbortController(); this.#nvrTrialJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), 95_000);
        const abort = (): void => { controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        try {
          const clip = await this.provider.cloudRecordingTrial(segments[2]!, body.recordId, query, controller.signal);
          if (controller.signal.aborted) { clip.fill(0); throw new CloudRecordingError("cancelled"); }
          response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": clip.length, "Cache-Control": "no-store" });
          response.end(clip);
        } catch (error) {
          const failure = error instanceof CloudRecordingError ? error : new CloudRecordingError(controller.signal.aborted ? "cancelled" : "video");
          logger.warn("cloud_recording_trial_failed", `stage=${failure.stage}`);
          if (!response.destroyed) json(response, 409, { error: failure.message, stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline);
          response.removeListener("close", abort); request.removeListener("aborted", abort); this.#nvrTrialJobs.delete(controller);
        }
        return;
      }
      if (calendarRoute) {
        if (!this.provider.cloudCalendar) return json(response, 501, { error: "Cloud calendar unavailable" });
        if (!this.config.apiToken || !this.config.experimentalCloudRecordings) return json(response, 409, { error: "Cloud calendar unavailable" });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        let query: CloudCalendarQuery;
        try {
          const month = url.searchParams.get("month"), offset = url.searchParams.get("offset") ?? "0";
          if (url.searchParams.getAll("month").length !== 1 || url.searchParams.getAll("offset").length > 1
            || [...url.searchParams.keys()].some(key => key !== "month" && key !== "offset")
            || month === null || !/^(0|-?[1-9]\d{0,4})$/.test(offset)) throw new SyntaxError();
          query = { month, timezoneOffset: Number(offset) };
          validateCloudCalendarQuery(query);
        } catch { return json(response, 400, { error: "Invalid cloud calendar query" }); }
        if (this.#cloudCalendarJobs.size >= 2) return json(response, 502, { error: "Cloud calendar unavailable", stage: "admission" });
        const controller = new AbortController(); this.#cloudCalendarJobs.add(controller);
        let timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(30_000, Math.max(1, this.cloudCalendarDeadlineMilliseconds)));
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort);
        let rejectAbort: () => void = () => undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(new CloudCalendarError(timedOut ? "request" : "cancelled"));
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        try {
          const result = await Promise.race([this.provider.cloudCalendar(segments[2]!, query, controller.signal), cancelled]);
          if (!response.destroyed) json(response, 200, { month: result.month, days: result.days });
        } catch (error) {
          const stage = error instanceof CloudCalendarError ? error.stage : "request";
          logger.warn("cloud_calendar_failed", `stage=${stage}`);
          if (!response.destroyed) json(response, 502, { error: "Cloud calendar unavailable", stage });
        } finally {
          clearTimeout(deadline); response.removeListener("close", abort);
          controller.signal.removeEventListener("abort", rejectAbort); this.#cloudCalendarJobs.delete(controller);
        }
        return;
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "cameras" &&
        segments[3] === "cloud-history" && segments.length === 4) {
        if (!this.provider.cloudHistory) return json(response, 501, { error: "Cloud history is unavailable" });
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        if (start === null || end === null) return json(response, 400, { error: "Cloud history requires start and end" });
        const query = {
          startTime: Number(start), endTime: Number(end),
          timezoneOffset: Number(url.searchParams.get("timezone_offset") ?? 0),
          cursor: Number(url.searchParams.get("cursor") ?? 0), count: Number(url.searchParams.get("count") ?? 100),
        };
        validateCloudHistoryQuery(query);
        response.setHeader("cache-control", "no-store");
        const records = await this.provider.cloudHistory(segments[2]!, query);
        return json(response, 200, { records, mediaPlaybackAvailable: false });
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
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "locks"
        && segments[3] === "status-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalModelControls || !this.provider.readT85V0StatusTrial) return json(response, 409, { stage: "admission" });
        if (url.search) return json(response, 400, { stage: "admission" });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 415, { stage: "admission" });
        let body: Record<string, unknown>;
        try { body = await readJson(request); } catch { return json(response, 400, { stage: "admission" }); }
        if (Object.keys(body).length !== 1 || body.consent !== true) return json(response, 400, { stage: "admission" });
        if (this.#recordingIndexJobs.size || this.#nvrTrialJobs.size) return json(response, 409, { stage: "busy" });
        const controller = new AbortController(); this.#recordingIndexJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), 65_000);
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        if (request.aborted || response.destroyed) controller.abort();
        try {
          const result = await this.provider.readT85V0StatusTrial(segments[2]!, controller.signal);
          if (controller.signal.aborted) throw new T85V0StatusError("cancelled");
          json(response, 200, { reportedState: result.reportedState, batteryPercent: result.batteryPercent, physicalConfirmationRequired: true });
        } catch (error) {
          const failure = error instanceof T85V0StatusError ? error : new T85V0StatusError(controller.signal.aborted ? "cancelled" : "session");
          logger.warn("lock_status_trial_failed", `stage=${failure.stage}`);
          if (!response.destroyed) json(response, 409, { stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline); response.removeListener("close", abort);
          request.removeListener("aborted", abort); this.#recordingIndexJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "sensors"
        && segments[3] === "local-motion-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalModelControls || !this.provider.readLocalMotionTrial) return json(response, 409, { stage: "admission" });
        if (!this.state.hasSensor(segments[2]!)) return json(response, 404, { stage: "admission" });
        if (url.search || (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 400, { stage: "admission" });
        let body: Record<string, unknown>;
        try { body = await readJson(request); } catch { return json(response, 400, { stage: "admission" }); }
        if (Object.keys(body).length !== 1 || body.consent !== true) return json(response, 400, { stage: "admission" });
        if (this.#recordingIndexJobs.size || this.#nvrTrialJobs.size) return json(response, 409, { stage: "busy" });
        const controller = new AbortController(); this.#recordingIndexJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), 95_000);
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        try {
          const result = await this.provider.readLocalMotionTrial(segments[2]!, controller.signal);
          if (controller.signal.aborted) throw new LocalMotionError("cancelled");
          json(response, 200, { outcome: result.outcome, candidates: result.candidates });
        } catch (error) {
          const failure = error instanceof LocalMotionError ? error : new LocalMotionError(controller.signal.aborted ? "cancelled" : "session");
          logger.warn("local_motion_trial_failed", `stage=${failure.stage}`);
          if (!response.destroyed) json(response, 409, { stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline); response.removeListener("close", abort);
          request.removeListener("aborted", abort); this.#recordingIndexJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "recording-index-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalModelControls || !this.provider.readRecordingIndexTrial) return json(response, 409, { stage: "admission" });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { stage: "admission" });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 400, { stage: "admission" });
        const body = await readJson(request);
        if (Object.keys(body).length !== 1 || body.consentReadRecordingIndex !== true) return json(response, 400, { stage: "admission" });
        if (this.#recordingIndexJobs.size || this.#nvrTrialJobs.size || this.streams.hasActiveSession(segments[2]!)) return json(response, 409, { stage: "busy" });
        const controller = new AbortController(); this.#recordingIndexJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), Math.min(45_000, this.nvrTrialDeadlineMilliseconds));
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        try {
          const result = await this.provider.readRecordingIndexTrial(segments[2]!, controller.signal);
          if (controller.signal.aborted) throw new C31IndexError("cancelled");
          json(response, 200, { outcome: result.outcome, windowMatches: result.windowMatches,
            ownerMatches: result.ownerMatches, valid: result.valid, invalid: result.invalid, overlapping: result.overlapping });
        } catch (error) {
          const failure = error instanceof C31IndexError ? error : new C31IndexError(controller.signal.aborted ? "cancelled" : "session");
          logger.warn("recording_index_trial_failed", `stage=${failure.stage}`);
          if (!response.destroyed) json(response, 409, { stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline); response.removeListener("close", abort);
          request.removeListener("aborted", abort); this.#recordingIndexJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "nvr-power-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalNvrControls || !this.config.experimentalNvrLive
          || !this.config.experimentalModelControls || !this.provider.testNvrCameraPower) return json(response, 409, { stage: "admission", manualRestoreRequired: false });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { stage: "admission", manualRestoreRequired: false });
        if (url.search) return json(response, 400, { stage: "admission", manualRestoreRequired: false });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 415, { stage: "admission", manualRestoreRequired: false });
        let body: NvrPowerRequest;
        try { body = await readNvrPowerBody(request); } catch { return json(response, 400, { stage: "admission", manualRestoreRequired: false }); }
        if (this.#nvrTrialJobs.size || this.#recordingIndexJobs.size || this.streams.hasActiveSession(segments[2]!)) return json(response, 409, { stage: "busy", manualRestoreRequired: false });
        const controller = new AbortController(); this.#nvrTrialJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), 45_000);
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        if (request.aborted || response.destroyed) controller.abort();
        try {
          const result = await this.provider.testNvrCameraPower(segments[2]!, body, controller.signal);
          if (!response.destroyed) json(response, 200, { outcome: result.outcome, restored: result.restored, physicalConfirmationRequired: true });
        } catch (error) {
          const failure = error instanceof NvrPowerError ? error : new NvrPowerError("restore", true);
          if (!response.destroyed) json(response, 409, { stage: failure.stage, manualRestoreRequired: failure.manualRestoreRequired });
        } finally {
          clearTimeout(deadline); controller.abort(); response.removeListener("close", abort);
          request.removeListener("aborted", abort); this.#nvrTrialJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "nvr-guard-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalNvrControls || !this.config.experimentalNvrLive
          || !this.config.experimentalModelControls || !this.provider.testNvrGuardMode) {
          return json(response, 409, { stage: "admission", manualRestoreRequired: false });
        }
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { stage: "admission", manualRestoreRequired: false });
        if (url.search) return json(response, 400, { stage: "admission", manualRestoreRequired: false });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
          return json(response, 415, { stage: "admission", manualRestoreRequired: false });
        }
        let body: NvrGuardRequest;
        try { body = await readNvrGuardBody(request); }
        catch { return json(response, 400, { stage: "admission", manualRestoreRequired: false }); }
        if (this.#nvrTrialJobs.size || this.#recordingIndexJobs.size || this.streams.hasActiveSession(segments[2]!)) {
          return json(response, 409, { stage: "busy", manualRestoreRequired: false });
        }
        const controller = new AbortController(); this.#nvrTrialJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), 185_000);
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        if (request.aborted || response.destroyed) controller.abort();
        try {
          const result = await this.provider.testNvrGuardMode(segments[2]!, body, controller.signal);
          if (!response.destroyed) json(response, 200, { outcome: result.outcome, restored: result.restored,
            scheduleUnchanged: result.scheduleUnchanged, physicalConfirmationRequired: true });
        } catch (error) {
          const failure = error instanceof NvrGuardError ? error : new NvrGuardError("restore", true);
          if (!response.destroyed) json(response, 409, { stage: failure.stage,
            manualRestoreRequired: failure.manualRestoreRequired });
        } finally {
          clearTimeout(deadline); controller.abort(); response.removeListener("close", abort);
          request.removeListener("aborted", abort); this.#nvrTrialJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "nvr-state-trial" && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        if (!this.config.apiToken || !this.config.experimentalNvrLive || !this.provider.readNvrStateTrial) return json(response, 409, { error: "Experimental NVR state tests are disabled" });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 400, { error: "JSON read-state consent is required" });
        const body = await readJson(request);
        if (Object.keys(body).length !== 1 || body.consentReadState !== true) throw new SyntaxError("Confirm read-state consent without other options");
        if (this.#nvrTrialJobs.size || this.streams.hasActiveSession(segments[2]!)) return json(response, 409, { error: "Stop other video activity before this test" });
        const controller = new AbortController(); this.#nvrTrialJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), Math.min(45_000, this.nvrTrialDeadlineMilliseconds));
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        try {
          const result = await this.provider.readNvrStateTrial(segments[2]!, controller.signal);
          controller.signal.throwIfAborted();
          json(response, 200, result);
        } catch (error) {
          const failure = error instanceof NvrTrialError ? error : new NvrTrialError(controller.signal.aborted ? "cancelled" : "state");
          logger.warn("nvr_state_trial_failed", `stage=${failure.stage}`);
          if (!response.destroyed) json(response, 409, { error: "NVR state test failed", stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline);
          response.removeListener("close", abort); request.removeListener("aborted", abort); this.#nvrTrialJobs.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && ["nvr-live-trial", "doorbell-video-trial"].includes(segments[3]!) && segments.length === 4) {
        response.setHeader("cache-control", "no-store");
        const doorbell = segments[3] === "doorbell-video-trial";
        const reserve = doorbell ? this.provider.reserveDoorbellRtcTrial : this.provider.reserveNvrLiveTrial;
        if (!this.config.apiToken || !(doorbell ? this.config.experimentalDoorbellRtc : this.config.experimentalNvrLive) || !reserve) {
          return json(response, 409, { error: doorbell ? "Experimental standalone doorbell video tests are disabled" : "Experimental NVR video tests are disabled" });
        }
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return json(response, 400, { error: "JSON private-media consent is required" });
        const body = await readJson(request);
        if (Object.keys(body).length !== 1 || body.consentPrivateMedia !== true) throw new SyntaxError("Confirm private-media consent without other options");
        if (this.#nvrTrialJobs.size || this.streams.hasActiveSession(segments[2]!)) return json(response, 409, { error: "Stop other video activity before this test" });
        const controller = new AbortController(); this.#nvrTrialJobs.add(controller);
        const deadline = setTimeout(() => controller.abort(), this.nvrTrialDeadlineMilliseconds);
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort); request.once("aborted", abort);
        let release: (() => Promise<void>) | undefined;
        try {
          release = reserve.call(this.provider, segments[2]!, controller.signal);
          const clip = await this.streams.recordClip(segments[2]!, 10, 75_000, true, controller.signal);
          if (doorbell) await validateStoredMedia(clip, controller.signal, 4096 * 2160);
          controller.signal.throwIfAborted();
          response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": clip.length, "Cache-Control": "no-store" }); response.end(clip);
        } catch (error) {
          const failure = doorbell
            ? error instanceof DoorbellRtcError ? error : new DoorbellRtcError(controller.signal.aborted ? "cancelled" : "video")
            : error instanceof NvrTrialError ? error : new NvrTrialError(controller.signal.aborted ? "cancelled" : "video");
          logger.warn(doorbell ? "doorbell_rtc_trial_failed" : "nvr_live_trial_failed",
            `stage=${failure.stage}${failure instanceof NvrTrialError || failure instanceof DoorbellRtcError ? ` reason=${failure.reason}` : ""}`);
          if (!response.destroyed) json(response, 409, { error: failure.message, stage: failure.stage });
        } finally {
          controller.abort(); clearTimeout(deadline);
          try { await release?.(); }
          catch { logger.warn(doorbell ? "doorbell_rtc_trial_failed" : "nvr_live_trial_failed", "stage=stop"); }
          finally { response.removeListener("close", abort); request.removeListener("aborted", abort); this.#nvrTrialJobs.delete(controller); }
        }
        return;
      }
      if ((request.method === "GET" || request.method === "POST") && segments[0] === "api"
        && segments[1] === "cameras" && segments[3] === "model-control-trial" && segments.length === 4) {
        if (!this.config.apiToken || !this.config.experimentalModelControls) return json(response, 409, { error: "Experimental model controls are disabled" });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        response.setHeader("cache-control", "no-store");
        const actions = this.provider.modelControlTrials?.(segments[2]!) ?? [];
        if (request.method === "GET") return json(response, 200, { actions, experimental: true });
        const trial = parseModelControlTrial(await readJson(request));
        if (!actions.includes(trial.action) || !this.provider.performModelControlTrial) return json(response, 409, { error: "Model control trial unavailable" });
        if (trial.action === "manualLight") {
          const controller = new AbortController();
          const abort = (): void => { if (!response.writableEnded) controller.abort(); };
          response.once("close", abort); request.once("aborted", abort);
          try {
            const result = await this.provider.performModelControlTrial(segments[2]!, trial, controller.signal);
            if (controller.signal.aborted || result.outcome !== "acknowledged") throw new Error("Manual light state unknown");
            return json(response, 200, { outcome: "acknowledged", physicalConfirmationRequired: true });
          }
          catch {
            logger.warn("model_control_trial_failed", "Model control trial failed: model=T81A0 action=manualLight state=unknown");
            if (!response.destroyed) return json(response, 409, { error: "Manual light test did not confirm the light state. Check the light and restore it before trying again." });
          }
          finally { controller.abort(); response.removeListener("close", abort); request.removeListener("aborted", abort); }
          return;
        }
        const result = await this.provider.performModelControlTrial(segments[2]!, trial);
        return json(response, 200, result);
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "settings" && segments.length === 4) {
        if (!this.config.apiToken) return json(response, 401, { code: "unavailable", error: "An API token is required" });
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new SyntaxError("JSON content type is required");
        const change = parseCameraSettingChange(await readJson(request));
        if (!this.provider.setCameraSetting) return json(response, 409, { code: "unavailable", error: "Camera setting unavailable" });
        const controller = new AbortController();
        const abort = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort);
        try {
          const identity = await this.provider.setCameraSetting(segments[2]!, change, controller.signal);
          return json(response, 200, this.state.registerCamera(identity));
        } catch (error) {
          if (error instanceof CameraSettingError) return json(response, error.code === "outcome_unknown" ? 503 : 409, { code: error.code, error: error.message });
          throw error;
        } finally { response.off("close", abort); }
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras"
        && segments[3] === "preferences" && segments.length === 4) {
        if (!this.state.hasCamera(segments[2]!)) return json(response, 404, { error: "Camera not found" });
        const body = await readJson(request);
        if (typeof body.preference !== "string") throw new SyntaxError("Missing camera preference");
        const value = requiredInteger(body.value);
        validateC31Preference(body.preference, value);
        if (!this.provider.setCameraPreference) return json(response, 409, { error: "Camera preference unavailable" });
        const identity = await this.provider.setCameraPreference(segments[2]!, body.preference, value);
        return json(response, 200, this.state.registerCamera(identity));
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "audio-recording" && segments.length === 4
      ) {
        return await this.#cameraAudioRecording(request, segments[2]!, response);
      }
      if (request.method === "POST" && segments[0] === "api" && segments[1] === "cameras" && segments.length === 4
        && ["nvr-live-control", "nvr-view"].includes(segments[3]!)) {
        if (!this.config.apiToken || !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) return json(response, 401, { error: "Unauthorized" });
        return await this.#nvrLiveAction(request, segments[2]!, segments[3] === "nvr-view", response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "streaming-quality" && segments.length === 4
      ) {
        return await this.#cameraStreamingQuality(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "refresh-capabilities" && segments.length === 4
      ) {
        return await this.#cameraCapabilityRefresh(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "guard-mode" && segments.length === 4
      ) {
        return await this.#cameraGuardMode(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "night-vision" && segments.length === 4
      ) {
        return await this.#cameraNightVision(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "siren" && segments.length === 4
      ) {
        return await this.#cameraSiren(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "light" && segments.length === 4
      ) {
        return await this.#cameraLight(request, segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "preset-positions" && segments.length === 4
      ) {
        return await this.#cameraPresetPositions(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "preset-position" && segments.length === 4
      ) {
        return await this.#cameraPresetPosition(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "ai-tracking" && segments.length === 4
      ) {
        return await this.#cameraAiTracking(request, segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "auto-cruise" && segments.length === 4
      ) {
        return await this.#cameraAutoCruise(request, segments[2]!, response);
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
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "event-image" && segments.length === 4
      ) {
        return await this.#eventImage(segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras"
        && (segments[3] === "live.h264" || segments[3] === "live.ts") && segments.length === 4
      ) {
        return await this.#live(segments[2]!, response, segments[3] === "live.ts");
      }
      if (request.method === "GET" && url.pathname === "/api/events") return this.#events(request, response);
      if (request.method === "POST" && url.pathname === "/api/simulate/detection" && this.simulatedProvider) {
        const body = await readJson(request);
        this.simulatedProvider.detectMotion(typeof body.personName === "string" ? body.personName : null);
        return json(response, 202, { accepted: true });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof NvrLiveControlError) return json(response, 409, { error: error.code, code: error.code, stage: error.stage });
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
    return html(response, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Eufy Mega Security</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#202124}main{border:1px solid #ddd;border-radius:12px;padding:1.5rem}img{display:block;max-width:100%;margin:1rem 0;border:1px solid #ddd}label,input,button{display:block;width:100%;box-sizing:border-box}input,button,.button{font:inherit;padding:.75rem;margin:.4rem 0 1rem}.button{display:inline-block;width:auto;border-radius:999px;background:#03a9f4;color:#fff;text-decoration:none}button{cursor:pointer}</style><main><h1>Eufy Mega Security</h1>${message ? `<p role="status">${escapeHtml(message)}</p>` : ""}${content}<p><a href="diagnostics">Create a diagnostic bundle</a></p></main></html>`);
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

  async #storedRecordings(request: IncomingMessage, response: ServerResponse, segments: string[], url: URL): Promise<void> {
    const serial = segments[2]!;
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (this.state.getCamera(serial).storedRecordingsSupported !== true ||
      !this.provider.listStoredRecordings || !this.provider.downloadStoredRecording) {
      return json(response, 501, { error: "Stored recordings are not supported on this camera connection" });
    }
    if (request.method === "GET" && segments.length === 4) {
      const date = url.searchParams.get("date") ?? "";
      validateRecordingDate(date);
      const controller = new AbortController();
      const abort = (): void => { if (!response.writableEnded) controller.abort(); };
      response.once("close", abort);
      try {
        const records = await this.provider.listStoredRecordings(serial, date, controller.signal);
        if (!response.destroyed) return json(response, 200, { records });
      } finally { response.off("close", abort); }
      return;
    }
    const id = segments[4] ?? "";
    if (!/^[a-f0-9]{64}$/.test(id)) return json(response, 404, { error: "Recording not found" });
    const key = `${serial}\0${id}`;
    if (request.method === "POST" && segments.length === 6 && segments[5] === "prepare") {
      const cached = this.#recordings.get(key);
      if (cached) { this.#recordings.put(key, cached); return json(response, 200, { ready: true }); }
      let job = this.#recordingJobs.get(key);
      if (!job) {
        if (this.#recordingJobs.size >= 2) return json(response, 409, { error: "Recording retrieval is busy. Please try again shortly" });
        const controller = new AbortController();
        const promise = this.provider.downloadStoredRecording(serial, id, controller.signal);
        job = { promise, controller, users: new Set() };
        this.#recordingJobs.set(key, job);
        void promise.finally(() => this.#recordingJobs.delete(key)).catch(() => undefined);
      }
      const ownedJob = job;
      ownedJob.users.add(response);
      const detach = (): void => {
        ownedJob.users.delete(response);
        if (!ownedJob.users.size && !response.writableEnded) ownedJob.controller.abort();
      };
      response.once("close", detach);
      try {
        const media = await ownedJob.promise;
        if (response.destroyed) return;
        if (!media) return json(response, 404, { error: "Recording reference expired. Refresh the recording list" });
        this.#recordings.put(key, media);
        return json(response, 200, { ready: true });
      } finally { response.off("close", detach); ownedJob.users.delete(response); }
    }
    if (["GET", "HEAD"].includes(request.method ?? "") && segments.length === 6 && segments[5] === "video") {
      const media = this.#recordings.get(key);
      if (!media) return json(response, 404, { error: "Prepared recording expired. Open the clip again" });
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Accept-Ranges", "bytes");
      const range = request.headers.range;
      if (range) {
        const bytes = recordingByteRange(range, media.length);
        if (!bytes) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${media.length}`); response.end(); return; }
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${bytes.start}-${bytes.end}/${media.length}`);
        response.setHeader("Content-Length", bytes.end - bytes.start + 1);
        response.end(request.method === "HEAD" ? undefined : media.subarray(bytes.start, bytes.end + 1));
      } else {
        response.setHeader("Content-Length", media.length);
        response.end(request.method === "HEAD" ? undefined : media);
      }
      return;
    }
    return json(response, 404, { error: "Not found" });
  }

  async #withNvrSettingSource<T>(request: IncomingMessage, response: ServerResponse, serial: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.config.apiToken || !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) throw new NvrLiveControlError("disabled");
    if (this.streams.hasActiveRecording(serial)) throw new NvrLiveControlError("busy");
    const controller = new AbortController(); const cancel = (): void => controller.abort();
    response.once("close", cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
    const action = (): Promise<T> => { signal.throwIfAborted(); return operation(signal); };
    try {
      return this.streams.hasActiveViewer(serial) ? await this.streams.withActiveViewer(serial, action)
        : await this.streams.withLiveSource(serial, action);
    } catch (error) { throw error instanceof NvrLiveControlError ? error : new NvrLiveControlError("unavailable"); }
  }

  async #nvrLiveAction(request: IncomingMessage, serial: string, view: boolean, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readClosedNvrBody(request);
    if (view) {
      if (Object.keys(body).length !== 1 || !Number.isInteger(body.view) || ![0, 1].includes(Number(body.view))) throw new SyntaxError("Invalid camera view");
      if (!this.provider.setNvrView) throw new NvrLiveControlError("disabled");
      if (this.streams.hasActiveSession(serial) || this.streams.hasActiveRecording(serial)) throw new NvrLiveControlError("busy");
      const identity = await this.provider.setNvrView(serial, body.view as number);
      return json(response, 200, this.state.registerCamera(identity));
    }
    let action: NvrLiveControl;
    if (Object.keys(body).length === 2 && body.kind === "pan" && typeof body.direction === "string" && ["left", "right", "up", "down"].includes(body.direction)) {
      action = { kind: "pan", direction: body.direction as "left" | "right" | "up" | "down" };
    } else if (Object.keys(body).length === 2 && body.kind === "zoom" && typeof body.level === "number" && [1, 2, 3].includes(body.level)) {
      action = { kind: "zoom", level: body.level as 1 | 2 | 3 };
    } else throw new SyntaxError("Invalid NVR control");
    if (!this.provider.performNvrLiveControl) throw new NvrLiveControlError("disabled");
    if (!this.streams.hasActiveViewer(serial) || this.streams.hasActiveRecording(serial)) throw new NvrLiveControlError("busy");
    const abort = new AbortController(); const cancel = (): void => abort.abort(); response.once("close", cancel);
    try {
      const result = await this.streams.withActiveViewer(serial, () => this.provider.performNvrLiveControl!(serial, action, AbortSignal.any([abort.signal, AbortSignal.timeout(90000)])));
      return json(response, 200, result);
    } finally { response.removeListener("close", cancel); }
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

  async #cameraAudioRecording(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const enabled = requiredBoolean(body.enabled);
    if (!this.provider.setCameraAudioRecording) return json(response, 409, { error: "Audio recording control unavailable" });
    const identity = await this.provider.setCameraAudioRecording(serial, enabled);
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraStreamingQuality(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const quality = requiredInteger(body.quality);
    const nvr = this.provider.nvrLiveSettingAdmitted?.(serial) === true;
    if (!nvr && this.state.getCamera(serial).nvrViewOptions?.length) throw new NvrLiveControlError("disabled");
    if (quality < 0 || quality > 4 || quality === 4 && !this.provider.nvrLiveSettingAdmitted?.(serial, quality)
      || nvr && !this.provider.nvrLiveSettingAdmitted?.(serial, quality)) throw new SyntaxError("Unsupported streaming quality");
    if (!this.provider.setCameraStreamingQuality) return json(response, 409, { error: "Streaming quality control unavailable" });
    const operation = (signal?: AbortSignal) => this.provider.setCameraStreamingQuality!(serial, quality, signal);
    const identity = nvr ? await this.#withNvrSettingSource(request, response, serial, operation) : await operation();
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraCapabilityRefresh(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const identity = await this.provider.refreshCameraCapabilities(serial);
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraGuardMode(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const identity = await this.provider.setCameraGuardMode(serial, requiredInteger(body.mode));
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraNightVision(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const mode = requiredInteger(body.mode);
    const nvr = this.provider.nvrLiveSettingAdmitted?.(serial) === true;
    if (!nvr && this.state.getCamera(serial).nvrViewOptions?.length) throw new NvrLiveControlError("disabled");
    const operation = (signal?: AbortSignal) => this.provider.setCameraNightVision(serial, mode, signal);
    const identity = nvr ? await this.#withNvrSettingSource(request, response, serial, operation) : await operation();
    return json(response, 200, this.state.registerCamera(identity));
  }

  async #cameraSiren(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    await this.provider.setCameraSiren(serial, requiredInteger(body.duration));
    return json(response, 200, { ok: true });
  }

  /** Route one state-free manual light action to a supported camera family. */
  async #cameraLight(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    await this.provider.setCameraLight(serial, requiredBoolean(body.enabled));
    return json(response, 200, { ok: true });
  }

  /** Return only preset indexes, occupancy, and the default marker. */
  async #cameraPresetPositions(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const positions = await this.provider.getCameraPresetPositions(serial);
    return json(response, 200, { positions });
  }

  /** Move once to an enabled stored camera position. */
  async #cameraPresetPosition(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    const index = requiredInteger(body.index);
    if (index < 0 || index > 9) throw new SyntaxError("Camera preset index must be between 0 and 9");
    const camera = this.state.getCamera(serial);
    const move = () => this.provider.selectCameraPresetPosition(serial, index);
    if (camera.model === "T817L" && camera.presetPositionControlSupported
      && (!camera.stationSerial || camera.stationSerial === serial)) {
      await this.streams.withLiveSource(serial, move);
    } else {
      await move();
    }
    return json(response, 200, { ok: true });
  }

  /** Send one physically verified AI-tracking action without claiming state. */
  async #cameraAiTracking(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    await this.provider.setCameraAiTracking(serial, requiredBoolean(body.enabled));
    return json(response, 200, { ok: true });
  }

  /** Send one physically verified automatic-cruise action without claiming state. */
  async #cameraAutoCruise(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const body = await readJson(request);
    await this.provider.setCameraAutoCruise(serial, requiredBoolean(body.enabled));
    return json(response, 200, { ok: true });
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
    else if (command === "siren") station = await this.provider.setHomeBaseSiren(serial, requiredInteger(body.duration));
    else return json(response, 404, { error: "Not found" });
    this.state.registerStation(station);
    return json(response, 200, station);
  }

  async #snapshot(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const snapshot = await this.snapshots.read(serial) ?? await this.snapshots.readEvent(serial);
    if (!snapshot) return this.#waitingImage(response);
    response.writeHead(200, {
      "Content-Type": snapshot.info.contentType,
      "Content-Length": snapshot.data.length,
      "Cache-Control": "no-cache",
      ETag: `\"${snapshot.info.revision}\"`,
      "Last-Modified": new Date(snapshot.info.capturedAt).toUTCString(),
    });
    response.end(snapshot.data);
  }

  async #eventImage(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const eventImage = await this.snapshots.readEvent(serial) ?? await this.snapshots.read(serial);
    if (!eventImage) return this.#waitingImage(response);
    response.writeHead(200, {
      "Content-Type": eventImage.info.contentType,
      "Content-Length": eventImage.data.length,
      "Cache-Control": "no-cache",
      ETag: `"${eventImage.info.revision}"`,
      "Last-Modified": new Date(eventImage.info.capturedAt).toUTCString(),
    });
    response.end(eventImage.data);
  }

  #waitingImage(response: ServerResponse): void {
    const image = waitingImage();
    response.writeHead(200, {
      "Content-Type": "image/jpeg", "Content-Length": image.length,
      "Cache-Control": "no-store", "X-Eufy-Image-Source": "waiting",
    });
    response.end(image);
  }

  async #live(serial: string, response: ServerResponse, transport = false): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "This camera was discovered through push events only; livestream control is unavailable" });
    }
    if (transport && !this.state.getCamera(serial).liveAudioSupported) {
      return json(response, 409, { error: "Live audio transport is unavailable for this camera" });
    }
    logger.info("camera_media_request", `model=${safeCameraModel(this.state.getCamera(serial).model)} operation=live_view`);
    if (transport) await this.streams.addTransportClient(serial, response);
    else await this.streams.addClient(serial, response);
  }

  #streamToken(serial: string, response: ServerResponse): void {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Livestream control is unavailable for this camera" });
    }
    const expiresAt = Math.floor(Date.now() / 1_000) + STREAM_TOKEN_LIFETIME_SECONDS;
    const token = this.config.apiToken
      ? createStreamToken(serial, expiresAt, this.config.apiToken)
      : null;
    const media = this.state.getCamera(serial).liveAudioSupported ? "live.ts" : "live.h264";
    const path = `/api/cameras/${encodeURIComponent(serial)}/${media}${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
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
      locks: this.config.experimentalE30Locks ? this.state.listLocks() : [],
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

async function readNvrPowerBody(request: IncomingMessage): Promise<NvrPowerRequest> {
  const text = await readBody(request);
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("Invalid power consent");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.consent !== true || typeof value.originalPower !== "string" || !["on", "off"].includes(value.originalPower)
    || typeof value.target !== "string" || !["on", "off"].includes(value.target)) throw new SyntaxError("Invalid power consent");

  // Accepted values are flat strings/true, so every property token must be one unique allowed key.
  const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map(match => JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))));
  if (keys.length !== 3 || new Set(keys).size !== 3 || !keys.every(key => ["consent", "originalPower", "target"].includes(key))) throw new SyntaxError("Duplicate or unknown power key");
  return { originalPower: value.originalPower as "on" | "off", target: value.target as "on" | "off" };
}

async function readNvrGuardBody(request: IncomingMessage): Promise<NvrGuardRequest> {
  const text = await readBody(request);
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("Invalid guard consent");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.consent !== true || value.target !== "home" || typeof value.timeZone !== "string") {
    throw new SyntaxError("Invalid guard consent");
  }

  // Accepted values are flat, so every property token must be one unique allowed key.
  const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map(match => JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))));
  if (keys.length !== 3 || new Set(keys).size !== 3 || !keys.every(key => ["consent", "target", "timeZone"].includes(key))) {
    throw new SyntaxError("Duplicate or unknown guard key");
  }
  return { target: "home", timeZone: nvrGuardTimeZone(value.timeZone) };
}

/** Parse a finite flat NVR action, rejecting duplicate and unknown property names. */
async function readClosedNvrBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (Buffer.byteLength(text) > 16384) throw new SyntaxError("Request too large");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected an object");
  const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map(match => JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))));
  if (new Set(keys).size !== keys.length || keys.some(key => !["kind", "direction", "level", "view"].includes(key))) throw new SyntaxError("Invalid keys");
  return value as Record<string, unknown>;
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
  if (!Number.isSafeInteger(expiresAt)
    || expiresAt < nowSeconds
    || expiresAt > nowSeconds + STREAM_TOKEN_MAX_FUTURE_SECONDS) return false;
  return equalSecret(token, createStreamToken(serial, expiresAt, apiToken));
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
