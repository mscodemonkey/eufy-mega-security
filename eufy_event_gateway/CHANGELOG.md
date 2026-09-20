# Changelog

## Unreleased

- Admit T8400 and T8419 camera inventory types 30 and 10009 while keeping media and event support evidence-gated.

## 0.1.62

- Add confirmed camera motion-detection switches for supported HomeBase-attached cameras.
- Align PPCS media assembly with the reference handling for decoded frame lengths.
- Correct T817L classification so it does not expose a Doorbell sensor.

## 0.1.61

- Admit Eufy device type 96 as a camera for T8224 inventory while keeping doorbell press support evidence-gated.
- Name the admission roles for the T8224, T85D0, and T85V0 device types so model strings cannot silently override reported numeric identity.

## 0.1.60

- Reassemble complete PPCS media access units before stream consumers receive bytes.
- Resolve direct and HomeBase-attached media protection through one authenticated path.
- Make camera stream replacement generation-safe and refresh retained Home Assistant images from committed revisions.
- Add canonical device routing, observed-state precedence, and split gateway evidence tooling.

## 0.1.59

- Add a capability-gated Camera enabled switch for cameras that report a master enablement value and have a ready PPCS control route.
- Send enablement writes through the camera's negotiated PPCS session and publish the new Home Assistant state only after fresh cloud inventory confirms it.
- Add regression coverage for the reported state polarity and bounded control-command body. Real-device confirmation remains pending.

## 0.1.58

- Added authenticated ECC-wrapped AES-GCM PPCS video decoding for cameras that mix protected frames with clear Annex-B media, while retaining the existing legacy RSA media path.
- Added regression coverage for authenticated keyframes, cached media keys on delta frames, and rejection of tampered media.

## 0.1.57

- Admit eufyCam C37 T814X, Mega camera type 10037, through its reported ready HomeBase 3 route. Discovery, events, snapshots, and live video await reporter testing.
- Allow up to 30 seconds for a fresh snapshot so slower cameras can complete peer lookup and produce a decodable frame without changing live-view or clip limits.
- Update device coverage with confirmed T8142-Z snapshots and live video, the intermittent T81A0 fresh-capture boundary, the mixed T84A1 bootstrap results, and the non-camera T85D0 classification.

## 0.1.56

- Fix stalled HTTP viewers when reopening a stopped camera stream by waiting for fresh codec headers and sending HTTP headers only once.
- Admit SoloCam E30 T8171, Mega camera type 88, through its reported HomeBase route. Hardware discovery, events, snapshots, and live video await reporter testing.
- Update device coverage with confirmed C20 and S100 live video, T8423 event snapshots, and the remaining T9000, T8417, T85V0, and T8214 playback limitations.

## 0.1.55

- Recognize H.265 VPS, SPS, and PPS headers when starting Home Assistant live viewers and retained-image extraction.
- Reissue a standalone camera's media start while it sends only delta frames, giving the camera another bounded chance to announce a decodable keyframe.
- Record direct-media start attempts in privacy-safe stream summaries.
- Record confirmed HomeBase 3 discovery and live video for SoloCam S230 / S40 T8124.

## 0.1.54

- Admit SoloCam S230 / S40 T8124 as Mega camera type 62 through its reported HomeBase route. Discovery, events, snapshots, and live video still need reporter confirmation on real hardware.

## 0.1.53

- Recover from Mega error 4404 by replacing and persisting the rejected request identity once, then use the existing login recovery if the fresh identity is also rejected.
- Accept Home Assistant's positional code argument for HomeBase Away, Home, and Disarm commands.
- Admit Floodlight Cam T8423, Indoor Cam T8417, and Familock T85V0 inventory through their reported HomeBase camera routes. These paths still need reporter confirmation on real hardware, and the T85V0 does not expose lock controls.
- Add privacy-safe video codec, NAL type, and codec bootstrap diagnostics to camera stream close summaries.

## 0.1.52

- Clear completed provider stop timers so a failed snapshot cannot leave later Home Assistant live-view requests stuck before stream startup.
- Keep the existing PPCS command, frame parsing, and HomeBase media paths unchanged.

## 0.1.51

- Retry PPCS peer discovery throughout the connection window and send the app-compatible cloud lookup forms once the gateway's routed address is known.
- Accept direct and relay lookup responses and probe the bounded UDP port neighbourhood used when NAT remaps a HomeBase connection. This targets the T9000 lookup timeout reported in issue 27 without changing either media path.

## 0.1.50

- Label standalone-camera live-start commands with the level-one signature and frame type expected by direct PPCS cameras. This addresses the T84A1 path that connected and accepted commands but never returned a video frame.

## 0.1.49

- Admit the T8142-Z / eufyCam 2C Pro as Mega camera type 15 through its reported HomeBase 2 route. Discovery, events, snapshots, and live video still need confirmation on this model.
- Use days-since-last-charging only when Eufy's established device inventory supplies it. The newer inventory's placeholder zero is no longer exposed as a real reading.
- Record community confirmation of HomeBase 3 alarm-panel state, guard-mode switching, and alarm-tone selection.
- Keep the hardware-verified v0.1.48 H.264 framing and viewer-bootstrap path unchanged.

## 0.1.48

- Send HTTP response headers before writing cached H.264 codec data to repeat live-view connections. This prevents a returning Home Assistant viewer from receiving video bytes before the stream response is established.
- Confirm live streaming on T817L, T8210, and three T8113-Z cameras using the packaged stream-framing and codec-bootstrap fixes.

## 0.1.47

- Preserve length-prefixed H.264 NAL units across PPCS video-frame boundaries before converting them to Annex-B. This covers the T8210 stream whose declared 252-byte NAL arrived over more than one gateway frame.
- Hold each Home Assistant live-view response until the stream has supplied SPS and PPS codec headers, then prepend those headers for both initial and repeat viewers. This prevents go2rtc from probing a stream at an SEI or slice NAL and rejecting an otherwise valid camera stream.

## 0.1.46

- Convert complete four-byte length-prefixed camera video payloads to Annex-B before handing them to Home Assistant. This addresses the T817L `unsupported header: 0000003f...` playback failure while leaving existing Annex-B streams unchanged.

## 0.1.45

- Ignore duplicate and stale PPCS datagrams instead of feeding retransmitted bytes into the media parser.
- Discard incomplete command payloads after a true datagram loss and resume only from a complete PPCS command header.
- Decode each encrypted media frame with its own wrapped key and leave later plaintext frames untouched. This prevents a mixed T817L stream being corrupted by a cached key from an earlier frame.

## 0.1.44

- Read the HomeBase camera channel from the current PPCS frame before advancing the parser buffer. This prevents valid requested-camera video from being rejected as sibling media.

## 0.1.43

- Report PPCS sessions that end naturally, including a privacy-safe close reason and their final media counters.
- End a connected camera session after 20 seconds without its first usable video frame, allowing Home Assistant to retry instead of retaining a silent stream.

## 0.1.42

- Keep HomeBase camera streams isolated to their requested camera channel. Sibling-camera media no longer reaches the wrong Home Assistant stream or suppresses its retry cycle.
- Add a privacy-safe `foreign_video_frames` stream diagnostic for confirming HomeBase camera handovers.

## 0.1.41

- Restore the missing Home Assistant integration domain import used by the T817L entity migration, so existing entries can start.

## 0.1.40

- Stop re-sending a HomeBase camera's full media-start command while its frames are flowing. The command is reasserted only during startup or after a genuine stall, preventing T8210 live-view resets and jumps.

## 0.1.39

- Add privacy-safe PPCS frame-shape diagnostics for data channels, command IDs, signature modes, bounded payload lengths, sequence gaps, parser state, and video-output outcomes.
- Log explicit live-view and fresh-snapshot request markers before Home Assistant media requests enter the camera transport.
- Read **Days since last charging** from Eufy's Security device inventory, which supplies the current value when the newer Mega inventory returns a placeholder zero.

## 0.1.38

- Admit the standalone T8200 / Mega type 5 as a doorbell camera through its self-parented direct PPCS route, including the existing doorbell press entity.
- Add a diagnostic **Days since last charging** sensor when Eufy's cloud inventory reports its validated `charging_days` value.

## 0.1.37

- Add a privacy-safe live PPCS probe for battery-history parameter 3100. Support logs report only bounded JSON field names and structural types, never timestamps, measurements, account data, or device identifiers.

## 0.1.36

- Discover T8010 HomeBase 2 as a read-only Home Assistant device with firmware, inventory availability, and child-camera route readiness, without enabling unverified T8030 controls.
- Log privacy-safe snapshot, clip, and PPCS failure stages with model, route, and bounded transport counters so direct-camera media failures can be diagnosed without device identifiers or packet data.

## 0.1.35

- Clarify that Home Assistant must be fully restarted after updating the integration, and that the HACS integration and app are updated separately.

## 0.1.34

- Attempt each missing startup snapshot only once per gateway run instead of retrying after every inventory refresh.
- Suppress repeated state pulses for two-stage push deliveries while retaining a thumbnail that arrives on the later delivery.

## 0.1.33

- Retry authenticated push-thumbnail downloads after brief HTTP 404 responses while Eufy's cloud object is still becoming available.
- Log successful retained push snapshots explicitly so notification-image recovery can be confirmed from privacy-safe support logs.

## 0.1.32

- Restore the Home Assistant app's displayed release history by backfilling its changelog for versions 0.1.27 through 0.1.31.
- Enforce the current release heading in both the repository and app-facing changelogs as part of the release consistency check.

## 0.1.31

- Authenticate temporary Eufy event-image downloads, follow only the expected object-store redirect without forwarding credentials, and retain attributed thumbnails independently of event classification.
- Add distinct transient sensors for pet, vehicle, dog, crying, sound, stranger, and stranded-package detections from the expanded Eufy push-event vocabulary.
- De-duplicate follow-up notification deliveries and summarize repeated HomeBase refresh failures instead of logging the same warning every minute.

## 0.1.30

- Confirm T8030 writes through fresh readback when an acknowledgement times out, without resending the command; log station-command outcomes and surface safe gateway errors in Home Assistant.

## 0.1.29

- Correct the USB-C-powered T817L classification: suppress its battery-shaped compatibility fields and remove battery entities created by v0.1.28 during upgrade.

## 0.1.28

- Add camera and doorbell battery percentage, charging, health, and temperature entities when the corresponding Mega inventory fields are present.
- Add a normalized standalone-sensor API and Home Assistant devices for supported contact, PIR motion, battery percentage, and last-seen state.
- Route contact open or closed pushes and transient PIR motion pushes into Home Assistant, with a 60-second inventory refresh for persisted readings.
- Keep capability decisions evidence-based: mains-powered camera sentinels do not create battery entities, and standalone sensor entities appear only for reported fields or recognized PIR types.
- Document the Home Assistant integration's module ownership, entity lifecycle, protocol boundaries, and non-obvious state behaviour under the project-wide Python commenting standard.

## 0.1.27

- Log privacy-safe capability groups for cameras, doorbells, HomeBase 3, and standalone sensors. The groups show known-type admission, route readiness, reported core evidence, and which gateway paths can be offered without printing device identifiers or raw values.
- Add authenticated gateway capability endpoints so a discovered device can be compared with the current gateway support paths before Home Assistant entities are considered.
- Use DSK keys fetched during the current inventory pass when deciding whether a camera's media route is ready.
- Unknown camera-like rows are marked for review, not automatically accepted. Battery reads and standalone sensor state remain discovery-only; this release adds no battery or sensor entities to Home Assistant.

## 0.1.26

- Handle snapshot and clip timer rejections as soon as their promises are created. A timeout during slow PPCS startup now reaches the capture or recording caller instead of triggering the process-level unhandled-rejection exit.
- Admit Mega camera types 26 (`T8162`), 47 (`T8425`), 48 (`T8170`), and 10005 (`T81A0`) through an inventoried parent peer with a camera channel, PPCS connection, and DSK key.
- Keep T9000/type 27 out of the camera and managed-station inventories. It remains an eligible PPCS parent for its cameras. Station command behaviour and media on the reported hardware still need testing.

## 0.1.25

- Admit Mega types 94 (`T8214` Video Doorbell E340) and 104 (`T8416` Indoor Cam S350) through their inventoried parent PPCS peers.
- Classify the E340 as a doorbell so its camera state includes the existing press sensor. Press-event routing on this model remains unverified.
- Keep the `T8023` MiniBase Chime outside the camera and HomeBase entity lists; its inventory connection may serve the E340's media path.

## 0.1.24

- Register for camera notifications as the Eufy Android app instead of a Chromium web-push client. The old subscription could connect to Firebase but delivered metadata-only messages.
- Normalize local motion (`3101`), person (`3102`), and T8210 doorbell press (`3103`) payloads from the new Android FCM transport.
- Report delivery and routing with payload-free logs, and include `npm run debug:push` for local checks without Home Assistant or PPCS.
- Persist the Android receiver identity and delivered message IDs so a restart can reconnect without replaying old notifications.

## 0.1.23

- Admit eufyCam S300 / 3C (`T8161`, Mega type 23) as a HomeBase-attached camera. The reporter's inventory had the station, channel, PPCS, and DSK prerequisites, but real-device discovery, events, snapshots, and live video still need confirmation.

## 0.1.22

- Include the merged HomeBase 3 device, alarm, guard-mode, storage, volume, and tone support for the next versioned app update. Hardware confirmation of command framing, storage units and status meanings, writable ranges, and siren stop codes is still required.
- Admit Mega device type 63 (T8134/SoloCam C20) as a camera when its inventory provides the required HomeBase and PPCS prerequisites. Discovery, events, snapshots, and live video still need hardware testing.
- Add the first standalone PPCS route for the Wired Wall Light Cam S100 (`T84A1`, Mega type 151). The gateway now uses an eligible parentless camera's own peer connection and DSK key rather than requiring a HomeBase.
- Log a privacy-safe summary of every normalized push and a payload-free receipt when a push cannot be normalized. Inventory diagnostics also identify HomeBase, direct, and unavailable stream routes without exposing device identity or connection values. S100 discovery, events, snapshots, and live video still need hardware testing.
- Run the app on the host network so local PPCS UDP discovery can reach Eufy devices on the LAN while keeping the gateway API port unmapped by default.
- Correct the HomeBase local-lookup and camera-check PPCS request headers.
- Convert HomeBase storage figures from the device's MiB values to bytes before publishing them to Home Assistant.
- Present HomeBase storage capacity in gigabytes with two-decimal display precision.

## 0.1.21

- Add HomeBase 3 as its own Home Assistant device with model, firmware, inventory availability, and separate PPCS connection diagnostics.
- Add a code-free alarm panel for Away, Home, and Disarmed, plus configured and effective guard-mode entities for Schedule, Geofencing, and Custom 1 through 3.
- Follow guard-mode and siren changes received through Eufy push notifications, with a 60-second PPCS recovery poll that waits while the HomeBase is serving camera media.
- Add read-only eMMC and HDD or SSD capacity, free-space, and device-status sensors.
- Add alarm volume, prompt volume, and alarm tone controls. Every write waits for a device acknowledgement and fresh readback, does not retry automatically, and stops active camera media when a security command needs the HomeBase.

## 0.1.20

- Remove the unused Web Portal/WebRTC, Thing/MQTT, and experimental native-relay code paths and their dependencies.
- Replace the saved session's fast password-derived value with a version 2 `scrypt` credential verifier. The first start after upgrading requires a fresh Eufy sign-in.
- Document why live PPCS sessions still use an ephemeral RSA-1024 key: current cameras return the encrypted video key in a fixed 128-byte protocol field.

## 0.1.19

- Discover T8160/S330, T8410/T8410C, and T8213 cameras from the Mega inventory types reported by affected installations.
- Keep the type 18 HomeBase as parent metadata instead of exposing it as a camera.
- Thanks to @AbeltjeNL for patiently testing the setup and sharing the inventory log that identified the missing device types.

## 0.1.18

- Prefix every gateway support-log line with a UTC timestamp, severity, release version, process run ID, component, and event name.
- Record explicit process start, listening, stop, and fatal-error events so copied logs preserve restart boundaries.
- Report grouped Mega inventory classifications and stream-readiness fields without device names or serial numbers.
- Suppress expected readiness-probe connection noise and redact common credentials and account email addresses from gateway diagnostics.

## 0.1.17

- Show the verification-code field directly in app configuration instead of hiding it behind the optional-field control.
- Capture retained images sequentially for newly discovered cameras that have no snapshot.
- Exit cleanly after Supervisor sends `SIGTERM` instead of reporting the gateway process's signal status as app exit code 143.

## 0.1.16

- Preserve Eufy's limited pre-verification Mega session across the documented app restart so email-code submission retains its required token.
- Submit Web UI email verification through the active Mega client instead of the separate legacy web session.
- Add regression coverage for verification-required login, app restart, and successful code submission.

## 0.1.15

- Add a first-day developer guide covering the repository architecture, Mega authentication, inventory, push events, snapshots, PPCS streaming, and Home Assistant conversion.
- Add a detailed Mega platform and protocol reference with endpoint, payload, encryption, and media-flow documentation.
- Expand file-level TypeScript, Python, probe, and test documentation so maintainers can understand ownership, lifecycle, and protocol boundaries from the source.
- Add direct links to the developer documentation from the public and app READMEs.

## 0.1.14

- Add contributor, security, and repository file-map documentation.
- Document the internal `eufy_event_gateway` compatibility identifiers separately from the Eufy Mega Security branding.
- Expand source comments around the Mega, PPCS, state, storage, and Home Assistant integration boundaries.
- Clarify that a battery camera with no charge can complete the PPCS handshake without producing video.

## 0.1.13

- Rename the project, Home Assistant integration, and HACS repository to Eufy Mega Security.

## 0.1.12

- Add a gateway-owned first-party PPCS camera transport with level-2 key negotiation.
- Prove live H.264 and fresh JPEG snapshots for wired and battery camera classes before Home Assistant integration.
- Remove the obsolete Web Portal PIN and Thing-login stream configuration.

## 0.1.11

- Use the gateway's first-party Mega authentication, inventory, push, and event-image implementations.
- Register camera types 7, 8, and 10031 from the current Mega inventory.
- Migrate an existing authenticated Mega session without retaining the obsolete client dependency.
- Disable unsupported live-stream actions instead of routing them through the retired legacy API.

## 0.1.10

- Use the Mega client's supported device-list request instead of an incompatible low-level payload.

## 0.1.9

- Avoid the legacy device list while operating through an authenticated Mega-only session.

## 0.1.8

- Use an authenticated Mega session for camera discovery and push notifications without requiring the failed legacy login.

## 0.1.7

- Keep CAPTCHA results inside the app web interface and show a fresh challenge when Eufy rejects an answer.

## 0.1.6

- Add an authenticated Home Assistant app web interface for completing Eufy CAPTCHA challenges.

## 0.1.5

- Download and retain event thumbnails for push-only HomeBase 3 cameras.

## 0.1.4

- Keep the app and companion integration release versions aligned.

## 0.1.3

- Keep the app and companion integration release versions aligned.

## 0.1.2

- Keep the app and companion integration release versions aligned.

## 0.1.1

- Include the companion integration's HACS brand asset in the repository release.

## 0.1.0

- Initial event-first gateway release.
- Generated private API authentication and Home Assistant discovery.
- Legacy and Mega device inventory, push detections, retained images, and on-demand P2P video.
- Independent liveness checks that keep authentication-required and temporary-disconnection states observable.
