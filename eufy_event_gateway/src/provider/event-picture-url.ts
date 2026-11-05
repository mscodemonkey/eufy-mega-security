/**
 * Selects one event image from Android's comma-separated picture field. The
 * provider owns snapshot publication, and MegaClient independently validates
 * the selected host. Raw push identity and deduplication remain unchanged.
 */

/**
 * Choose the first nonempty source entry for the gateway's single snapshot.
 * Native notifications may combine images in completion order. Literal commas
 * separate entries, while percent-encoded commas remain part of a URL. Bounds
 * reject the whole list, and an invalid first choice never selects another host.
 */
export function eventPictureUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32_768) return null;
  const entries = value.split(",");
  if (entries.length > 8) return null;
  const selected = entries.map(entry => entry.trim()).find(entry => entry.length > 0);
  if (!selected || selected.length > 8_192 || /[\s\x00-\x1f\x7f]/u.test(selected)) return null;
  return selected;
}
