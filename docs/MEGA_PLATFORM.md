# Mega platform and Eufy protocol reference

This is the deeper protocol reference for Eufy Mega Security. It explains what “Mega” means in this repository, what the gateway requests, what comes back, and how those results become Home Assistant camera and detection entities.

For the newcomer-friendly route through the whole repository, start with [`Developers start here`](DEVELOPERS_START_HERE.md). For contribution rules and safe handling of credentials, read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`SECURITY.md`](../SECURITY.md).

## Mega is the cloud control plane

Mega is Eufy's current mobile-app account and device platform. It is a set of regional HTTPS services plus Firebase notification delivery. It is not the live video stream itself.

The gateway uses Mega for:

- account login and token renewal;
- regional service-domain discovery;
- encrypted API identity exchange and request envelopes;
- device and HomeBase inventory;
- station DSK keys and HomeBase ECC cipher keys;
- Firebase push-token registration;
- event notifications and event-image URLs.

The gateway uses PPCS for camera media. A useful mental model is:

```text
Mega HTTPS + Firebase = who the account owns, what happened, and which keys are needed
PPCS UDP              = the peer-to-peer camera connection carrying live H.264
Gateway HTTP/SSE      = the stable contract exposed to Home Assistant
```

Mega and the old Thing/SmartLife platform are not interchangeable. They use different account sessions, identifiers, signatures, encryption envelopes, and media paths. Production startup uses `MegaClient`. The unused Thing and Web Portal transport experiments were removed in v0.1.20 so they cannot be mistaken for supported paths.

## Service domains and operations

`MegaClient` begins with a clear JSON POST to the regional passport host:

```text
POST /passport/estimate_domain
body: { "ab": "au", "mode": 1 }
```

The response supplies the account's Mega domain and a product-domain map. The client retains those host names in `MegaSession` and uses service names such as `openapi`, `house`, `push`, `devicerelation`, and `security` to choose the correct endpoint.

The production operations are:

| Operation | Endpoint | Why we call it | Output used by |
| --- | --- | --- | --- |
| Login | `/passport/login` | Establish or refresh account session | provider startup |
| CAPTCHA | `/passport/generate/captcha` | Obtain an image challenge | gateway Web UI |
| Verification | `/app/sendmsg/verify_code` | Ask Eufy to send an email code | gateway Web UI |
| Inventory | `/app/house/get_devs_list` | Enumerate stations, cameras, channels, and P2P metadata | provider |
| DSK lookup | `/app/devicerelation/get_dsk_keys` | Obtain station secrets for PPCS lookup | PPCS session |
| Cipher lookup | `/v3/app/cipher/get_ciphers` | Obtain ECC private keys for HomeBase level-two setup | PPCS session |
| Push registration | `/app/push/register_push_token` | Register the Firebase receiver | push receiver |

The actual host is selected from the discovered product-domain map. Hard-coding one global Eufy host would break accounts in other regions and is one reason host discovery belongs in `MegaClient`.

## Wire formats and encryption

Most Mega responses have an outer JSON shape:

```json
{
  "code": 0,
  "msg": "success",
  "data": "<encrypted response text>"
}
```

`code` is the first decision point. A successful string `data` is decrypted with the shared host AES key and parsed as JSON. Some bootstrap or error responses contain an object directly instead. The client handles that distinction before exposing a result.

Normal request bodies are JSON-serialized, encrypted, and sent as text. Headers identify the host key, request timestamp, random nonce, country, and signature. Authenticated calls also include the Mega account token. The signature covers the values required by Eufy's native application, so reordering or changing a field can invalidate an otherwise correct request.

Identity setup uses P-256 ECDH (`prime256v1`). The client starts with a Mega preset key, sends an encrypted client public key, receives an encrypted server public key and key identifier, and derives two values: the AES material used for envelopes and the signing material used for request headers. The resulting `MegaIdentity` is cached per host in the private session file.

Two protocol fields retain older hash names without using them as security controls. Mega requires `gtoken` to be the MD5 digest of the public user ID, and Eufy's older event-image wrapper includes MD5 as one step in its fixed key transformation. Neither operation stores a password, verifies a credential, signs a request, or makes a trust decision. They must remain byte-compatible with Eufy's wire format.

Login encrypts the password with Eufy's published login public key and a fresh client key pair. The plaintext password never enters the request body. A successful response yields an auth token, user ID, and expiry. The session store also records the country, a `scrypt` credential verifier, open device identifier, domains, and host identities so a restart can reuse a valid session without storing the password.

The session file is private JSON with mode `0600` and is replaced atomically. It contains secret session material, so it must stay in the gateway's private data volume and must never be attached to an issue or committed to Git. Version 2 replaces the old fast password-derived guard; version 1 credentials and tokens are deliberately rejected, so the first start after upgrading to v0.1.20 requires a fresh Eufy sign-in. The non-secret device identifier is carried forward to avoid registering an unnecessary new client. When Eufy requests email verification, the limited token and user ID returned by that login are saved before the client exposes the challenge. This lets either the active Web UI or one documented app restart submit the code with the same limited session. Passwords, CAPTCHA answers, and email verification codes are not stored in the session file.

## Login challenges

Mega may return one of three useful states:

- `authenticated`: the account token is valid and startup can continue;
- `captcha-required`: Mega returned an image and challenge ID;
- `verification-required`: Eufy sent a six-digit code to the account email.

The provider exposes those states to the gateway Web UI. The answer or code lives in memory long enough to submit it through the same `MegaClient` that received the challenge, after which normal inventory and push startup resumes. The limited pre-verification Mega session is also persisted so the app-configuration fallback can survive one restart without losing the token that requested the code. The challenge page is not the production media protocol and should not be confused with the old expiring Web Portal Access PIN.

## Inventory: raw values to safe camera identity

`get_devs_list` returns a JSON object containing a `devices` array and optional `groups`. Each row is untrusted and may contain many fields that differ across product generations. The gateway keeps only the values required for routing and presentation:

```text
device_sn       -> serial
device_name     -> name
device_model    -> model
category        -> category
device_type     -> deviceType
parent_sn or station_sn -> parentSerial
device_channel or channel -> channel
p2p_did         -> p2pDid
p2p_conn or app_conn -> p2pConnection
cipher_id       -> cipherId
member.admin_user_id -> adminUserId
```

`parseMegaInventory()` rejects rows without a serial, removes duplicate serials, bounds text fields, and fills absent values with `null` or safe defaults. If a child camera has no `admin_user_id`, it inherits the parent station's value because the HomeBase media request is account-scoped.

The current camera filter accepts `eufy_security` device types generated from
catalogue entries marked `ready_to_test` or `supported` with the camera
handler. A `recognised` camera stays visible in privacy-safe inventory
diagnostics without creating Home Assistant entities until a reporter is
available to test it. Stations and accessories have separate generated roles,
so a shared inventory response cannot accidentally turn a HomeBase or lock
into a camera tile.

For a HomeBase child, the parent provides the P2P DID, app connection, and DSK key. A parentless or self-parented supported camera uses its own values through the direct PPCS route. The diagnostic log identifies the selected route and only reports whether those peer values and the DSK key are available. It never includes the values themselves. A row that names a missing, different parent stays unavailable rather than being guessed as a standalone camera.

The normalized provider row is converted into `CameraIdentity`, which is the first shape that the protocol-neutral domain and Home Assistant can consume. Raw Mega keys and payload fields stop at this boundary.

## Push delivery and event data

The gateway registers a Firebase installation as the Eufy Android app using the app package, certificate, and FCM sender. It checks in with Google, obtains an FCM token, registers that token with Mega, and holds an authenticated MCS socket for notifications. `src/mega/android-push/` owns registration and socket framing; `MegaPushReceiver` saves the private identity and delivered IDs, then normalizes Eufy's MCS appData JSON. The earlier Chromium web-push subscription could connect and register a token while receiving metadata-only messages rather than camera events.

`MegaPushReceiver` extracts only this normalized event shape:

```text
cameraSerial, stationSerial, cameraName
eventType, messageType, notificationStyle
personName, content
pictureUrl, filePath, fetchId, senseId
guardMode, effectiveMode, alarmType
```

The provider interprets event type 3101 as motion, 3102/3111 as person detection, and 3103 as a doorbell press on supported doorbell models. A press becomes its own transient gateway event and Home Assistant binary sensor. It accepts a person name only when the structured or textual value is an explicit recognized identity. Generic labels such as `Someone` do not become a named person entity.

Station event type 9 updates the configured and effective guard modes. Event type 10 updates whether the HomeBase siren is active. The provider applies these messages immediately and keeps a 60-second local PPCS poll for missed notifications or reconnect recovery.

Diagnostics retain timestamps, event types, camera name, and boolean “field present” flags. They do not retain raw push payloads, tokens, complete media URLs, or notification text. The last fifty diagnostic records are enough to investigate a camera without turning the endpoint into an account-data dump.

## Event images and snapshots

An event may contain an HTTPS `pictureUrl`. `MegaClient.download()` verifies HTTPS, applies a 20 MiB default limit, enforces a 30-second timeout, and rejects empty or oversized responses.

The bytes can be:

1. a normal JPEG beginning with `FF D8`;
2. a `v2_eufysecurity:` wrapper where the payload is missing the ordinary JPEG prefix and tables;
3. an older `eufysecurity` wrapper whose first encrypted block is keyed from the station serial, camera P2P DID, and wrapper code.

`decodeEventImage()` handles those formats locally. `EufyProvider` checks that the result is a JPEG before calling `GatewayState` and `SnapshotStore`. `SnapshotStore` writes a hashed serial filename, an index entry containing capture time/content type/revision, and replaces files atomically.

Home Assistant reads the retained image through `GET /api/cameras/{serial}/snapshot`. A retained image does not wake a battery camera and remains useful while the device sleeps. A fresh snapshot is different: Home Assistant calls `capture_snapshot`, the gateway starts a live PPCS source, FFmpeg extracts one JPEG, and the result replaces the retained image.

The first time a discovered camera has no retained image, startup schedules the same fresh-snapshot path after the provider reports that it is connected. The gateway handles these captures sequentially to avoid opening several battery-camera sessions together. A failed or sleeping camera is left without a snapshot and retried on a later startup; its failure does not block the rest of the queue.

## PPCS: the native media path

PPCS is Eufy's peer-to-peer camera transport. It uses UDP packet families and command frames rather than RTSP. The gateway's `FirstPartyPpcsSession` hides those details behind a readable stream of Annex-B H.264 bytes.

### Inputs

The session needs:

- station serial and P2P DID;
- decoded cloud application connection addresses;
- station DSK from `get_dsk_keys`;
- camera channel and model;
- account/admin ID for the media request;
- cipher lookup for the camera's direct authenticated media or HomeBase-attached level-two setup;
- a maximum session duration.

### Handshake and media

1. Bind an ephemeral UDP port.
2. Send LAN broadcast and cloud lookup packets containing the encoded DID and DSK.
3. Send `CAM_CHECK` to each responding address.
4. Accept the first matching `CAM_ID`; this proves reachability, not video.
5. Send the start command for the camera's media route.
6. For direct authenticated cameras, resolve the camera-record cipher ID before media decoding. For HomeBase cameras, decrypt the `1100` gateway-info command, fetch its referenced ECC key from Mega, unwrap the level-two AES key, and send the encrypted `1350` media-start JSON.
7. Acknowledge data datagrams, reassemble `XZYH` frames by type/sequence, decode every `1300` video chunk, and reassemble station-split chunks into complete access units before normalising their H.264 or H.265 framing.
8. Send heartbeats and close the UDP socket/output stream when the consumer releases it or the maximum lifetime expires.

The session exposes counters for `camId`, data datagrams, command headers, gateway-info frames, level-two completion, transport video chunks, complete output units, incomplete units dropped, and errors. A station-split access unit is identified by its repeated sequence and timestamp fields. Full 64,000-byte chunks are retained until a shorter continuation arrives. A continuation without an Annex-B start code is appended only when its identity matches the open unit. If the tail is lost, the incomplete bytes are dropped and only structural counts are reported. Those counters are essential when a battery camera completes lookup but has no charge or does not send media.

## Home Assistant conversion

### HomeBase state and commands

`HomeBasePpcsSession` uses a short-lived local UDP session for HomeBase camera-info, storage, and control commands. Reads collect station-channel parameters for configured mode, effective mode, alarm volume, prompt volume, and alarm tone. Storage responses are reduced to status, total space, and free space for eMMC and the installed HDD or SSD. Disk paths and drive serial numbers are discarded.

The gateway serializes operations for each HomeBase. Recovery polls wait while that station has active camera media. A security or settings command takes priority and stops the active media session first. The gateway sends each write once, waits for the matching PPCS result, then reads the relevant state again. It rejects the request when acknowledgement fails or the readback does not match, so Home Assistant never presents an optimistic setting as confirmed.

Home Assistant maps the result to a code-free alarm panel for Away, Home, and Disarmed; a configured guard-mode select; a separate effective-mode sensor; current siren state; connection diagnostics; storage sensors; volume and tone controls; and bounded HomeBase and camera siren controls where the command capability is reported.

The gateway converts media and events into a small HTTP/SSE contract:

```text
Mega/Firebase/PPCS
  -> MegaClient, MegaPushReceiver, FirstPartyPpcsSession, HomeBasePpcsSession
  -> EufyProvider normalized callbacks
  -> GatewayState and SnapshotStore
  -> GatewayServer JSON/JPEG/H.264/MP4/SSE
  -> Python client/coordinator
  -> Home Assistant entities and camera card
```

The Python integration never sees a Mega envelope, DSK, cipher key, P2P DID, push wrapper, or PPCS packet. It receives a camera dictionary, reads a retained JPEG, asks for a signed stream path, or consumes an SSE event. That is the point of the boundary: Home Assistant can evolve its entity lifecycle without carrying Eufy's protocol assumptions.

## Why this is a standalone gateway

The native client needs Node's cryptography and UDP support, FFmpeg process management, long-lived Firebase delivery, private session files, challenge handling, and careful media timeouts. Home Assistant needs a cooperative Python event loop, config entries, entity platforms, and recovery after supervisor restarts. Combining both concerns in one integration would make every protocol failure look like an entity failure and would make the Eufy implementation difficult to reuse.

The gateway provides a stable place for:

- protocol-specific credentials and key material;
- rate limiting and session restoration;
- event-image decoding and snapshot retention;
- PPCS packet handling and H.264 output;
- safe diagnostics and proof-of-concept probing;
- a simulated provider for tests.

The Home Assistant integration is consequently small, replaceable, and safe to run without an Eufy password in Python.

## Reuse outside Home Assistant

Another project can reuse the Eufy side without importing the Home Assistant integration. The useful public seams are `MegaClient`, the pure functions in `mega/crypto.ts` and `mega/image.ts`, `MegaPushReceiver`, `parseMegaInventory()`, and `FirstPartyPpcsSession`.

The reuse contract is intentionally conservative:

- provide a private persistent directory;
- keep account credentials and session files secret;
- honour request spacing and bounded downloads;
- treat Mega endpoint fields and PPCS packets as changeable;
- refresh DSK/cipher material when it expires or a session is recreated;
- consume normalized return values instead of reaching into private client state;
- keep a physical-camera proof or fixture for every newly supported model.

This is reusable implementation code, not a guaranteed stable Eufy SDK. A future consumer should pin a project release and expect protocol maintenance.

## Debugging checklist

When a camera does not appear, start with inventory diagnostics. When it appears without streaming support, inspect its parent station, channel, P2P connection, and DSK status. When lookup succeeds but no frames arrive, inspect the PPCS counters and camera power state. When an event has no snapshot, inspect whether the push event contained a URL, whether the download was HTTPS and within limits, and whether the image wrapper had the required station DID.

The standalone proof command is:

```sh
cd eufy_event_gateway
npm run poc:ppcs
```

It writes raw media only to the configured local output directory. Do not attach those files or the gateway data directory to an issue without removing account and device identifiers.
