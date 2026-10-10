# Capturing failed event pictures privately

Use this only when a maintainer asks for an event-image sample. A log such as
`format=binary result=missing_both` says the response was not recognised. It does
not establish encryption or a new image format. Manual snapshots use a separate
path and can work while event pictures fail.

This diagnostic feature must be included in an installed release or diagnostic
build before its configuration option appears. It is not in v0.1.125.

## Capture one failing event

In the Eufy Mega Security app configuration, enable **Capture failed event
images**, save and restart the app. Trigger the affected camera's motion event.
The gateway retains failed decode inputs only. A valid JPEG is not collected,
and the last good event picture remains in place.

Collection lasts 30 minutes from startup. Samples remain available for export
until 60 minutes from startup, then are erased from memory. There is no disk
capture. Restarting loses existing samples and opens another capture window while
the option stays enabled. Disable the option and restart after exporting.

The session accepts one sample per model, device type and direct/attached route,
up to four samples. Each sample is at most 2 MiB, with at most 6 MiB retained
in total. Oversized samples and additional samples are skipped, without truncation.
An HTTP error, empty response or failed download-integrity check is not captured.

## Export from a trusted Home Assistant terminal

Copy [`export-event-image-capture.py`](../eufy_event_gateway/scripts/export-event-image-capture.py)
from the matching source checkout or diagnostic build into a trusted terminal
environment with Python 3.9 or later and access to `/config`. It must be able to
reach the gateway's internal address. The script reads Home Assistant's saved
integration connection locally, so you do not need to retrieve or share a token.

```sh
python3 export-event-image-capture.py --output /config/eufy-event-image-evidence.json
```

Export before the 60-minute deadline. If there are multiple Eufy Mega Security
integration entries, add `--entry-id YOUR_ENTRY_ID` to select the intended one.
The existing destination must not exist. The tool creates an owner-only file,
checks the archive's hashes and lengths, and refuses paths in `/config/www`.
It refuses redirects and bypasses proxy environment variables. Requests have a
30-second total deadline and a 10 MiB response limit.

Export is repeatable until expiry. The script leaves the capture available by
default. Add `--clear` to end the session only after the file is saved. If clearing
fails, the saved file remains available and the script tells you to disable the
option. A timeout also preserves a file that was completely written. Check for
that private file before retrying with a new filename.

The normal app Web UI does not export this evidence. The API requires bearer
authentication, which the script handles privately. Standalone gateways can use
the authenticated `GET /api/diagnostics/event-images` status route,
`POST /api/diagnostics/event-images/export` download route and
`DELETE /api/diagnostics/event-images` clear route with their existing credential.
Status contains counts and deadlines only. Samples are never included in ordinary
Home Assistant diagnostics.

Gateway connections can use plain HTTP on the local network. Use a trusted local
terminal and network, or an existing HTTPS gateway connection. Do not expose the
gateway port publicly to collect evidence.

## Share the archive privately

The archive contains the exact bytes passed to the image decoder, represented
as base64, with SHA-256 hashes and limited response metadata. Fetch may already
have decompressed the HTTP body. The recorded content encoding and declared
length refer to the final server response and do not by themselves prove
truncation of the decoded body.

Treat the archive as sensitive. Even an encrypted or wrapped body can contain
identifiers, and an unexpected response can include household images or faces.
Do not paste it into a GitHub comment or attach it to an issue. Ask the maintainer
to arrange a private transfer channel without posting any archive content.
After transfer, delete the exported file, including any copies or backups you
made, and disable capture. No upload happens automatically.

Maintainers must keep received archives in ignored private storage. Do not commit
them, include them in Claude review prompts, normal diagnostic reports or status
emails. Derive synthetic regression fixtures after establishing the actual format.
Capture availability is not a decoder fix or confirmation on reporter hardware.
