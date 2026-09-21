# Developers start here

This document is the starting point for somebody who has just joined MSCodeMonkey Inc. and has been assigned Eufy Mega Security without any previous context. It explains the vocabulary, the system boundary, the data flow, and the reasons behind the unusual-looking parts of the repository.

Read this document before changing authentication, camera discovery, snapshots, or streaming. For endpoint and packet detail, continue with [`MEGA_PLATFORM.md`](MEGA_PLATFORM.md). Then read [`docs/FILE_MAP.md`](FILE_MAP.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md), and the source header for the module you intend to change.

## The short version

Eufy Mega Security is two programs:

1. `eufy_event_gateway` is a standalone Node.js service. It talks to Eufy's cloud and camera protocols, owns the Eufy account session, receives push notifications, downloads and decodes event images, and opens live camera sessions.
2. `custom_components/eufy_event_gateway` is a small Home Assistant integration. It talks to the gateway's authenticated local HTTP and Server-Sent Events API and turns the gateway's stable JSON into Home Assistant entities.

The gateway knows Eufy. Home Assistant knows Home Assistant. That boundary is the most important design decision in the project.

The service name is a historical internal identifier. The user-facing name is **Eufy Mega Security**. The Home Assistant domain, add-on slug, and action namespace remain `eufy_event_gateway` so existing installations do not lose their entity and service identities during the rename.

## What is Mega?

“Mega” is Eufy's current account and device platform used by the recent Eufy mobile applications. It is not a camera model, a media codec, or a Home Assistant library. In this project, Mega means the family of Eufy HTTPS APIs and associated push services that provide account authentication, regional service discovery, device inventory, event notifications, media URLs, station keys, and camera-session credentials.

Mega is an observed application protocol, not a public stable SDK. Eufy can change endpoint names, response fields, error codes, encryption details, or device behaviour without notice. The code therefore keeps all Mega-specific work under `eufy_event_gateway/src/mega` and converts untrusted responses into typed, bounded values before they reach the rest of the gateway.

The word “Mega” is easy to confuse with Eufy's older **Thing** or SmartLife service. They are different account systems with different credentials, signing rules, device IDs, and transport paths. Production startup uses `MegaClient`; the retired Thing and Web Portal experiments are no longer part of the repository.

## What is PPCS?

**PPCS** is Eufy's peer-to-peer camera transport. The acronym is used in Eufy's packet headers and native application traces; it is not a generic Home Assistant protocol. PPCS uses UDP lookup and handshake packets to find a camera or HomeBase, then carries command frames and encrypted media over the resulting peer connection.

The production session in `src/stream/first-party-ppcs.ts` does the following:

1. sends a LAN broadcast lookup and cloud lookup requests using the station's P2P DID, application connection string, and DSK key;
2. sends `CAM_CHECK` and waits for the camera's `CAM_ID` response;
3. sends the camera command that starts media;
4. for a HomeBase-attached camera, decrypts the HomeBase gateway information, asks Mega for the matching ECC private key, unwraps the level-two session key, and sends the encrypted media-start request;
5. accepts PPCS data datagrams, acknowledges them, reassembles `XZYH` command frames, unwraps the per-stream video key, and writes Annex-B H.264 bytes to a Node readable stream.

PPCS is therefore the camera-side media path. Mega supplies the account and key material needed to use it, but Mega's HTTPS API does not itself contain the live H.264 stream.

`start()` resolving means that the peer answered the lookup. It does not mean that the first video frame has arrived. Diagnostics intentionally expose the later handshake and frame counters so a reachable but sleeping or out-of-charge battery camera is distinguishable from a protocol failure.

## Why not use `eufy-security-ws` or `eufy-security-client`?

The established Eufy Security WebSocket ecosystem is useful prior art, but it is not the runtime dependency for this project. Its client stack follows older account and transport assumptions, including the separate Thing/SmartLife login and web/P2P paths that led to the expiring Web Portal Access PIN and CAPTCHA experience we were trying to remove. It also couples the Home Assistant process to a large, evolving protocol implementation that was not providing the camera models and native Mega path we needed.

We wrote the first-party client because the project needed:

- current Mega authentication and session reuse without asking for the Web Portal PIN on every setup;
- direct access to the inventory fields needed for HomeBase-attached battery cameras;
- the DSK and ECC cipher lookups required by the native PPCS path;
- bounded, testable handling of Eufy's event-image wrappers;
- a small normalized boundary that can be used by Home Assistant, a probe, or another consumer;
- control over redaction, timeouts, rate limiting, and persistence rather than inheriting those choices from an unrelated client.

This is not a claim that the older ecosystem is universally bad. It is a deliberate compatibility boundary. Do not add it back as a shortcut when a protocol step is missing. Capture the observation, add a focused fixture or probe, and extend the first-party module that owns that boundary.

## Runtime architecture

```text
Eufy Mega HTTPS APIs
  ├─ account login, domain discovery, encrypted API envelopes
  ├─ device inventory, DSK keys, ECC cipher keys
  ├─ Firebase push registration and event notifications
  └─ HTTPS event-image URLs
              │
              ▼
      src/mega/MegaClient + MegaPushReceiver
              │ normalized inventory/events and key material
              ▼
      src/provider/EufyProvider
              ├─ GatewayState: camera/detection/snapshot state
              └─ FirstPartyPpcsSession: UDP camera media
                              │ Annex-B H.264
                              ▼
      LiveStreamManager + SnapshotStore + GatewayServer
              │ authenticated JSON, JPEG, MP4, SSE
              ▼
      Home Assistant custom integration
              ├─ camera entity and retained image
              ├─ motion/person binary sensors
              └─ last-recognized-person sensor
```

`src/main.ts` is the composition root. It constructs configuration, storage, state, provider, stream management, and HTTP server, then owns graceful shutdown. It should not become a second protocol implementation.

## Repository map

### Eufy and gateway code

- `eufy_event_gateway/src/mega/client.ts`: account login, session restoration, inventory, keys, push registration, and bounded HTTPS media download.
- `eufy_event_gateway/src/mega/crypto.ts`: pure Mega request, password, identity, and envelope cryptography.
- `eufy_event_gateway/src/mega/types.ts`: checked Mega response and persisted-session shapes.
- `eufy_event_gateway/src/mega/android-push/`: Eufy Android FCM registration and authenticated Google MCS socket transport.
- `eufy_event_gateway/src/mega/push.ts`: Mega token registration, private Android identity and delivered-ID storage, notification parsing, and safe diagnostics.
- `eufy_event_gateway/src/mega/image.ts`: JPEG detection and Eufy event-image decoding.
- `eufy_event_gateway/src/provider/eufy-provider.ts`: the adapter that turns Mega observations into gateway callbacks and chooses the production PPCS session.
- `eufy_event_gateway/src/stream/first-party-ppcs.ts`: the native UDP media protocol.
- `eufy_event_gateway/src/domain`: normalized camera state and events. No raw Mega payloads belong here.
- `eufy_event_gateway/src/storage/snapshot-store.ts`: last-good image persistence.
- `eufy_event_gateway/src/stream/live-stream-manager.ts`: shared H.264 source, JPEG extraction, MP4 recording, idle cleanup, and time limits.
- `eufy_event_gateway/src/server.ts`: the gateway API and local authentication page.

### Home Assistant code

- `custom_components/eufy_event_gateway/client.py`: authenticated HTTP/SSE calls only.
- `custom_components/eufy_event_gateway/coordinator.py`: first poll, SSE reconnect/backoff, and sixty-second recovery polling.
- `custom_components/eufy_event_gateway/entity.py`: serial-based device identity and availability.
- `custom_components/eufy_event_gateway/camera.py`: retained image, short-lived stream URL, fresh snapshot action, and clip action.
- `custom_components/eufy_event_gateway/binary_sensor.py`: motion and person states.
- `custom_components/eufy_event_gateway/alarm_control_panel.py`: confirmed Away, Home, and Disarmed control for HomeBase 3.
- `custom_components/eufy_event_gateway/select.py` and `number.py`: HomeBase guard mode, alarm tone, and volume controls.
- `custom_components/eufy_event_gateway/sensor.py`: last recognized person, effective HomeBase mode, and storage state.
- `custom_components/eufy_event_gateway/config_flow.py`: manual and Supervisor-discovered gateway connections.

### Documentation and delivery

- `README.md`: user installation and operating behaviour.
- `CONTRIBUTING.md`: contribution rules and local checks.
- `docs/FILE_MAP.md`: per-file orientation.
- `docs/DEVELOPERS_START_HERE.md`: this architecture and protocol guide.
- `docs/project-memory/README.md`: durable project decisions and delivery state.
- `eufy_event_gateway/Dockerfile` and `config.yaml`: Home Assistant app packaging.

## Authentication, from credentials to a usable session

The gateway receives an Eufy account email, password, and two-letter country code from private app configuration. Home Assistant never receives the Eufy password.

### 1. Regional discovery

`MegaClient` first calls the regional Mega passport host to estimate the account's service domain. The response contains the account's Mega domain and a product-domain map for services such as `openapi`, `house`, `push`, `devicerelation`, and `security`.

### 2. Per-host identity exchange

Before encrypted requests, the client performs an ECDH exchange using `prime256v1`. The client sends its public key with the Mega preset bootstrap material, receives the service's public key and key identifier, and derives a shared AES key and signing key. Identities are cached per host in the persisted Mega session so a restart does not repeat the exchange unnecessarily.

### 3. Password login

The plaintext password is never sent in an API request. `encryptPassword()` uses Eufy's published login public key and a fresh client key pair. The login request contains the encrypted password, the client public key, country, login identifiers, and empty challenge fields unless the user has just supplied a CAPTCHA answer or email verification code.

The response supplies an account token, user ID, and token expiry. The client stores the session metadata and derived host key material in `mega-session.json`. A limited token returned with an email-verification challenge is saved before the challenge is exposed, allowing the documented configuration-and-restart fallback to submit the code with the same session. The session file stores no password, CAPTCHA answer, or email verification code.

### 4. Challenge states

Mega can require an image CAPTCHA or a six-digit email verification code. These are represented as explicit `MegaAuthResult` states. The gateway's local Web UI presents the current challenge, holds the answer in memory, submits it through the same Mega client and session, and then completes normal startup. A challenge page is a gateway convenience, not a second Eufy account system.

### 5. Authenticated request envelopes

Each API request is rate-limited, signed, encrypted, and sent to the service-specific Mega host. The client decrypts the response envelope, validates the basic shape, and exposes only the fields required by its public methods. Error codes are retained long enough for the provider to distinguish a stale session from an ordinary request failure.

On the wire, Mega returns an outer JSON object shaped like `{ code, msg?, data? }`. For most authenticated operations, `data` is a string containing the encrypted response envelope. After AES decryption the string is parsed as JSON. The decoded value is operation-specific: the inventory is an object with `devices` and optional `groups`, DSK lookup returns station-key rows, cipher lookup returns cipher rows, and push/media operations return their own small objects. The code never passes that raw decoded object to Home Assistant; it validates and projects it first.

The request body follows the same distinction. Domain estimation is a clear JSON POST because it is the bootstrap operation. Key exchange sends a JSON object containing the encrypted client public key. Normal operations serialize their payload to JSON, encrypt it, and send the encrypted text body with headers containing the key identifier, timestamp, nonce, request signature, country, and auth token. This distinction matters when adding an endpoint: do not assume every Mega request is a clear JSON body just because its response is represented by JSON.

## What data we retrieve from Mega

The gateway does not mirror the entire Eufy account. It asks for the smallest useful slices and normalizes them.

| Mega operation | Important upstream values | Gateway representation | Consumer |
| --- | --- | --- | --- |
| Domain estimate | regional domain and product-domain map | `MegaSession.megaDomain`, `domains` | `MegaClient` request routing |
| Passport login | auth token, user ID, expiry, challenge state | `MegaSession`, `MegaAuthResult` | provider startup and Web UI |
| `get_devs_list` | device serial, name, model, category, type, parent station, channel, P2P DID/connection, cipher ID, admin user | `MegaInventoryDevice` and `CameraIdentity` | provider, domain state |
| `get_dsk_keys` | station serial and short-lived DSK key | in-memory station-key map with expiry | PPCS lookup |
| `get_ciphers` | cipher ID and ECC private key | in-memory cipher-key map | HomeBase level-two PPCS unwrap |
| push registration | Firebase registration token | private `mega-push.json` state | `MegaPushReceiver` |
| push event | camera/station serials, event/message type, person label, picture URL and diagnostic IDs | `MegaPushEvent` | provider and diagnostics |
| event-image URL | HTTPS response bytes | JPEG bytes after decode | `SnapshotStore`, Home Assistant |

The inventory is untrusted JSON. `parseMegaInventory()` rejects missing or duplicate serials, bounds strings, fills missing fields with `null` or safe defaults, and inherits a HomeBase admin user ID for child cameras when Eufy puts it only on the station row. Device types currently accepted as cameras are 7, 8, 19, 23, 31, 63, 91, 151, and 10031. Type 23 is the HomeBase-attached eufyCam S300 / 3C (`T8161`); type 151 is the standalone Wired Wall Light Cam S100 (`T84A1`). HomeBase type 18 becomes a separate station record, not a camera entity.

`ppcsStreamRoute()` keeps the transport choice explicit. A child uses its known HomeBase parent, while a parentless or self-parented supported camera is its own P2P peer. The route must have a peer DID, app connection, DSK key, and camera channel before `streamSupported` becomes true. A missing non-self parent is unavailable, not a reason to try a direct connection.

## Push events and detection state

Eufy sends notifications through Firebase Cloud Messaging. The gateway registers as the Eufy Android app, not a Chromium web-push client, because the latter produced only metadata on a tested account even while the owner phone received alerts. Firebase delivers the MCS stanza; the gateway decodes Eufy's base64 JSON appData and projects only the fields used downstream. The field names still differ between camera generations.

`MegaPushReceiver` extracts a deliberately small whitelist: camera serial, station serial, camera name, event and message types, notification style, person label, picture URL, file path, fetch ID, and sense ID. It stores the Firebase persistent ID atomically and redacts raw payloads from diagnostics.

`EufyProvider` maps event type 3101 to motion, event types 3102/3111 to person detection, and 3103 to a doorbell press on supported models. A person label is accepted only when Eufy supplies a non-generic recognized name. The provider downloads a referenced image in a per-camera queue so bursts cannot race the snapshot store.

`GatewayState` holds transient motion, person, and doorbell-press flags for 10 seconds, remembers the last detection, and emits normalized events. Home Assistant receives those events through SSE and also gets a sixty-second poll as recovery when a connection drops.

## How snapshots work

There are two distinct snapshot paths:

1. **Event snapshot:** a push notification contains an HTTPS picture URL. `MegaClient.download()` requires HTTPS, applies a response-size limit, and returns bytes. `decodeEventImage()` passes through ordinary JPEGs, reconstructs the Eufy v2 wrapper, or decrypts the older `eufysecurity` wrapper using the station P2P DID. The provider verifies that the result is JPEG before publishing it.
2. **Fresh live snapshot:** Home Assistant calls `capture_snapshot`. `LiveStreamManager` opens the PPCS H.264 source, gives it to FFmpeg, extracts one JPEG with `JpegParser`, and publishes the new image to `SnapshotStore`.

`SnapshotStore` writes a hashed serial filename and JSON index under the private data directory. Writes are serialized and performed through temporary files followed by rename. A restart therefore sees either the previous complete image or the new complete image, never a half-written file.

The ordinary camera card reads the retained JPEG. It does not wake a battery camera on every dashboard refresh. Opening live view or asking for a fresh snapshot is an explicit operation.

## How live streams work

### Inventory prerequisites

The camera row must contain a channel and be attached to a station that supplies a P2P DID, application connection string, and DSK. The provider fetches station DSK keys during startup. HomeBase-attached cameras may also need a cipher ID and the station's ECC private key from `get_ciphers`.

### PPCS media flow

The PPCS session begins with UDP lookup. The cloud lookup address is decoded from the Eufy connection string; a LAN broadcast is also attempted. Once a `CAM_ID` response identifies the peer, the session sends the camera command that requests media.

For a camera that owns its media path, the command is encrypted with a key derived from station serial and P2P DID. For a HomeBase-attached camera, the `1100` gateway-info frame is decrypted, its cipher ID is used to fetch the ECC private key from Mega, and an ECIES-wrapped level-two AES key is unwrapped. The session then sends a level-two AES-GCM JSON request containing the channel, account ID, stream type, and an ephemeral RSA modulus. The camera uses that modulus to establish a per-stream video key. Captured devices return that encrypted key as a fixed 128-byte field, so the session uses an ephemeral RSA-1024 key for wire compatibility. A larger key must not be substituted until the camera protocol is proven to accept it.

PPCS data datagrams are acknowledged and reassembled by type and sequence. `XZYH` command frames carry media payloads. The session removes the PPCS framing and writes Annex-B H.264 NAL units to its output stream. It does not convert the camera to RTSP.

### From H.264 to Home Assistant

`LiveStreamManager` owns one provider source per camera and shares it between viewers and captures. It starts the source on the first consumer, fans H.264 bytes to HTTP clients, feeds FFmpeg for JPEG extraction or MP4 recording, enforces an idle grace period, and closes the source at the configured maximum duration.

The gateway returns a short-lived HMAC-signed path for Home Assistant's camera stream. The integration asks for that path, supplies it to Home Assistant's stream pipeline, and never needs to understand a PPCS packet.

## The Home Assistant API boundary

The gateway exposes:

- `GET /health`: process and provider status for the app watchdog;
- `GET /api/cameras`: normalized camera state and retained snapshot metadata;
- `GET /api/cameras/{serial}/snapshot`: the retained JPEG;
- `POST /api/cameras/{serial}/stream-token`: a short-lived signed H.264 path;
- `GET /api/cameras/{serial}/live.h264`: the authenticated H.264 response;
- `POST /api/cameras/{serial}/capture-snapshot`: one fresh live frame;
- `GET /api/cameras/{serial}/record.mp4`: bounded MP4 capture;
- `GET /api/events`: SSE events such as camera discovery, motion, person, snapshot, stream state, and connection changes;
- `GET /api/diagnostics/inventory` and `/api/diagnostics/push`: safe troubleshooting views.
- `GET /api/diagnostics/catalogue-evidence`: support evidence with local device identities removed for Home Assistant's diagnostics download.

All `/api` calls use a bearer token except a short-lived signed stream path. `/health` is intentionally separate so Supervisor can tell “the process is alive” from “Eufy authentication is currently waiting for the user.”

The Home Assistant integration turns the API into entities as follows:

| Gateway value | Home Assistant result |
| --- | --- |
| camera identity and retained JPEG | camera entity and dashboard image |
| `streamSupported` plus stream-token endpoint | live camera capability |
| `motionDetected` | motion binary sensor |
| `personDetected` | person binary sensor |
| last detection with name/kind/time | last-recognized-person sensor and attributes |
| SSE update | immediate coordinator refresh |
| sixty-second poll | recovery after SSE or gateway restart |

## Why a standalone gateway exists

It would be possible to put every protocol detail inside the Home Assistant integration, but that would make the integration responsible for Node-native UDP sockets, cryptography, FFmpeg processes, account credentials, event-image decoding, long-lived push delivery, and Home Assistant's asynchronous entity lifecycle at the same time.

The gateway gives us:

- **protocol isolation:** Eufy changes stay in TypeScript modules and tests;
- **credential isolation:** Home Assistant only receives a local bearer token;
- **media-friendly runtime:** Node and FFmpeg handle UDP and byte streams without blocking Home Assistant's Python event loop;
- **reuse:** a probe, another automation service, or a future UI can consume the normalized HTTP/SSE API;
- **testability:** simulated provider tests can exercise the whole gateway contract without an Eufy account;
- **controlled failure:** Eufy authentication can be waiting for a CAPTCHA or email code without making Home Assistant think the integration itself is corrupt.

The cost is one extra process and one local API boundary. That cost is intentional because it keeps the difficult protocol code independently observable and reusable.

## Can the Eufy part be reused elsewhere?

Yes, with care. The most reusable layers are:

- `MegaClient` for account login, inventory, keys, and bounded media download;
- `src/mega/crypto.ts` for pure envelope and key operations;
- `MegaPushReceiver` plus `MegaPushEvent` for notification delivery and normalization;
- `FirstPartyPpcsSession` for a bounded camera media source;
- `parseMegaInventory()` and the typed domain contracts for safe device selection.

Another application should consume those modules through its own adapter rather than reaching into private fields. It must provide a private persistent directory, keep credentials out of logs, honour Eufy's rate limits, refresh DSK/cipher material when it expires, and treat the protocol as changeable. There is no promise that these observed internal endpoints form a stable public SDK.

The Home Assistant-specific pieces are `GatewayState`, `GatewayServer`, the Python integration, and the entity naming rules. A different consumer can skip those and use the Mega and PPCS layers directly, or run the gateway and consume its HTTP/SSE contract.

## Where to start when something breaks

1. Check `/health` and the gateway log. Start at the most recent `gateway_start` event and follow only lines with that `run` value. The UTC timestamp orders events, and `version` identifies the running release. “Authentication required” is different from “connected but no camera stream.”
2. Check `/api/diagnostics/inventory`. Confirm the camera was accepted as a supported Mega device and whether `streamSupported` is true.
3. Check `/api/diagnostics/push`. Confirm an event arrived, the camera serial matched inventory, and a picture URL was present.
4. Run `npm run poc:ppcs` and inspect safe counters. A `camId` without `videoFrames` means lookup succeeded but media did not reach the output; record battery and network state before changing code.
5. For a retained-image problem, inspect `SnapshotStore` and the event-image decoder. For a live-view problem, inspect `FirstPartyPpcsSession` and `LiveStreamManager`. For an entity problem, inspect the Python client/coordinator and the normalized JSON first.

Do not start by adding Eufy parsing to Home Assistant. If the gateway does not expose the needed normalized fact, fix the Eufy-side boundary and its test first.

Application code must use the component logger from `src/logging.ts` instead of writing directly to `console` or the process streams. Give each condition a stable snake-case event name and pass only bounded, human-readable text that is safe to share. The logger rejects arbitrary metadata objects and redacts common credentials and account email addresses, but callers remain responsible for excluding session data, device serial numbers, signed media URLs, and raw cloud responses.

## Local development

```sh
cd eufy_event_gateway
npm ci
npm run check
npm run build
EUFY_GATEWAY_PROVIDER=simulated npm run dev
```

Use a real Eufy account only for the probe or a focused integration test. Keep the session directory outside Git. The full local gate is `npm run check`, `npm run build`, and `git diff --check`; see [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the release and review process.

## Glossary

- **Annex-B H.264:** the byte-stream form of H.264 NAL units emitted by the camera session and consumed by FFmpeg.
- **DSK:** the station/device secret key used by PPCS lookup and handshake messages. It is retrieved from Mega and held only in the gateway's private runtime state.
- **DID:** Eufy's P2P device identifier. It identifies the station on the PPCS path and is not the same as a Home Assistant entity ID.
- **ECC cipher key:** an ECC private key returned by Mega for a station cipher ID. It unwraps HomeBase gateway information for level-two media setup.
- **Firebase push:** the delivery channel for Eufy notifications. The notification payload is Eufy-specific and is normalized by this project.
- **HomeBase:** Eufy's station. Battery cameras normally report a parent HomeBase serial, channel, and station-level transport metadata.
- **Mega:** Eufy's current cloud account/API family used by the native application.
- **PPCS:** Eufy's peer-to-peer UDP camera media protocol.
- **SSE:** Server-Sent Events, the one-way HTTP stream used from gateway to Home Assistant for state changes.
- **Thing/SmartLife:** Eufy's older account and transport family. Its unused experiments were removed in v0.1.20.
- **Web Portal Access PIN:** a separate, expiring web transport credential. Production Mega/PPCS does not use it.
