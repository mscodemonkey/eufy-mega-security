/** Registry of qualified directional controllers; existing C37 and preset paths remain separate. */
import type { MegaInventoryDevice } from "./inventory-normalization.js";
import type { PpcsStreamRoute } from "./eufy-provider.js";
import type { PanControllable, PanControlTransport, PanExecutionPolicy } from "../stream/pan-controllable.js";
import { T8410 } from "../stream/t8410-pan.js";

export interface PanControllableDevice {
  readonly requiresOwnerAccount: boolean;
  readonly execution: PanExecutionPolicy;
  supports(device: MegaInventoryDevice, route: PpcsStreamRoute | null): boolean;
  new(transport: PanControlTransport, channel: number): PanControllable;
}

const PAN_CONTROLLABLE_DEVICES: readonly PanControllableDevice[] = [T8410];
// C37 needs its standalone viewer transport qualified before registration; HomeBase borrowing does not cover it.

export function panControllableDevice(device: MegaInventoryDevice, route: PpcsStreamRoute | null): PanControllableDevice | null {
  return PAN_CONTROLLABLE_DEVICES.find(Device => Device.supports(device, route)) ?? null;
}
