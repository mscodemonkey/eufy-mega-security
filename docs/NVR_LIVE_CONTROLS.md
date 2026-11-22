# Experimental NVR live controls

These controls are off by default. Hardware results are limited to what is listed under [Hardware results](#hardware-results), and every other pairing stays unconfirmed. They are available only for an explicitly owned T8N00 NVR, type 300, with an exact T8E00/type301 or T8416/type104 child. Guest access, inherited child ownership and T8416121 are excluded. The exact T8E00/type301 through HomeBase S1 T9000/type27 has a separate pan-only experimental profile. It uses the Movable source and offers single direction clicks, with no zoom, view selector, night-vision or quality controls. Physical movement on S1 remains unconfirmed. The same T8416 on its own Wi-Fi or behind a HomeBase keeps its existing route and controls. None of these NVR profiles, labels or markers apply to it.

Enable `experimental_nvr_live`, `experimental_model_controls` and `experimental_nvr_controls`, and configure gateway API authentication. Enabling those flags also exposes the separate power and guard trials. Those trials retain their own consent and are never run by these normal controls. No physical control test runs automatically. Martin authorised implementation of #433, not unattended movement or security changes.

| Camera | Night vision | Streaming quality | Camera view | Movement | AI tracking |
| --- | --- | --- | --- | --- | --- |
| T8E00/type301 | Standard, Infrared, Spotlight | Auto, Low, High | Fixed, Movable or Both, default Both | Single pan clicks and optical zoom 1x, 2x, 3x on Movable and Both | Not offered here; Eufy app only |
| T8416/type104 | Off, Auto Infrared, Infrared on | Auto, HD (720P), Full HD (1080P), 2K, Ultra 4K | None (wide source) | Single pan clicks and zoom 1x, 2x, 3x | Enable or disable |

T8416 offers no Camera view choice. A reporter described a Telephoto source, but on an owner-tested S350 the second NVR source showed the same wide picture, while zoom 2x and 3x narrowed it to the telephoto picture and 1x restored the wide one. T8416 quality names follow the eufy app's Streaming Quality. The T8416 NVR night values differ from the separate HomeBase connection.

T8E00 Both shows the Fixed and Movable lenses together, Fixed above Movable, as the eufy app's live view does. It is the default view where Camera view is offered. Live video without these controls keeps the Movable lens. The NVR stacks them into one 1280×1440 picture, two 1280×720 panes, so it is still one source and one live view, with fewer pixels than a single 1920×1080 view. While Both is chosen, every card that shows the camera shows the stacked picture. Direction and zoom act on the Movable lens, the lower pane. With `experimental_fixed_h265_resolution` on, the H.264 compatibility conversion fits the stacked picture inside 1920×1080 with bars at the sides, as it does any other size. With `experimental_low_cpu_h265_conversion` on, the conversion of this combined view halves the stacked picture to 640×720, so each lens is 640×360, at every second picture. Both remains the combined camera view. The optional lens entities below show each lens separately, natively or, with H.264 compatibility, through their own conversion, which neither option changes.

T8416 AI tracking is a persistent setting like night vision. The gateway sends 6016 on the PTZ transport, accepts the receipt, and then requires the channel row to read back the requested value before reporting success. The Home Assistant enable and disable buttons appear once a live start or capability refresh has read the current value. On an owner-tested S350 the eufy app showed each change.

T8E00 AI tracking has no control here, but the camera does have the feature in the eufy app. While it is on, the camera can move with no request, so a shift in the picture alone doesn't show that a pan worked.

## Using the controls

Open and keep a live viewer attached before pressing a direction or optical zoom button. The gateway holds the existing source without waiting for a snapshot. Each button sends one click or absolute optical step. It never holds a direction, replays a request or silently retries.

Night vision and quality are persistent settings. Off, Standard or lower quality may reduce useful security footage. Record the original setting first and restore it after testing. With no viewer attached, changing a setting opens a normal source, captures and retains one image, and publishes it through the usual snapshot path. Source readiness has a 30-second snapshot cap. An action may fail if the source cannot become ready within that time.

Close live views, recordings and preloading before changing Camera view. The choice applies to the next source and resets on restart or binding change. Changing it clears observed settings until the next explicit live start or capability refresh. Direction and zoom buttons disappear from availability on the Fixed T8E00 view. Admitted cameras carry `nvrLiveControlsSupported`, which Home Assistant uses to route night and quality through the NVR whether or not a view choice exists.

A setting needs 35 seconds of source lifetime remaining before the first write. The second quality write needs 25 seconds. Movement needs 10 seconds.

Normal NVR live view keeps its source while the viewer owns it and usable video continues. Checked picture-bearing output renews a 45-second video-progress budget. Heartbeats, parameter sets and controls do not renew it. This tracks coded output rather than decoded or displayed pictures. A stalled source closes when that budget expires, and no setting is sent without its required remaining budget. Negotiation and the first usable frame retain their separate finite deadlines. Diagnostic and security-control trials retain their finite total lifetimes. The battery-camera and doorbell `max_stream_seconds` limits are unchanged.

Actions are exclusive per NVR and spaced at least one second apart. Explicit capability refresh has a ten-second cooldown. Refresh reads settings without starting video when the camera is idle.

## Hardware results

Two T8416/type 104 cameras on firmware 1.5.6.4 behind one T8N00 were tested on 4 November 2026 with the changes released in v0.1.242. The owner watched one camera and saw all four pan directions. Video from the second camera shows its picture shifting after each of the four pan requests, and returning after the opposite one. Both cameras showed 2x and 3x zoom narrowing the picture and 1x restoring it. Streaming quality and AI tracking changed and read back on both, and the eufy app confirmed the quality values and an AI tracking change. Night vision has readback evidence only, from a daylight test.

One T8E00/type 301 on firmware 1.1.2.9 behind the same T8N00 was tested on 6 November 2026 on v0.1.241, in the Movable view with a live view held. The owner watched it move in all four directions, and picture measurements agree on each direction. Each press moved the camera one step, but all 14 presses returned `outcome_unknown` with `pan_data=0`: the camera sent the acknowledgement and no data reply.

These results show that the T8416 and T8E00 movement paths work on that setup. They do not qualify T8416 on Wi-Fi or a HomeBase, T8416121, T9000, T8E00 behind T9000 or other firmware. A single `request_accepted` still does not prove that a single movement happened.

## Interpreting results

`request_accepted` requires physical confirmation. It does not establish movement, lens position or optical magnification. Some vendor paths accept a pan acknowledgement alone. T8416 and T8E00 behind T8N00 send only that acknowledgement, with no data reply, so their pan settles on it. T8E00 through S1 still requires a matching data reply, and a device that sends only an acknowledgement there can move and still return `outcome_unknown`. A refused or missing acknowledgement returns `outcome_unknown`, and the camera may still have moved. Do not immediately repeat it. Check the camera in Eufy first.

A quality write targets both sources. The pairing of those live writes with the reported web-quality field is an unproven assumption. T8416 reports live quality instead in a channel-scoped row encoded twice as base64, whose current mode selects the value. On an owner-tested S350 its values followed the eufy app's Streaming Quality: 0 Auto, 1 HD (720P), 2 Full HD (1080P), 3 2K, 4 Ultra 4K. The separate recording-quality row is not read. A disconnect or timeout between the two quality writes can leave the first source changed and the second unchanged. A partial write, missing confirmation, codec change or lost connection leaves the result unknown. A quality change can end the current view. There is no automatic rollback or retry. Check both sources and the setting in Eufy before trying again.

Observed night and quality values expire after 30 minutes and clear on a binding change, selected-view change, logout or restart. Query receipt time does not establish how recently the appliance refreshed its own cache. A refresh can restore availability only when an unambiguous baseline is returned.

The experimental NVR identity uses `ready_to_test`, so Home Assistant may also offer a compatibility-report button. Pressing that button opens a report workflow. It does not confirm support or run a physical test.

For a reporter retest, use one model at a time. Start with Wide or Movable video, try one direction, and check what actually happened. If it fails, send the single `nvr_live_control_failed` line. Test persistent settings only while watching the result in Eufy, then restore the original values. Physical behaviour on any other model, firmware or route remains unconfirmed until the reporter supplies that result.

The first control on a source reconfirms its child identity with a fresh echoed request segment. Devices that reply without echoing that segment cannot use controls, even if legacy video plays. This is a hardware-unconfirmed compatibility limit. PTZ data on the child channel or channel 255 is accepted, with the latter still unconfirmed on hardware. An accepted PTZ request may mean the camera has reached its movement limit.

T8E00 optical levels 1x to 3x deliberately restrict the vendor's 1x to 8x range to the reporter-tested subset. T8416 uses the same 1x to 3x levels, which an owner test confirmed on two S350 cameras. The T8E00 Auto/Low/High choices follow the portal fallback UI, rather than an explicit resolution list in that model profile.

A fresh inventory that omits explicit ownership withdraws control admission until membership returns. Raw ownership is mandatory for these controls and the manual guard/power writes. T8416 live video itself needs only `experimental_nvr_live`: without control admission it plays the Wide view and offers no controls. Legacy video and diagnostic playback admission are unchanged.

## Changing camera on the NVR

The NVR serves one live call at a time. When a Home Assistant view opens another camera on the same T8N00, the gateway moves the call to the new camera instead of refusing it until the old view has closed. The old view ends, and the newest view wins, because the gateway cannot tell a closed view from one that is still being watched.

Only ordinary Home Assistant views give way. Snapshots, controls, clips, Home Assistant preload and recordings, and any other consumer of the stream URL keep the call, and a new camera is refused until they finish. A recording added to a view that is already running shares that view's connection, so the integration asks the gateway to hold that view before it adds the recorder. A held view keeps the call until its connection closes, including after the recording ends. From the moment the recording is asked for until the gateway confirms the hold, the integration opens new views without a mark, so the gateway refuses them instead of moving the call. If the hold is not confirmed, the recording goes ahead and new views stay unmarked until it has had time to finish. A view that lost the call is not able to take it back on its own retry. Opening that camera again does.

HomeBase routes are unchanged. Both the gateway and the integration need this release. With only one of them updated, cameras behave as before.

## HomeBase S1 camera switching candidate

For the already admitted T9000/type 27 camera pairings, a new marked HA view can
close the previous yielding call and open a fresh call for the next camera. This
uses the existing S1 close/start lifecycle, not the NVR S4 in-call switch. S1
hardware switching remains unconfirmed. The normal experimental NVR-live option
is still required, and the accepted camera/parent pairings are unchanged.

Recordings, held views, leases and unmarked consumers keep their connection. A
new recording hold cannot be acknowledged while the old source is stopping.
Previously delivered view URLs cannot take the call back after switching. This
is a single-call handoff, not simultaneous-view support.

## Separate lens entities

The exact T8E00/type301 behind an owned T8N00/type300 has two optional camera
entities, **Fixed lens** and **Movable lens**. They start disabled
in Home Assistant. Enable the existing experimental NVR live, model controls and
NVR controls options, select **Both** while the camera is idle, then enable the
two entities on that same HA device. They become unavailable outside Both view.
No setting changes or viewers start merely because the entities are discovered.

Each pane plays its own lens on its own NVR call. It is the same single-lens
start that Camera view uses for Fixed or Movable, 1920x1080 H.265 straight from
the NVR, with no decoding or encoding on the gateway. The NVR sends one live
picture per call: a second live start inside a call replaces the first within
milliseconds. So the two panes are two calls, and the first one opened takes over
the mode observer's listening call when there is one. Viewers of a pane share its
call and join from its current keyframe. A slow viewer closes on its own. When a
pane's last viewer has gone, its call is stopped after the gateway's normal idle
grace (`EUFY_GATEWAY_STREAM_GRACE_SECONDS`, 10 s by default), so Home
Assistant's URL renewals do not stop it and call again.

The T8N00 ends all of the gateway's calls to it when any one of them hangs up.
On one NVR, the other calls lost video within about 2 s and failed 25 to 30 s
later, whichever call hung up (a pane, the main camera's view or another
camera's view). A stop and a start inside one call did not do this. So while
another gateway call on that NVR is in use, a stopped call stays connected with
no camera, parked, and is logged as `nvr_call_parked`. The next pane or view on
that NVR takes a parked call over with an in-call start instead of placing a
call (`nvr_lens_call_idle_used`, `nvr_live_idle_call_used`). When the last call
in use on that NVR ends, it hangs up together with every parked call there
(`nvr_parked_calls_hung_up`). Closing one pane leaves the other playing.

A call placed while one of these hang-ups is still running would be ended by it.
So until every hang-up on that NVR has finished, no pane or view, and no
diagnostic call or state read, is admitted there. A new pane or view waits for
the hang-up for up to 6 s, the time a view already waits for a call that is
part-way through stopping, and is then refused before a call is placed
(`nvr_lens_call_refused` or `nvr_live_start_refused`, `reason=hang_up_pending`)
if one is still running.

A call that the NVR drops, or one that fails to start or to park, still ends
with a hang-up and takes the gateway's other calls on that NVR with it. Their
viewers close, and Home Assistant's retry places fresh calls.

### Call budget

With the mode observer connected, the T8N00 answered two more calls and left a
third unanswered (one NVR, twice). The gateway counts its own calls to each NVR
and keeps them to three: the two panes and one ordinary view, or the
[multi-view camera](#multi-view-camera) in place of one of them. Parked calls count
too, but a new pane or view takes a parked call first, so a parked call never
causes a refusal. The observer never adds a fourth, because the first pane or
view takes its call or closes it, and it stays off until every call, parked ones
included, has ended. While both panes are open:

- One ordinary view can still play, on the main S4 camera or on any other camera
  on that NVR. It is the third call. Ordinary views keep their one-call rule: a
  new view takes that call from a view that is only being watched, as before,
  and a view that is recording, held or still starting keeps it.
- The panes never give their calls to an ordinary view and never take one.
- Anything beyond three calls, for example the panes of a second S4 on the same
  NVR, is refused before a call is placed and logged as
  `nvr_lens_call_refused reason=call_budget`. Opening a pane that is already open
  in a second way is refused as `lens_reserved`.
- Diagnostic calls and state reads, the guard and power trials, and the
  settings refresh wait until the panes and any parked calls have closed
  (`call_reserved`). Each would place a call of its own that ends with a
  hang-up.
- Camera view cannot be changed while a pane is open, as for any open view.
- Direction, zoom and the night vision, quality and tracking settings go through
  the main camera's own view, so they need it open. The panes carry no controls.

The eufy app also takes calls on the NVR that the gateway cannot count. If it is
watching at the same time, the NVR may leave one of the gateway's calls
unanswered.

### H.264 compatibility

With the integration's H.264 compatibility option on, both panes use the shared
route instead. One Both call carries the recorder's 1280x1440 picture, and the
gateway decodes it once and encodes a top Fixed 1280x720 pane and a bottom
Movable 1280x720 pane as H.264. That costs two 720p encodes plus one decode
(about 1.5 of a Home Assistant Green's four cores with both panes open). An
unexpected input resolution is refused rather than shown under the wrong lens
label. A decoder that cannot keep up closes its views rather than retaining an
ever-growing input queue. On this route an active pane keeps the camera's call,
and other NVR cameras wait until the panes, recordings and any preload have
finished. An integration that predates native panes always uses this route, and
a new integration falls back to it when the gateway predates native panes.

### Both routes

These views are video-only, including when Live audio is enabled for the main
camera. Their retained images have separate caches, cropped from the camera's
retained Both image. Use Home Assistant's standard `camera.record` to record a
pane. The integration's `record_clip` action is refused on these entities
because that gateway action records the whole physical source. Fresh
`capture_snapshot` reads the selected pane after the normal explicit capture.
Retained dashboard images never start the camera and never substitute a
whole-camera or opposite-lens image.

Local tests cover the call budget and its refusals, one pane closing while the
other runs, release of the call on every exit, the observer handover and the
compatible fallback. If a pane closes unexpectedly, share only
`native_lens_view_closed`, `nvr_lens_call_failed` or `shared_lens_view_closed`,
keeping images and video private.

## Multi-view camera

Each owned T8N00/type300 has one optional **Multi-view** camera entity on the
NVR's own HA device. It starts disabled in Home Assistant, and needs the existing
experimental NVR live option and normal NVR live view, as the NVR's cameras do.
It is offered only when the NVR has at least two cameras it can stitch.

The NVR draws the multi-view itself: one live start with `stitch_mode` 3 (a 3x3
grid, eufy's `Std_3X3`), a list of channels, and a picture size of 3840x2160, so
each cell is 1280x720. The NVR sends that as one H.265 stream on one call,
which the gateway passes through unconverted, as it does a pane's lens. 3840x2160
is the largest 3x3 within H.265 level 5.1, the level browsers, phones and TV
boxes generally decode. On one T8N00 it ran at 20 fps in real time, about
0.76 Mbit/s, using 33 of the NVR's 240 units of encoder capacity.

The cells hold the NVR's cameras that play natively in Home Assistant, in
channel order, up to nine. Any further cameras are left out. An S4 shows the lens
chosen in its own **Multi-view lens** select, Fixed by default. That choice is
separate from Camera view, so the cell never changes when Camera view does. Like
Camera view, it changes only while the multi-view is closed, and it returns to
Fixed when the gateway restarts. The select starts disabled in Home Assistant. A
cell with no camera stays blank, and a camera that is switched off
shows the NVR's own "turned off" card. The T8214 (E340) doorbell is left out: it
plays on its own as both its lenses stacked, but in every grid and stack tried
it left its cell on "Please wait…", with either lens. The cells are fixed when
the call starts, so a camera added, removed or rebound ends the call, and Home
Assistant's retry opens it with the new set.

The multi-view's call is admitted, shared and closed as a pane's call is. It
counts as one call in the budget above. It never gives its call to a pane or
view and never takes one, apart from the mode observer's listening call or a
parked call. Viewers share the one call and join from its current keyframe. When
its last viewer has gone, the call is stopped after the idle grace, and parked if
another gateway call on that NVR is in use, so closing the multi-view leaves the
panes and views playing, and the other way round. A request past the budget is
refused before a call is placed (`nvr_multiview_call_refused reason=call_budget`):
with both panes and the multi-view open, a further ordinary view is refused.
The gateway's log lines are `nvr_multiview_call_completed`,
`nvr_multiview_call_failed`, `nvr_multiview_call_observer_used`,
`nvr_multiview_call_idle_used` and `native_multiview_view_closed`, each with the
number of cells and no camera names.

With the integration's H.264 compatibility option on, the multi-view camera is
unavailable. A 3840x2160 H.264 conversion is beyond the hardware the app
typically runs on, and the multi-view never falls back to a converted route.

The layouts were measured on one NVR S4 and its firmware only, so the multi-view
fails safe elsewhere. If an NVR answers the call but refuses or never
acknowledges the stitched start, the gateway logs
`nvr_multiview_unavailable reason=stitched_start_refused` once, with the NVR's
model and firmware, and withdraws that NVR's multi-view: the camera shows
unavailable and no further stitched call is placed until the gateway restarts or
the NVR's firmware changes. An unanswered or failed call is not a refusal; it
fails like any view, and Home Assistant retries.

**Recording.** The multi-view sends the NVR only the camera list request, the
start and the stop, as a pane does: no recording or camera setting is read or
written, and the NVR's own recording is independent of live calls. In the
gateway it never takes or yields a call, so a view recording a gateway clip
keeps its call, and the multi-view is refused instead when the budget is full.
Use Home Assistant's `camera.record` to record the multi-view; the integration's
`record_clip` and `capture_snapshot` actions are refused on it, because both
work on one camera's own source.

The gateway route is `/api/stations/<NVR>/live-multiview-native.annexb`, signed
like the native camera routes; `POST /api/stations/<NVR>/stream-token` with
`{"profile":"native"}` returns it. The station's `nvrMultiViewSupported` field
says whether the multi-view is offered.

The stitched start is general: the layout, the cells with their lenses, and the
size are parameters, so other layouts (a 2x2 grid, or two or three pictures
stacked) use the same path. Only the 3x3 multi-view camera uses it so far.

Who owns what: the gateway's provider owns the NVR call and its admission,
parking and hang-up; one gateway view per NVR owns the call's output and its
HTTP viewers, joining each at a keyframe and closing a slow viewer alone; Home
Assistant's stream worker owns its own HLS output for the entity. Each closes on
its own idle rule: HA stops its stream after its idle timeout, the gateway view
closes its call after the gateway's idle grace, and the provider parks or hangs
up the call as above.

Local tests cover the stitched start for several layouts, the cell rule and the
doorbell, the lens choice and its independence from Camera view, admission within
the budget beside both panes and a view, refusal past it with no call placed, a
recording view kept untouched, viewers sharing one call, parking and the hang-up
hold with the panes, the fail-safe on a refused stitched start, the compatibility
behaviour, and release of the call on every exit.

## Retry while an unused call is closing

A retried Home Assistant URL must not take a call away from another active
view. It can, however, wait for the previous camera's already-unused connection
to disconnect. The media owner can waive idle grace only while that source has
zero viewers, leases and recordings. Normal NVR and HomeBase S1
routes now share that bounded wait even when the URL's takeover window has
expired. The existing six-second handoff budget still applies.

This does not stop an active view or permit simultaneous calls. Recordings, leases, diagnostic calls and another station's
connection retain their reservations. A returning consumer cancels unused idle
cleanup, so the waiting retry is refused rather than taking that consumer's
call. Cancelling the request prevents a late replacement call.

Software regressions cover the immediate retry across both the idle grace and
delayed disconnect. Actual HomeBase S1 reopening latency still requires hardware
confirmation. The earlier confirmation that the active first view remains
playing is separate from this remaining after-close case.
