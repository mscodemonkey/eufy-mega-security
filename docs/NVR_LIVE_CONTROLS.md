# Experimental NVR live controls

These controls are off by default and hardware-unconfirmed. They are available only for an explicitly owned T8N00 NVR, type 300, with an exact T8E00/type301 or T8416/type104 child. Guest access, inherited child ownership and T8416121 are excluded. The exact T8E00/type301 through HomeBase S1 T9000/type27 has a separate pan-only experimental profile. It uses the Movable source and offers single direction clicks, with no zoom, view selector, night-vision or quality controls. Physical movement on S1 remains unconfirmed. The same T8416 on its own Wi-Fi or behind a HomeBase keeps its existing route and controls. None of these NVR profiles, labels or markers apply to it.

Enable `experimental_nvr_live`, `experimental_model_controls` and `experimental_nvr_controls`, and configure gateway API authentication. Enabling those flags also exposes the separate power and guard trials. Those trials retain their own consent and are never run by these normal controls. No physical control test runs automatically. Martin authorised implementation of #433, not unattended movement or security changes.

| Camera | Night vision | Streaming quality | Camera view | Movement | AI tracking |
| --- | --- | --- | --- | --- | --- |
| T8E00/type301 | Standard, Infrared, Spotlight | Auto, Low, High | Fixed, Movable or Both, default Movable | Single pan clicks and optical zoom 1x, 2x, 3x on Movable and Both | No |
| T8416/type104 | Off, Auto Infrared, Infrared on | Auto, HD (720P), Full HD (1080P), 2K, Ultra 4K | None (wide source) | Single pan clicks and zoom 1x, 2x, 3x | Enable or disable |

T8416 offers no Camera view choice. A reporter described a Telephoto source, but on an owner-tested S350 the second NVR source showed the same wide picture, while zoom 2x and 3x narrowed it to the telephoto picture and 1x restored the wide one. T8416 quality names follow the eufy app's Streaming Quality. The T8416 NVR night values differ from the separate HomeBase connection.

T8E00 Both shows the Fixed and Movable lenses together, Fixed above Movable, as the eufy app's live view does. The NVR stacks them into one 1280×1440 picture, two 1280×720 panes, so it is still one source and one live view, with fewer pixels than a single 1920×1080 view. While Both is chosen, every card that shows the camera shows the stacked picture. Direction and zoom act on the Movable lens, the lower pane. With `experimental_fixed_h265_resolution` on, the H.264 compatibility conversion fits the stacked picture inside 1920×1080 with bars at the sides, as it does any other size. Both is not a separate Fixed camera entity.

T8416 AI tracking is a persistent setting like night vision. The gateway sends 6016 on the PTZ transport, accepts the receipt, and then requires the channel row to read back the requested value before reporting success. The Home Assistant enable and disable buttons appear once a live start or capability refresh has read the current value. On an owner-tested S350 the eufy app showed each change.

## Using the controls

Open and keep a live viewer attached before pressing a direction or optical zoom button. The gateway holds the existing source without waiting for a snapshot. Each button sends one click or absolute optical step. It never holds a direction, replays a request or silently retries.

Night vision and quality are persistent settings. Off, Standard or lower quality may reduce useful security footage. Record the original setting first and restore it after testing. With no viewer attached, changing a setting opens a normal source, captures and retains one image, and publishes it through the usual snapshot path. Source readiness has a 30-second snapshot cap. An action may fail if the source cannot become ready within that time.

Close live views, recordings and preloading before changing Camera view. The choice applies to the next source and resets on restart or binding change. Changing it clears observed settings until the next explicit live start or capability refresh. Direction and zoom buttons disappear from availability on the Fixed T8E00 view. Admitted cameras carry `nvrLiveControlsSupported`, which Home Assistant uses to route night and quality through the NVR whether or not a view choice exists.

A setting needs 35 seconds of source lifetime remaining before the first write. The second quality write needs 25 seconds. Movement needs 10 seconds.

Normal NVR live view keeps its source while the viewer owns it and usable video continues. Checked picture-bearing output renews a 45-second video-progress budget. Heartbeats, parameter sets and controls do not renew it. This tracks coded output rather than decoded or displayed pictures. A stalled source closes when that budget expires, and no setting is sent without its required remaining budget. Negotiation and the first usable frame retain their separate finite deadlines. Diagnostic and security-control trials retain their finite total lifetimes. The battery-camera and doorbell `max_stream_seconds` limits are unchanged.

Actions are exclusive per NVR and spaced at least one second apart. Explicit capability refresh has a ten-second cooldown. Refresh reads settings without starting video when the camera is idle.

## Interpreting results

`request_accepted` requires physical confirmation. It does not establish movement, lens position or optical magnification. Some vendor paths accept a pan acknowledgement alone. T8416 and T8E00 behind T8N00 send only that acknowledgement, with no data reply, so their pan settles on it. T8E00 through S1 still requires a matching data reply, and a device that sends only an acknowledgement there can move and still return `outcome_unknown`. A refused or missing acknowledgement returns `outcome_unknown`, and the camera may still have moved. Do not immediately repeat it. Check the camera in Eufy first.

A quality write targets both sources. The pairing of those live writes with the reported web-quality field is an unproven assumption. T8416 reports live quality instead in a channel-scoped row encoded twice as base64, whose current mode selects the value. On an owner-tested S350 its values followed the eufy app's Streaming Quality: 0 Auto, 1 HD (720P), 2 Full HD (1080P), 3 2K, 4 Ultra 4K. The separate recording-quality row is not read. A disconnect or timeout between the two quality writes can leave the first source changed and the second unchanged. A partial write, missing confirmation, codec change or lost connection leaves the result unknown. A quality change can end the current view. There is no automatic rollback or retry. Check both sources and the setting in Eufy before trying again.

Observed night and quality values expire after 30 minutes and clear on a binding change, selected-view change, logout or restart. Query receipt time does not establish how recently the appliance refreshed its own cache. A refresh can restore availability only when an unambiguous baseline is returned.

The experimental NVR identity uses `ready_to_test`, so Home Assistant may also offer a compatibility-report button. Pressing that button opens a report workflow. It does not confirm support or run a physical test.

For a reporter retest, use one model at a time. Start with Wide or Movable video, try one direction, and check what actually happened. If it fails, send the single `nvr_live_control_failed` line. Test persistent settings only while watching the result in Eufy, then restore the original values. Physical behaviour remains unconfirmed until the reporter supplies that result.

The first control on a source reconfirms its child identity with a fresh echoed request segment. Devices that reply without echoing that segment cannot use controls, even if legacy video plays. This is a hardware-unconfirmed compatibility limit. PTZ data on the child channel or channel 255 is accepted, with the latter still unconfirmed on hardware. An accepted PTZ request may mean the camera has reached its movement limit.

T8E00 optical levels 1x to 3x deliberately restrict the vendor's 1x to 8x range to the reporter-tested subset. T8416 uses the same 1x to 3x levels, which an owner test confirmed on one S350. The T8E00 Auto/Low/High choices follow the portal fallback UI, rather than an explicit resolution list in that model profile.

A fresh inventory that omits explicit ownership withdraws control admission until membership returns. Raw ownership is mandatory for these controls and the manual guard/power writes. T8416 live video itself needs only `experimental_nvr_live`: without control admission it plays the Wide view and offers no controls. Legacy video and diagnostic playback admission are unchanged.

## Changing camera on the NVR

The NVR serves one live call at a time. When a Home Assistant view opens another camera on the same T8N00, the gateway moves the call to the new camera instead of refusing it until the old view has closed. The old view ends, and the newest view wins, because the gateway cannot tell a closed view from one that is still being watched.

Only ordinary Home Assistant views give way. Snapshots, controls, clips, Home Assistant preload and recordings started on an idle stream, and any other consumer of the stream URL keep the call, and a new camera is refused until they finish. A recording added to a view that is already running shares that view and can be moved away. A view that lost the call is not able to take it back on its own retry. Opening that camera again does.

HomeBase routes are unchanged. Both the gateway and the integration need this release. With only one of them updated, cameras behave as before.
