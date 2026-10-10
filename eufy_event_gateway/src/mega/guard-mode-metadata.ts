/**
 * Describes custom guard-mode metadata without retaining account labels.
 * Inventory owns parameter 1256. The provider consumes only this structural
 * diagnostic until an explicit label-to-mode contract has been established.
 */

const KNOWN_FIELDS = new Set(["id", "mode", "mode_id", "mode_type", "name", "mode_name", "custom_modes", "modes", "3", "4", "5"]);
const ID_FIELDS = new Set(["id", "mode", "mode_id", "mode_type"]);

/**
 * Preserve nested mode evidence using document-local aliases instead of names.
 * Only known mode IDs survive as values. Explicit cap markers distinguish
 * incomplete evidence from an absent field; tokens cannot identify labels
 * across documents and must never be used to choose a security mode.
 */
export function guardModeMetadataStructure(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value !== "string") return "invalid";
  if (value.length > 16_384) return "oversized";
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return "invalid";
    try { parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")); }
    catch { return "invalid"; }
  }
  const fields = new Map<string, string>();
  const texts = new Map<string, string>();
  let visited = 0;
  let exhausted = false;
  const alias = (table: Map<string, string>, text: string, prefix: string): string => {
    let token = table.get(text);
    if (token === undefined) {
      token = `${prefix}${table.size + 1}`;
      table.set(text, token);
    }
    return token;
  };
  const inspect = (node: unknown, depth: number, key?: string): string => {
    if (++visited > 128) {
      exhausted = true;
      return "capped:nodes";
    }
    if (node === null) return "null";
    if (typeof node === "boolean") return "boolean";
    if (typeof node === "number") {
      return key !== undefined && ID_FIELDS.has(key) && Number.isInteger(node) && node >= 0 && node <= 5
        ? `num:${node}` : "number";
    }
    if (typeof node === "string") {
      return key !== undefined && ID_FIELDS.has(key) && /^\d{1,3}$/.test(node) && Number(node) <= 5
        ? `str:${Number(node)}` : alias(texts, node, "text");
    }
    if (depth > 4) return "capped:depth";
    const array = Array.isArray(node);
    const entries = array ? node : Object.entries(node as Record<string, unknown>);
    const children: string[] = [];
    for (const entry of entries.slice(0, 16)) {
      if (array) children.push(inspect(entry, depth + 1));
      else {
        const [field, child] = entry as [string, unknown];
        const safeKey = KNOWN_FIELDS.has(field) ? field : alias(fields, field, "field");
        children.push(`${safeKey}:${inspect(child, depth + 1, field)}`);
      }
      if (exhausted) break;
    }
    if (entries.length > 16) children.push("capped:entries");
    return `${array ? "[" : "{"}${children.join(",")}${array ? "]" : "}"}`;
  };
  const structure = inspect(parsed, 0);
  return structure.length > 2_048 ? "capped:length" : structure;
}

/**
 * Inspect bounded JSON or base64 JSON without exposing names or arbitrary keys.
 * Numeric/text ID lists contain distinct mode values 3 to 5, never counts.
 * Array counts distinguish entry types and indicate when traversal was capped.
 */
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
  const idTypes = new Set<string>();
  const textIds = new Set<number>();
  const otherIds = new Set<number>();
  let objects = 0;
  let arrays = 0;
  let arrayObjects = 0;
  let arrayNumbers = 0;
  let arrayTexts = 0;
  let arrayOther = 0;
  let arrayEntriesCapped = false;
  let entriesWithId = 0;
  let unlistedTextFields = 0;
  let visited = 0;
  const inspect = (node: unknown, depth: number, inArray: boolean): void => {
    if (++visited > 128) { arrayEntriesCapped = true; return; }
    if (depth > 4) return;
    if (Array.isArray(node)) {
      arrays++;
      if (node.length > 16) arrayEntriesCapped = true;
      for (const child of node.slice(0, 16)) {
        if (visited >= 128) { arrayEntriesCapped = true; break; }
        if (child !== null && typeof child === "object" && !Array.isArray(child)) arrayObjects++;
        else if (typeof child === "number") arrayNumbers++;
        else if (typeof child === "string") arrayTexts++;
        else arrayOther++;
        inspect(child, depth + 1, true);
      }
    } else if (node !== null && typeof node === "object") {
      objects++;
      let hasId = false;
      for (const [key, child] of Object.entries(node).slice(0, 16)) {
        if (KNOWN_FIELDS.has(key)) fields.add(key);
        else if (typeof child === "string") unlistedTextFields++;
        if (ID_FIELDS.has(key)) {
          const numericText = typeof child === "string" && /^\d{1,3}$/.test(child);
          const value = typeof child === "number" ? child : numericText ? Number(child) : null;
          idTypes.add(`${key}:${typeof child === "number" ? "number" : numericText ? "numeric_text" : typeof child === "string" ? "text" : "other"}`);
          if (value !== null && Number.isInteger(value)) {
            hasId = true;
            if (![3, 4, 5].includes(value)) otherIds.add(value);
            else if (typeof child === "number") ids.add(value);
            else textIds.add(value);
          }
        }
        inspect(child, depth + 1, false);
      }
      if (hasId && inArray) entriesWithId++;
    }
  };
  inspect(parsed, 0, false);
  const list = (values: Iterable<number | string>): string => {
    const sorted = [...values].sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    return sorted.join(",") || "none";
  };
  const root = Array.isArray(parsed) ? "array" : parsed !== null && typeof parsed === "object" ? "object" : "scalar";

  // numeric_ids_3_to_5 lists distinct numeric values, not a count. The later
  // fields show how many entries carried an ID and whether IDs arrive as text.
  return [
    `root=${root} objects=${objects} arrays=${arrays} fields=${[...fields].sort().join(",") || "none"} numeric_ids_3_to_5=${list(ids)}`,
    `array_objects=${arrayObjects} array_numbers=${arrayNumbers} array_texts=${arrayTexts} array_other=${arrayOther} array_entries_capped=${arrayEntriesCapped} entries_with_id=${entriesWithId}`,
    `id_types=${list(idTypes)} text_ids_3_to_5=${list(textIds)} other_ids=${list([...otherIds].filter((value) => value >= 0 && value <= 255))}`,
    `unlisted_text_fields=${unlistedTextFields}`,
  ].join(" ");
}
