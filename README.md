# Eufy Mega Security for Home Assistant

[Explore the device catalogue](https://mscodemonkey.github.io/eufy-mega-security/) to check features for your setup or get help with a device.

The project is maintained as an open-source gateway and Home Assistant integration. Start with the [developers start here guide](docs/DEVELOPERS_START_HERE.md) if you are new to the codebase, then use the [Mega platform reference](docs/MEGA_PLATFORM.md) for protocol and data-flow detail. The [contributor guide](CONTRIBUTING.md) covers local setup, testing, protocol boundaries, and release rules. The [file map](docs/FILE_MAP.md) explains where each part lives, and [SECURITY.md](SECURITY.md) covers private reports and secret handling.

[![My Home Assistant](https://img.shields.io/badge/Home%20Assistant-%2341BDF5.svg?style=flat&logo=home-assistant&label=My)](https://my.home-assistant.io/redirect/hacs_repository/?owner=mscodemonkey&repository=eufy-mega-security&category=integration)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](https://github.com/mscodemonkey/eufy-mega-security/blob/main/LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/mscodemonkey)

<p align="center">
  <img src="https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/main/custom_components/eufy_event_gateway/brand/icon.png" width="128" height="128" alt="Eufy Mega Security icon">
</p>

Reliable, event-first Home Assistant support for Eufy cameras that do not provide a permanent RTSP stream.

If you use Eufy Mega Security and fancy buying me a beer, you can support the project on [Ko-fi](https://ko-fi.com/mscodemonkey).

Motion, person, pet, vehicle, dog, crying, sound, stranger, and stranded-package detections arrive as distinct Home Assistant entities. Supported doorbells also expose a press sensor. HomeBase 3 familiar-person names appear when Eufy supplies one. Each camera keeps its last good still, while a separate **Last event image** entity retains the latest picture supplied with an event.

Changing motion detection through a HomeBase 2 temporarily interrupts live video while the gateway confirms the setting. Pending live-view requests wait for that operation to finish.

Last event image uses Home Assistant's `image` domain, so it does not create a second camera tile on the automatic Security page. It remains available on the device page and in manually added picture cards. Upgraded installations keep their old event-image camera entities hidden for compatibility with existing dashboard cards and automations. These entries are not deleted or disabled. The main camera uses a retained picture while video is idle, with an explicit waiting image only when no picture has ever been captured.

Camera attributes include reported audio configuration and, when supplied, image rotation, status-indicator and sound-detection settings. These are read-only inventory settings, not live hardware verification. Missing or unrecognized values remain absent. Reading them does not wake a camera or offer a new control.

T9000 Pro HomeBase and T8N00 NVR discovery and retained pictures remain separate from live-media support. These stations use the alternate RTC route rather than the gateway's PPCS route. The default-off NVR option enables normal Home Assistant live view for T8E00 through T8N00 and T8140-Z through T9000 when the binding checks pass. T8416 through T8N00 has a separate, hardware-unconfirmed owner-only path requiring the experimental control options. Other pairings remain unavailable or limited to diagnostic tests. See the [NVR video section](#experimental-nvr-video-test) for exact types and conditions.

T8210 and T8214 also expose reported HomeBase chime, mechanical chime, WDR and chime-volume settings when supplied. T8210 exposes live-view quality ranks (0 Auto, 1 Low, 2 Medium, 3 High) and the associated high-compression setting. These attributes report configuration only. They do not change the chime, image processing or stream format, and are not inferred for other doorbells.

T8170 exposes its reported working mode, clip duration, interval between clips and stop-when-motion-ends setting. The recording settings describe the camera's Customize Recording policy, not the gateway's recording service or proof of a completed clip. They remain read-only and are not inferred for other models.

Optional camera attributes include the device's secondary firmware and explicit firmware-update flag. Missing flags remain unknown. T8214 ringtone volume is separate from chime volume. T8410 sound sensitivity and sound type are reported only for that model. T8170 exposes separate streaming and active-mode recording quality ranks, plus reported solar intensity and the rolling 24-hour solar-contribution flag. Solar intensity is unitless and is not displayed as a percentage. These reads do not add setters, install firmware, start recordings or verify physical audio, video or solar output.

T8171 exposes reported live-view and recording quality, notification style, and standalone controls for infrared mode, motion detection, live-view quality, recorded audio and AI tracking. T8425 exposes watermark mode and anti-theft detection configuration. T8170 exposes its reported spotlight-enable switch and raw motion-sensitivity value. The spotlight switch does not say whether its lamp is currently illuminated, and notification style does not prove delivery. These settings are not inferred for another model merely because it reports the same parameter number.

The exact standalone Wired Cam C31 T817L, type 10031 on channel zero, also exposes camera enablement, motion detection, night vision, recorded audio and live-view quality controls. Its quality choices are Auto, Medium and High. Additional admitted preferences provide microphone and speaker switches, speaker volume, image rotation, watermark, pre-recording, sound detection, status LED, recording quality, sound sensitivity/type/round-look, enhanced lighting, light brightness and notification spacing. Each requires a known baseline and fresh camera readback. Short captures confirm 720p at Medium and 1080p at High. Longer live viewing still needs investigation. Continuous footage currently plays through the Eufy app only. These standalone controls do not establish support for T817L121 or change C31 HomeBase routing.

The same exact standalone C31 supports RTSP publication and continuous-recording switches. RTSP on/off was verified through Home Assistant with a decoded 1080p video and AAC stream, then a rejected connection after off. Its RTSP timestamps can jump backwards, so an external RTSP consumer may need wallclock timestamps. The gateway continues using PPCS for live video. Continuous-recording switch readback is verified, but continuous-footage browsing remains unavailable.

The C31 also supports `eufy_event_gateway.play_audio`. Select its camera entity and supply an allowlisted Home Assistant filename containing AAC-LC audio at 16 kHz, mono, in ADTS format. Clips are limited to 20 seconds and 320 KB. The speaker must be enabled. A four-second tone played through the actual Home Assistant service was physically confirmed. This service plays a prepared file. Live microphone talkback is not available.

Saved event playback is available for the SoloCam E30 T8171, both standalone with microSD and attached to HomeBase 3, and the standalone Wired Cam C31 T817L (type 10031, channel zero). Open **Media > Eufy recordings**, choose the camera, then a day and clip. The browser shows the last fourteen days. Standalone queries return up to one hundred completed local event clips per day. HomeBase queries examine the first one hundred station events per day and filter this camera’s completed clips. Close live view before browsing recordings, including views of other cameras sharing the HomeBase. Playback includes recorded audio when present and supports silent clips and seeking. Preparing a clip downloads and verifies it before playback, so the first selection can take a little time. Prepared clips expire after ten minutes. Select the clip again to reload it. This does not expose continuous recordings, format the card or delete clips. Standalone C31 and HomeBase E30 playback have been verified with complete video and audio through Home Assistant. C31 HomeBase playback and the T817L121 variant remain unverified.

Supported child sensors receive validated contact and telemetry updates from the existing HomeBase refresh. While a requested HomeBase camera session is open, matching contact notifications can also update a known sensor without waiting for cloud push. This is passive observation, not an always-on sensor subscription. It doesn't open a connection, wake a sensor or change phone-notification settings.

The exact Baby Monitor E21 T8354, Mega type 86 in `eufy_care`, has experimental camera and care-event support. Crying, sound, motion, pet, activity, care-area and temperature notifications use the existing push receiver. Event pictures and reported room settings are passive. Explicit live view, live audio and confirmed preference controls require the default-off `experimental_model_controls` option. Controls additionally require an API token and the configured owner account. No E21 media opens at startup. Physical behaviour is still unconfirmed. See [the E21 trial guide](docs/E21_TEST.md) for the supported settings and limits.

> [!IMPORTANT]
> This is an early community project built against real EufyCam 2C, HomeBase 3, and Doorbell hardware. It is not affiliated with Anker or Eufy and should not be your only security system.

## Device support

Green ticks mark behaviour tested on real hardware. Amber marks features we have developed but still need to verify. A tick does not mean every feature of a device is supported.

### HomeBase

- ✅ HomeBase 3 S380 / T8030: confirmed as the parent of working camera setups. Community hardware tests confirmed eMMC and HDD capacity, free space and healthy status, alarm-panel state, guard-mode switching, alarm-tone selection, prompt volume from 1 to 26, and siren start, timed stop and explicit stop.
- 🟠 HomeBase 3 S380 / T8030 remaining controls: alarm-volume acknowledgement and readback, readable siren state, siren stop from the Eufy app, and Away and Schedule guard modes still need focused confirmation.
- 🟠 HomeBase 2 T8010: discovered as a read-only HomeBase with firmware,
  inventory availability, and child-camera route readiness. HomeBase 3 alarm,
  guard-mode, storage, volume, and tone controls remain hidden until the T8010
  station protocol is verified on real hardware.
- 🟠 HomeBase Professional S1 T9000: confirmed as the inventory parent for
  discovered cameras. The latest reporter retest still times out during PPCS lookup
  for all seven attached camera models. The separate RTC path has reporter-confirmed initial and reopened T8140-Z video on v0.1.174, although one reopened session ended after 49 seconds with `peer_failed`. The cause is unresolved, sustained playback is unconfirmed, and the T8030 station controls are unavailable.

### NVR

- 🟠 NVR S4 Max T8N00: inventory discovery and read-only configured guard-mode reporting are implemented, with periodic refresh confirmed on hardware. A reporter confirmed T8E00 RTC views of about a minute and reopening on v0.1.163, with startup delay and initially accelerated playback still reported. Sustained playback is unconfirmed. T8416 has a separate hardware-unconfirmed owner-only path. Camera-power and Schedule guard-mode trials remain default-off. One T8E00/type 301 through T8N00/type 300 reporter observed physical power off/on and restored on state in three runs on v0.1.188. Later versions are not separately confirmed, and the guard-mode trial remains physically unconfirmed. Normal arm/disarm, storage diagnostics and automatic fresh snapshots remain unavailable.

### Cameras

- ✅ EufyCam 2C T8113-Z: discovery, snapshots, live video, and motion events have been confirmed on real hardware. Person events work through HomeBase 3, while the reported HomeBase 2 notification carries only generic motion evidence.
- 🟠 eufyCam C35 T8110: Mega type 10035 is admitted through its reported HomeBase 3 route. Discovery, events, snapshots, live video, and battery entities await reporter testing.
- 🟠 eufyCam 2 Pro T8140-R: discovery, snapshots, live video, and motion events are confirmed through HomeBase 2. Battery values and person detection still need work on the reported setup.
- ✅ EufyCam 2C Pro T8142-Z: discovery, snapshots, and live video are confirmed through HomeBase 2. Event delivery still needs focused confirmation.
- ✅ Wired Cam C31 T817L: live streams, snapshots, preset discovery and movement, AI tracking, and automatic cruise produced on real hardware through HomeBase 3. Tracking and cruise are exposed as explicit actions because they do not provide readable persistent state.
- ✅ eufyCam S330 (Mega model T8160): discovered with sensors, retained images, and live streaming through HomeBase 3.
- ✅ eufyCam S300 / 3C T8161: discovery, person events, and live video are confirmed through HomeBase 3. Discovery, events, and retained snapshots are confirmed through a T9000, where live video remains blocked at PPCS lookup.
- 🟠 eufyCam S3 Pro T8162: HomeBase 3 discovery, snapshots, H.265 live video, motion and person events are reporter-confirmed. T9000 discovery, person, pet, vehicle, and retained snapshots are confirmed, with T9000 live video unresolved. Event-image decoding and a meaningful signal value remain unconfirmed.
- ✅ SoloCam C20 (Mega model T8134): discovery, motion and person events, and live video are reporter-confirmed. Battery availability and retained event images are being investigated separately.
- ✅ SoloCam E30 T8171, Mega type 88: standalone discovery, detection events, snapshots, live video with audio, recorded-audio control, AI tracking and preset movement are confirmed on hardware. SD event recordings also play through Home Assistant. HomeBase 3 discovery, runtime name refresh, fresh snapshots, live video with audio and infrared controls are also hardware-tested. HomeBase saved event playback is also verified through Home Assistant, and both saved preset positions and default return are hardware-tested. Other HomeBase controls still need separate tests.
- ✅ eufyCam S4 T8172: discovery, motion, person and vehicle events, fresh snapshots, and live video are confirmed through HomeBase 3. The separate T9000 route still times out during peer lookup.
- 🟠 SoloCam E20 T8130, SoloCam E40 T8131, and SoloCam C210 T8B00: each exact standalone model is admitted through the direct camera handler. Discovery, events, snapshots, and live video await reporter testing.
- ✅ SoloCam S230 / S40 T8124: discovery and live video are confirmed through HomeBase 3. Events and fresh snapshots still need focused confirmation.
- 🟠 SoloCam S340 T8170: discovery, person events, and retained snapshots are confirmed through a T9000. Live video is waiting on that station's PPCS lookup result.
- 🟠 Solar Wall Light Cam S120 T81A0: discovery, sensors, motion events, retained snapshots, and live video are confirmed. A HomeBase 3 reporter confirms sustained live video and reopening on v0.1.157. Manual light controls worked on the standalone route, but remain unavailable through HomeBase 3. Fresh captures and clip recording still need focused confirmation.
- 🟠 Floodlight Cam E340 T8425: one standalone firmware 1.6.4.6 setup reports roughly one-second live startup and clean reopening on v0.1.192. An older standalone setup reported revisit freezes and has not been retested. Discovery, person and vehicle events, and retained snapshots are confirmed through a T9000, where live video still awaits a successful peer lookup.
- 🟢 Floodlight Camera E30 T8426: standalone discovery, fresh snapshots, and live video are confirmed. The current stream is video-only; audio, two-way talk, and floodlight controls are not implemented for this model.
- 🟠 Floodlight Cam S330 / 2 Pro T8423: discovery and an event snapshot are confirmed. Direct H.265 live video is stable in most attempts. CPU recovery after closing live view is reporter-confirmed on v0.1.117. Consistent first-open success is still awaiting confirmation.
- 🟠 Wired Wall Light Cam S100 T84A1: discovery and direct PPCS are confirmed. One setup has repeated working H.264 live video, while another receives only delta slices without the codec bootstrap, so snapshots and live video remain under investigation across hardware setups.
- ✅ Indoor Cam Pan & Tilt T8410: discovered with sensors, a retained image, and a live stream through HomeBase 3.
- ✅ Indoor Cam Pan & Tilt T8410C: discovered with sensors, a retained image, and a live stream through HomeBase 3.
- 🟠 Indoor Cam 2K T8400: Mega type 30 is admitted through its reported ready route. Discovery, events, snapshots, and live video await reporter testing.
- 🟠 Indoor Cam 2K Pan & Tilt T8419: Mega type 10009 is admitted through its reported ready route. Discovery, events, snapshots, and live video await reporter testing.
- 🟠 Indoor Cam C220 T8W11C: Mega type 10010 is admitted as ready to test in v0.1.118. Inventory battery reads are reported. Live media is unavailable without a ready route. Hardware discovery, events and snapshots await confirmation. Type 10008 remains recognised only.
- 🟠 Indoor Cam S350 T8416: discovery and Home Assistant entities are confirmed on direct Wi-Fi and T9000-attached setups. There is no normal live binding through T9000. The T8N00 owner-only RTC path requires the experimental options described below and remains hardware-unconfirmed. Privacy-mode control is not exposed.
- 🟠 Indoor Cam E30 4K T8417: discovery and properties are confirmed. Direct media arrives, but live video remains blank and codec startup is unresolved. Events and snapshots still need confirmation.
- 🟠 Baby Monitor E21 T8354: exact type 86 and `eufy_care` only. Care notifications, event pictures and reported room settings, plus opt-in direct live video/audio and freshly confirmed controls. Hardware and cloud delivery await reporter confirmation.
- ✅ eufyCam C37 T814X / T814XS: Mega type 10037 is confirmed through HomeBase 3. The standalone solar variant's type 10039 is confirmed for discovery, person events, fresh snapshots, and reliable live video.
- 🟠 eufyCam T8111 original: discovery, Home Assistant entities, live video, and manual fresh snapshots are confirmed through HomeBase 3. Motion-driven event images still need confirmation.
- ✅ eufyCam E330 Professional T8600: discovery, fresh snapshots, live video, motion events, and person events are confirmed through HomeBase 3. Sustained H.265 playback can stutter, and battery-shaped values are suppressed because this model is mains-powered.
- 🟠 eufyCam E40 T8144: discovery, motion, person, pet, sound events, fresh snapshots, and live video are confirmed through HomeBase 2. Chrome, Safari, and the Home Assistant iOS app have all produced sustained live video, but a newer report found intermittent first-frame failures and short sessions before a later attempt worked.

### Doorbells

- 🟠 Video Doorbell T8200: discovery, entities, motion and person events, retained event images, and continuous live video are reporter-confirmed through its self-parented PPCS session on v0.1.157. The reporter still sees 30 to 45 seconds of startup stutter. Push registration is separately under investigation. Press notifications and on-demand snapshots remain unresolved.
- ✅ Video Doorbell T8210: live streams and snapshots produced on real hardware. One HomeBase 2 reporter now has smooth playback, while another still receives video data without a rendered view.
- 🟠 Video Doorbell T8213: discovery, sensors, retained images, and live video are confirmed through HomeBase 3. A second HomeBase 3 setup now shows live video from both lenses on v0.1.123, while fresh snapshots and longer-term reliability on that setup remain unconfirmed.
- 🟠 Video Doorbell Slim T8220: discovery and live video through HomeBase 2 are reporter-confirmed. Slow startup and continued streaming after the view closes are reported. Events, fresh snapshots, and battery values still await confirmation.
- 🟠 Video Doorbell E340 T8214: discovery and Home Assistant entities are confirmed through a T9000. A separate T8030 report confirms live video, motion, person, familiar-person updates, and restored doorbell presses, but reports intermittent frame jumps. T9000 live video remains blocked at lookup, and missing push deliveries are under investigation separately.
- 🟠 Video Doorbell C30 T8224: Mega type 96 admission, Home Assistant entities and a physical button press are reporter-confirmed. With the default-off standalone RTC option enabled on v0.1.191, three normal live-view opens started in about 7.5 to 13 seconds and reopening worked. Gateway source sessions ended about 10 seconds after the last viewer left. Fresh snapshot capture is reporter-confirmed on v0.1.191. Physical camera sleep remains unconfirmed.
- 🟠 Familock S3 Max T85V0: discovery and the main rechargeable battery are confirmed. HomeBase media arrives with H.265 startup headers, but visible playback remains unconfirmed. Backup AA battery reporting, snapshots, and doorbell events need separate evidence. Lock controls are not exposed. An optional [read-only status check](docs/T85V0_STATUS_TEST.md) is available for T85V0/type 203 through HomeBase 3. Its physical behaviour remains unconfirmed.

### Standalone sensors

- ✅ Entry Sensor T8900: discovery and open or closed state are confirmed on real hardware.
- ✅ Motion Sensor T8910: discovery and motion events are confirmed through HomeBase 2 and HomeBase 3 when notifications for the sensor are enabled in the active Eufy mode. The cloud last-seen value remains unconfirmed.

### Recognised but not supported

- MiniBase Chime T8023: Eufy's inventory lists it as the E340 doorbell's parent connection. The gateway can use that connection metadata for the doorbell, but it does not create a Home Assistant entity for the chime or expose its settings.
- T85D0, Mega type 202: reported in camera-focused diagnostics, but it belongs to a non-camera device family. Lock and access-control entities are not implemented.

If a tested device behaves differently for you, [open an issue](https://github.com/mscodemonkey/eufy-mega-security/issues) with its model number and what happened. Do not post serial numbers, credentials, or verification codes.

## What it provides

For every discovered camera, the integration creates:

- a camera entity with its last good still;
- a separate Event image camera entity with the latest valid event picture;
- a motion binary sensor;
- a person binary sensor;
- pet, vehicle, dog, crying, sound, stranger, and stranded-package binary sensors;
- a last-recognized-person sensor, including the detection type and timestamp.

Cameras that report their master enablement state and have a ready PPCS control
route also get a Camera enabled switch. The switch waits for a fresh cloud
readback before Home Assistant publishes the new state. Hardware confirmation
is still required across the reported HomeBase 2 camera families.

The T817L gets one button for every enabled preset reported by the camera,
including its default position. It also gets separate enable and disable
buttons for AI tracking and automatic cruise. These remain actions rather than
switches because the direct HomeBase route does not return their current state.
Preset movement is sent once and is never retried when the camera moves without
returning a command acknowledgement.

Supported doorbells also get a Doorbell binary sensor. A bell press turns it on
for 10 seconds, so an automation can catch the press without opening a video stream.

Cameras and doorbells that report Mega battery fields also get battery percentage,
charging, health, temperature, and days-since-last-charging entities for the fields that device supplies.
Known mains-powered models with dummy battery values do not get battery entities.

Standalone sensors get entities only for capabilities they report. The first
supported set covers entry-sensor open/closed state, PIR motion, battery percentage,
and last-seen time. Contact and motion pushes update Home Assistant immediately,
and the gateway refreshes the inventory-backed readings every 60 seconds. The
T8900 contact path is confirmed on installed hardware. T8910 motion pushes are
confirmed through HomeBase 2 when notifications are enabled for the sensor in
the active Eufy mode. Its inventory-backed last-seen value remains unconfirmed.
The exact T8354/type 86 E21 also gets care notification entities. They follow the push receiver and expire after 10 seconds. Off means no recent notification is retained. Its existing crying and sound entity IDs stay the same, and camera admission does not create duplicate detection entities.

The integration also defines three Home Assistant actions for on-demand streaming:

- `eufy_event_gateway.capture_snapshot` requests a fresh frame from a camera with a supported live transport;
- `eufy_event_gateway.record_clip` records from a camera with a supported live transport;
- `eufy_event_gateway.get_stream_url` starts Home Assistant's HLS provider and returns a temporary URL for an automation, local restreamer, or compatible player.

Live viewing uses the gateway-owned Eufy Mega/PPCS transport. The gateway does not use the separate SmartLife/Thing login or an expiring Web Portal Access PIN. The transport has produced real stream and snapshot bytes from both a wired T8210 and USB-C-powered T817L, and v0.1.14 exposes it through the Home Assistant camera entities.

Home Assistant should have direct network reachability to the HomeBase. On one
tested isolated-VLAN setup, allowing Home Assistant to reach the HomeBase was
enough for attached-camera video, but HomeBase state and storage remained
unavailable until the HomeBase could also reach Home Assistant. Two
host-specific firewall rules, one in each direction between Home Assistant and
the HomeBase, were enough. The test allowed all protocols between those two
hosts, so a narrower port list is not confirmed yet. You should not need to open
the whole VLAN.

The actions work in Home Assistant automations and through Node-RED's Home Assistant Action node. An importable example is included in [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json).

## How it fits together

This repository contains two parts, and Home Assistant needs both:

1. **Eufy Mega Security app.** It signs in through Eufy's current Mega service, receives push/HomeBase events, and retains snapshots.
2. **Eufy Mega Security integration.** It turns the gateway data into normal Home Assistant camera, binary-sensor, and sensor entities.

The integration's internal Home Assistant domain remains `eufy_event_gateway` so existing entity IDs and action names keep working. The user-facing name is Eufy Mega Security.

On Home Assistant OS or Supervised, the app generates its own private API token and passes it directly to the integration through Supervisor discovery. The gateway port is closed to the LAN by default.

## Before installing

Create a separate Eufy guest account and share only the Home and cameras you want Home Assistant to access. Do not use the Eufy account currently signed into your everyday mobile app; simultaneous Eufy sessions can interfere with one another.

Open the shared Home in the Eufy app while signed in as the guest account and confirm the shared devices are visible. Event delivery also depends on each device's Eufy push-notification setting. On tested HomeBase 3 hardware that setting applied to every account, and the gateway had no separate local event route when device notifications were disabled. T8910 motion sensors behind HomeBase 2 and HomeBase 3 also require notifications to be enabled for the sensor in the active Eufy mode. That setting sends the push used by the gateway and may also show the same alert on the account owner's phone.

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

If Eufy rejects push registration, the app keeps cameras and snapshots available, reports push as degraded in the event-delivery diagnostics and logs, and retries a few times in the background. Events may not arrive until registration succeeds. When reporting this, send the `event=push_registration_degraded` log lines from the latest start (at most six).

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

Motion, person, and supported doorbell press events are Home Assistant binary sensors, so they appear directly in Node-RED's **Events: state** node. Snapshot, recording, and HLS handoff requests are ordinary Home Assistant actions, so use an **Action** node with one of:

```text
eufy_event_gateway.capture_snapshot
eufy_event_gateway.record_clip
eufy_event_gateway.get_stream_url
```

All three actions target the camera entity. Example recording data:

```json
{
  "filename": "/media/eufy/gate_latest.mp4",
  "duration": 15
}
```

Create the target directory first and ensure the path is allowed by Home Assistant. The importable example uses JSONata to add a timestamp to each filename. Import [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json), select your Home Assistant server, replace the example entity IDs, and deploy it.

`get_stream_url` must target one supported camera and use a response variable.
The response is keyed by camera entity ID and contains `url` and
`content_type`. The URL points to Home Assistant's HLS provider, not the private
gateway, and should be passed straight to the local consumer rather than stored.
Home Assistant invalidates it after the provider becomes idle or restarts.

Recordings are assembled by the gateway with a hard stream-start timeout and duration limit, then written atomically by Home Assistant. A failed request therefore cannot leave a partial MP4 at the requested filename.

## Camera behaviour

- Motion, person, and doorbell press notifications update their Home Assistant sensors without waking a stream.
- The last valid event image remains visible while the camera sleeps.
- Opening a camera starts its native PPCS session on demand and stops it after the configured limit, once that camera has passed the gateway proof.
- A familiar-person name appears only when HomeBase supplies an explicit identity. Generic detections such as `Someone` remain unknown.
- Powered cameras with their own RTSP feed can continue using that feed for video while this integration supplies Eufy/HomeBase detection entities.

## Standalone gateway

For a failing event picture, the opt-in [private evidence capture](docs/EVENT_IMAGE_EVIDENCE.md)
can preserve a bounded response sample for a maintainer. It is separate from
ordinary Home Assistant diagnostics and must be included in your installed build.

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

Private diagnostic bundles for all discovered device families are described in
[the private diagnostics guide](docs/PRIVATE_DIAGNOSTICS.md). Media requires explicit consent and private sharing.

### Experimental fixed H.265 viewer resolution

The app option `experimental_fixed_h265_resolution` is off by default. When
enabled, the H.265 live-view fallback produces a fixed 1920 by 1080 H.264 output
instead of following source resolution changes. It does not alter H.264 camera
streams, retained snapshots, or saved clips.

This is a playback compatibility test. It may improve players that drop when
the source changes resolution, but it can increase transcoder work for smaller
input and reduce detail from 4K input. Turn it off after testing to restore the
existing behaviour. Standalone installs can set
`EUFY_GATEWAY_EXPERIMENTAL_FIXED_H265_RESOLUTION=true`.


### Motion sensitivity and doorbell quiet hours

Home Assistant exposes a motion sensitivity number for these exact routes.
Step 1 is least sensitive. Higher steps increase sensitivity, including on
models whose native values count down.

| Model | Connection | Steps |
| --- | --- | --- |
| T8210 | HomeBase 3 | 1 to 5 |
| T8113-Z | HomeBase 3 | 1 to 7 |
| T8160-C | HomeBase 3 | 1 to 7 |
| T8171 | HomeBase 3 | 1 to 7 |
| T817L | Standalone, channel zero | 1 to 3 |

Controls appear only when the gateway has a known setting and a ready route.
Close live views before changing these settings, including views of other
cameras on the same HomeBase. Each change sends one command and waits for
fresh confirmation. If the outcome is unknown, check the Eufy app before
retrying. Other models and connections do not gain these controls.

The T8210 on HomeBase 3 also exposes a HomeBase doorbell chime switch. Turning
it off leaves motion detection, recording and Home Assistant doorbell events
enabled. It controls the HomeBase sound, not a separate wired or plug-in chime.

[Import the quiet-hours blueprint](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fmscodemonkey%2Feufy-mega-security%2Fblob%2Fv0.1.150%2Fblueprints%2Fautomation%2Feufy_event_gateway%2Fdoorbell_quiet_hours.yaml)
and select that chime switch, then set the start and end times. The blueprint
checks the switch's dedicated chime attribute and refuses other controls.
It switches the chime off during quiet hours and on outside them. Equal times
mean no quiet interval. The automation owns this schedule and reevaluates on
Home Assistant startup, automation reload and recovery of the switch.

Times follow Home Assistant's local timezone. A clock time skipped by daylight
saving time takes effect at the next trigger or recovery. Disabling the
automation during quiet hours leaves the chime off until it is enabled manually.
Stored-setting confirmation does not establish acoustic silence or ringing,
or measure how effectively a camera detects physical motion at each step.

### Experimental Smart Lock E30

The `experimental_e30_locks` app option is off by default. Enable it only with
an API token of at least 32 characters. The trial supports one standalone E30
T85F1, type 206, on the US cloud route. Other models and regions remain disabled.

EMS acts as an MQTT client of Eufy's cloud broker. Home Assistant receives a lock
entity and battery sensor through EMS. It does not need its own MQTT broker.
Both lock and unlock were physically confirmed on an off-door E30, with fresh
queries after each command. This does not establish behaviour under door load,
jam detection or recovery after a network outage.

Each command queries the lock first, sends at most one absolute action, and
waits for a fresh device query. It never reports an accepted MQTT message as
completed movement. An unknown outcome makes the entity unavailable. Check the
physical lock or Eufy app before trying again. Calibration, user management,
latch opening and schedule editing are not exposed.

Home Assistant also receives Auto Lock, overall notifications, locked
notifications and unlocked notifications switches, plus a Low/Medium/High
sound selector. Settings writes require the bolt to be locked. Native sound
Off is reported but makes the selector unavailable. EMS never writes Off.
The Auto-lock delay selector offers 30, 60, 90, 120, 150, 180 and 300 seconds.
Changing the delay preserves Auto Lock enablement and its schedule. Timers
outside those choices remain readable but make the selector unavailable.
Auto Lock switch changes preserve the existing delay and schedule. Notification
changes preserve every other notification bit.

Off-door tests confirmed both Auto Lock values and both lock/unlock
notification values against the restarted Eufy app. Overall notifications
were switched off through EMS and restored in the native app after the trial
stopped before its restore write. Low and Medium sound values were compared
with the app. High, timed auto-locking and these controls in Home Assistant
still need hardware confirmation.

State and battery depend on Eufy's cloud. EMS polls every five minutes and
expires observations after six minutes, so a change made elsewhere can take
several minutes to appear. Home Assistant's recovery poll reads the EMS cache.
Enabling this feature exposes unlock to Home Assistant dashboards, automations
and any voice assistants to which you expose the entity. Review those before
enabling it.

### Experimental model controls

The app option `experimental_model_controls` is off by default. When enabled,
open `/diagnostics`, enter your gateway token, select one camera and expand
**Experimental model controls**. Choose **Check available controls**, select
one operation and its value, confirm you can observe the camera, then **Try once**.
Stop live views first. Record the original setting and restore it after testing.

The separate [FamiLock S3 / S3 Max status check](docs/T85V0_STATUS_TEST.md) is a
read-only, source-derived test for exact T85V0/type 203 through HomeBase 3.
Its reported state and battery need comparison on actual hardware. It neither
operates the lock nor adds a normal Home Assistant lock control.

The initial exact-model trials are standalone T84A1 (type 151), T8417 (type 105)
and T8423 (type 38) motion detection, standalone T8423 spotlight enablement,
standalone T8417 and T8423 pan/tilt, and T8410 (type 31) pan/tilt through a T8030
HomeBase 3. Other models, channels and topologies remain unavailable. These trials come from official
Android model handlers. Their physical behaviour in this gateway still needs
confirmation on each model. Normal Home Assistant capability flags are unchanged.

Boolean settings require a fresh device-reported original value and matching
readback after the command. A movement acknowledgement does not prove movement.
A timeout can mean the command took effect but the reply was lost. Check the
camera in the Eufy app before retrying. Trials never automatically replay a
movement command. They refuse a peer already used by live viewing, recording
retrieval or another control operation.

The T8417 pan/tilt trial sends one directional click. Observe the camera and
manually restore its original view after testing. Stop and continuous movement
controls are unavailable, and physical movement and restoration remain unverified.

The standalone S100 T84A1 (type 151) also has an experimental **siren** trial.
Confirm you can observe the camera and stop it if needed, then choose
**Five-second sound test** and listen for sound and early stop. You can
use **Stop siren** while the test runs. The gateway attempts both stop commands
before closing its session, including after a lost start reply or graceful
shutdown. The start command requests a 30-second limit, but enforcement by this
device is unverified. If it keeps sounding, stop it in the Eufy app. Keep the
camera within reach of somebody who can observe the test.

S100 sound and stop behaviour still needs confirmation on reporter hardware.
Acknowledgements do not prove sound or silence. A failed trial can mean a reply
was lost, even if the command worked. Report whether it sounded and stopped,
plus the `model_control_trial_failed` log line on failure. A `start` failure means
start acknowledgement was not established. `primary_stop` or `secondary_stop`
means the corresponding stop was not confirmed. A late start reply cannot turn
an ambiguous start into a successful trial. Any failed start, including an
explicit rejection, sends the primary stop without waiting for its reply. The
expected failure stages are then `start,primary_stop`. A stop requested while
the connection is still being prepared is refused because no pulse has started. The normal Home Assistant siren
capability remains unavailable. NVR live video uses the separate experimental option and exact pairings documented below.

For standalone installs, set `EUFY_GATEWAY_EXPERIMENTAL_MODEL_CONTROLS=true`
and configure `EUFY_GATEWAY_API_TOKEN`. The authenticated
`GET /api/cameras/{camera}/model-control-trial` lists admitted actions.
`POST` accepts exactly `{"action":"motion","enabled":true}`,
`{"action":"spotlight","enabled":false}`,
`{"action":"siren","enabled":true}` (five-second test, false to stop), or
`{"action":"ptz","direction":"left"}` (also right, up and down).
Do not include camera identifiers or private diagnostics in public issue comments.

### Experimental general camera video test

The default-off `experimental_general_rtc` option adds a separate, consented ten-second private clip test in Diagnostics. It requires the configured account to own the camera and the camera or HomeBase to report portal RTC support. Guest accounts, NVR cameras and the T8224 doorbell are refused. Hardware behaviour is unconfirmed, and normal live view stays unchanged.

Read [the trial guide](docs/GENERAL_RTC_TEST.md) before enabling it. The Eufy live-view PIN is sent to Eufy once per dispatched attempt. The test uses battery, can take about three minutes and may keep the camera awake for about 40 seconds after capture. It does not force sign-in. An eligible video identity is captured only during a future natural sign-in.

### Experimental NVR video test

The separate [NVR camera-power test](docs/NVR_CAMERA_POWER_TEST.md) is off by
default and limited to T8E00/type 301 through T8N00/type 300. It requires
observation consent, a recorded original state and its own app option. It
attempts restoration, but a lost connection can require manual restoration.
One reporter confirmed physical off/on and restored on state for this pairing on
v0.1.188. Later versions and recovery after a connection failure have not been
separately confirmed. Normal controls stay unavailable.

The [NVR Schedule guard-mode test](docs/NVR_GUARD_MODE_TEST.md) is also off by
default and limited to the same exact pairing. It temporarily changes the whole
T8N00 from Schedule to Home, confirms fresh cloud state, and restores Schedule
with correlated state reads matching the schedule in the operator-entered NVR
timezone and byte-identical schedule data. It refuses unsafe schedule windows.
An unconfirmed restore blocks further NVR tests and live starts until restart,
and restarting does not restore the NVR. A lost connection can still require
manual restoration. Hardware behaviour is unconfirmed, and no normal alarm
control is enabled.

`experimental_nvr_live` is off by default. Enabling it adds a consented,
ten-second private video test to Diagnostics through exact T8N00/type 300 or
T9000/type 27 parents. The exact camera/model pairs are T8E00/type 301,
T8140/type 14, T8140-Z/type 14, T8113-V/type 8, T8172/type 89, T8162/type 26,
T8170/type 48, T81A0/type 10005 and T8425/type 47. Additional diagnostic models request only
their first lens and remain hardware-unconfirmed, including non-Z T8140.

The same option also enables normal Home Assistant live view for T8E00/type 301 through T8N00/type 300 and T8140-Z/type 14 through T9000/type 27 when the gateway's NVR binding checks pass. Normal live view has no per-view consent step. Anyone with Home Assistant camera access can open these cameras. The reported T8E00 views and reopening on v0.1.163 lasted about a minute, with startup delay and initially accelerated playback. T8140-Z initial and reopened video was reported on v0.1.174, with one reopened session ending after 49 seconds with `peer_failed`. That cause and sustained playback remain unconfirmed.

T8416/type 104 through T8N00/type 300 has a separate hardware-unconfirmed normal live path requiring `experimental_nvr_live`, `experimental_model_controls`, `experimental_nvr_controls`, a configured API token, explicit camera and station ownership, and a unique camera channel. It needs owner credentials, unlike the usual guest-account recommendation. Do not switch a working gateway to your everyday owner account just to enable this experiment. Enabling the NVR controls option also makes the manual physical camera-power and Schedule guard-mode trials available. Those trials remain off by default, require their own consent and observation, and are limited to T8E00/type 301 through T8N00/type 300. The camera-power trial has a reporter-observed physical off/on and restored-on result on v0.1.188 for this pairing. Later versions are not separately confirmed. The guard-mode trial and experimental live controls remain physically unconfirmed. There is no normal T8416 live binding through T9000.

This does not establish support for every NVR camera, automatic fresh snapshots, events, storage, normal station controls or arming. Retained pictures and each diagnostic result remain separate.

Update the app and integration, enable the option, open Diagnostics, enter the
gateway API token locally and load devices. Select one supported camera, expand
Experimental NVR video test, confirm private video consent and choose Try NVR
video once. Close other live viewers first. You can cancel the test, and the
connection has a hard time limit. Turn the option off after testing if you no
longer need it.

The same option also enables **Read NVR state once** in Diagnostics. Select a
camera, confirm the separate read-state consent and use that button to query
station guard settings and the selected camera's power setting. It starts no
video and changes no settings. Compare the displayed values with the Eufy app.
Missing or unrecognised values stay unknown. The query time records gateway
receipt, not proof that the appliance refreshed its own cache. Arming and
camera controls remain unavailable. If it fails, share only the
`nvr_state_trial_failed` line, keeping all private diagnostics private.

The authenticated `POST /api/cameras/{camera}/nvr-state-trial` accepts exactly
`{"consentReadState":true}`. It returns only interpreted settings, a parameter
count and query time, never raw device parameters, account information or keys.
It shares the video trial's exclusive connection and cancellation button.

The service region option accepts `auto`, `us`, `eu` or `ie`. GB-style accounts
may need `ie` even when automatic domain metadata selects `eu`. The account
country remains unchanged. Only IE has independent hardware evidence for the
join region. There is no automatic retry across regions or second login.

Check whether the clip plays and shows the selected camera. HEVC playback may
require downloading it to a compatible player. A connection or command result
alone does not confirm playback. If the test fails, share only the
`nvr_live_trial_failed` log line publicly. Keep the token and clip private.
Nothing is uploaded automatically.

This first trial does not implement FEC or retransmission recovery. NVR receive
framing, response segment echo, discovery identity fields, video command
selection, compact offers, and stop behaviour still need hardware confirmation.
Unsupported or inconsistent data fails the test instead of being treated as
working camera support.

The trial admits only the exact camera/model pairs and parents listed above. Enabling it can add an experimental inventory camera
entry to the gateway and Home Assistant. Normal streaming is available only for the exact pairings and conditions above. Other entries do not gain normal streaming or controls. Turning the option off and restarting removes it from the gateway.
Home Assistant may retain an unavailable registry entry. An entry left after an
inventory change remains a read-only placeholder and cannot start a trial if its
binding no longer matches.

The trial aborts after 82 seconds, reserving time within its 90-second safety
budget for closing the connection and reaping a cancelled media process. This
implementation limit may cancel an unusually slow connection before it can
return a full clip. It is not a measured hardware performance guarantee.
Trial footage is excluded from retained snapshots and diagnostic media capture.

### Optional native camera video

In **Settings → Devices & services → Eufy Mega Security → Configure**, enable
**Try native camera video (video only)** to share the original H.264 or H.265
video with Home Assistant. This option is off by default. Saving reloads the
integration. Native H.265 avoids the gateway's H.264 compatibility conversion.
Home Assistant's existing go2rtc provider continues to own WebRTC signalling.

One reporter's installation confirmed native H.265 playback in the Home Assistant iOS app and desktop browsers on v0.1.192. The reported time from stream request to first HLS part was about 7 to 10 seconds, which does not measure end-to-end rendering latency. The report does not establish which transport a physical client selected. Two cameras still produce no source video and are tracked separately. Client support varies.

Native mode is video only, including for cameras that support audio. HLS and
`get_stream_url` use the same selected source. Synthetic H.264 and H.265 video
decoded through go2rtc and HA's pinned PyAV version, but H.265 playback still
depends on the browser and hardware decoder. There is no automatic fallback.
Turn the option off to restore compatible video and audio.

NVR connections also send their answer after an initial UDP candidate and a
short gathering grace, while remaining candidates continue to arrive. Late
relay selection and cancellation are covered by local connection tests. Startup
timings are recorded without connection identities. Real NVR latency and its
acceptance of late candidates still need hardware confirmation.

### Optional shorter Home Assistant live-view idle timeout

In **Settings → Devices & services → Eufy Mega Security → Configure**, enable
**Try a 60-second HLS idle timeout** to test earlier release of unused HA live
views. This option is off by default and saving reloads the integration. Turn
camera **Preload stream** off for this test. Active HLS requests keep the viewer
output alive. Closing all viewers should let it expire after about 60 seconds
plus any in-flight requests and worker cleanup, instead of HA's usual five
minutes. Other HLS clients, including casts, can still keep it active.

The option starts its 60-second startup deadline before the first video segment,
so a failed initial session can expire instead of retrying indefinitely. A new
playback request can start another session. This does not fix an HTTP 463 failure
or restore a missing picture.

The option applies to this integration's HA live views. Recordings and explicitly
requested timeouts retain their own behaviour, and gateway URLs or Eufy app
sessions are separate. If a slow camera fails to start or active
playback suffers, disable the option to restore HA defaults. Shorter camera
wake time and battery savings remain unconfirmed until tested on the affected
hardware. Report whether playback stays healthy while open and whether
reconnections stop sooner after all viewers close.

The T85V0/type203 backup AA battery has a separate read-only sensor when its
inventory reports that measurement. Missing, invalid and unavailable values
stay unknown. The primary battery is never used as a substitute, and the sensor
does not poll or operate the lock. Physical percentage accuracy is unconfirmed.

Experimental exact-model NVR controls are documented in [NVR live controls](docs/NVR_LIVE_CONTROLS.md). They remain off by default and hardware-unconfirmed.
