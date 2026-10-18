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
