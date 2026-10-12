# Private diagnostics reference

For the short walkthrough, see [Send a diagnostic bundle](PRIVATE_DIAGNOSTICS.md).
This page keeps the technical details and troubleshooting commands.

The gateway can create the same diagnostic bundle for HomeBases, standalone
cameras, sensors, NVRs and other discovered devices. No external research tool,
Android device, packet sniffer or alternate Eufy login is required. Start with a
30-second metadata session and reproduce the problem while it runs.

Only collect private media when a maintainer has explained what it will help
investigate and you agree. Video, audio and pictures can reveal people,
conversations and your surroundings. Keep bundles and their download links out
of public GitHub issues. Nothing uploads automatically.

## What is captured

Every session includes the gateway version, model/type/topology and reported
firmware, capability availability, event-delivery counters, relative lifecycle
timing, request outcomes, log event codes and numeric counters from active
gateway stream transports. These counters include parser progress, sequence
gaps and duplicate/stale datagrams without wire prefixes or peer addresses. Device identifiers become
session-local labels such as `device-1`. Names, account details, credentials,
signed URLs, detection identities, arbitrary log/error messages and settings
files are excluded. Global connection and log event codes are marked by the
absence of a device label, even when one device is selected.

### Privacy boundaries

The technical projection excludes Eufy account details and email addresses,
passwords, gateway API tokens, encryption keys, device and room names, serial
numbers, IP addresses, private URLs and full log or error messages. Device names
and original identifiers are used for local selection and replaced with
capture-local aliases in the export. The gateway token authenticates requests
to your own gateway and is not included in the archive.

This is filtered diagnostic data, not a guarantee of anonymity. Models,
firmware, topology, capabilities and event categories can still distinguish a
setup. Detection categories are included, but recognised people's identities
are excluded from the technical projection.

Optional media is copied without anonymising, blurring or scrubbing its contents
or embedded metadata. It can reveal faces, voices, surroundings, camera overlays
or other identifying information. The technical exclusions above do not remove
information visible, audible or embedded in that media. Private-media consent
is off by default.

Sending a bundle also reveals information outside the archive, such as your
email address, cloud-sharing account or chosen filename. Maintainers retain a
private copy for investigation, with no automatic deletion date promised.
Gateway expiry, clearing or restart removes its temporary in-memory capture,
not downloads, sent files or copies in backups and synced folders. Home
Assistant's `/config` output may be included in Home Assistant backups. Delete
copies you no longer need and revoke shared access after the investigation.

### Optional media and device selection

With explicit consent, the same session can retain original H.264/H.265 video
and validated AAC audio from the gateway's existing source, before viewer
conversion or container muxing. Retained JPEG snapshots and event images can
also be included. Those images may predate the session. The bundle retains chunk
timing, codec labels, lengths and SHA-256 hashes. It is diagnostic evidence,
not a guaranteed playable recording. Starting during an existing stream may
miss decoder initialization and the time/size limit can stop mid-picture.

Selecting a HomeBase includes its inventoried child cameras. Selecting a camera
includes its parent station's metadata and lifecycle events. Selecting all
devices is useful for discovery or account-wide problems. Capture itself does
not change camera settings or open a stream. Optional live viewing uses the
existing supported gateway route and releases that viewer afterwards.

The manifest states which stages are available. Raw network packets, arbitrary
vendor responses and NVR RTC media are **not captured by this version**. NVR
metadata, discovery and gateway event evidence use the same workflow, but this
does not implement NVR live video. Failed-image response capture remains a
separate opt-in tool documented in [issue diagnostics](ISSUE_EVIDENCE_DIAGNOSTICS.md).

## Home Assistant app installs

The support utility reads the integration's saved gateway connection locally.
Do not send your `.storage` directory, app options or credentials to anyone.

Run these commands in the Home Assistant Terminal & SSH app. They download
our two support scripts from the same published release. The scripts use Python's
standard library. Keep them outside `/config/www`.

```sh
mkdir -p /config/eufy-diagnostics-tools
curl -fL https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/v0.1.131/eufy_event_gateway/scripts/diagnostic-bundle.py -o /config/eufy-diagnostics-tools/diagnostic-bundle.py
curl -fL https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/v0.1.131/eufy_event_gateway/scripts/export-event-image-capture.py -o /config/eufy-diagnostics-tools/export-event-image-capture.py
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py list
```

The list shows device indexes, models and gateway stream availability. These
indexes select the current inventory, so check the list again after adding or
moving devices. If there are multiple integration entries, supply `--entry-id`
before the subcommand. Do not share the entry ID or saved configuration.

For discovery, event delivery, controls or other problems, capture all devices:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py capture --output /config/eufy-diagnostics.json.gz
```

Reproduce the problem during those 30 seconds. To focus on one device, add
`--target-index 1`, replacing `1` with its current index. A HomeBase selection
also observes child cameras. Use a new output filename for each attempt.

For a stream problem, when you agree to include private media, choose a camera
with `streamSupported` and run:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py capture --target-index 1 --media --consent-private-media --open-live --output /config/eufy-stream-diagnostics.json.gz
```

Add `--seconds 60` only when a longer reproduction is useful. Existing live
viewers may share the source. The utility releases only its own viewer. Do not
open the official app's live viewer at the same time if it preempts the session.
For retained pictures without opening live view, omit `--open-live`.

The utility saves a new private file with mode `0600`, validates its media
checksums and prints counts plus the recommended sharing method. Existing
files and public output folders are refused. Export stops acquisition and
preserves retryable evidence for up to ten minutes from capture start. A failed
transfer can be retried using a new output filename:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py status
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py export --output /config/eufy-retry.json.gz
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py clear
```

Use your normal private file transfer method to retrieve the file. Do not move
it into `/config/www` to create a download link. Delete local copies after the
investigation when you no longer need them.

## Gateway page and ordinary diagnostics

The app's Web UI links to **Create a diagnostic bundle**. Direct gateway users
can visit `/diagnostics` on their existing gateway address. The page requires
the gateway API token, keeps it only in page memory and uses authenticated
requests. App users who do not have that token should use the utility above.

Choose a device or all devices, choose the duration and start capture. Reproduce
the problem, then download the bundle. Private-media consent is unchecked by
default. Opening the selected camera's live stream requires both consent and an
existing supported stream route. Stop releases the page's viewer. Clear erases
the session. Leaving the page releases its viewer, while the gateway still
applies its capture deadline. Capture expiry or restarting the gateway erases
retained evidence.

Home Assistant's normal **Download diagnostics** remains metadata-only. It
includes the new cross-device summary alongside catalogue/event evidence and
never implicitly starts a private capture or includes media.

## Limits and sharing

One capture can run at a time. Capture lasts 30 or 60 seconds and stops early at
64 MiB of native media or 20,000 combined events/media chunks. Evidence expires
after ten minutes. The compressed download is usually small for metadata, but
video dominates the size. At 4 Mb/s, 60 seconds of video is roughly 30 MB before
compression. At 8 Mb/s it is roughly 60 MB. Already compressed video may barely
shrink. Check the actual downloaded size and capture outcome.

Email the bundle to **mscm.projects@gmail.com** with the issue number, model,
firmware, standalone/HomeBase/NVR topology, the action you tried and what
happened. You can attach a small file. Above 20 MB, use a private cloud link
granting that address viewer and download access. Keep the file recipient-only,
confirm downloads are enabled and revoke access after the investigation. Do not
post private links, tokens or footage in the public issue. A bundle is private
evidence even when it contains only metadata.

## Maintainer inspection

Keep received bundles in private ignored storage. Inspect them without
extracting or executing any contents:

```sh
python3 eufy_event_gateway/scripts/diagnostic-bundle.py inspect --input /private/path/eufy-diagnostics.json.gz
```

The inspector limits compressed and expanded sizes, checks the schema and
record/timing limits, and verifies every media length and SHA-256 hash. It prints
only counts and a sharing recommendation. It does not check that archive
contents are anonymous or scan media for personal information. Inspection success proves archive
integrity, not correct playback or a hardware fix. Compare evidence with the
exact model and topology before changing support claims. Never execute a
reporter's attachment or add private media to source-controlled test fixtures.
