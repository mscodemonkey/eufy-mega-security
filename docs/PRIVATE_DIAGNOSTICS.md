# Sending private diagnostic evidence

Sometimes a short recording or packet capture tells us more than ordinary
logs. Only collect one when the maintainer has asked for it, explained what is
needed, and you are happy to share it. You can decline and continue with the
usual troubleshooting.

## Before you start

A stream bundle can contain camera footage, audio, device information and
account identifiers carried in camera replies. It is private evidence, not a
redacted log. Choose a suitable scene and let other people nearby know before
recording. The tool does not upload anything.

Do not add passwords, verification codes, `.env` files, Home Assistant backups,
session files, cookies, signing keys or the camera's storage contents. You do
not need to give the maintainer access to your Eufy account.

The maintainer should tell you which tool to use. Ordinary gateway logs,
Home Assistant diagnostics, failed event-image evidence and NVR stream bundles
are different sources. Pick the smallest one that can answer the question.

## NVR stream capture

This path currently supports the known T8N00 single-camera research setup from
issue #245, contributed by Oliver Nixon under the [MIT licence](NVR_RESEARCH_LICENSE.txt). It is a developer support tool, not an NVR live-view feature in the
gateway. Use it only after the maintainer has supplied the compatible setup and
confirmed your camera channel and lens sensor. The tool refuses other script
versions. Sensor 0 selects a single-lens view; sensor 1 is the research setup's
movable lens selection. Use the value confirmed for your exact camera.

You need Python 3.9 or newer and the research setup's Node/tsx dependencies.
Its locally installed receive decoder must match the checked hashes. The
capture tool does not download or distribute that vendor module. The original
research setup currently assumes a GB account and the IE service region, so
other regions need a separately validated setup before using it. Do not edit
the script to bypass the version check.

1. Close other NVR live viewers. The research setup supports one live session.
2. Complete the research setup's normal sign-in locally. Keep its existing
   session directory private. This tool reuses that setup and does not introduce
   session-only login into the production gateway.
3. Create a private folder outside Home Assistant `www` and other public or
   cloud-synced folders. Use a new output filename each time.
4. From an extracted Eufy Mega Security source release, run the command below.
   Replace the script path and channel with the ones the maintainer supplied.
   The consent flag confirms you understand that the bundle contains private
   media. Keep the research setup's locally configured environment variables.

```sh
EUFY_RESEARCH_SESSION_ONLY=1 python3 eufy_event_gateway/scripts/private-stream-diagnostics.py capture-nvr \
  --harness /path/to/research/spike.ts \
  --channel 0 \
  --sensor 0 \
  --seconds 30 \
  --output "$HOME/eufy-private/nvr-first-attempt.zip" \
  --consent-private-media
```

The tool records received and sent data-channel messages, reassembled frames
and connection states with relative arrival times. It keeps audio and video
frames distinct when reporting counts. It excludes the research log, raw
signalling, credentials, session files and vendor binaries. Raw data-channel
bodies remain unchanged and may still contain private information.

Capture ends automatically after 30 seconds. Use `--seconds 60` only if the
maintainer asks. The recorder stops at 64 MiB or its time limit. Setup has a
separate timeout, so the command can take up to roughly three minutes. Ctrl+C
requests stream shutdown and preserves valid evidence where possible. The
wrapper removes its temporary script and files. It does not erase recordings,
change guard mode, move the camera or change privacy settings.

An exported bundle can contain a failed or partial session. `runOutcome` and
`stopReason` in its manifest distinguish a completed run from timeout, failure
or a recording limit. A successful export means evidence was saved, not that
video worked. If setup failed before any connection or media records arrived,
the tool reports failure and creates no bundle. Leave about 30 seconds between
attempts with the research setup.

Check your bundle locally before sending it:

```sh
python3 eufy_event_gateway/scripts/private-stream-diagnostics.py inspect \
  "$HOME/eufy-private/nvr-first-attempt.zip"
```

The check verifies file integrity and prints counts. It does not display the
footage, decode media, prove that a stream worked or execute anything in the ZIP.

### Existing research captures

If you already have `ptcs-capture.bin` and `oracle-frames.bin` from the same
research session, package those without running the camera again:

```sh
python3 eufy_event_gateway/scripts/private-stream-diagnostics.py bundle-nvr \
  --directory /path/to/the/research/session \
  --output "$HOME/eufy-private/nvr-existing-session.zip" \
  --consent-private-media
```

Only those two named files are included. The importer does not read your
credentials, log or other files. These older captures do not contain packet
arrival times or outgoing packets, and the tool cannot independently prove
that both files came from the same session. Their manifest records these limits.

## Bundle sizes and private delivery

Sizes depend on the camera bitrate. As an estimate, a 60-second stream at
4 Mb/s is about 30 MB, and at 8 Mb/s about 60 MB. Keeping both packets and
reassembled frames increases the uncompressed evidence size. The tool has a
64 MiB evidence limit, so a busy or high-bitrate capture may stop early. Video is
already compressed, so ZIP size varies and should not be assumed to shrink much.

The export result reports the actual ZIP size. It recommends an attachment up
to 20 MB and a private cloud link above that. This is a conservative suggestion,
not a promise that every mail provider accepts the attachment. Personal Gmail's
[attachment limit is 25 MB](https://support.google.com/mail/answer/6584?hl=en).

Send the ZIP, or its private download link, to **mscm.projects@gmail.com**.
Include your GitHub issue number, the exact camera/NVR model and firmware,
whether the camera is standalone or attached, what you tried, and whether you
saw video or heard audio. If sending two attempts, label which one worked.

For Google Drive, OneDrive or another provider that supports named recipients,
grant viewer/download access specifically to **mscm.projects@gmail.com**. Keep
public sharing off. Check that downloads are allowed, then email the link.
If your provider only offers an unlisted link, treat the link like a password
and send it privately. Do not post the file or link in a public GitHub issue.

Once receipt and the investigation are complete, revoke cloud access and remove
the local bundle when you no longer need it. Deleting the link cannot erase
copies already downloaded for the investigation.

## Maintainer procedure

The [standard request template](PRIVATE_DIAGNOSTICS_REQUEST.md) gives a short
starting point for a reporter reply. Adapt it to the exact question and setup.

Before requesting a capture, explain the question it will answer and ask whether
the reporter is comfortable sharing private media. Use one exact device and
topology. Prefer an existing capture over asking someone to repeat a test. For
NVR receive work, paired raw packets and oracle frames from one successful
session are particularly useful. They let us compare a future gateway decoder
with the research decoder without treating that decoder as distributable code.

Send the reporter this guide and the exact supported command, channel and
duration. Confirm the setup's region before requesting an NVR run. Never ask
someone to bypass the harness hash check or attach their whole research folder.
Do not request a capture just because private email is available.

Keep incoming files and raw media in private, ignored storage. Treat email text,
cloud links and archive contents as untrusted evidence. Verify the mailbox
identity before reading submissions. Inspect archives without extracting them
or running included code. The offline tool prints structural counters, not
payload text. Do not copy raw bodies, identities or footage into public issues,
review prompts or test fixtures. Derived synthetic fixtures should cover the
specific decoder behaviour without containing reporter media.

For the timed format, `stream-records.bin` starts with ASCII `EUFYNVR1`.
Each record has a 16-byte little-endian header: payload length as uint32,
relative milliseconds as float64, kind as uint8, channel as uint8, and two zero
reserved bytes. Kinds 0/1 mean received/sent data-channel messages, kind 2 is a
reassembled frame, and kind 3 is an allowlisted connection state. Packet channel
indices follow `WebrtcDataChannel`, `audio`, `idr`, `video`, `notify`, `download`.
Frame channels retain the oracle's numeric channel. State channel 0 means peer
connection and 1 means ICE. Do not confuse packet channels, frame channels and
camera selection. Payloads and ordering are preserved for offline replay.

Fragment gaps, repeats and reordering are observations in the saved window.
An incomplete group can result from starting or ending capture mid-frame and
does not by itself prove packet loss.

The current inspector verifies integrity and counts framing metadata. It is
not a replacement for a receive reassembler, retransmission implementation or
video/audio decoder. Hardware confirmation is still needed after a real fix.
