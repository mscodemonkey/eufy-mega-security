/**
 * Identifies the exact Outdoor Cam E210 trial without granting a media route or
 * write authority. Catalogue admission, provider routing and HA projection use
 * this shared identity check; the provider owns all runtime device state.
 */

/** Match only the reported security camera identity, never a model or type alias. */
export function isT8442Camera(device: { readonly category: string | null; readonly model?: string; readonly deviceType: number | null }): boolean {
  return device.category === "eufy_security" && device.model?.toUpperCase() === "T8442" && device.deviceType === 46;
}
