/**
 * Describes custom guard-mode metadata without retaining account labels.
 * Inventory owns parameter 1256. The provider consumes only this structural
 * diagnostic until an explicit label-to-mode contract has been established.
 */

const KNOWN_FIELDS = new Set(["id", "mode", "mode_id", "mode_type", "name", "mode_name", "custom_modes", "modes", "3", "4", "5"]);

/** Inspect bounded JSON or base64 JSON, exposing no names or arbitrary keys. */
export function guardModeMetadataShape(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value !== "string" || value.length > 16_384) return "invalid";
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return "invalid";
    try { parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")); }
    catch { return "invalid"; }
  }
  const fields = new Set<string>();
  const ids = new Set<number>();
  let objects = 0;
  let arrays = 0;
  let visited = 0;
  const inspect = (node: unknown, depth: number): void => {
    if (++visited > 128 || depth > 4) return;
    if (Array.isArray(node)) {
      arrays++;
      for (const child of node.slice(0, 16)) inspect(child, depth + 1);
    } else if (node !== null && typeof node === "object") {
      objects++;
      for (const [key, child] of Object.entries(node).slice(0, 16)) {
        if (KNOWN_FIELDS.has(key)) fields.add(key);
        if (["id", "mode", "mode_id", "mode_type"].includes(key) && typeof child === "number" && [3, 4, 5].includes(child)) ids.add(child);
        inspect(child, depth + 1);
      }
    }
  };
  inspect(parsed, 0);
  const root = Array.isArray(parsed) ? "array" : parsed !== null && typeof parsed === "object" ? "object" : "scalar";
  return `root=${root} objects=${objects} arrays=${arrays} fields=${[...fields].sort().join(",") || "none"} explicit_ids=${[...ids].sort().join(",") || "none"}`;
}
