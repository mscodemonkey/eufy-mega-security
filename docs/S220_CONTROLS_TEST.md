# Optional standalone S220 controls

These candidates apply only to SoloCam S220 T8134, device type 63, on its own direct Wi-Fi route. Physical sensitivity and live-quality behavior remain unconfirmed. Talkback, recorded-audio controls, other settings and guard controls are separate work.

Use the existing gateway account. If it is shared, do not change accounts for this test. Enable Experimental model controls only if the existing account owns the camera. Gateway API authentication must already be configured.

## Live quality

The camera's Home Assistant device page can show a Streaming quality selector when EMS has a known current value. Its Auto, Low, Medium and High names describe preference ranks, not a verified resolution or codec. The selector remains absent when the route or reported value is unavailable.

Close live views and leave recordings alone. Note the original quality in Eufy, choose one adjacent rank in Home Assistant, then check the setting in Eufy. Restore the original rank and check it there again. Do not change recorded-video quality.

EMS reads a fresh baseline, sends one change and requires fresh confirmation. It does not repeat an uncertain write. If the request fails or its result is unclear, check the actual setting in Eufy before doing anything else. Keep any error message free of names, serials, URLs and account details when sharing it.

Disable Experimental model controls after the check if it was enabled just for this test. A working selector or accepted request alone does not confirm the camera changed its preference.
