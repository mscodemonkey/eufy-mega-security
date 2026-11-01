/**
 * Copies application transport boundaries into the optional private history.
 * Socket owners retain lifecycle, callbacks and protocol decisions. These taps
 * do not open connections, consume streams or turn recording errors into errors
 * on the observed transport. TLS and RTC taps see application-decrypted bytes.
 */
import { randomUUID } from "node:crypto";
import { errorMonitor } from "node:events";
import { recordRaw, rawHistoryEnabled } from "./raw-history.js";

function binary(value: unknown): Buffer | undefined {
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(item => Buffer.isBuffer(item))) return Buffer.concat(value);
  return undefined;
}

/**
 * Tap one owned emitter before its parser listeners. The returned ID associates
 * connection observations only. Outgoing records mean attempted dispatch, not
 * acknowledgement. MQTT packet events are post-MQTT framing, pre-vendor decode.
 */
export function observeRawSocket(socket: object, boundary: string, kind: "udp" | "tls" | "tcp" | "ws" | "mqtt"): string {
  const connection = randomUUID();
  if (!rawHistoryEnabled()) return connection;
  const record = (direction: "send" | "receive" | "state", value: unknown, metadata?: unknown): void => {
    try {
      const bytes = binary(value);
      recordRaw({ boundary, connection, direction, metadata: bytes ? metadata : { value, detail: metadata } }, bytes);
    } catch { recordRaw({ boundary, connection, direction: "state", metadata: { observationFailed: true } }); }
  };
  const emitter = socket as { on?: (name: string | symbol, callback: (...args: unknown[]) => void) => unknown;
    prependListener?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    once?: (name: string, callback: () => void) => unknown };
  record("state", undefined, { event: "created", kind });
  const listen = emitter.prependListener ?? emitter.on;
  listen?.call(socket, (kind === "tls" || kind === "tcp") ? "data" : kind === "mqtt" ? "packetreceive" : "message",
    (data: unknown, detail: unknown) => record("receive", data, detail));
  emitter.once?.call(socket, "close", () => record("state", undefined, { event: "closed" }));
  emitter.on?.call(socket, errorMonitor, () => record("state", undefined, { event: "transport_error" }));
  if (kind === "mqtt") {
    listen?.call(socket, "packetsend", (packet: unknown) => record("send", packet));
    return connection;
  }
  const object = socket as unknown as Record<string, unknown>;
  const method = (kind === "tls" || kind === "tcp") ? "write" : "send";
  const original = object[method];
  if (typeof original === "function") {
    object[method] = function(this: unknown, ...args: unknown[]): unknown {
      try {
        let bytes = binary(args[0]);
        if (kind === "udp" && bytes && typeof args[1] === "number" && typeof args[2] === "number" && args.length >= 4) {
          bytes = bytes.subarray(args[1], args[1] + args[2]);
        }
        record("send", bytes, args.slice(1).filter(value => typeof value === "string" || typeof value === "number"));
      } catch { record("state", undefined, { observationFailed: true }); }
      return Reflect.apply(original, this, args);
    };
  }
  return connection;
}

/**
 * Associate a bounded-response consumer with its request before parsing. Bodies
 * cancelled by the caller are explicitly incomplete. This wraps the same reader,
 * with no tee, detached consumer or unbounded second download.
 */
export function observeRawFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!rawHistoryEnabled()) return fetcher(input, init);
    const connection = randomUUID();
    const boundary = "cloud_http";
    recordRaw({ boundary, connection, direction: "send", metadata: { url: String(input),
      method: init?.method ?? "GET", headers: init?.headers } }, binary(init?.body));
    let response: Response;
    try { response = await fetcher(input, init); }
    catch (error) { recordRaw({ boundary, connection, direction: "state", metadata: { event: "request_failed" } }); throw error; }
    recordRaw({ boundary, connection, direction: "receive", metadata: { status: response.status, headers: [...response.headers] } });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            recordRaw({ boundary, connection, direction: "state", metadata: { event: "body_complete" } });
            controller.close(); reader.releaseLock();
          } else {
            recordRaw({ boundary, connection, direction: "receive" }, chunk.value);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          recordRaw({ boundary, connection, direction: "state", metadata: { event: "body_failed" } });
          controller.error(error);
        }
      },
      async cancel(reason) {
        recordRaw({ boundary, connection, direction: "state", metadata: { event: "body_cancelled_incomplete" } });
        await reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(observed, "url", { value: response.url });
    Object.defineProperty(observed, "redirected", { value: response.redirected });
    return observed;
  };
}
