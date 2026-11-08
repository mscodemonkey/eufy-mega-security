# S220 settings availability check

If a standalone S220 quality or sensitivity control is missing, this helper reads
only the gateway's existing camera state. It opens no camera connection and sends
no setting change. Keep the camera, account and gateway options as they are.

Use the saved-connection setup in [private diagnostics](PRIVATE_DIAGNOSTICS.md#1-open-the-capture-tool)
and download both helper scripts from the same release containing this command.
Run `list` first, then use that current S220 index in Home Assistant Terminal & SSH:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py s220-settings-check --target-index 1
```

Send only the printed summary or fixed failure. Names, serials, credentials and
current setting values are excluded. `qualityCurrentKnown=false` means EMS lacks
a usable current quality reading. A known reading with unavailable control leaves
its account, option or route admission unresolved. This does not identify which
of those gates failed or prove a physical setting. It does not enable a selector.
