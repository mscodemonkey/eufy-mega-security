/**
 * Carries a camera's own capture time with a media chunk, without changing its bytes.
 * A source marks the exact Buffer it writes; a viewer that receives that same
 * object can read the mark. Copies and concatenations carry none, so a reader
 * falls back to its own clock. Marks are held weakly and never leave the process.
 */

const marks = new WeakMap<Buffer, number>();

/** Mark one written chunk with its source time in milliseconds on the camera's clock. */
export function markSourceTime(data: Buffer, milliseconds: number): void {
  if (Number.isFinite(milliseconds)) marks.set(data, milliseconds);
}

/** Return the source time a chunk was written with, if it is the marked object itself. */
export function sourceTime(data: Buffer): number | undefined {
  return marks.get(data);
}
