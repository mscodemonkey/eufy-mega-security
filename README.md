# Eufy Mega Security for Home Assistant

The project is maintained as an open-source gateway and Home Assistant integration. Start with the [developers start here guide](docs/DEVELOPERS_START_HERE.md) if you are new to the codebase, then use the [Mega platform reference](docs/MEGA_PLATFORM.md) for protocol and data-flow detail. The [contributor guide](CONTRIBUTING.md) covers local setup, testing, protocol boundaries, and release rules. The [file map](docs/FILE_MAP.md) explains where each part lives, and [SECURITY.md](SECURITY.md) covers private reports and secret handling.

[![My Home Assistant](https://img.shields.io/badge/Home%20Assistant-%2341BDF5.svg?style=flat&logo=home-assistant&label=My)](https://my.home-assistant.io/redirect/hacs_repository/?owner=mscodemonkey&repository=eufy-mega-security&category=integration)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](https://github.com/mscodemonkey/eufy-mega-security/blob/main/LICENSE)

<p align="center">
  <img src="https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/main/custom_components/eufy_event_gateway/brand/icon.png" width="128" height="128" alt="Eufy Mega Security icon">
</p>

Reliable, event-first Home Assistant support for Eufy cameras that do not provide a permanent RTSP stream.

Motion, person, pet, vehicle, dog, crying, sound, stranger, and stranded-package detections arrive as distinct Home Assistant entities. Supported doorbells also expose a press sensor. HomeBase 3 familiar-person names appear when Eufy supplies one, and the last good event image remains visible while the camera is idle.

> [!IMPORTANT]
> This is an early community project built against real EufyCam 2C, HomeBase 3, and Doorbell hardware. It is not affiliated with Anker or Eufy and should not be your only security system.

## Device support

Green ticks mark behaviour tested on real hardware. Amber marks features we have developed but still need to verify. A tick does not mean every feature of a device is supported.

### HomeBase

- ✅ HomeBase 3 S380 / T8030: confirmed as the parent of working camera setups. A community tester also confirmed alarm-panel state, guard-mode switching, and alarm-tone selection on real hardware.
- 🟠 HomeBase 3 S380 / T8030 remaining controls: siren state, storage diagnostics, volume controls, storage units and status meanings, writable ranges, and siren stop codes still need focused real-device confirmation.
- 🟠 HomeBase 2 T8010: discovered as a read-only HomeBase with firmware,
  inventory availability, and child-camera route readiness. HomeBase 3 alarm,
  guard-mode, storage, volume, and tone controls remain hidden until the T8010
  station protocol is verified on real hardware.
- 🟠 HomeBase Professional S1 T9000: confirmed as the inventory parent for
  discovered cameras. The latest reporter retest still times out during PPCS lookup
  for all seven attached camera models, and it does not receive the T8030 station controls.

### Cameras

- ✅ EufyCam 2C T8113-Z: discovery, snapshots, live video, and motion events have been confirmed on real hardware. Person events work through HomeBase 3, while the reported HomeBase 2 notification carries only generic motion evidence.
- 🟠 eufyCam C35 T8110: Mega type 10035 is admitted through its reported HomeBase 3 route. Discovery, events, snapshots, live video, and battery entities await reporter testing.
- 🟠 eufyCam 2 Pro T8140-R: discovery, snapshots, live video, and motion events are confirmed through HomeBase 2. Battery values and person detection still need work on the reported setup.
- ✅ EufyCam 2C Pro T8142-Z: discovery, snapshots, and live video are confirmed through HomeBase 2. Event delivery still needs focused confirmation.
- ✅ USB-C-powered camera T817L: live streams and snapshots produced on real hardware.
- ✅ eufyCam S330 (Mega model T8160): discovered with sensors, retained images, and live streaming through HomeBase 3.
- ✅ eufyCam S300 / 3C T8161: discovery, person events, and live video are confirmed through HomeBase 3. Discovery, events, and retained snapshots are confirmed through a T9000, where live video remains blocked at PPCS lookup.
- 🟠 eufyCam S3 Pro T8162: discovery, person, pet, and vehicle events, and retained snapshots are confirmed through a T9000. Live video is waiting on that station's PPCS lookup result.
- ✅ SoloCam C20 (Mega model T8134): discovery, motion and person events, and live video are reporter-confirmed. Battery availability and retained event images are being investigated separately.
- 🟠 SoloCam E30 T8171: Mega type 88 is admitted through its reported ready HomeBase route. Discovery, events, snapshots, and live video await reporter testing.
- 🟠 SoloCam E20 T8130, SoloCam E40 T8131, and SoloCam C210 T8B00: each exact standalone model is admitted through the direct camera handler. Discovery, events, snapshots, and live video await reporter testing.
- ✅ SoloCam S230 / S40 T8124: discovery and live video are confirmed through HomeBase 3. Events and fresh snapshots still need focused confirmation.
- 🟠 SoloCam S340 T8170: discovery, person events, and retained snapshots are confirmed through a T9000. Live video is waiting on that station's PPCS lookup result.
- 🟠 Solar Wall Light Cam S120 T81A0: discovery, sensors, motion events, retained snapshots, and live video are confirmed. Fresh captures can still time out during peer lookup or before a later valid frame, and clip recording needs focused confirmation.
- 🟠 Floodlight Cam E340 T8425: discovery, person and vehicle events, and retained snapshots are confirmed through a T9000. Live video is waiting on that station's PPCS lookup result.
- 🟠 Floodlight Camera E30 T8426: standalone discovery and Home Assistant entities are confirmed. Direct media reaches the gateway, but live view and fresh snapshots remain blank because the H.265 stream has no complete decoder bootstrap.
- 🟠 Floodlight Cam S330 / 2 Pro T8423: discovery and an event snapshot are confirmed in a HomeBase 3 setup. Live sessions still deliver only H.265 slices without a usable decoder bootstrap, including at the lowest stream quality.
- 🟠 Wired Wall Light Cam S100 T84A1: discovery and direct PPCS are confirmed. One setup has repeated working H.264 live video, while another receives only delta slices without the codec bootstrap, so snapshots and live video remain under investigation across hardware setups.
- ✅ Indoor Cam Pan & Tilt T8410: discovered with sensors, a retained image, and a live stream through HomeBase 3.
- ✅ Indoor Cam Pan & Tilt T8410C: discovered with sensors, a retained image, and a live stream through HomeBase 3.
- 🟠 Indoor Cam 2K T8400: Mega type 30 is admitted through its reported ready route. Discovery, events, snapshots, and live video await reporter testing.
- 🟠 Indoor Cam 2K Pan & Tilt T8419: Mega type 10009 is admitted through its reported ready route. Discovery, events, snapshots, and live video await reporter testing.
- 🟠 Indoor Cam S350 T8416: discovery and Home Assistant entities are confirmed on direct Wi-Fi and T9000-attached setups. Live video through T9000 is waiting on that station's PPCS lookup result, and privacy-mode control is not yet exposed.
- 🟠 Indoor Cam E30 4K T8417: discovery and properties are confirmed. Direct media arrives, but live video remains blank and codec startup is unresolved. Events and snapshots still need confirmation.
- 🟠 eufyCam C37 T814X: Mega type 10037 is admitted through its reported HomeBase 3 route. Discovery, events, snapshots, and live video need reporter confirmation.
- 🟠 eufyCam E40 T8144: discovery, motion, person, pet, and sound events are confirmed through HomeBase 2. Fresh snapshots work, but live view is mixed. Chrome has sustained video for more than 100 seconds after an occasional failed first attempt, while Safari shows only a frozen first frame.

### Doorbells

- 🟠 Video Doorbell T8200: discovery, entities, motion and person events, and retained event images are confirmed through its self-parented PPCS session. Press notifications, live video, and on-demand snapshots remain unresolved on the reported hardware.
- ✅ Video Doorbell T8210: live streams and snapshots produced on real hardware. One HomeBase 2 reporter now has smooth playback, while another still receives video data without a rendered view.
- ✅ Video Doorbell T8213: discovered with sensors, retained images, and a live stream through HomeBase 3.
- 🟠 Video Doorbell E340 T8214: discovery and Home Assistant entities are confirmed through a T9000. A separate T8030 report confirms live video but reports intermittent jumps back to an earlier frame. T9000 live video remains blocked at lookup, and press notifications need targeted results.
- 🟠 Video Doorbell C30 T8224: Mega type 96 admission and Home Assistant entities are reporter-confirmed. A physical button press is confirmed as push event 3103, and the latest event handler awaits reporter testing. Live media is not yet supported on the reported route.
- 🟠 Familock S3 Max T85V0: discovery and the main rechargeable battery are confirmed. HomeBase media arrives with H.265 startup headers, but visible playback remains unconfirmed. Backup AA battery reporting, snapshots, and doorbell events need separate evidence. Lock controls are not exposed.

### Standalone sensors

- ✅ Entry Sensor T8900: discovery and open or closed state are confirmed on real hardware.
- 🟠 Motion Sensor T8910: discovery and the motion entity are implemented. A HomeBase 2 setup confirms that the sensor wakes an attached doorbell, but its own push event does not reach the gateway. The cloud timestamp fallback still needs hardware confirmation.

### Recognised but not supported

- MiniBase Chime T8023: Eufy's inventory lists it as the E340 doorbell's parent connection. The gateway can use that connection metadata for the doorbell, but it does not create a Home Assistant entity for the chime or expose its settings.
- T85D0, Mega type 202: reported in camera-focused diagnostics, but it belongs to a non-camera device family. Lock and access-control entities are not implemented.

If a tested device behaves differently for you, [open an issue](https://github.com/mscodemonkey/eufy-mega-security/issues) with its model number and what happened. Do not post serial numbers, credentials, or verification codes.

## What it provides

For every discovered camera, the integration creates:

- a camera entity with a retained event image;
- a motion binary sensor;
- a person binary sensor;
- pet, vehicle, dog, crying, sound, stranger, and stranded-package binary sensors;
- a last-recognized-person sensor, including the detection type and timestamp.

Cameras that report their master enablement state and have a ready PPCS control
route also get a Camera enabled switch. The switch waits for a fresh cloud
readback before Home Assistant publishes the new state. Hardware confirmation
is still required across the reported HomeBase 2 camera families.

Supported doorbells also get a Doorbell binary sensor. A bell press turns it on
for 10 seconds, so an automation can catch the press without opening a video stream.

Cameras and doorbells that report Mega battery fields also get battery percentage,
charging, health, temperature, and days-since-last-charging entities for the fields that device supplies.
Known mains-powered models with dummy battery values do not get battery entities.

Standalone sensors get entities only for capabilities they report. The first
supported set covers entry-sensor open/closed state, PIR motion, battery percentage,
and last-seen time. Contact and motion pushes update Home Assistant immediately,
and the gateway refreshes the inventory-backed readings every 60 seconds. The
T8900 contact path is confirmed on installed hardware. The T8910 motion path still
needs a conclusive test.

The integration also defines two Home Assistant actions for on-demand streaming:

- `eufy_event_gateway.capture_snapshot` requests a fresh frame from a camera with a supported live transport;
- `eufy_event_gateway.record_clip` records from a camera with a supported live transport.

Live viewing uses the gateway-owned Eufy Mega/PPCS transport. The gateway does not use `eufy-security-client`, the separate SmartLife/Thing login, or an expiring Web Portal Access PIN. The transport has produced real stream and snapshot bytes from both a wired T8210 and USB-C-powered T817L, and v0.1.14 exposes it through the Home Assistant camera entities.

The actions work in Home Assistant automations and through Node-RED's Home Assistant Action node. An importable example is included in [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json).

## How it fits together

This repository contains two parts, and Home Assistant needs both:

1. **Eufy Mega Security app.** It signs in through Eufy's current Mega service, receives push/HomeBase events, and retains snapshots.
2. **Eufy Mega Security integration.** It turns the gateway data into normal Home Assistant camera, binary-sensor, and sensor entities.

The integration's internal Home Assistant domain remains `eufy_event_gateway` so existing entity IDs and action names keep working. The user-facing name is Eufy Mega Security.

On Home Assistant OS or Supervised, the app generates its own private API token and passes it directly to the integration through Supervisor discovery. The gateway port is closed to the LAN by default.

## Before installing

Create a separate Eufy guest account and share only the Home and cameras you want Home Assistant to access. Do not use the Eufy account currently signed into your everyday mobile app; simultaneous Eufy sessions can interfere with one another.

You will need:

- Home Assistant OS or Home Assistant Supervised for the app installation below;
- HACS, or File Editor/SSH for the manual integration method;
- the guest account username, password, and two-letter account country code;
- the Eufy account credentials; the gateway does not use the expiring Web Portal Access PIN.

## Install the integration with HACS

The project does not need to be accepted into HACS's default catalogue. Add it as a custom repository:

1. Open **HACS** in Home Assistant.
2. Open the three-dot menu and choose **Custom repositories**.
3. Enter `https://github.com/mscodemonkey/eufy-mega-security`.
4. Select **Integration** as the category and add it.
5. Find **Eufy Mega Security**, choose **Download**, and restart Home Assistant.

After every integration update, fully restart Home Assistant so it loads the
new integration code. Updating or restarting the Eufy Mega Security app only
restarts the gateway; it does not reload the integration running inside Home
Assistant. If a release updates both parts, update the integration in HACS and
the app separately, then restart Home Assistant.

If you do not use HACS, copy `custom_components/eufy_event_gateway` into `/config/custom_components/eufy_event_gateway` and restart Home Assistant.

## Install the Home Assistant app

1. Open **Settings > Apps > App Store**.
2. Open the repository manager from the top-right menu.
3. Add `https://github.com/mscodemonkey/eufy-mega-security`.
4. Find **Eufy Mega Security** under the new repository and select **Install**.
5. On its **Configuration** tab, enter the dedicated Eufy guest username, password, and country code.
6. Start the app and enable **Start on boot** and **Watchdog**.

Mega events and the native camera transport use the gateway's Mega session. If Eufy requests a CAPTCHA or sends a six-digit email code, open the app's **Web UI** and complete the prompt there without restarting the app. The gateway stores the resulting Mega session so routine app upgrades and restarts do not repeat authentication.

As a fallback for email verification, enter the temporary code in **Verification code** and restart the app once. The gateway retains Eufy's limited pre-verification session across that restart, so the code is submitted with the token that requested it. Remove the code after the app connects. Web UI challenge answers and codes are kept in memory only; the configuration fallback keeps the code in the app's private options until you remove it. Never post credentials, verification codes, or app logs containing private account details in a GitHub issue.

On first discovery, the gateway captures one live snapshot from each camera that has no retained image. Cameras are warmed one at a time, and a sleeping or unavailable camera does not prevent the remaining cameras from starting. Later restarts reuse retained images instead of waking every camera again.

## Connect it to Home Assistant

After the app connects:

1. Open **Settings > Devices & services**.
2. A discovered **Eufy Mega Security** card should appear.
3. Select **Configure** and submit the confirmation.

The app address and generated API token are transferred privately. You do not need to copy either value.

If discovery does not appear, first confirm the app log reports a healthy gateway. Then choose **Add integration**, search for **Eufy Mega Security**, and use the manual gateway details only if you deliberately exposed a standalone gateway.

## Support logs

Gateway log lines begin with a UTC timestamp and identify the running release, process invocation, component, and event. For example:

```text
2026-09-15T04:32:08.417Z INFO version=0.1.18 run=7f31c2ab component=provider event=connection_connected Eufy connection connected
```

The `run` value changes whenever the app process starts. It separates restarts that use the same release, while `version` distinguishes current failures from messages retained from an older app image. Inventory logs group devices by model and classification without device names or serial numbers.

New `push_received` lines show the camera model, event codes, whether the gateway recognizes the device, and how it handled the notification. `push_unparsed` means Firebase delivered a notification that the gateway could not associate with an Eufy device. Neither line includes names, serial numbers, notification text, or image URLs.

An admitted device that still needs real-hardware confirmation gets a
diagnostic **Help test this device** button. Pressing it creates a local
notification with a prefilled GitHub report. Nothing is uploaded until the
user reviews and submits that report.

For the report, open the Eufy Mega Security integration in Home Assistant and
choose **Download diagnostics**. The resulting catalogue evidence
includes model and numeric type, admission and route decisions, reported
parameter IDs, and privacy-safe push results. It excludes device names, serial
numbers, recognized person names, payloads, credentials, and account data.
Attach it with a short result for discovery, events, snapshots, and live view.
Those real-device results are what move individual catalogue capabilities from
`declared` to `tested` or `failing`.

When requesting support, copy the complete log from the most recent `gateway_start` event through the failure instead of selecting only the final error. The gateway redacts common credential fields and account email addresses, but review logs before posting them publicly.

## Automations and Node-RED

Motion, person, and supported doorbell press events are Home Assistant binary sensors, so they appear directly in Node-RED's **Events: state** node. Snapshot and recording requests are ordinary Home Assistant actions, so use an **Action** node with one of:

```text
eufy_event_gateway.capture_snapshot
eufy_event_gateway.record_clip
```

Both actions target the camera entity. Example recording data:

```json
{
  "filename": "/media/eufy/gate_latest.mp4",
  "duration": 15
}
```

Create the target directory first and ensure the path is allowed by Home Assistant. The importable example uses JSONata to add a timestamp to each filename. Import [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json), select your Home Assistant server, replace the example entity IDs, and deploy it.

Recordings are assembled by the gateway with a hard stream-start timeout and duration limit, then written atomically by Home Assistant. A failed request therefore cannot leave a partial MP4 at the requested filename.

## Camera behaviour

- Motion, person, and doorbell press notifications update their Home Assistant sensors without waking a stream.
- The last valid event image remains visible while the camera sleeps.
- Opening a camera starts its native PPCS session on demand and stops it after the configured limit, once that camera has passed the gateway proof.
- A familiar-person name appears only when HomeBase supplies an explicit identity. Generic detections such as `Someone` remain unknown.
- Powered cameras with their own RTSP feed can continue using that feed for video while this integration supplies Eufy/HomeBase detection entities.

## Standalone gateway

### Gateway-only stream proof

Before enabling Home Assistant live entities, run `npm run poc:ppcs` from `eufy_event_gateway` with the gateway's existing data directory and credentials available as environment variables. The probe prints one safe JSON result per discovered camera and writes raw `.h264` plus first-frame `.jpg` files to `EUFY_PPCS_OUTPUT_DIR` (default `./poc-output`). A camera only counts as working when both byte counts are non-zero.

Home Assistant Container/Core users can run the gateway separately with Node.js 24 and FFmpeg. From `eufy_event_gateway`:

```sh
npm ci
npm run build
EUFY_USERNAME='guest@example.com' \
EUFY_PASSWORD='your-password' \
EUFY_COUNTRY='AU' \
EUFY_GATEWAY_API_TOKEN='use-a-random-secret-of-at-least-32-characters' \
EUFY_GATEWAY_HOST='0.0.0.0' \
npm start
```

Keep credentials outside source control. A non-loopback gateway refuses to start without a bearer token of at least 32 characters. Add the integration manually using the reachable gateway URL and the same token.

For development without a Eufy account:

```sh
cd eufy_event_gateway
npm ci
EUFY_GATEWAY_PROVIDER=simulated npm run dev
```

## Supported and known limitations

See [device support](#device-support) for the tested setups and features still awaiting hardware confirmation. HomeBase 3 has its own device in v0.1.21 rather than appearing as a camera.

- Eufy's cloud, push, and HomeBase protocols are undocumented and can change without notice.
- Familiar-person names depend on HomeBase recognition and are not present in every Eufy event.
- Live video uses Eufy's native camera transport. Eufy may require account verification the first time that session is created.
- The app handles authentication challenges in its Web UI, then reuses the valid Mega session across upgrades and restarts.
- Direct-camera and HomeBase-attached media routes can behave differently even for the same model, so device support records the tested topology where it matters.
- The app currently publishes source builds for `amd64` and `aarch64`; installation may take several minutes.

## Privacy and security

- Eufy credentials, sessions, generated API tokens, and snapshots stay in the app's private persistent data volume.
- The app's API port is not exposed to the LAN by default.
- Local PPCS discovery requires the app to use Home Assistant's host network so UDP broadcasts can reach Eufy devices on the LAN.
- Process liveness is checked separately from Eufy connectivity, so an email-code prompt or temporary Eufy outage does not create a restart loop.
- API, snapshot, and event endpoints require authentication when the gateway is remotely reachable.
- Diagnostics intentionally exclude passwords, access tokens, signing keys, notification text, media URLs, and raw payloads.

## Help translate Eufy Mega Security

Translations use YAML files, so you only need to translate text and open a
pull request. The release workflow generates Home Assistant's JSON files for
you. You do not need Node.js and should not generate or commit any JSON.

You will need a free GitHub account and Git installed.

1. Open <https://github.com/mscodemonkey/eufy-mega-security> and click
   **Fork** to make your own copy.
2. On your fork, click **Code** and copy the HTTPS address. Then check out the
   repository from a terminal. Replace `YOUR-USERNAME` with your GitHub
   username:

   ```sh
   git clone https://github.com/YOUR-USERNAME/eufy-mega-security.git
   cd eufy-mega-security
   git checkout -b add-language-translation
   ```

3. Copy the English source. Name the new file with the language's BCP 47 code.
   For example, Danish is `da.yaml` and Dutch is `nl.yaml`:

   ```sh
   cp custom_components/eufy_event_gateway/translation_sources/en.yaml custom_components/eufy_event_gateway/translation_sources/da.yaml
   ```

4. Open the new YAML file in a text editor and translate only the text values.
   Keep every key and placeholder such as `{medium}` unchanged.
5. Commit and push that one YAML file:

   ```sh
   git add custom_components/eufy_event_gateway/translation_sources/da.yaml
   git commit -m "Add Danish translation"
   git push -u origin add-language-translation
   ```

6. Open your fork on GitHub and click **Compare & pull request**.

GitHub Actions checks the YAML structure and placeholders on the pull request.
The generated JSON is added when the next release is prepared.

## Development

```sh
cd eufy_event_gateway
npm ci
npm run check
npm run build
docker build -t eufy-mega-security:test .
```

## Licence

[MIT](LICENSE)
