# File map

This repository has a deliberate split. The gateway knows about Eufy. The Home Assistant integration knows about Home Assistant. Keeping that line clear makes both sides easier to test and makes the Eufy protocol reusable outside Home Assistant.

If you are new to the project, read [`DEVELOPERS_START_HERE.md`](DEVELOPERS_START_HERE.md) first. It explains Mega, PPCS, authentication, event images, stream conversion, and the reason the standalone gateway exists. This page is the quick “where is that code?” index.

## Repository files

| Path | Purpose |
| --- | --- |
| `README.md` | User-facing installation, configuration, camera behaviour, and troubleshooting guide. |
| `CONTRIBUTING.md` | Development setup, test commands, protocol boundaries, pull request expectations, and release notes. |
| `SECURITY.md` | Private reporting and secret-handling rules. |
| `docs/DEVELOPERS_START_HERE.md` | First-day developer guide to the architecture, Mega/PPCS protocols, data transformations, and debugging workflow. |
| `docs/MEGA_PLATFORM.md` | Detailed Mega API, authentication, inventory, push, event-image, PPCS, and Home Assistant transformation reference. |
| `docs/CAMERA_CAPABILITY_MATRIX.md` | Camera core discovery boundary and implemented battery reads. |
| `docs/DEVICE_CAPABILITY_BASELINES.md` | Separate sensor, HomeBase, and doorbell core discovery boundaries. |
| `docs/DEVICE_COMPATIBILITY_MATRIX.md` | Device, HomeBase topology, capability, and versioned hardware evidence ledger. |
| `eufy_event_gateway/device_catalogue/` | Contributor-editable property and command reference, split into one validated JSON file per device. |
| `docs/TODO.md` | Implementation backlog and hardware-evidence follow-up list. |
| `hacs.json` | HACS metadata for the custom integration. |
| `examples/node-red-gate-and-motion.json` | Importable Node-RED flow showing motion events and gateway actions. |
| `.github/workflows/validate.yml` | CI for gateway tests/build, HACS validation, and Home Assistant metadata. |
| `docs/project-memory/README.md` | Short record of the current architecture and delivery state. |

## Gateway app

### Startup and state

| Path | Purpose |
| --- | --- |
| `eufy_event_gateway/src/main.ts` | Composition root. Wires configuration, storage, provider callbacks, stream management, HTTP server, and shutdown without owning protocol rules. |
| `eufy_event_gateway/src/config.ts` | Converts environment strings into validated typed settings and enforces API-token rules for non-loopback listeners. |
| `eufy_event_gateway/src/server.ts` | Owns the authenticated health, camera, snapshot, stream, clip, SSE, diagnostics, and challenge-page HTTP boundary. |
| `eufy_event_gateway/src/domain/types.ts` | Stable protocol-neutral contracts for cameras, detections, snapshots, streams, connections, and diagnostics. |
| `eufy_event_gateway/src/domain/gateway-state.ts` | In-memory state machine for connection status, camera entities, transient detections, retained snapshots, and stream state. |
| `eufy_event_gateway/src/storage/snapshot-store.ts` | Persists one verified last-good image per camera with hashed filenames, serialized writes, and atomic replacement. |
| `eufy_event_gateway/src/provider/provider.ts` | Narrow adapter interface separating a real or simulated provider from state and HTTP code. |
| `eufy_event_gateway/src/provider/eufy-provider.ts` | Translates Mega inventory/push/media observations into provider callbacks and selects first-party PPCS for live video. |
| `eufy_event_gateway/src/provider/camera-capability-core.ts` | Small live lookup of existing camera media, events, and battery reads. |
| `eufy_event_gateway/src/provider/{sensor,homebase,doorbell}-capability-core.ts` | Small core family lookups. |
| `eufy_event_gateway/src/provider/device-capability-core.ts` | Shared row shape used by each family definition file. |
| `eufy_event_gateway/src/provider/device-capabilities-core.ts` | Shared evaluator for all camera, sensor, HomeBase, and doorbell core lookups; separates evidence from support without admitting unsupported devices. |
| `eufy_event_gateway/src/provider/devices/` | Typed compatibility catalogue for device models, HomeBase topologies, capabilities, quirks, and versioned evidence. |
| `eufy_event_gateway/src/provider/simulated-provider.ts` | Deterministic provider for local UI, API, SSE, and lifecycle testing without an Eufy account. |

### Mega protocol

| Path | Purpose |
| --- | --- |
| `src/mega/client.ts` | Production Mega account client: domain discovery, ECDH identity exchange, encrypted login/requests, session reuse, inventory, DSK/cipher lookup, push registration, and bounded media download. |
| `src/mega/crypto.ts` | Pure Mega key exchange, request signing, AES envelope, password encryption, credential-verifier, and token primitives. |
| `src/mega/types.ts` | Checked response and persisted-session contracts; not a raw undocumented API schema. |
| `src/mega/session-store.ts` | Private, atomic Mega session persistence with strict current-schema validation. |
| `src/mega/android-push/` | Eufy Android FCM registration, Google MCS framing, reconnect, and raw Eufy push delivery. Adapted from mega-yfue/eufy-sdk under Apache-2.0. |
| `src/mega/push.ts` | Registers the Android token with Mega, persists the private receiver identity and delivered IDs, and projects camera notifications into safe gateway events. |
| `src/mega/image.ts` | JPEG detection and decoding of Eufy event-image wrappers, including encrypted legacy bytes. |

### Video and media

| Path | Purpose |
| --- | --- |
| `src/stream/first-party-ppcs.ts` | Production Eufy PPCS UDP lookup, CAM_CHECK, HomeBase key unwrap, media request, H.264 extraction, and heartbeat. PPCS means Eufy's peer-to-peer camera transport. |
| `src/stream/homebase-ppcs.ts` | Short-lived local HomeBase 3 state, storage, acknowledgement, and readback command sessions. |
| `src/stream/live-stream-manager.ts` | Shares a provider H.264 source, feeds FFmpeg for snapshots/clips, bounds recordings, and stops idle sessions. |
| `src/stream/jpeg-parser.ts` | Reassembles complete JPEG frames from arbitrary FFmpeg stdout chunks. |
| `scripts/ppcs-probe.ts` | Safe standalone proof tool that enumerates cameras and records PPCS byte/frame results. |

## Home Assistant integration

| Path | Purpose |
| --- | --- |
| `custom_components/eufy_event_gateway/manifest.json` | Integration metadata, version, documentation, and issue links. |
| `custom_components/eufy_event_gateway/__init__.py` | Creates the gateway client/coordinator and forwards entity platforms. |
| `custom_components/eufy_event_gateway/config_flow.py` | Manual and Supervisor discovery flows, connection validation, and reconfiguration. |
| `custom_components/eufy_event_gateway/client.py` | Authenticated HTTP/SSE client for the gateway API. |
| `custom_components/eufy_event_gateway/coordinator.py` | Polling recovery plus reconnecting SSE updates. |
| `custom_components/eufy_event_gateway/entity.py` | Shared device registry information and availability for all entities. |
| `custom_components/eufy_event_gateway/camera.py` | Retained-image cameras, live stream URLs, fresh snapshots, and clip actions. |
| `custom_components/eufy_event_gateway/alarm_control_panel.py` | Code-free Away, Home, and Disarmed control with transient command progress. |
| `custom_components/eufy_event_gateway/binary_sensor.py` | Camera detections, battery charging, standalone contact/PIR, and HomeBase connection sensors. |
| `custom_components/eufy_event_gateway/number.py` | HomeBase alarm and prompt volume controls. |
| `custom_components/eufy_event_gateway/select.py` | Configured guard-mode and alarm-tone controls. |
| `custom_components/eufy_event_gateway/sensor.py` | Camera and standalone-sensor battery reads, last-seen time, recognized people, effective mode, and HomeBase storage. |
| `custom_components/eufy_event_gateway/const.py` | Domain, API-token key, and platform constants. |
| `custom_components/eufy_event_gateway/services.yaml` | Service descriptions for snapshot and clip actions. |
| `custom_components/eufy_event_gateway/strings.json` | Config-flow and entity translation keys. |
| `custom_components/eufy_event_gateway/translations/en.json` | English translations used by Home Assistant. |

## Tests

The gateway tests live in `eufy_event_gateway/test`. They cover configuration, crypto, Mega session and push handling, image decoding, state transitions, native transport framing, PPCS helpers, snapshots, HTTP authentication, and the simulated provider. Add a focused test beside the module it protects. Keep real-account probes in `scripts/ppcs-probe.ts` and `scripts/push-debug.ts`, not in the automated test suite.
