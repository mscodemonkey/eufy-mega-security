/**
 * Sends one camera motion/PIR switch directly over first-party PPCS.
 *
 * This developer probe bypasses Home Assistant and reports only whether the
 * camera acknowledged the verified 1011 direct-binary command.
 */
import { MegaClient } from "../src/mega/client.js";
import { isSupportedMegaCamera, parseMegaInventory } from "../src/provider/eufy-provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const username = process.env.EUFY_USERNAME;
const password = process.env.EUFY_PASSWORD;
const serial = process.env.EUFY_PPCS_SERIAL;
const name = process.env.EUFY_PPCS_NAME;
const mode = process.env.EUFY_PPCS_MOTION_MODE;
const dataDirectory = process.env.EUFY_GATEWAY_DATA_DIR ?? "./data";
if (!username || !password) throw new Error("EUFY_USERNAME and EUFY_PASSWORD are required (values are never printed)");
if (!serial && !name) throw new Error("EUFY_PPCS_SERIAL or EUFY_PPCS_NAME is required");
if (mode !== "on" && mode !== "off") throw new Error("EUFY_PPCS_MOTION_MODE must be on or off");

const client = new MegaClient({ email: username, password, country: process.env.EUFY_COUNTRY ?? "AU", persistentDirectory: dataDirectory });
const auth = await client.connect();
if (auth.state !== "authenticated") throw new Error(`Mega authentication is ${auth.state}`);
const devices = parseMegaInventory(await client.inventory());
const camera = devices.find((device) => (serial ? device.serial === serial : device.name === name) && isSupportedMegaCamera(device));
if (!camera || !camera.parentSerial || camera.channel === null || !camera.adminUserId) throw new Error("selected camera has no supported HomeBase route");
const station = devices.find((device) => device.serial === camera.parentSerial);
if (!station?.p2pDid || !station.p2pConnection) throw new Error("selected HomeBase has no PPCS identity");
const dsk = (await client.dskKeys([station.serial]))[station.serial];
if (!dsk) throw new Error("selected HomeBase has no DSK key");
const cipherKeys = new Map<number, string>();
const session = new FirstPartyPpcsSession({
  stationSerial: station.serial, p2pDid: station.p2pDid, appConnection: station.p2pConnection,
  dskKey: dsk.key, channel: camera.channel, cameraModel: camera.model, accountId: camera.adminUserId,
  homeBaseAttached: true, purpose: "control", maxSeconds: 40,
  resolveCipherKey: async (cipherId) => {
    const cached = cipherKeys.get(cipherId); if (cached) return cached;
    if (!station.adminUserId) return undefined;
    for (const cipher of await client.getCiphers([cipherId], station.adminUserId, station.serial)) {
      const id = typeof cipher.cipher_id === "number" ? cipher.cipher_id : Number(cipher.cipher_id);
      if (Number.isInteger(id) && typeof cipher.ecc_private_key === "string") cipherKeys.set(id, cipher.ecc_private_key);
    }
    return cipherKeys.get(cipherId);
  },
});
try {
  await session.start();
  await session.writeMotionDetection(mode === "on");
  console.log(JSON.stringify({ status: "passed", evidence_scope: "direct_ppcs_transport", requested: mode }));
} finally {
  session.close();
}
