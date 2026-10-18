# Experimental NVR live controls

These controls are off by default and hardware-unconfirmed. They are available only for an explicitly owned T8N00 NVR, type 300, with an exact T8E00/type301 or T8416/type104 child. Guest access, inherited child ownership, T8416121 and T9000 are excluded.

Enable `experimental_nvr_live`, `experimental_model_controls` and `experimental_nvr_controls`, and configure gateway API authentication. Enabling those flags also exposes the separate power and guard trials. Those trials retain their own consent and are never run by these normal controls. No physical control test runs automatically. Martin authorised implementation of #433, not unattended movement or security changes.

| Camera | Night vision | Streaming quality | Camera view | Movement |
| --- | --- | --- | --- | --- |
| T8E00/type301 | Standard, Infrared, Spotlight | Auto, Low, High | Fixed or Movable, default Movable | Single pan clicks and optical zoom 1x, 2x, 3x on Movable only |
| T8416/type104 | Off, Auto Infrared, Infrared on | Auto, Low, Full HD, High, Highest | Wide or Telephoto, default Wide | Single pan clicks on the shared head, no optical zoom control |

T8416 Telephoto is reporter-reported, not established by the portal source. Wide is the portal default. Highest is a gateway presentation label for the vendor quality rank, not the vendor's own label. Highest is a preference, not a promise of 4K on the telephoto source. The T8416 NVR night values differ from the separate HomeBase connection.

## Using the controls

Open and keep a live viewer attached before pressing a direction or optical zoom button. The gateway holds the existing source without waiting for a snapshot. Each button sends one click or absolute optical step. It never holds a direction, replays a request or silently retries.

Night vision and quality are persistent settings. Off, Standard or lower quality may reduce useful security footage. Record the original setting first and restore it after testing. With no viewer attached, changing a setting opens a normal source, captures and retains one image, and publishes it through the usual snapshot path. Source readiness has a 30-second snapshot cap. An action may fail if the source cannot become ready within that time.

Close live views, recordings and preloading before changing Camera view. The choice applies to the next source and resets on restart or binding change. Changing it clears observed settings until the next explicit live start or capability refresh. Direction and zoom buttons disappear from availability on the Fixed T8E00 view.

A setting needs 35 seconds of source lifetime remaining before the first write. The second quality write needs 25 seconds. Movement needs 10 seconds. The maximum source lifetime still applies, normally 120 seconds, and no control extends it. Use `max_stream_seconds` of 120 seconds or more. Below about 60 seconds, startup and discovery may leave too little time for a setting. Actions are exclusive per NVR and spaced at least one second apart. Explicit capability refresh has a ten-second cooldown. Refresh reads settings without starting video when the camera is idle.

## Interpreting results

`request_accepted` requires physical confirmation. It does not establish movement, lens position or optical magnification. Some vendor paths accept a pan acknowledgement alone, while this experimental path requires a matching data reply. A device that sends only an acknowledgement can move and still return `outcome_unknown`. Do not immediately repeat it. Check the camera in Eufy first.

A quality write targets both sources. The pairing of those live writes with the reported web-quality field is an unproven assumption. A disconnect or timeout between the two quality writes can leave the first source changed and the second unchanged. A partial write, missing confirmation, codec change or lost connection leaves the result unknown. A quality change can end the current view. There is no automatic rollback or retry. Check both sources and the setting in Eufy before trying again.

Observed night and quality values expire after 30 minutes and clear on a binding change, selected-view change, logout or restart. Query receipt time does not establish how recently the appliance refreshed its own cache. A refresh can restore availability only when an unambiguous baseline is returned.

The experimental NVR identity uses `ready_to_test`, so Home Assistant may also offer a compatibility-report button. Pressing that button opens a report workflow. It does not confirm support or run a physical test.

For a reporter retest, use one model at a time. Start with Wide or Movable video, try one direction, and check what actually happened. If it fails, send the single `nvr_live_control_failed` line. Test persistent settings only while watching the result in Eufy, then restore the original values. Physical behaviour remains unconfirmed until the reporter supplies that result.

The first control on a source reconfirms its child identity with a fresh echoed request segment. Devices that reply without echoing that segment cannot use controls, even if legacy video plays. This is a hardware-unconfirmed compatibility limit. PTZ data on the child channel or channel 255 is accepted, with the latter still unconfirmed on hardware. An accepted PTZ request may mean the camera has reached its movement limit.

T8E00 optical levels 1x to 3x deliberately restrict the vendor's 1x to 8x range to the reporter-tested subset. The T8416 profile deliberately withholds optical zoom despite another vendor path advertising it. The T8E00 Auto/Low/High choices follow the portal fallback UI, rather than an explicit resolution list in that model profile.

A fresh inventory that omits explicit ownership withdraws control admission and the104 normal stream until membership returns. Raw ownership is mandatory for these controls, 104 streaming and the manual guard/power writes. Legacy video and diagnostic playback admission are unchanged.
