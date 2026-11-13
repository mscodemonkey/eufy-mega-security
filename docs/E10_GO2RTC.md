# E10 source for go2rtc

The gateway already offers an authenticated H.264 source at a stable address. go2rtc can use it to provide its own stable RTSP output. Each reconnect uses the same saved gateway authentication, rather than an expiring Home Assistant HLS link. This does not repair the separate E10 five-minute video failure. E10 hardware playback and recovery through go2rtc remain unconfirmed.

Use the saved-connection scripts from this release as described in [private diagnostics](PRIVATE_DIAGNOSTICS_REFERENCE.md#home-assistant-app-installs). In the Home Assistant Terminal & SSH app, use `diagnostic-bundle.py list` to find the current E10 index, then run:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py e10-go2rtc-source --target-index 1 --output /config/eufy-e10-source.json
```

This reads cached gateway admission and writes a new private file. It does not open video, enable camera recording or edit your running go2rtc configuration. It refuses a different model, an unsupported route, an existing file or a public output folder.

The file contains the gateway API token and camera identifier. Keep it private, restrict access and never paste it into an issue or log. Transfer it through your normal private file route to the machine running go2rtc. The saved gateway hostname must be reachable from that machine. Do not expose the gateway port publicly or change network isolation to make it work. If that hostname is unreachable, stop and establish a private route before using this configuration.

Download [e10-go2rtc-source.py](../eufy_event_gateway/scripts/e10-go2rtc-source.py) from this same release into the private scripts folder on the go2rtc machine. Python 3.9 or newer is required. Add this entry using your normal configuration editor, keeping your existing listeners, authentication and other streams:

```yaml
streams:
  eufy_e10: "exec:python3 /config/eufy-diagnostics-tools/e10-go2rtc-source.py --connection /config/eufy-e10-source.json"
```

The producer reads its token from the private file. Credentials never enter the go2rtc source string or its process arguments. The producer rejects redirects, opens only the saved camera route and closes its response when the consumer stops. The RTSP stream name is `eufy_e10`, available through go2rtc's loopback listener on its usual port 8554 when the consuming application runs on the same machine. For another machine, use your existing authenticated private go2rtc address. This helper does not configure downstream RTSP access.

Open one ordinary view when no recording or other view owns this camera. Disconnecting the last consumer lets the gateway's normal idle cleanup release the camera. A continuous Frigate consumer keeps requesting media, so stop that consumer when you no longer want the camera active. go2rtc owns reconnect scheduling. EMS does not add a retry loop or guarantee uninterrupted video. If the gateway API token changes, remove the old private fragment and generate a new one.

The [go2rtc exec documentation](https://github.com/AlexxIT/go2rtc/blob/master/internal/exec/README.md) describes the pipe input and process lifecycle. Two reconnects through go2rtc v1.9.15 have been checked with authenticated synthetic video. That qualifies the consumer handoff, not the physical E10 or five-minute recovery. Keep source connectivity, local consumer tests and actual E10 recovery separate.
