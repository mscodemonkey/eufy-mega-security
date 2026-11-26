/** One-step T8410 movement through its HomeBase 3 child channel. */
import type { MegaInventoryDevice } from "../provider/inventory-normalization.js";
import type { PpcsStreamRoute } from "../provider/eufy-provider.js";
import { PanTiltController, type PpcsControlTransport, type PanTiltDirection } from "./pan-tilt-controller.js";

export class T8410 extends PanTiltController {
  static readonly requiresOwnerAccount = false;
  constructor(transport: PpcsControlTransport, channel: number) { super("T8410", transport, channel); }

  static supports(device: MegaInventoryDevice, route: PpcsStreamRoute | null): boolean {
    return device.model === "T8410" && device.deviceType === 31 && device.category === "eufy_security"
      && device.channel !== null && Number.isInteger(device.channel) && device.channel >= 0 && device.channel <= 254
      && !!device.adminUserId && route?.homeBaseAttached === true && route.peer.model === "T8030"
      && route.peer.deviceType === 18 && device.parentSerial === route.peer.serial
      && route.peer.adminUserId === device.adminUserId;
  }

  protected commandValue(direction: PanTiltDirection): string {
    return JSON.stringify({ commandType: 6030, data: { cmd_type: 1,
      rotate_type: { left: 1, right: 2, up: 3, down: 4 }[direction], transaction: `${Date.now()}` } });
  }

  protected movementResult(header: Buffer, payload: Buffer, type: number): number | null {
    if (!this.#isMovementReceipt(header, payload, type)) return null;
    // The opaque tail is not a position report; only the correlated result scalar is used.
    return payload.readInt32LE(0);
  }

  /**
   * XZYH: uint16LE command at 4; channel/protection/result/reserved at 12/13/14/15.
   * CONTROL type 0, clear protection 0, result flag 1 and reserved byte 0 identify this receipt.
   * Payload: int32LE result, alone (4 bytes) or followed by 128 opaque bytes (132 total).
   */
  #isMovementReceipt(header: Buffer, payload: Buffer, type: number): boolean {
    if (header.length !== 16 || ![4, 132].includes(payload.length)) return false;
    const movementCommand = header.readUInt16LE(4) === 1700 && header[12] === this.channel;
    const clearResult = type === 0 && header[13] === 0 && header[14] === 1 && header[15] === 0;
    return movementCommand && clearResult;
  }

}
