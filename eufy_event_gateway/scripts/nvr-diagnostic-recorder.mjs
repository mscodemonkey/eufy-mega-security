/**
 * Records explicitly requested NVR data-channel evidence into a private file.
 * The research wrapper owns this recorder and its output directory. Offline
 * diagnostics consume records without requiring an account or vendor module.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

const CHANNELS = ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"];
const STATES = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed", "checking", "completed", "gathering", "complete"]);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_RECORDS = 200_000;

/**
 * Owns an exclusive, size-limited capture until close or its first limit.
 * Raw packet/frame bodies are private media, not redacted diagnostic logs.
 * Limits seal the file, without altering the research peer's packet handling.
 */
export class NvrDiagnosticRecorder {
  #fd;
  #started;
  #timer;
  #bytes = 8;
  #records = 0;
  #reason = "completed";
  #counts = { received: 0, sent: 0, frame: 0, state: 0 };

  /** Open a new private file; callers must own the enclosing private directory. */
  constructor(path, seconds = 30, now = () => performance.now()) {
    if (![30, 60].includes(seconds)) throw new Error("Capture duration must be 30 or 60 seconds");
    this.seconds = seconds;
    this.now = now;
    this.#fd = openSync(path, "wx", 0o600);
    try { this.#write(Buffer.from("EUFYNVR1")); }
    catch { closeSync(this.#fd); this.#fd = undefined; throw new Error("Cannot initialize private capture"); }
  }

  /** Record a complete data-channel message before receive-side interpretation. */
  packet(direction, label, data) {
    const channel = CHANNELS.indexOf(label);
    if (!["received", "sent"].includes(direction) || channel < 0) return;
    this.#record(direction === "received" ? 0 : 1, channel, data, direction);
  }

  /** Record an oracle-produced frame unchanged, including audio and control replies. */
  frame(channel, data) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) return;
    this.#record(2, channel, data, "frame");
  }

  /** Retain allowlisted connection states without SDP, candidates or relay secrets. */
  state(scope, value) {
    if (["peer", "ice"].includes(scope) && STATES.has(value)) {
      this.#record(3, scope === "peer" ? 0 : 1, Buffer.from(value), "state");
    }
  }

  /** Close once and return safe counts, including any reason for incomplete evidence. */
  close() {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#fd !== undefined) { closeSync(this.#fd); this.#fd = undefined; }
    return { bytes: this.#bytes, records: this.#records, counts: { ...this.#counts }, stopReason: this.#reason };
  }

  #write(data) {
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(this.#fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error("Private capture write failed");
      offset += written;
    }
  }

  #record(kind, channel, value, count) {
    if (this.#fd === undefined) return;
    const now = this.now();
    if (!Number.isFinite(now)) return;
    if (this.#started === undefined) {
      this.#started = now;
      this.#timer = setTimeout(() => this.#stop("duration_limit"), this.seconds * 1000);
      this.#timer.unref();
    }
    const elapsed = Math.max(0, now - this.#started);
    if (elapsed >= this.seconds * 1000) { this.#stop("duration_limit"); return; }
    if (!(value instanceof Uint8Array)) return;
    if (value.length > MAX_RECORD || this.#bytes + 16 + value.length > MAX_BYTES || this.#records >= MAX_RECORDS) {
      this.#stop("size_limit"); return;
    }
    const header = Buffer.alloc(16);
    header.writeUInt32LE(value.length);
    header.writeDoubleLE(elapsed, 4);
    header[12] = kind;
    header[13] = channel;
    try {
      this.#write(header);
      this.#write(value);
      this.#bytes += 16 + value.length;
      this.#records++;
      this.#counts[count]++;
    } catch { this.#stop("write_failed"); }
  }

  #stop(reason) { this.#reason = reason; this.close(); }
}
