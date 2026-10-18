# Changelog

## 0.1.176

- Add a privacy-safe camera-enable diagnostic that reports whether parameter 1035 is missing, normalized, or an unrecognized value shape.
- Include the existing normalized enabled state beside that classification without exposing raw device payloads or widening camera control admission.

## 0.1.175

- Restore the pre-v0.1.174 default login preparation path. The gateway no longer extracts the optional RTC private scalar unless the default-off general video trial is enabled.
- Keep opt-in RTC identity capture separate and verify its scalar, public key and encrypted password remain one matching ephemeral key pair.

## 0.1.174

- Add the default-off `experimental_general_rtc` owner-account video trial in Diagnostics. It requests one consented private H.264 clip without changing normal live view.
- Keep trial authentication passive, use only cached native request identities, and clear optional stored video identity when disabled. The PIN and clip are not persisted.
- Check fresh ownership before and after recording, enforce PIN cooldowns and bounded media cleanup, and document unconfirmed hardware and service compatibility.

## 0.1.173

- Fix NVR live video reopening after a previous stream ends, including overlapping viewer cleanup. The reported remote stream closure still needs investigation.
- Match the official app's login CAPTCHA request. Account-specific sign-in outcomes still need confirmation.
- Clarify how to open the gateway diagnostics page from Home Assistant app settings.

## 0.1.172

- Add default-off normal NVR camera controls for exact T8E00/type301 and T8416/type104 cameras on an explicitly owned T8N00. Home Assistant offers model-specific view, night-vision and live-quality choices, plus single-step movement and limited optical zoom where admitted.
- Require an active viewer for movement, fresh administrator and child checks before writes, bounded source lifetime, exclusive control ownership and confirmed setting readback. Malformed control replies leave working video alive.
- Expire observed NVR settings after 30 minutes and clear them when the binding or selected view changes. Unconfirmed writes remain unknown and are never silently retried or rolled back.
- Tighten the existing manual NVR guard and camera-power trials to require explicit child membership.
- All new controls remain experimental and hardware-unconfirmed. Changing a setting without a viewer opens a source and retains an image. See docs/NVR_LIVE_CONTROLS.md for model choices, persistent-setting effects and the reporter retest.

## 0.1.171

- Add the default-off NVR Schedule-to-Home trial with an operator-confirmed NVR timezone, schedule-aware preflight and correlated state checks.
- Keep restoration independent of browser cancellation, retry transient read failures and block further NVR operations after an unconfirmed restore.
- Preserve ownership of diagnostic station reservations and enforce NVR cooldowns before new live sessions.
- This trial temporarily changes the whole NVR and may arm cameras or alarms. Hardware behaviour remains unconfirmed, and manual restoration in Eufy may be required.

## 0.1.170

- Keep distinct push meanings separate when Eufy reuses one event identifier. A doorbell press arriving immediately after a person event now reaches the Home Assistant doorbell sensor, while repeated delivery of the same event remains suppressed.

## 0.1.169

- Add explicit Home Assistant camera actions for cloud recording day lists and calendar hints. Responses omit recording IDs, owner details and playable links.
- Add a manual cloud calendar check in Diagnostics, behind the existing default-off cloud-recording option. Calendar filtering and real-account behaviour remain unconfirmed.
- Add an exact-model S100 connection check that prepares one session without sending a siren command. It separates connection, key-negotiation and counter failures, while audible siren behaviour remains unconfirmed.
- Preserve all normal camera routes and default-off experimental controls. The new metadata actions make cloud requests only when explicitly called.

## 0.1.168

- Add a separately enabled, owner-only NVR camera-power diagnostic that checks the original state, tests one temporary value and attempts verified restoration. It stays off by default and needs observed hardware confirmation.
- Recognise type-95 C31/C30 doorbells in the existing ring-event and Home Assistant doorbell-sensor path. Physical presses and absence of false rings still need reporter confirmation.

## 0.1.167

- Picture download failures now include redacted request paths, the failing request hop and attempt count, making persistent cloud 404 errors easier to investigate without sharing signed URLs.
- Read-only NVR state queries now require a matching reply instead of accepting unsolicited state updates. NVR security writes and restoration remain unavailable.

## 0.1.166

- Handle event notifications containing several picture links by selecting the first nonempty link for the retained snapshot. Literal commas separate links, as in the Android app. Invalid or oversized lists leave the last good image intact.
- Give not-yet-ready cloud pictures a longer, bounded retry window, while preserving motion delivery independently of picture downloads. Cancel discarded responses and stop retries promptly when the gateway closes. These changes still need confirmation against the reported picture failures.

## 0.1.165

- Add an optional read-only FamiLock S3 / S3 Max status check for exact T85V0 devices through HomeBase 3. Diagnostics requests the reported state and battery once without locking, unlocking or changing settings. Hardware confirmation is still needed.
- Keep the new check separate from existing E30 controls, with owner and connection checks, an exclusive HomeBase session, strict encrypted reply matching, cancellation and a cooldown.

## 0.1.164

- Recognise T8910 motion timestamps in milliseconds as well as seconds. Cloud motion fallback consumes cached and rolled-back readings without replay, ignores stale or future events, and expires old push confirmations so they cannot suppress later motion indefinitely. Actual delivery with phone notifications disabled still needs hardware confirmation.
- Add a manual, default-off T8910 local-motion test through HomeBase 2 or 3. It listens for fresh local messages without changing sensor or phone notification settings, rejects competing HomeBase activity and returns candidate counts only. Phone-independent Home Assistant motion remains unconfirmed and is not enabled by this diagnostic.
- Add an explicit On/Off light test for T81A0 Solar Wall Light Cam S120 through HomeBase 3. It requires an owner account and fresh device bindings, sends once and accepts only an authenticated matching acknowledgement. Physical light behaviour remains unconfirmed, and no normal Home Assistant light control or cached light state is added.
- Keep both experiments manual and off by default, with cancellation, bounded lifetimes, privacy-safe results and separate instructions for the smallest useful hardware check.

## 0.1.163

- Expose normal Home Assistant live view for the reporter-confirmed T8E00 through T8N00 and T8140-Z through T9000 pairings when experimental NVR support is enabled. Other pairings remain limited to Diagnostics, and automatic startup snapshots do not consume these NVR sessions.
- Add a manual, default-off standalone C31 continuous-recording index test in Diagnostics. It sends one source-defined query, checks current device and account bindings, and returns structural counts without footage, recording times or encryption identifiers. Hardware behaviour is unconfirmed, and a timeout remains inconclusive.
- Require explicit index-test consent, bounded replies, exclusive session ownership and cancellation on disconnect or page departure. Recording settings, playback support, arming, locks and destructive storage operations are not enabled by this test.

## 0.1.162

- Match the official Eufy login request shape for accounts that previously failed at startup with application error 26108.
- Recover experimental NVR video after a forward sequence discontinuity instead of ending the whole trial.

## 0.1.161

- Correct experimental NVR test-clip timing when the camera declares a different frame rate from the video it sends. Successful clip completion no longer carries a cancelled-stage label.
- Limit the bitrate and encoder buffer of the H.265 browser fallback to reduce oversized H.264 output and delivery backpressure. Browser playback on the reporting setup still needs confirmation.
- Show which fixed cloud operation rejected startup, while keeping account and response details private. Error 26108 remains an unclassified server rejection, with no automatic sign-in or retry added.
- Recheck NVR child, station and account bindings against new inventory reads around the read-only settings test. Identify configured mode as cloud inventory, preserve independently queried camera power, and keep missing local effective-mode readings unknown. Cancelled, expired or changed bindings cannot return stale results.
- Keep NVR arming, camera-power and privacy writes disabled. Reporter hardware playback and control behaviour remain unconfirmed.

## 0.1.160

- Accept the reported T8223 Video Doorbell C31 device type 95 variant behind HomeBase 2 without widening admission to other models.
- Preserve the observed NVR diagnostic video cadence when packaging private test clips, and report successful video delivery as completed instead of failed cancellation.
- Add privacy-safe failure reasons when a standalone T8224 diagnostic call rejects the received video offer.
- Show working feature indicators and separate support-site update dates more clearly.

## 0.1.159

- Correct two receive checks that rejected valid T8E00 keyframe fragments and video replies in the experimental T8N00 NVR video test. Preserve camera selection and bounded receive validation. Hardware playback still needs reporter confirmation.
- Recognise exact NVR heartbeat echoes without counting them as malformed video traffic. The NVR trial remains off by default, and normal Home Assistant NVR streaming and write controls remain disabled.

## 0.1.158
- Preserve the accepted Mega push registration when a later Security registration or activation request fails with an HTTP or network error. Restoration runs once, keeps sign-in intact and does not retry the rejected Security request. Initial Mega rejections remain failures.

- Correct the experimental standalone doorbell video test joining the video service. The test now sends the service-specific join header instead of a bare account token. It remains off by default, and T8224 physical playback still needs confirmation.
- Recover an additional HomeBase 2 v2 event-thumbnail layout safely, so a received motion event can update its event image rather than fail at image decoding. Reporter confirmation is still required.

## 0.1.157

- Read the T8N00 NVR S4 configured and effective modes separately from verified mode-change notifications. Keep mode and camera-power controls disabled. Reject stale or replayed delivery and clear the push-owned reading when notification reception is lost.
- Show validated custom mode titles and the last NVR report time in the read-only Home Assistant effective-mode sensor.
- Match the current Android app routing header on Security picture/video key requests while retaining the existing account sign-in and bounded recovery. Reporter media recovery still needs confirmation.

## 0.1.156

- Add a default-off Diagnostics preview for existing cloud recordings, protected by an API token and private-video consent. It supports plain MP4 and source-defined v8 H.264, produces a checked video-only preview up to two minutes and keeps local HomeBase recordings separate.
- Validate current camera, parent, record and shared-account key ownership before downloading. Keep private URLs and keys out of logs and cancel queued requests, downloads and conversion when the preview is retired.
- Reject unsupported legacy formats, damaged frames and failed authentication. Handle video resolution changes with a fixed-size H.264 preview. Actual cloud recording and shared-account behaviour remain unconfirmed.

## 0.1.155

- Add a default-off, consented private video trial for standalone T8224/type 96 doorbells without a normal streaming connection. The diagnostic checks the clip before download. Hardware and shared-account playback remain unconfirmed.
- Keep camera siren state unknown when the command route has no readback, and preserve unknown HomeBase alarm state until the station reports it.
- Cancel pending experimental NVR or doorbell connections when their trial is stopped, preventing a late video start.

## 0.1.154

- Correct Security-cloud encrypted request headers and add a rate-limited media-key recovery that preserves the signed-in account.
- Share concurrent camera startups, cancel stopped lookups promptly, and use bounded fresh lookups for standalone T8170 cameras.
- Start Home Assistant's normal HLS startup timeout even when the optional idle-timeout setting is off.
- Preserve specific NVR framing failure reasons and rejection counts. Include the queued effective-mode field-source diagnostic. NVR playback and mode controls remain unconfirmed.
- Recover an H.265 viewer converter that stalls after initially producing a picture, using a later complete picture and a fixed retry limit.
- Isolate cached media credentials by device and shared-account owner, reject mismatched or duplicate replies, and share matching key lookups.

## 0.1.153

- Delivers every decoded video fragment from standalone T8200 doorbells so large keyframes reach the viewer instead of being discarded at the 64,000-byte transport boundary.
- Updates the T8200 support note to distinguish confirmed live-video startup from continuous-playback confirmation that still needs reporter hardware testing.

## 0.1.152

- Fix the standalone T8200 doorbell live-start request to match the official client contract. This is limited to exact T8200 direct connections and leaves every other camera on its existing media path.
- Prevent later session-key negotiation from repeating the T8200 start request, and identify the selected path in privacy-safe stream diagnostics.
- Add exact JSON and wire-envelope regression coverage.
- The request contract is verified from an official-client capture. Playable video on physical T8200 hardware still needs reporter confirmation.

## 0.1.151

- Improve the opt-in NVR connection test to accept concealed related-address metadata while preserving strict destination and certificate checks. This corrects a connection compatibility problem but still needs a T9000 hardware retest.
- Correct NVR diagnostics labels for custom guard modes and Geofencing, and preserve those values when actually returned. Missing or unrecognised station readings remain Unknown. Inventory state stays separate from a fresh local read.
- Fix the existing opt-in 60-second Home Assistant HLS timeout so it also starts before the first video segment. Failed startup can now expire instead of leaving the worker retrying indefinitely. The option remains off by default, and recordings and explicit timeouts keep Home Assistant behaviour.
- Add regression coverage through the actual WebRTC candidate parser, malformed metadata checks, guard-mode projections and diagnostics output.

- NVR video playback, effective mode under schedules, arming and camera-power controls remain unconfirmed or unavailable. This release does not claim to fix the HTTP 463 video failures.

## 0.1.150

- Add a Home Assistant Smart Lock E30 auto-lock delay selector with reviewed 30, 60, 90, 120, 150, 180 and 300-second choices. Changes preserve auto-lock enablement, schedules and other lock settings. The existing experimental E30 option remains off by default.
- Add model-specific Home Assistant motion sensitivity controls for T8210, T8113-Z, T8160-C and T8171 on HomeBase 3, plus standalone channel-zero T817L. Higher HA steps always mean greater sensitivity, including the inverted eufyCam 2C scale.
- Add a T8210 HomeBase chime switch and a quiet-hours automation blueprint that supports overnight schedules, checks the dedicated chime control attribute and leaves detection, recording and HA doorbell events enabled.
- Require a fresh settings baseline, one native write and independent readback. Competing peer operations are rejected, and uncertain outcomes invalidate only the affected setting. Unsupported models and connections remain unavailable.

## 0.1.149

- Give Smart Lock E30 initial status queries up to 15 seconds before rejecting a command, while reserving time for confirmed readback.
- Keep E30 controls available after a command is rejected before dispatch, using the existing confirmed state and its original expiry. Uncertain outcomes after dispatch still invalidate state.
- Handle rejected preflight reads safely when the operation budget is exhausted. Motor commands are never retried automatically.

## 0.1.148

- Add default-off Smart Lock E30 T85F1 support with Home Assistant lock/unlock and battery entities through Eufy cloud MQTT.
- Add E30 Auto Lock and notification switches plus audible sound selection, with fresh readback, shared operation limits and no optimistic setting changes.
- Keep E30 support experimental and limited to one standalone lock on the US cloud route. Home Assistant hardware testing, High sound and timed auto-locking remain unconfirmed.
- Include the opt-in fixed-resolution H.265 viewer trial already merged into main.

## 0.1.147

- Restore Home Assistant integration setup when the device registry does not expose the newer scoped identifier lookup.
- Accept the observed flagged and padded NVR reply frames in the default-off T8N00 state and video trials while retaining strict framing checks.

## 0.1.146

- Accept the NVR's variable receive-packet lengths and metadata fields during experimental T9000 trials.
- Decode bounded Zstandard-compressed NVR application frames while preserving strict fragment and memory limits.

## 0.1.145

- Prevent queued Firebase notifications from replaying stale motion, person and doorbell events when the app restarts. Deliveries from the current startup remain available, and suppressed messages are still acknowledged so they do not return on the next connection.
- Accept the standards-valid NVR data-channel offer observed on T8N00 hardware when its media line includes the optional SCTP port token. NVR video and read-state results still need reporter confirmation.
- Let complete H.264 decoder headers override a repeated incorrect H.265 provider hint, fixing the no-output path observed on T8160 while preserving later confirmed streams.

## 0.1.144

- Add privacy-safe failure reasons to experimental NVR video and read-state tests, distinguishing negotiation checks and failed connection steps without logging private connection data.

## 0.1.143

- Add a separate read-only backup AA battery sensor for exact T85V0/type203 locks when authenticated inventory reports that measurement. Missing, invalid, ambiguous and unavailable values stay unknown, and the primary battery is never substituted. A reading arriving later can create the sensor without restarting Home Assistant. Physical accuracy still needs reporter confirmation.

## 0.1.142

- Expand the default-off NVR live-view trial to exact T8140/T8140-Z, T8113-V, T8172, T8162, T8170, T81A0 and T8425 camera types behind T8N00 or T9000 parents. Additional cameras use their first lens. Fresh discovery must match the selected camera, channel and type before video starts. Hardware playback remains unconfirmed.
- Add a separate read-only NVR settings test in Diagnostics. It requests station and selected-camera state without starting video or changing settings, and shows unknown values honestly. Guard-mode and camera-power controls remain unavailable pending physical confirmation.
- Add an optional 60-second Home Assistant HLS idle timeout under the integration's Configure menu. It is off by default, follows viewer requests, preserves recording timeouts and preload behaviour, and can be disabled to restore HA defaults. Battery savings require reporter testing.

## 0.1.141

- Add a default-off, private NVR video trial for T8E00/type301 cameras attached to exact T8N00/type300 or T9000/type27 parents. Enable `experimental_nvr_live`, select the camera in Diagnostics and explicitly request one ten-second clip. This is a test candidate, with physical NVR behaviour still unconfirmed.
- Support H.264 and H.265 in the trial, check fresh camera identity before requesting video, and keep normal Home Assistant streams and NVR controls unavailable.
- Keep trial footage out of retained snapshots and diagnostic media captures. Cancelling closes the original connection, and another trial waits for cleanup. Regional service selection is explicit when automatic discovery cannot identify the correct service.

## 0.1.140

- Reconnect HomeBase-attached camera live view after decoded media stalls. The gateway now makes one bounded restart attempt, then closes the silent source so the viewer can establish a fresh camera session instead of remaining blank indefinitely.
- Preserve the existing startup retry limits and standalone-camera behaviour.

## 0.1.139

- Added an opt-in S100 T84A1 siren test in Diagnostics, with a five-second pulse, an explicit stop button and ordered stop attempts on cleanup. Sound and stop behaviour still need confirmation on S100 hardware. Normal Home Assistant siren support remains disabled.
- Added the previously merged opt-in E30 T8417 pan/tilt trial so owners can test directional movement. Physical movement remains unconfirmed.
- Clarified diagnostic bundle privacy, including optional media and identifying metadata. Bundles are not guaranteed anonymous.
- Included offline NVR reassembly groundwork. This release does not enable NVR live video.

## 0.1.138

- Fix live video startup when a camera's initial codec hint differs from its actual H.264 or H.265 video. The shared stream cache can now correct the provisional format before decoder headers are complete, while preserving established streams.

## 0.1.137

- Keep a previously confirmed HomeBase connection through up to three consecutive background refresh failures, avoiding transient connection-entity flicker while preserving startup and explicit-operation failure handling.
- Correct the read-only T8N00 NVR guard-mode sensor so mode 3 uses its validated account-defined custom title and catalogue mode 47 maps to Geofencing. NVR guard-mode writes remain unavailable.

## 0.1.136

- Correct account-owned encrypted event-picture key lookup while preserving the last valid image when a key is unavailable.
- Stop automatic identity retries when Eufy reports an account login limit.

## 0.1.135

- Decode authenticated V8 event pictures through the matching station owner's account key, allowing this encrypted picture format to update Home Assistant event images.
- Preserve retained images on key or authentication failure and discard delayed push-picture results after a gateway restart.

## 0.1.134

- Improve standalone T8423 live-start compatibility by omitting an optional startup field that this model does not request. Reporter confirmation of intermittent first-start behaviour is still pending.
- Preserve startup behaviour for other standalone cameras and HomeBase-attached cameras.

## 0.1.133

- Add default-off experimental controls in the diagnostics page: standalone T84A1, T8417 and T8423 motion detection, T8423 spotlight enablement and pan/tilt, and T8410 pan/tilt through HomeBase 3.
- Use exact official Android model contracts, submit commands once and require fresh device readback for changed settings. Movement acknowledgements remain separate from physical confirmation. Hardware behaviour still needs testing on each model.
- Keep trials authenticated and separate from normal Home Assistant capabilities. Refuse busy device connections, reject changed routes and clean up sessions on failure or shutdown. Enable experimental_model_controls in the app settings to try them.

## 0.1.132

- Correct reported motion-detection state for standalone Wall Light Cam S100 (T84A1), Indoor Cam E30 (T8417), and Floodlight Cam 2 Pro (T8423). The native state now takes precedence over conflicting legacy values, and missing or invalid native state stays unknown.
- Surface the reported master spotlight setting for those exact models in Home Assistant camera attributes. This setting is separate from the momentary manual light and does not indicate whether the light is currently illuminated.
- Keep motion, spotlight, privacy, PTZ and siren control eligibility unchanged. These state corrections do not establish new hardware control support.

## 0.1.131

- Add gateway-owned diagnostic bundles for HomeBases, standalone cameras, sensors, NVR inventory and other discovered devices. Metadata is the default, with explicit consent for native video, audio and retained pictures.
- Include relative lifecycle/request evidence, capability availability and safe active-source transport counters, with memory, time and size limits and authenticated export/clear actions.
- Add a diagnostics page, a utility using Home Assistant's saved gateway connection, offline integrity checking and standard private email/cloud-sharing instructions. No external research harness is required.
- v0.1.130 was withdrawn. NVR RTC media remains unavailable and is stated explicitly in the bundle manifest and documentation.

## 0.1.129

- Show account-defined names for custom HomeBase guard modes instead of generic Custom 1, Custom 2 and Custom 3 labels.
- Correct the read-only T8N00 NVR guard mode sensor so Geofencing is displayed correctly instead of Custom 1.
- Distinguish cloud registration transport, HTTP, response and timeout failures in privacy-safe diagnostics.

## 0.1.128

- Fix Home Assistant recordings with live AAC audio failing at a segment boundary. Both tracks now start from the same positive transport timestamp, avoiding a first-segment shift that could make audio timestamps move backwards. A fresh standalone C31 recording was used for the reproduction and hardware validation.
- Choose Home Assistant stream timing from the camera's current audio capability when opening a source, rather than only from its startup inventory.

## 0.1.127

- Add Home Assistant switches for RTSP publication and continuous recording on the verified standalone Wired Cam C31 (T817L, device type 10031). Both switches were tested through Home Assistant with fresh camera readback. RTSP video and audio decoded successfully, and a controlled continuous recording played in the Eufy app. Gateway playback of continuous footage remains unavailable.
- Add the `eufy_event_gateway.play_audio` camera action for short AAC-LC 16 kHz mono ADTS files on the verified standalone C31. Playback is limited to 20 seconds and Home Assistant allowlisted paths. Audible playback was confirmed on the camera. Interactive microphone talkback is not included.
- Fix a gateway crash when an encryption-key lookup finishes after its camera connection has closed. Add regression coverage for shutdown, speaker packet handling, HTTP admission and Home Assistant file access.

## 0.1.126

- Add hardware-tested standalone Wired Cam C31 controls, SD event playback, live AAC audio and timed siren support for the exact T817L type 10031 channel-zero route.
- Add a default-off, bounded private capture for failed event pictures so their original response can be diagnosed without exposing it through normal logs or Home Assistant diagnostics.
- Add privacy-safe diagnostics for custom guard-mode metadata, failed stream sequence ranges and unknown numeric HTTP 463 application errors.
- Record confirmed T8900 signal-strength readback through HomeBase 3 and the failed standalone T8172 live-view and snapshot route without changing camera admission.

## 0.1.125

- Add hardware-verified standalone C31 saved-position movement, manual light actions and schedule-backed cruise controls on the exact direct T817L route.
- Keep C31 preset movement connected until travel finishes and authenticate the observed control replies without widening adjacent model or HomeBase routes.
- Correct the HomeBase prompt-volume range to the hardware-confirmed 1 to 26 values and update the compatibility notes for verified storage, alarm tone, guard mode and siren behaviour.

## 0.1.124

- Add SoloCam E30 (T8171) standalone discovery and refresh camera names and HomeBase bindings without restarting the gateway.
- Add hardware-verified standalone infrared modes, motion detection, AI tracking, streaming quality, recorded-audio controls and selection of existing presets.
- Support SoloCam E30 standalone microSD event browsing and authenticated, seekable playback with audio in Home Assistant.
- Support verified SoloCam E30 live video and audio, infrared controls, saved-event playback and existing preset movement through HomeBase 3.
- Correct attached SoloCam video decoding and preserve verified child settings during HomeBase refreshes.
- Protect shared HomeBase recording downloads from conflicting sibling-camera activity and report clearer live-stream failure reasons.
- Keep unverified HomeBase SoloCam AI tracking, motion, quality and recorded-audio writes unavailable. Preset creation and editing remain unsupported.
- Admit T8220 doorbells connected through HomeBase 2 for further hardware testing.

## 0.1.123

- Restart a silent H.265 viewer conversion from a later complete keyframe, with a five-second delay and two-retry limit, while keeping the camera source and waiting Home Assistant viewer open.
- Report the bounded decoder-restart count in the privacy-safe viewer summary.

## 0.1.122

- Add a response-only `get_stream_url` action that starts Home Assistant's HLS provider and returns its temporary URL for automations, local restreamers and compatible players without exposing the private gateway URL or bearer token.

## 0.1.121

- Recover a saved Mega session once when Eufy returns HTTP 463 for an expired request identity, without forcing a new login or retrying unrelated failures.
- Document the separate network directions required for HomeBase-attached camera media and HomeBase state on a tested isolated VLAN.

## 0.1.120

- Restore the proven Mega notification registration after Security push activation is rejected, avoiding the repeated activation cycle that could leave fresh camera events unavailable.
- Keep push delivery marked as degraded until a real event confirms it, while cameras, snapshots and live view remain available.

## 0.1.119

- Keep cameras and snapshots available when Eufy rejects push registration or activation, instead of failing provider startup.
- Retry push registration in the background up to five times and show degraded push status in the event-delivery diagnostics and logs until it succeeds.
- Add tests for rejected activation, recovery, retry limits and shutdown.
- Event delivery is not yet confirmed as restored on affected setups.
- Recover a rejected saved login once when inventory returns HTTP 401, while preserving CAPTCHA and verification prompts.

## 0.1.118

- Keep the provider available when Mega and Security accept push registration but the final activation check is still unconfirmed. Diagnostics now show that state without claiming event delivery works.
- Admit the T8W11C type 10010 camera path as ready to test while keeping media availability dependent on a usable route.
- Treat a zero RSSI report as unavailable and add privacy-safe event-image format and size diagnostics.
- Document the latest T8162 HomeBase 3, T8423 stream cleanup, VLAN reachability, and T8W11C evidence boundaries.

## 0.1.117

- Start reopened and additional live viewers from the current complete keyframe, preserving matching decoder headers and multi-slice pictures.
- Recover silently dropped push connections and report reconnect and shutdown state accurately.
- Preserve known HomeBase state when local reads omit values, while clearing stale effective mode after a guard-mode change.
- Refresh cached Home Assistant stream credentials without restarting healthy live views, including idle streams.
- Clarify privacy-safe custom-mode and video startup diagnostics without guessing custom mode names.

## 0.1.116

- Serialize concurrent cloud requests, share per-host identity exchanges, and decode responses with their originating identity.
- Reject failed HTTP responses and invalid signed ciphertext without including private server bodies in errors.
- Keep restored verification-only sessions at the user prompt and cancel active and queued cloud work during shutdown.
- Bound cloud and image bodies while streaming and reject declared-length mismatches before parsing.
- Add a read-only cloud history metadata API for admitted cameras, with shared-owner preservation and no playback, keys, URLs or deletion.
- Add a privacy-safe HomeBase custom-mode metadata diagnostic without changing security mode labels or numbers.
- Complete the Android receiver login before asking Security to activate its push token, avoiding startup failure for newly registered tokens.

## 0.1.115

- Keep the T8N00 guard-mode sensor current through the periodic account refresh.
- Reuse a valid saved account session when an old verification code remains in app configuration.

## 0.1.114

- Publish supported child-sensor readings obtained during an existing HomeBase refresh, including contact state and late telemetry.

- Expose optional secondary firmware, update availability and model-limited audio, quality and solar readings without adding controls.

- Report T8170 recording policy without changing camera configuration.
- Do not advertise PPCS media or controls through RTC-only T9000 and T8N00 stations.

- Close stalled shared video connections cleanly while preserving the retained camera picture.

- Report camera rotation, status-indicator and sound-detection configuration without adding controls.
- Expose validated T8210/T8214 chime configuration and T8210 quality/compression settings as read-only attributes.
- Complete Security push registration and activation using the existing Mega session, with explicit rejection handling.

## 0.1.113

- Keep camera cards populated with durable last-good snapshots through gateway and Home Assistant restarts, with a labelled waiting image only before any picture is available.
- Recover event-picture geometry and contrast instead of forcing an incorrect fixed JPEG header, and repair previously retained affected pictures on startup.
- Expose Last event image as a Home Assistant image entity so automatic Security pages no longer show a second camera tile. Preserve existing event-camera references as hidden compatibility entries.
- Retry failed initial snapshot captures on later inventory refreshes with a cooldown and a limited attempt budget.
- Show reported camera firmware, hardware version, signal strength and allowlisted audio settings when available.
- Withdraw the failed SoloCam L40 light-control path while preserving the separately confirmed Floodlight control path.

## 0.1.112

- Improve live-video recovery when packets arrive out of order or are retransmitted.
- Improve direct-device connection attempts by registering multiple UDP source ports and retaining the successful route.
- Read event details and device identity from nested push notifications more reliably.
- Allow Home Assistant device removal when a successful fresh gateway inventory confirms the device is no longer present.
- Suppress misleading battery readings on externally powered T8410 and T84A1 cameras.
- Add supported light controls for T8123 and T8441 cameras, with physical-device confirmation still required.
- Improve event-image diagnostics for notifications whose image format isn't supported yet.

## 0.1.111

- Add a separate Event image camera entity for every discovered camera. It retains the latest valid event picture without replacing a fresher live still on the main camera.

## 0.1.110

- Expose the NVR S4's reported guard mode as read-only station state without enabling unproven arm, disarm, or media controls.
- Record confirmed T8910 motion delivery through HomeBase 2 and report routed sensor pushes as handled.
- Document that T8910 event delivery requires notifications to be enabled for the sensor in the active Eufy mode.

## 0.1.109

- Start H.265 viewer conversion from the latest random-access frame and keep feeding the source chunk that opened the converter.
- Admit the original T8111 eufyCam through its reported ready HomeBase 3 route for hardware testing.

## 0.1.108

- Switch direct-camera media retries to the negotiated session after key exchange while retaining the legacy first-start fallback.
- Refresh eligible standalone alarm capabilities before Home Assistant creates entities, without making a failed camera read block integration setup.
- Keep the last recognized person through a plain T8214 doorbell press.
- Prevent a push-event thumbnail from replacing a retained live camera frame.

## 0.1.107

- Admit eufyCam S4 T8172 type 89 for hardware testing through its reported ready HomeBase 3 route.
- Reassert standalone camera media only after a genuine frame stall so short H.265 bursts can recover without resetting an active stream.
- Hide motion detection controls on standalone routes until their level-two key exchange is proven, avoiding a control that cannot be sent on T8123 hardware.
- Add a bounded one-time HomeBase 2 SD diagnostic for the raw result, total MiB, and free MiB fields while keeping unknown status values unmapped.

## 0.1.106

- Restore T8214 doorbell presses when style-3 notifications carry no detection evidence, while retaining motion, person, and familiar-person updates.
- Remove the unproven direct T84A1 siren entity after hardware testing showed the attached-camera command does not operate this standalone model.
- Admit the reported standalone T814XS solar variant as Mega type 10039 for hardware testing.
- Suppress battery-shaped placeholder values on the mains-powered T8600.

## 0.1.105

- Add bounded direct siren start and stop actions for T84A1 cameras while keeping physical confirmation pending.

## 0.1.104

- Add T817L preset-position actions plus physically verified AI-tracking and automatic-cruise on and off actions.
- Add read-only HomeBase 2 SD-card status and capacity support using its generation-specific local query.
- Add standalone camera Home, Away, and Disarmed controls, with fresh local state readback required before Home Assistant reports success.
- Expose Eufy Custom 1, Custom 2, and Custom 3 through Home Assistant's Custom Bypass, Night, and Vacation alarm actions, contributed by @svdbeemt in PR #209.
- Add separate package-delivered and package-taken detection entities instead of discarding those push events.
- Add diagnostic signal-strength sensors for security accessories that report the verified RSSI parameter.
- Add the Danish translation contributed by @BalooDK in PR #217. Thanks for helping make the integration accessible to more people.
- Stop refreshing cached Home Assistant stream sources when no active stream consumer remains.
- Add acknowledged direct-camera motion control for T8123 and probe the LAN endpoint advertised by T9000 discovery.
- Add privacy-safe per-viewer lifecycle evidence that distinguishes source delivery, HTTP startup, stalls, and backpressure.
- Add a privacy-safe raw parameter diagnostic for T8416 and T8417 without exposing an unverified control or claiming physical state.

## 0.1.103

- Add codec-independent viewer delivery diagnostics that separate camera input, converted output, HTTP delivery, stalls, and client backpressure.
- Include privacy-safe push receiver state and aggregate delivery outcomes in Home Assistant diagnostics without payloads, device identities, or exact event times.

## 0.1.102

- Accept an additional encrypted media length form reported by standalone T8425 and T8426 cameras while keeping the validated outer frame boundary as the safety limit.
- Force stalled media conversion workers to exit after a camera session closes, preventing abandoned workers from continuing to consume CPU.

## 0.1.101

- Add timed on and off actions for the compatible T81A0 camera light.
- Add the T8110 eufyCam C35 to the existing HomeBase 3 camera handler for hardware testing, while preserving its reported battery state.
- Keep closed live-view and snapshot converter pipes from stopping the gateway during overlapping media sessions.
- Wait for complete H.265 decoder configuration and a keyframe before starting viewer conversion, preventing FFmpeg from starting with incomplete camera headers.

## 0.1.100

- Accept the complete-frame length form used by direct-camera encrypted video startup, so affected cameras can retain the decoder setup frame.
- Admit T8123, T8420, and T8441 cameras through the existing handler for real-hardware discovery, controls, event, snapshot, and live-view testing.

## 0.1.99

- Accept the standalone encrypted video length reported by the T8426 so its decoder setup can reach Home Assistant.
- Refresh signed camera stream URLs before they expire so Home Assistant reconnects do not loop on 401 responses.

## 0.1.98

- Keep motion active for every generic security notification while also emitting person, vehicle, pet, dog, crying, and sound events when the push contains matching structured evidence.
- Add privacy-safe standalone camera video diagnostics that identify the media decode stage which rejected an encrypted frame.

## 0.1.97

- Admit the standalone T8130 SoloCam E20, T8131 SoloCam E40, and T8B00 SoloCam C210 through the existing direct-camera handler as ready to test.
- Record the latest HomeBase 2 motion and person-event results for T8113 and T8140-R, plus the standalone T8426 media result.
- Align the public device list and implementation backlog with the current hardware evidence.

## 0.1.96

- Retry HomeBase state discovery through both LAN broadcast and the current private address, including bounded nearby UDP ports, so station entities can recover when the first local lookup is missed.
- The Home Assistant i18n engine is now up and running, with translatable entity names and selectable values, contributor-friendly YAML sources, and generated runtime JSON. Translators are wanted for the first community language files.

## 0.1.95

- Fixed repeating HomeBase camera stream restarts while valid video frames are still arriving.
- Restored motion events for cameras that use the generic HomeBase security notification, including person events when Eufy supplies the person marker.
- Made fresh snapshot captures wait for a live camera frame instead of accepting a concurrent event image.
- Added the standalone T8426 Floodlight Camera E30 as ready to test.

## 0.1.94

- Add privacy-safe timing counters around HomeBase H.265 viewer conversion to separate camera input pauses from conversion output pauses.
- Report viewer backpressure counts and maximum queued bytes when a converted stream closes.

## 0.1.93

- Calculate HomeBase 3 HDD free space from the unused video partition, including the system areas that the Eufy app counts as used.
- Preserve the existing fallback for HomeBase storage responses that do not include partition figures.

## 0.1.92

- Give Home Assistant usable arrival timestamps for raw camera video, preventing its stream worker from repeatedly closing and reopening otherwise healthy live views.
- Add a hosted integration contract check for the Home Assistant stream option.

## 0.1.91

- Retain bounded Firebase sibling fields when a decoded Eufy payload entry is also present, allowing HomeBase 2 camera identity to reach motion-event normalization.
- Add privacy-safe receipt flags for sibling device, station, and event fields without logging their values.

## 0.1.90

- Use the T8210-family direct Auto night vision command instead of the unrelated three-mode night vision command.
- Read and confirm the dedicated Auto night vision value from both cloud inventory and current HomeBase child state.

## 0.1.89

- Prefer fresh allowlisted child-device values reported by the HomeBase over older cloud inventory values, including battery level and night vision mode.
- Log the cloud and live battery figures when a HomeBase reports a new local battery value, without exposing device identifiers or arbitrary parameters.
- Keep signed live-view URLs valid through Home Assistant's retry window so a delayed retry does not fail with an authorization error.

## 0.1.88

- Adds a delayed cloud fallback for standalone PIR motion sensors when their realtime push does not reach the gateway.
- Exposes the cloud-reported PIR event time through the sensor last-seen diagnostic and logs timestamp transitions without device identifiers.
- Prevents the cloud fallback from replaying historical motion at startup or duplicating a motion push that already worked.

## 0.1.87

- Add a privacy-safe Firebase delivery receipt before duplicate filtering and push parsing to diagnose missing sensor events.

## 0.1.86

- Add a once-per-start HomeBase 3 HDD diagnostic with exact numeric and boolean storage fields, calculated byte totals, and redacted text values.

## 0.1.85

- Refresh expiring PPCS lookup keys before new camera sessions, avoiding stale credentials during long-running gateway sessions.
- Start H.264 snapshots and live viewers from a complete decoder boundary, and avoid feeding the opening media chunk to FFmpeg twice.
- Add privacy-safe H.265 viewer conversion counters so blank playback can be separated from camera transport and decoder failures.

## 0.1.84

- Keep successfully decrypted HomeBase 2 keyframe continuations for access-unit reassembly instead of rejecting chunks that begin part-way through a NAL.

## 0.1.83

- Admit T8140-R and T8140R eufyCam 2 Pro cameras through the existing HomeBase camera handler.
- Add an opt-in Help test this device action for exact ready-to-test camera models, with a reviewable GitHub report link and no background upload.
- Include privacy-safe device catalogue evidence in Home Assistant diagnostics without local names, serials, payloads, or exact event times.
- Accept legacy HomeBase 2 keyframes that use four-byte NAL length prefixes, preserving the H.264 decoder setup needed before later video frames can play.

## 0.1.82

- Use the T8010 HomeBase 2 direct encrypted media-stop command before retrying or closing camera streams, replacing the newer stop envelope that this generation ignores.
- Report the selected HomeBase stop protocol in privacy-safe stream diagnostics.

## 0.1.81

- Reset stale HomeBase-attached media with an explicit stop before retrying or closing, so a new capture can begin with codec configuration and an IDR frame.
- Report HomeBase media stop attempts alongside startup counts in privacy-safe stream diagnostics.

## 0.1.80

- Scope Home Assistant device-registry lookups to the owning config entry, removing the deprecated ambiguous lookup scheduled for removal in Home Assistant 2027.8.

## 0.1.79

- Keep the general Motion entity active for person and other visual camera detections.
- Report invalid snapshot paths and gateway capture failures as useful Home Assistant action errors.

## 0.1.78

- Add directed LAN discovery for HomeBases when broadcast lookup is blocked by container or network boundaries.
- Reassert attached-camera media starts until complete codec configuration and an IDR make the stream decoder-ready.
- Recognise untyped four-byte HomeBase command acknowledgements instead of waiting for the readback fallback.
- Report redacted viewer and snapshot conversion failures through the gateway log.

## 0.1.77

- Align HomeBase cloud candidate handling and attached-camera media starts, removing unsupported legacy branches introduced in the previous release.
- Convert confirmed H.265 live streams to a shared low-latency H.264 viewer feed when a HomeBase ignores the requested H.264 codec.
- Keep native H.264 live streams on the direct path and retain original codecs for snapshots and recordings.

## 0.1.76

- Complete the PPCS relay and TURN handshake used when a HomeBase cannot be reached through a direct peer address.
- Use the legacy live-start command required by HomeBase firmware before 2.0.9.7.
- Prefer recognisable H.264 or H.265 decoder setup over a conflicting HomeBase frame marker, while retaining the marker as a fallback for ambiguous media.
- Increase the PPCS UDP receive buffer and report privacy-safe direct, relay, and TURN lookup progress in stream summaries.

## 0.1.75

- Honour Home Assistant siren durations for both camera and HomeBase siren entities.
- Repair the JPEG header used to reconstruct wrapped event images.
- Preserve HomeBase video codec metadata so H.264 frames are not misidentified as H.265 during live view, snapshot, or recording startup.
- Add confirmed guard-mode reads and writes for HomeBase 2 on firmware that supports the current command protocol, without enabling HomeBase 3-only controls.

## 0.1.74

- Generate camera, sensor, HomeBase, and non-camera runtime admission data from the human-edited device catalogue.
- Remove the duplicate hand-written TypeScript compatibility ledger.
- Distinguish recognised devices, hardware-ready test candidates, and supported handlers without automatically admitting every known product.
- Add 53 accessory records, including locks, sensors, sirens, keypads, safes, trackers, chimes, remotes, and SmartDrop.
- Reconcile the T7402, T7403, and T87B4 numeric type mappings and retain the conflicting T8224 type 95 and 96 evidence.

## 0.1.73

- Normalise device catalogue IDs to their primary model code and retain readable display names in filenames.
- Keep short variant suffixes only for the four model codes that identify multiple records.
- Add validation that filenames retain a model and display slug, unique IDs use their model code, and shared models document their variant rule.
- Remove the remaining source-specific identifier wording from catalogue records.

## 0.1.72

- Remove reference-source names, locations, excerpts, and cross-reference fields from the public device catalogue.
- Add a catalogue validation gate that rejects those markers if they are introduced again.
- Keep the neutral device facts, properties, selectable values, evidence levels, and confirmed hardware results.

## 0.1.71

- Add a read-only HomeBase 2 mode check that exposes configured and effective security modes only after a successful local read. HomeBase 2 writes remain disabled until hardware confirmation.
- Add a contributor-editable catalogue covering 81 devices, 7,154 capability entries, and 3,756 selectable values, with evidence and conflicts kept alongside each device.
- Record the fully confirmed T817L night vision mapping for PureColor, Infrared, and Spotlight in the detailed device catalogue.

## 0.1.70

- Retry night vision mode writes over the HomeBase camera route so brief UDP loss does not leave a successful selection reported as failed.
- Record the hardware-confirmed T817L night vision mapping: PureColor, Infrared, and Spotlight.

## 0.1.69

- Mirror device-specific night controls, using Colour on known low-light colour models, Off on spotlight-only cameras, and an Auto night vision switch for doorbells.

## 0.1.68

- Use HomeBase 3's usable HDD capacity and decimal used-space value so total and free storage match the Eufy app.
- Admit eufyCam 2 model T8114 with Mega device type 9 through an available HomeBase camera route.
- Add a night-vision mode select for HomeBase-attached cameras that report the setting.
- Refresh existing Home Assistant device names when Eufy inventory reports a rename, while preserving Home Assistant user overrides.

## 0.1.67

- Offer camera siren control from reported capability evidence instead of one camera type, and add the HomeBase siren trigger and stop path.

## 0.1.66

- Add a camera siren entity using the camera's own duration timer and explicit stop command.
- Record a real-device T8113-Z siren test in the compatibility evidence.

## 0.1.65

- Resynchronise PPCS command streams after short dropped-byte tails so supported cameras can continue assembling live video and snapshots.

## 0.1.64

- Admit eufyCam E40 inventory type 49 through the existing HomeBase 2 camera route. Discovery and media still need reporter confirmation.

## 0.1.63

- Admit T8400 and T8419 camera inventory types 30 and 10009 while keeping media and event support evidence-gated.
- Enable T8224 doorbell-press events after reporter-confirmed type 96 push evidence.

## 0.1.62

- Add confirmed camera motion-detection switches for supported HomeBase-attached cameras.
- Correct PPCS media assembly for decoded frame lengths.
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

- Prevent a camera frame or clip timeout from exiting the gateway when PPCS stream startup is still pending. The capture still reports its timeout. The HomeBase Professional S1 crash-loop reported in issue #28 needs confirmation on the affected installation.
- Recognize eufyCam S3 Pro (`T8162`, Mega type 26), Floodlight Cam E340 (`T8425`, type 47), SoloCam S340 (`T8170`, type 48), and Solar Wall Light Cam S120 (`T81A0`, type 10005) as cameras through their inventoried HomeBase peer.
- Keep the HomeBase Professional S1 (`T9000`, type 27) as PPCS connection metadata for its cameras. This release does not add station controls or settings for T9000 because its local command protocol has not been verified.
- Discovery, push events, snapshots, and live video for the four newly admitted cameras still need real-device testing.

## 0.1.25

- Recognize the Video Doorbell E340 (`T8214`, Mega type 94) and Indoor Cam S350 (`T8416`, type 104) as camera entities through their inventoried parent connections.
- Give the E340 the existing Doorbell press sensor. A press event from this model still needs real-device confirmation.
- List the MiniBase Chime (`T8023`) as recognized connection metadata for the E340. The integration does not create a chime entity or controls.
- Device discovery, push events, snapshots, and live video for the E340 and S350 still need hardware testing.

## 0.1.24

- Register for camera notifications as the Eufy Android app. The previous Chromium web-push subscription could connect to Firebase while receiving only metadata instead of motion, person, and doorbell events.
- Route a doorbell press (`3103`) to a new Doorbell binary sensor on supported doorbells. The sensor stays on for 10 seconds after a press.
- Add a local push probe and payload-free delivery logs to help diagnose notifications without restarting Home Assistant or printing account data.
- Confirm motion (`3101`), person (`3102`), and T8210 doorbell press (`3103`) payloads on local cameras. Other Eufy event types and HomeBase 2 live streaming need separate testing.

## 0.1.23

- Admit eufyCam S300 / 3C (`T8161`, Mega type 23) as a HomeBase-attached camera. The reporter's inventory had the station, channel, PPCS, and DSK prerequisites, but real-device discovery, events, snapshots, and live video still need confirmation.

## 0.1.22

- Include the merged HomeBase 3 device, alarm, guard-mode, storage, volume, and tone support for the next versioned app update. Hardware confirmation of command framing, storage units and status meanings, writable ranges, and siren stop codes is still required.
- Admit Mega device type 63 (T8134/SoloCam C20) as a camera when its inventory provides the required HomeBase and PPCS prerequisites. Discovery, events, snapshots, and live video still need hardware testing.
- Add the first standalone PPCS route for the Wired Wall Light Cam S100 (`T84A1`, Mega type 151). The gateway now uses an eligible parentless camera's own peer connection and DSK key rather than requiring a HomeBase.
- Log a privacy-safe summary of every normalized push and a payload-free receipt when a push cannot be normalized. Inventory diagnostics also identify HomeBase, direct, and unavailable stream routes without exposing device identity or connection values. S100 discovery, events, snapshots, and live video still need hardware testing.
- Run the Home Assistant app on the host network so local PPCS UDP discovery can reach Eufy devices on the LAN while keeping the gateway API port unmapped by default.
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

- Add the gateway-owned first-party PPCS transport for live H.264 streams and fresh camera snapshots.
- Discover and use Eufy's DSK and ECC cipher APIs without the Web Portal PIN or SmartLife/Thing login.
- Validate the transport against wired T8210 and battery T817L cameras before exposing the Home Assistant live entities.

## 0.1.11

- Add the gateway's own Mega API implementation for login and device discovery.
- Discover HomeBase 3 battery cameras, video doorbells, and T817L cameras directly from Mega inventory.
- Register and normalize current Eufy push notifications.
- Decode and retain event snapshots using the gateway's own image decoder.
- Reuse an existing authenticated Mega session during the one-time upgrade, avoiding unnecessary CAPTCHA authentication.
- Add a first-party client for Eufy's current web authentication and WebRTC signalling services.
- Restore on-demand live viewing, fresh snapshots, and clip recording for the discovered cameras.
- Persist the separate web session and handle its CAPTCHA or email verification prompt inside the app Web UI.

## 0.1.10

- Fetch the complete Mega camera inventory using the current API's supported device-list request.

## 0.1.9

- Load Mega camera inventory directly when the legacy Eufy service is unavailable.

## 0.1.8

- Continue through Eufy's current API when its obsolete legacy login requests CAPTCHA after Mega authentication has already succeeded.

## 0.1.7

- Keep CAPTCHA results inside the app web interface and show a fresh challenge when Eufy rejects an answer.

## 0.1.6

- Add a Home Assistant app web interface for completing Eufy CAPTCHA challenges during first sign-in.

## 0.1.5

- Show retained event thumbnails for push-only cameras discovered through HomeBase 3.

## 0.1.4

- Remove internal development notes from the public release.

## 0.1.3

- Use a HACS-compatible static MIT licence badge.

## 0.1.2

- Fix the project icon in HACS's rendered README.
- Add one-click HACS installation and licence badges.

## 0.1.1

- Add the local integration brand icon required by HACS.
- Publish a versioned update to validate the HACS upgrade path.

## 0.1.0

- Initial public hardware-validation release.
- Event-first Eufy camera gateway with legacy and Mega inventory discovery.
- Home Assistant camera, motion, person, and familiar-person entities.
- On-demand battery-camera live streams with retained idle images.
- Fresh-snapshot and timed-recording actions for automations and Node-RED.
- Home Assistant OS app with generated private API authentication and Supervisor discovery.
- Separate process-liveness and Eufy-connection health checks so authentication prompts do not cause app restart loops.
