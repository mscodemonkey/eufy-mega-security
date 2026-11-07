# Send a diagnostic bundle

A bundle helps us investigate a problem with your Eufy devices. It works with
HomeBases, standalone cameras and other discovered devices. Nothing uploads
automatically, and capturing diagnostics doesn't change your camera settings.

You'll need app and integration v0.1.131 or newer. Follow the short request in
your GitHub issue for which device to choose and what to try.

## Your privacy

The bundle's technical data excludes Eufy account details, email addresses,
passwords, API tokens, encryption keys, camera or room names, device serial
numbers, IP addresses, private URLs and full log or error messages. Your gateway
token authenticates requests to your own gateway. It is not put in the bundle.
Device names on the capture page help you choose a device and aren't exported.

The technical data includes gateway version, device models, firmware, supported
features, connection and stream status, event categories, relative timing and
diagnostic counts. Devices get labels such as `device-1` that apply only to that
capture. These details can still distinguish your setup, so we don't promise
complete anonymity.

**Optional media is different.** Pictures, audio and video are off by default
and require your agreement. If enabled, they are included without anonymising,
blurring or removing embedded information. People, voices, your home, camera
overlays and media metadata may identify you or someone else. We can't promise
a bundle containing media has no personal information. Leave media off unless
we've explained why it is needed and you're comfortable sharing it privately.

Nothing uploads automatically. You choose whether to download and send the
file. Your email address or cloud-sharing account can identify you separately
from the bundle. We retain a private copy for investigation, with no automatic
deletion date promised.

The gateway's temporary capture stays in memory and is removed ten minutes
after capture starts, when you clear it, or when the gateway restarts. That
doesn't delete downloaded or sent files. Copies may remain in Home Assistant
backups, browser downloads, synced folders, email or cloud storage. Delete copies
you no longer need and revoke shared access after the investigation.

## 1. Open the capture tool

In the Eufy Mega Security app's Web UI, click **Open diagnostics**.
Enter your gateway API token and click **Load devices**. This is the gateway's
token, not your Eufy password. Keep it private.

**Don't know your token?** Home Assistant users can use the terminal method
below instead. It uses your saved connection automatically.

<details>
<summary>Home Assistant terminal method</summary>

Open the **Terminal & SSH** app in Home Assistant. Copy and run this block once:

```sh
mkdir -p /config/eufy-diagnostics-tools
curl -fL https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/v0.1.131/eufy_event_gateway/scripts/diagnostic-bundle.py -o /config/eufy-diagnostics-tools/diagnostic-bundle.py
curl -fL https://raw.githubusercontent.com/mscodemonkey/eufy-mega-security/v0.1.131/eufy_event_gateway/scripts/export-event-image-capture.py -o /config/eufy-diagnostics-tools/export-event-image-capture.py
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py list
```

For a normal capture, run:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py capture --output /config/eufy-diagnostics.json.gz
```

Then reproduce the problem during the next 30 seconds.

If we've asked for private video and you're comfortable sharing it, use this
command instead. Replace `1` with your camera's index from the list:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py capture --target-index 1 --media --consent-private-media --output /config/eufy-stream-diagnostics.json.gz
```

Open the camera's live view in Home Assistant while capture runs. Add
`--seconds 60` only if we've asked for a longer capture.

Retrieve the saved file from `/config` using your usual private file access,
such as Samba. Don't move it into `/config/www`. Then go to step 4.
If you don't have terminal or file access, tell us in the issue and we'll help.

</details>

## 2. Choose what to capture

Choose the device we've asked about, or **All devices** if we haven't specified
one. Leave the duration at **30 seconds** unless we've asked for 60.

Leave **Include private pictures, audio and video** unchecked unless we've
requested media and you agree. It may include people, conversations and saved
pictures from before the capture.

Leave **Open the selected camera's live stream during capture** unchecked
unless we've specifically asked you to use it.

## 3. Reproduce the problem

Click **Start capture**, then try the action from your issue, such as opening
live view in Home Assistant. After the capture finishes, click **Download bundle**.
Download within ten minutes and before restarting the gateway.

## 4. Send the file privately

Email it to **mscm.projects@gmail.com** with your issue number and what happened.
If it's over **20 MB**, send a private cloud link granting that email address
download access instead.

Keep the file and link out of public GitHub issues. Don't send passwords,
tokens or configuration files. After we've finished investigating, revoke any
cloud access and delete copies you no longer need. On the capture page,
**Clear evidence** removes the gateway's temporary copy.

## Need help?

If something fails, tell us which step stopped you. For another terminal capture,
use a new output filename so you don't overwrite the first file.

This tool doesn't capture NVR live video. Failed event-picture downloads may
need the [separate image capture guide](EVENT_IMAGE_EVIDENCE.md).
Home Assistant's ordinary **Download diagnostics** is a different, information-only download.

[Technical details and troubleshooting](PRIVATE_DIAGNOSTICS_REFERENCE.md)


## Private raw message history

Enable **Private raw message history** in the app options to keep receive and send
traffic for retrospective debugging. It is off by default. The local journal is
encrypted and retains up to 24 hours or 1 GiB, with a 256 MiB free-space reserve.
It can contain account secrets, device identifiers and household media. Its key
and raw files are excluded from ordinary diagnostic downloads.

The diagnostics page shows recorder health, including dropped records, storage
errors and retention. A stopped recorder, a cancelled HTTP body or an observation
gap cannot establish that a device sent nothing. UDP, application TLS, WebSocket,
cloud HTTP, MQTT and RTC observations retain their own boundaries. Commands are
recorded as dispatch attempts, which do not prove device acknowledgement.

Private export requires the API bearer token and explicit private-raw consent.
It reads one bounded journal file at a time. The private local analysis tools can
authenticate retained records and distinguish an incomplete final record from a
failed authentication tag. Code and dependency fingerprints identify the build
that produced each new record. Recording does not change device settings.

## Check familiar names in existing recordings

Use **Check familiar names in recordings** on the Diagnostics page when Eufy
shows a familiar name in its recording list but Home Assistant did not receive
it. This experimental read-only check supports T8210/type 7 attached to HomeBase
3 T8030/type 18. Select the doorbell and date, close live viewers, then choose
**Check names once**. It uses your existing authenticated connection and changes
no device settings.

The result counts recordings, person entries and recordings containing familiar
names. Actual names and identifiers are excluded. Each request reads one page
of at most 50 station recordings, so a zero count cannot establish that the
whole day has no matching recording. Other cameras can occupy the same page.
Cancelling, changing the selected device or date, or leaving the page cancels
the request and prevents an old result appearing under a new selection.

The authenticated API operation is
`POST /api/cameras/{serial}/diagnostics/event-names` with JSON
`{"date":"2026-10-31"}`. Private investigations can supply an optional `startId`
string copied from a captured history request to check that exact page. This is
an opaque database cursor. It must never be calculated from a recording time.
The default cursor is `"0"`. The reader does not retry or fetch subsequent pages
automatically.

A successful name check establishes availability in recording history. It does
not show when recognition became available after the event, prove the app's
text-rendering path, or fix a missing late notification. It does not publish a
new detection or update person sensors. Use it to distinguish a missing push
from a name that is also absent in the corresponding history page.

## Check a recording thumbnail

Use **Check a recording picture** for a T8113-Z/type 8 camera attached to
HomeBase 3 T8030/type 18. Select the camera and date, close live viewers, then
choose **Check one picture**. EMS reads one history page, selects an owned
recording and requests its exact thumbnail from the HomeBase. A successful check
reports decoded dimensions and size. Image bytes, paths and recording identifiers
stay private. This operation does not replace event images or update detections.

The authenticated operation is
`POST /api/cameras/{serial}/diagnostics/event-picture` with JSON
`{"date":"2026-11-02"}`. It checks the first matching camera record in that
page. Private investigations may supply an observed `startId` cursor and an exact
`recordId`, both as strings. No caller-supplied image path or URL is accepted.
An absent record leaves the check unfinished rather than selecting another one.
There is no automatic pagination or retry. Cancellation or a changed camera or
date prevents a late result from appearing under the new selection.

Private investigations can additionally supply `recordingPath` with `recordId`
to require the complete recording reference to match. This narrows the history
selection. It is never used as the requested image path, and the response still
contains counts only.

The recording thumbnail and notification image can be different renditions.
Retrieving the thumbnail does not establish why a cloud download failed, prove
that both images contain identical bytes, or enable automatic recovery. Other
models and HomeBase generations remain outside this check's observed contract.

## Experimental HomeBase picture recovery

The app option **Experimental HomeBase picture recovery** is off by default.
For a T8113-Z/type 8 camera on HomeBase 3 T8030/type 18, it tries the matching
recording thumbnail after the normal cloud-picture retries finish with HTTP 404.
It can recover a lower-resolution picture of the same event. The cloud image
and recording thumbnail are not assumed to contain identical bytes.

Recovery requires a recent notification with an exact recording ID and complete
supported recording path. Both must match the camera's HomeBase history row.
One page of at most 50 rows is checked, with no retry or automatic pagination.
Unsupported paths, missing records, other download errors and a busy HomeBase
leave the last good image in place. There is at most one attempt per HomeBase
per ten seconds. Live viewers and other reserved operations take precedence.

A newer event, changed camera/account binding or gateway restart invalidates
an older picture operation. Recovery only updates the image. It does not create
another detection or extend its timer. `push_snapshot_recovered` records a
successful thumbnail retrieval. `push_snapshot_recovery_unavailable` means the
attempt could not recover that exact thumbnail. Neither line contains private
recording references.

The notification-to-history join and real protected replies have been replayed
through EMS, and the exact thumbnail read has been exercised on local hardware.
Automatic recovery on a fresh naturally failing notification still needs that
separate confirmation. This option does not add HomeBase 2 or doorbell support.

## Experimental HomeBase 2 event frames

The app option **Experimental HomeBase 2 event frames** is off by default. Some
notifications from a T8140 or T8140-Z/type 14 camera on HomeBase 2 T8010/type 0
carry a small close-up rather than the scene. When the retained event picture is
narrower than 320 pixels, this option reads the first picture of that event's
clip from the HomeBase SD card and retains it as the event image. The cloud
picture appears first and is replaced later.

The clip download contract is unconfirmed on hardware. The gateway sends the
legacy fixed-width download command with level-one encryption, then unwraps each
signed frame's key with the RSA key from the station cipher lookup. The notification
must name a clip in this camera's own SD-card folder and a station cipher.

Attempts run 20, 60 and 120 seconds after the picture, because the clip is still
being written when the notification arrives. The clip is on the HomeBase, so this
is not expected to wake the battery camera. A newer event, changed camera/account binding or
gateway restart invalidates the job, and a newer cropped picture starts its own.
Live viewers take precedence over an attempt. While a clip is being read, the
HomeBase is reserved until the disconnect has been sent, so a viewer on that
camera waits and a viewer on another camera of that HomeBase is refused. Any
failure leaves the cropped picture in place. Reading a clip does not create
another detection or extend its timer.

`event_frame_retained` records a replaced picture. `event_frame_attempt_failed`
gives a structural reason, and `event_frame_unavailable` says which clip details
a notification lacked. None of these lines contains a clip path or key.
