/**
 * Keeps opt-in failed event responses in process memory for private analysis.
 * The composition root owns this bounded session and its expiry timer. Only the
 * authenticated diagnostic export consumes bodies and failure references.
 * Ordinary diagnostics consume counts only.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createLogger } from "../logging.js";
import { MediaHttpError, type MediaHttpFailure } from "../mega/media-request-diagnostic.js";
import { safeCameraModel } from "../domain/safe-camera-model.js";

const logger = createLogger("provider");
const CAPTURE_WINDOW = 30 * 60_000;
const EXPORT_WINDOW = 60 * 60_000;
const BODY_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 6 * 1024 * 1024;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/octet-stream", "application/json", "text/html"]);
const CONTENT_ENCODINGS = new Set(["identity", "gzip", "deflate", "br", "zstd"]);

/** Non-identifying context copied from the camera's own inventory row. */
export interface EventImageContext {
  readonly model?: string;
  readonly deviceType?: number;
  readonly topology?: "direct" | "attached";
}

/** Closed HTTP metadata from the final response, alongside fetch-decoded bytes. */
export interface EventImageResponseMetadata {
  readonly status: number;
  readonly contentType: string;
  readonly contentEncoding: string;
  readonly declaredLength?: number;
  readonly bodyRepresentation: "fetch-body";
}

/** Normalize response headers without retaining arbitrary upstream text. */
export function eventImageResponseMetadata(response: Response): EventImageResponseMetadata {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "other";
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
  const declared = response.headers.get("content-length");
  const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : NaN;
  return {
    status: response.status,
    contentType: CONTENT_TYPES.has(contentType) ? contentType : "other",
    contentEncoding: CONTENT_ENCODINGS.has(contentEncoding) ? contentEncoding : "other",
    ...(Number.isSafeInteger(length) && length >= 0 ? { declaredLength: length } : {}),
    bodyRepresentation: "fetch-body",
  };
}

/** Private values hashed only for matching within one capture session. */
export interface EventImageReferences {
  readonly cameraSerial?: string;
  readonly stationSerial?: string;
  readonly filePath?: string | null;
  readonly pictureUrl?: string | null;
}

/** A terminal HTTP receipt without a response body or reusable device identity. */
export interface EventImageDownloadFailure {
  readonly context: EventImageContext;
  readonly failure: MediaHttpFailure;
  readonly capturedOffsetMinutes: number;
  readonly references: Readonly<Partial<Record<"camera" | "station" | "recording" | "picture", string>>>;
}

interface Sample {
  readonly body: Buffer;
  readonly sha256: string;
  readonly metadata: EventImageContext & Partial<EventImageResponseMetadata> & { capturedOffsetMinutes: number };
}

/**
 * Owns one optional, non-persistent capture session and its private buffers.
 * Inserts are synchronous across camera queues, with one body sample per family
 * and up to 16 distinct HTTP receipts. Reference salts last only for this session.
 * Capture closes after 30 minutes; export and retention end after 60 minutes.
 * The root must close the session on shutdown. No camera or network work occurs.
 */
export class EventImageCapture {
  readonly #samples = new Map<string, Sample>();
  readonly #downloadFailures: EventImageDownloadFailure[] = [];
  readonly #referenceSalt = randomBytes(32);
  readonly #startedAt = Date.now();
  readonly #startedMonotonic: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  #state: "active" | "expired" | "cleared" = "active";
  #bytes = 0;
  #dropped = 0;
  #skippedOversize = 0;

  /** The injected clock permits deterministic expiry tests without network work. */
  constructor(private readonly monotonicNow: () => number = () => performance.now()) {
    this.#startedMonotonic = monotonicNow();
    this.#timer = setTimeout(() => this.#end("expired"), EXPORT_WINDOW);
    this.#timer.unref();
  }

  /** Copy eligible decode input before the decoder can mutate it; never retain success. */
  prepare(body: Buffer): Buffer | null {
    try {
      if (!this.#accepting()) return null;
      if (body.length > BODY_LIMIT) return null;
      return Buffer.from(body);
    } catch {
      logger.warn("event_image_capture_unavailable", "Failed event-image evidence could not be captured");
      return null;
    }
  }

  /** Retain a failed response if eligible; capture failures never replace decode errors. */
  capture(body: Buffer, context: EventImageContext = {}, response?: EventImageResponseMetadata): void {
    try {
      if (!this.#accepting()) return;
      if (body.length > BODY_LIMIT) { this.#skippedOversize++; return; }
      const model = context.model ? safeCameraModel(context.model) : "unknown";
      const deviceType = Number.isSafeInteger(context.deviceType) && context.deviceType! >= 0 && context.deviceType! <= 65_535
        ? context.deviceType : undefined;
      const topology = context.topology === "attached" || context.topology === "direct" ? context.topology : undefined;
      const key = `${model}/${deviceType ?? "unknown"}/${topology ?? "unknown"}`;
      const sha256 = createHash("sha256").update(body).digest("hex");
      if ([...this.#samples.values()].some((sample) => sample.sha256 === sha256)) return;
      if (this.#samples.has(key) || this.#samples.size >= 4 || this.#bytes + body.length > TOTAL_LIMIT) {
        this.#dropped++; return;
      }
      this.#samples.set(key, {
        body: Buffer.from(body), sha256,
        metadata: {
          ...(model !== "unknown" ? { model } : {}),
          ...(deviceType !== undefined ? { deviceType } : {}),
          ...(topology ? { topology } : {}),
          ...(response ? {
            ...(Number.isInteger(response.status) && response.status >= 200 && response.status <= 299 ? { status: response.status } : {}),
            contentType: CONTENT_TYPES.has(response.contentType) ? response.contentType : "other",
            contentEncoding: CONTENT_ENCODINGS.has(response.contentEncoding) ? response.contentEncoding : "other",
            ...(Number.isSafeInteger(response.declaredLength) && response.declaredLength! >= 0 ? { declaredLength: response.declaredLength } : {}),
            bodyRepresentation: "fetch-body" as const,
          } : {}),
          capturedOffsetMinutes: Math.max(0, Math.floor(this.#elapsed() / 60_000)),
        },
      });
      this.#bytes += body.length;
    } catch {
      logger.warn("event_image_capture_unavailable", "Failed event-image evidence could not be captured");
    }
  }

  /**
   * Retain a bounded terminal HTTP receipt without fetching or saving an error body.
   * Only the client's typed HTTP error qualifies. HMAC-SHA256 uses a random salt
   * exported privately with this session, domain plus NUL plus the exact value.
   * Matching references establish identity, not that the app fetched equal bytes.
   */
  captureDownloadFailure(error: unknown, context: EventImageContext, values: EventImageReferences): void {
    try {
      if (!this.#accepting() || !(error instanceof MediaHttpError)) return;
      const failure = error.failure;
      if (!Number.isInteger(failure.status) || failure.status < 400 || failure.status > 599
          || !Number.isInteger(failure.attempts) || failure.attempts < 1 || failure.attempts > 5) return;
      const references: Partial<Record<"camera" | "station" | "recording" | "picture", string>> = {};
      for (const [domain, value] of [["camera", values.cameraSerial], ["station", values.stationSerial],
        ["recording", values.filePath], ["picture", values.pictureUrl]] as const) {
        if (typeof value === "string" && value.length > 0 && value.length <= 2_048) {
          references[domain] = createHmac("sha256", this.#referenceSalt).update(domain + "\0" + value).digest("hex");
        }
      }
      if (this.#downloadFailures.some(value => JSON.stringify(value.references) === JSON.stringify(references)
          && JSON.stringify(value.failure) === JSON.stringify(failure))) return;
      if (this.#downloadFailures.length >= 16) { this.#dropped++; return; }
      const model = context.model ? safeCameraModel(context.model) : "unknown";
      this.#downloadFailures.push({
        context: {
          ...(model !== "unknown" ? { model } : {}),
          ...(Number.isSafeInteger(context.deviceType) && context.deviceType! >= 0 && context.deviceType! <= 65_535 ? { deviceType: context.deviceType } : {}),
          ...(context.topology === "direct" || context.topology === "attached" ? { topology: context.topology } : {}),
        },
        failure: { ...failure }, capturedOffsetMinutes: Math.max(0, Math.floor(this.#elapsed() / 60_000)), references,
      });
    } catch {
      logger.warn("event_image_capture_unavailable", "Failed event-image evidence could not be captured");
    }
  }

  /** Return counts and deadlines only, suitable for authenticated status polling. */
  status() {
    this.#expire();
    return {
      state: this.#state, sampleCount: this.#samples.size, downloadFailureCount: this.#downloadFailures.length,
      acceptingSamples: this.#state === "active" && this.#elapsed() < CAPTURE_WINDOW,
      captureEndsAt: new Date(this.#startedAt + CAPTURE_WINDOW).toISOString(),
      expiresAt: new Date(this.#startedAt + EXPORT_WINDOW).toISOString(),
      dropped: this.#dropped, skippedOversize: this.#skippedOversize,
    };
  }

  /** Build a retryable sensitive archive; null means no retained samples remain. */
  archive(): { schemaVersion: number; referenceSalt?: string; downloadFailures?: EventImageDownloadFailure[]; samples: { bodyBase64: string; sha256: string; length: number; metadata: Sample["metadata"] }[] } | null {
    this.#expire();
    if (this.#state !== "active" || (!this.#samples.size && !this.#downloadFailures.length)) return null;
    return {
      schemaVersion: this.#downloadFailures.length ? 2 : 1,
      ...(this.#downloadFailures.length ? {
        referenceSalt: this.#referenceSalt.toString("hex"),
        downloadFailures: this.#downloadFailures.map(value => ({ ...value, context: { ...value.context }, failure: { ...value.failure }, references: { ...value.references } })),
      } : {}),
      samples: [...this.#samples.values()].map((sample) => ({
        bodyBase64: sample.body.toString("base64"), sha256: sample.sha256,
        length: sample.body.length, metadata: { ...sample.metadata },
      })),
    };
  }

  /** Erase retained buffers and end this process session, including its timer. */
  close(): void { this.#end("cleared"); }

  #elapsed(): number {
    return Math.max(this.monotonicNow() - this.#startedMonotonic, Date.now() - this.#startedAt);
  }

  #accepting(): boolean {
    this.#expire();
    return this.#state === "active" && this.#elapsed() < CAPTURE_WINDOW;
  }

  #expire(): void {
    if (this.#state === "active" && this.#elapsed() >= EXPORT_WINDOW) this.#end("expired");
  }

  #end(state: "expired" | "cleared"): void {
    clearTimeout(this.#timer);
    for (const sample of this.#samples.values()) sample.body.fill(0);
    this.#samples.clear();
    this.#downloadFailures.length = 0;
    this.#referenceSalt.fill(0);
    this.#bytes = 0;
    this.#state = state;
  }
}
