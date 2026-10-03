/**
 * Bounds untrusted cloud and media bodies before their client parses them.
 * The caller owns cancellation and authorization. This module retains no data
 * and rejects oversized, empty or truncated responses without exposing bytes.
 */

/** Read a finite response body and check a supplied HTTP length before parsing. */
export async function readBoundedResponse(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid response size limit");

  // Fetch exposes decompressed bytes while Content-Length can describe the
  // compressed transfer. Only compare exact lengths for identity encoding.
  const encoding = response.headers.get("content-encoding");
  const declared = !encoding || encoding === "identity" ? response.headers.get("content-length") : null;
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
    await response.body?.cancel();
    throw new Error("Cloud response has an invalid size");
  }
  if (!response.body) throw new Error("Cloud response is empty");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Cloud response exceeds the size limit");
      chunks.push(Buffer.from(chunk.value));
    }
    if (bytes === 0 || declared !== null && bytes !== Number(declared)) throw new Error("Cloud response is empty or truncated");
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
