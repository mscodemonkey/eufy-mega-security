# E21 experimental support

The exact T8354, Mega type 86, category `eufy_care` is recognized separately from security cameras. Device behaviour remains unconfirmed on physical E21 hardware.

Care notifications and attributed event pictures are passive. Notifications cover motion, crying, sound, pet, baby leaving/entering, high/low temperature, care-area leaving/entering and activity. They expire after the gateway's detection hold window. Off means there is no recent retained notification. Existing crying and sound IDs are preserved. No security-camera vehicle or dog event is inferred from care event numbers.

Reported room temperature and thresholds are normalized to Celsius using the reported native temperature unit. Missing units, malformed values and a possible zero-temperature sentinel remain unknown. White noise volume, temperature-monitoring state and RTSP-publication state are read-only diagnostics. The raw white noise timer has no assumed unit and is disabled by default in Home Assistant.

## Optional live view and preferences

Enable `experimental_model_controls` only if you want to try explicit E21 live view and controls. This does not start a stream. The E21 must report its own direct channel-zero connection and a current transport key. Live audio uses the existing receive-only AAC path. Video frames, codec, audio playback and stopping still need physical confirmation. Snapshot requests may explicitly open live view when this option is enabled. Startup never opens E21 media.

Preference controls also need a configured API token, validated API request, authenticated owner account and a known reported baseline. Guest accounts cannot write. Every preference shares one per-camera queue. A baseline already equal to the requested value causes no write. Each changed preference opens one dedicated control session, uses authenticated protection and waits for a matching raw inventory fetch that began after dispatch. The complete operation has a 35-second deadline, including transport setup. Retained metadata, old live reads, optimistic command state, an acknowledgement or a duplicate device row cannot confirm success. Ambiguous results are reported as unknown and are never automatically resent on a second session.

Try one setting at a time. After a physical change, compare Home Assistant with the Eufy app. A confirmed inventory setting does not prove audible output, a changed picture or a physical movement.

## Reviewed command and read contracts

The source chain is the official T8354 model delegating to T8352 and BabyMonitorBase parsers, Android app 6.1.10_30612. These are implementation contracts, not hardware confirmation. Each setting requires its own independently reported parameter. No app default is treated as a reading.

| Preference | Read parameter | Absolute write | Values |
| --- | --- | --- | --- |
| Microphone | 1240 | Binary 1240 | 0 or 1 |
| Speaker | 1241 | Binary 1241 | 0 or 1 |
| Speaker volume | 1230 | Binary 1230 | 0 to 100 |
| Image flip | 1207 | Binary 1207 | 0 or 1 |
| Watermark | 1214 | Binary 1214 | 0 to 2 |
| Status LED | 6014 | 1700, `value` | 0 or 1 |
| Sound detection | 6043 | 1700, `status` | 0 or 1 |
| Sound sensitivity | 6044 | 1700, `index` | 1 to 5 |
| Sound type | 6046 | 1700, `type` | 128 or 256 |
| Sound round look | 6208 | 1350, `onoff` | 0 or 1 |
| Recorded audio | 6012 | 1700, `enable` | 0 or 1 |
| Continuous recording | 6010 | 1700, `enable` | 0 or 1 |
| Motion detection | 6040 | 1700, `status` | 0 or 1 |
| Motion sensitivity | 6041 | 1700, `value` and `index`, `channel:0` | 1 to 5 |
| AI tracking | 6016 | 1700, `value` | 0 or 1 |
| Cruise | 6031 | 1700, `value` | 0 or 1 |
| Live quality | 2730 | 1350, `quality`, reported `mode`, `primary_view:0`, `channel:0` | 0 to 4 |
| Recording quality | 2731 | 1350, `quality`, `mode:-1`, `primary_view:-1` | 1 to 4 |
| White noise volume | 6283 | 1350, `volume` | 0 to 100 |
| Temperature monitoring | 7004 | 1350, `value` | 0 or 1 |

Binary commands carry channel zero, value and padded owning account. The 1700 wrapper carries `commandType` plus `data`. The 1350 wrapper carries owning account, inner command, channel zero, `mValue3:0` and `payload`. JSON settings carry an epoch-millisecond transaction string. Absolute packets use the existing three-transmission delivery idiom within one session, never a second session retry.

Live quality additionally requires parameter 6243 to report native view mode 0 or 12. Parameter 2730 is decoded from the corresponding `mode_0` or `mode_1` quality bank, or its reported scalar. Confirmation requires the same view mode after dispatch. Quality ranks describe settings, not observed stream resolution.

## Features still held back

Camera power/privacy writes, RTSP publication writes, notification spacing, night vision, temperature unit or threshold writes, white noise playback/timer writes, preset movement, free pan/tilt, preset save/delete and talkback are unavailable. Their exact E21 value, codec or independent confirmation contract is not established. In particular, a stored preset list cannot independently confirm a completed move. No destructive, firmware or Wi-Fi operations are exposed.

For a first test, report whether the existing notifications arrive and whether an event picture appears. If opting into live view, report whether it opens, plays sound and stops. There is no need to change every preference or upload private room footage.
