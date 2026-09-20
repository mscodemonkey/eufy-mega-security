# Device compatibility matrix

This is the current evidence ledger for device and HomeBase combinations. It
separates gateway implementation from hardware verification. A supported path
still needs a matching developer or community test before we call that physical
combination confirmed.

Version fields use the Eufy Mega Security app and Home Assistant integration
version. Home Assistant Core is included when it was recorded. Raw logs,
serials, credentials, snapshots, and videos stay outside the repository.

## Status values

| Status | Meaning |
| --- | --- |
| `confirmed` | The capability worked on the stated hardware topology. |
| `implemented` | The gateway path exists, but this topology still needs hardware confirmation. |
| `partial` | Some part of the capability works, with a documented limitation. |
| `unverified` | No reliable hardware result is recorded yet. |
| `unsupported` | The gateway deliberately does not expose this capability. |

## HomeBases

| Device | Eufy model and type | Discovery | Controls | Camera route | Evidence |
| --- | --- | --- | --- | --- | --- |
| HomeBase 2 | T8010, type 0 | `confirmed` | `unsupported` | `implemented` | Developer, v0.1.63. Read-only station path. |
| HomeBase 3 S380 | T8030, type 18 | `confirmed` | `partial` | `confirmed` | Developer, v0.1.63. Community confirmation for guard mode, alarm panel, and alarm tone. |
| HomeBase Professional S1 | T9000, type 27 | `confirmed` | `unsupported` | `partial` | Community reports. Inventory works, but PPCS lookup remains unresolved for affected camera families. |

## Cameras

| Marketing model | Eufy model and type | HomeBase 2 | HomeBase 3 | T9000 | Direct | Current capability notes |
| --- | --- | --- | --- | --- | --- | --- |
| EufyCam 2C | T8113-Z, type 8 | `unverified` | `confirmed` | `unverified` | `unverified` | Discovery, motion, person, snapshots, live video, and camera siren control confirmed by developer testing. Garden and Pool accepted a five-second siren duration and explicit stop. |
| EufyCam 2C Pro | T8142-Z, type 15 | `confirmed` | `unverified` | `unverified` | `unverified` | Discovery, snapshots, and live video confirmed. Events need focused testing. |
| USB-C-powered camera | T817L, type 10031 | `unverified` | `confirmed` | `unverified` | `unverified` | Live video and snapshots confirmed. Battery-shaped fields are suppressed. |
| eufyCam S330 | T8160, type 19 | `unverified` | `confirmed` | `unverified` | `unverified` | Discovery, sensors, retained images, and live video confirmed. |
| eufyCam S300 / 3C | T8161, type 23 | `unverified` | `confirmed` | `partial` | `unverified` | HomeBase 3 discovery, person events, and live video confirmed. T9000 discovery and retained snapshots confirmed, live video blocked at PPCS lookup. |
| eufyCam S3 Pro | T8162, type 26 | `unverified` | `unverified` | `partial` | `unverified` | T9000 discovery, person, pet, vehicle, and retained snapshots confirmed. Live video unresolved. |
| SoloCam C20 | T8134, type 63 | `unverified` | `confirmed` | `unverified` | `unverified` | Discovery, motion, person, and live video community-confirmed. Battery and event images need separate confirmation. |
| SoloCam E30 | T8171, type 88 | `unverified` | `implemented` | `unverified` | `unverified` | Admission and ready parent route implemented. Hardware discovery, events, snapshots, and live video await confirmation. |
| SoloCam S230 / S40 | T8124, type 62 | `unverified` | `confirmed` | `unverified` | `unverified` | Discovery and live video confirmed. Events and fresh snapshots need focused confirmation. |
| SoloCam S340 | T8170, type 48 | `unverified` | `unverified` | `partial` | `unverified` | T9000 discovery, person events, and retained snapshots confirmed. Live video unresolved. |
| Solar Wall Light Cam S120 | T81A0, type 10005 | `unverified` | `confirmed` | `unverified` | `confirmed` | Discovery, sensors, motion, retained snapshots, and live video confirmed. Fresh capture can still time out. |
| Floodlight Cam E340 | T8425, type 47 | `unverified` | `unverified` | `partial` | `unverified` | T9000 discovery, person and vehicle events, and retained snapshots confirmed. Live video unresolved. |
| Floodlight Cam S330 / 2 Pro | T8423, type 38 | `unverified` | `partial` | `unverified` | `unverified` | Discovery and event snapshot confirmed. Live view still lacks a usable H.265 decoder bootstrap. |
| Wired Wall Light Cam S100 | T84A1, type 151 | `unverified` | `unverified` | `unverified` | `partial` | Direct PPCS is confirmed. H.264 live video works on one setup, while another receives only delta slices. |
| Indoor Cam Pan & Tilt | T8410, type 31 | `unverified` | `confirmed` | `unverified` | `unverified` | Sensors, retained image, and live stream confirmed. |
| Indoor Cam Pan & Tilt | T8410C, type 104 | `unverified` | `confirmed` | `unverified` | `unverified` | Sensors, retained image, and live stream confirmed. |
| Indoor Cam S350 | T8416, type 105 | `unverified` | `implemented` | `partial` | `implemented` | Discovery and entities confirmed on direct Wi-Fi and T9000. T9000 live video unresolved. Privacy mode is not exposed. |
| Indoor Cam E30 4K | T8417, type 105 | `unverified` | `implemented` | `unverified` | `partial` | Admission and direct media are implemented. Live video is blank while codec startup remains unresolved. |
| Indoor Cam 2K | T8400, type 30 | `unverified` | `implemented` | `unverified` | `unverified` | Admission added in v0.1.63. Awaiting hardware confirmation. |
| Indoor Cam 2K Pan&Tilt | T8419, type 10009 | `unverified` | `implemented` | `unverified` | `unverified` | Admission added in v0.1.63. Awaiting hardware confirmation. |
| eufyCam C37 | T814X, type 10037 | `unverified` | `implemented` | `unverified` | `unverified` | Admission added through a ready HomeBase 3 route. Hardware confirmation is outstanding. |
| eufyCam E40 | T8144, type 49 | `implemented` | `unverified` | `unverified` | `unverified` | Admission added for HomeBase 2. Hardware discovery, snapshots, and live video still need reporter confirmation. |

## Doorbells and video locks

| Marketing model | Eufy model and type | Topology | Current capability notes | Evidence |
| --- | --- | --- | --- | --- |
| Video Doorbell | T8200, type 5 | Direct or self-parented | Discovery and self-parented PPCS are confirmed. Press and video remain unresolved. | Developer, v0.1.63. |
| Video Doorbell | T8210, type 7 | Direct and HomeBase 2 | Live video and snapshots confirmed directly. HomeBase 2 playback has a separate blank or frozen report. | Developer and community, versions not consistently recorded. |
| Video Doorbell | T8213, type 91 | HomeBase 3 | Discovery, sensors, retained images, and live stream confirmed. | Developer, v0.1.63. |
| Video Doorbell E340 | T8214, type 94 | HomeBase 3 and T9000 | T9000 discovery and entities confirmed. T8030 live video has intermittent frame jumps. Press notifications need focused testing. | Community reports, versions not consistently recorded. |
| Video Doorbell C30 | T8224, type 96 | Direct | Admission and doorbell press handling are implemented. Live media remains unverified. | Community evidence from `lsnewman`, issue #83, app/integration v0.1.59 reported; press support released in v0.1.63. |
| Familock S3 Max | T85V0, type 203 | HomeBase 3 | Discovery and main battery confirmed. H.265 media arrives, but visible playback, snapshots, doorbell events, and lock controls remain unverified or unsupported. | Community reports, versions not consistently recorded. |

## Other recognised devices

| Device | Eufy model and type | Current status |
| --- | --- | --- |
| MiniBase Chime | T8023, type 25 | Used as E340 doorbell connection metadata. No Home Assistant chime entity or settings. |
| Lock | T85D0, type 202 | Recognised as a non-camera device. Lock and access-control entities are not implemented. |

## Evidence maintenance

New evidence should record the device, topology, capability, result, date, app
version, integration version, Home Assistant Core version when available, and
the GitHub issue or user who supplied it. A release or code test can show that
the gateway path exists. Only a real device result should move a topology from
`implemented` to `confirmed`.
