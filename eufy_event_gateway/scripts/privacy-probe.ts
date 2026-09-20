/**
 * Sends one privacy-mode command directly over first-party PPCS.
 *
 * This developer probe owns no Home Assistant state and does not expose
 * credentials, serials, payloads, or privacy readback. It is intended for one
 * explicitly selected HomeBase camera and reports only transport completion.
 */
import { MegaClient } from "../src/mega/client.js";
import { parseMegaInventory, isSupportedMegaCamera } from "../src/provider/eufy-provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const username = process.env.EUFY_USERNAME;
const password = process.env.EUFY_PASSWORD;
const serial = process.env.EUFY_PPCS_SERIAL;
const requestedMode = process.env.EUFY_PPCS_PRIVACY_MODE;
const dataDirectory = process.env.EUFY_GATEWAY_DATA_DIR ?? "./data";

if (!username || !password) throw new Error("EUFY_USERNAME and EUFY_PASSWORD are required (values are never printed)");
if (!serial) throw new Error("EUFY_PPCS_SERIAL is required");
if (requestedMode !== "on" && requestedMode !== "off") throw new Error("EUFY_PPCS_PRIVACY_MODE must be on or off");

const client = new MegaClient({
  email: username,
  password,
  country: process.env.EUFY_COUNTRY ?? "AU",
  persistentDirectory: dataDirectory,
});
const auth = await client.connect();
if (auth.state !== "authenticated") throw new Error(`Mega authentication is ${auth.state}; complete authentication in the gateway first`);
const devices = parseMegaInventory(await client.inventory());
const camera = devices.find((device) => device.serial === serial && isSupportedMegaCamera(device));
if (!camera) throw new Error("selected camera was not found in supported inventory");
if (!camera.parentSerial || camera.channel === null || !camera.adminUserId) throw new Error("selected camera has no HomeBase control route");
const station = devices.find((device) => device.serial === camera.parentSerial);
if (!station?.p2pDid || !station.p2pConnection) throw new Error("selected camera parent has no PPCS identity");
const dskKeys = await client.dskKeys([station.serial]);
const dsk = dskKeys[station.serial];
if (!dsk) throw new Error("selected camera parent has no DSK key");
const cipherKeys = new Map<number, string>();

const session = new FirstPartyPpcsSession({
  stationSerial: station.serial,
  p2pDid: station.p2pDid,
  appConnection: station.p2pConnection,
  dskKey: dsk.key,
  channel: camera.channel,
  cameraModel: camera.model,
  accountId: camera.adminUserId,
  homeBaseAttached: true,
  purpose: "control",
  maxSeconds: 40,
  resolveCipherKey: async (cipherId) => {
    const cached = cipherKeys.get(cipherId);
    if (cached) return cached;
    if (!station.adminUserId) return undefined;
    const ciphers = await client.getCiphers([cipherId], station.adminUserId, station.serial);
    for (const cipher of ciphers) {
      const id = typeof cipher.cipher_id === "number" ? cipher.cipher_id : Number(cipher.cipher_id);
      if (Number.isInteger(id) && typeof cipher.ecc_private_key === "string") cipherKeys.set(id, cipher.ecc_private_key);
    }
    return cipherKeys.get(cipherId);
  },
});

try {
  await session.start();
  await session.writePrivacyMode(requestedMode === "on");
  console.log(JSON.stringify({ status: "passed", evidence_scope: "direct_ppcs_transport", requested: requestedMode }));
} finally {
  session.close();
}
