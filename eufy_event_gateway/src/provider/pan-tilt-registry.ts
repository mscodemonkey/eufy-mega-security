/** Registry of qualified directional controllers; existing C37 and preset paths remain separate. */
import type { MegaInventoryDevice } from "./inventory-normalization.js";
import type { PpcsStreamRoute } from "./eufy-provider.js";
import type { PanTiltController, PpcsControlTransport } from "../stream/pan-tilt-controller.js";
import { T8410 } from "../stream/t8410-pan-tilt.js";

export interface PanTiltDevice {
  readonly requiresOwnerAccount: boolean;
  supports(device: MegaInventoryDevice, route: PpcsStreamRoute | null): boolean;
  new(transport: PpcsControlTransport, channel: number): PanTiltController;
}

const PAN_TILT_DEVICES: readonly PanTiltDevice[] = [T8410];

export function panTiltDevice(device: MegaInventoryDevice, route: PpcsStreamRoute | null): PanTiltDevice | null {
  return PAN_TILT_DEVICES.find(Device => Device.supports(device, route)) ?? null;
}
