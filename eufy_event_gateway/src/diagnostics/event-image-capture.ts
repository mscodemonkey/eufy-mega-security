/**
 * Keeps opt-in failed event responses in process memory for private analysis.
 * The composition root owns this bounded session and its expiry timer. Only the
 * authenticated diagnostic export consumes bodies; ordinary diagnostics never do.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createLogger } from "../logging.js";
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

interface Sample {
  readonly body: Buffer;
  readonly sha256: string;
  readonly metadata: EventImageContext & Partial<EventImageResponseMetadata> & { capturedOffsetMinutes: number };
}

/**
 * Owns one optional, non-persistent capture session and its private buffers.
 * Inserts are synchronous across camera queues, with one sample per family.
 * Capture closes after 30 minutes; export and retention end after 60 minutes.
 * The root must close the session on shutdown. No camera or network work occurs.
 */
export class EventImageCapture {
  readonly #samples = new Map<string, Sample>();
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

  /** Return counts and deadlines only, suitable for authenticated status polling. */
  status() {
    this.#expire();
    return {
      state: this.#state, sampleCount: this.#samples.size,
      acceptingSamples: this.#state === "active" && this.#elapsed() < CAPTURE_WINDOW,
      captureEndsAt: new Date(this.#startedAt + CAPTURE_WINDOW).toISOString(),
      expiresAt: new Date(this.#startedAt + EXPORT_WINDOW).toISOString(),
      dropped: this.#dropped, skippedOversize: this.#skippedOversize,
    };
  }

  /** Build a retryable sensitive archive; null means no retained samples remain. */
  archive(): { schemaVersion: number; samples: { bodyBase64: string; sha256: string; length: number; metadata: Sample["metadata"] }[] } | null {
    this.#expire();
    if (this.#state !== "active" || !this.#samples.size) return null;
    return {
      schemaVersion: 1,
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
    this.#bytes = 0;
    this.#state = state;
  }
}
