/**
 * Validates operator-selected HomeBase LAN destinations for the provider.
 * Process configuration owns these immutable hints. Session construction consumes
 * them only for an already discovered station; peer authentication, admission and
 * UDP response identity remain owned by the existing transport boundaries.
 */
import { isIP } from "node:net";

/** One explicit destination hint, never a replacement for a station identity. */
export interface HomeBaseAddress {
  readonly serial: string;
  readonly address: string;
}

/** Parse a finite JSON list, rejecting ambiguous selectors without echoing private values. */
export function parseHomeBaseAddresses(value: string | undefined): readonly HomeBaseAddress[] {
  if (value === undefined || value === "") return [];
  const invalid = (): Error => new Error("HomeBase local addresses must be a JSON list of unique serial and private IPv4 address pairs");
  if (value.length > 8_192) throw invalid();
  let rows: unknown;
  try { rows = JSON.parse(value); } catch { throw invalid(); }
  if (!Array.isArray(rows) || rows.length > 32) throw invalid();
  const seen = new Set<string>();
  return Object.freeze(rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid();
    const entry = row as Record<string, unknown>;
    if (Object.keys(entry).length !== 2 || typeof entry.serial !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.serial) || seen.has(entry.serial)
      || typeof entry.address !== "string" || !privateIpv4(entry.address)) throw invalid();
    seen.add(entry.serial);
    return Object.freeze({ serial: entry.serial, address: entry.address });
  }));
}

/**
 * Select a hint only for the same discovered HomeBase, retaining every other route.
 * A hint does not supply credentials, admit a camera, change ownership, or enable a
 * control. Unknown selectors stay dormant until a matching station is discovered.
 */
export function homeBaseLocalAddress(
  peer: { readonly serial: string; readonly model: string; readonly deviceType: number | null;
    readonly category: string | null; readonly parentSerial: string; readonly localAddress: string | null },
  hints: readonly HomeBaseAddress[],
): string | null {
  const station = peer.category === "eufy_security" && (!peer.parentSerial || peer.parentSerial === peer.serial)
    && (peer.model.startsWith("T8010") && peer.deviceType === 0
      || peer.model.startsWith("T8030") && peer.deviceType === 18
      || peer.model === "T9000" && peer.deviceType === 27);
  if (!station) return peer.localAddress;
  return hints.find(hint => hint.serial === peer.serial)?.address ?? peer.localAddress;
}

/** Keep configured destinations within the transport's existing private IPv4 scope. */
function privateIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || first === 172 && second! >= 16 && second! <= 31
    || first === 192 && second === 168;
}
