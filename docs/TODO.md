# Eufy Mega Security to-do list

This is the implementation backlog for work that is separate from waiting for
another issue reporter. Hardware-dependent entries stay open until the
provider path and a real-device result both exist.

## Ready to investigate

- [x] Identify the PTZ camera intended for preset-position, auto-cruise, and
  AI-tracking work. Front of House is T817L. The Eufy Android app exposes
  these controls on that device even though the reference SDK registry does
  not yet list the model.
- [ ] Add preset-position support for T817L, after cross-referencing the
  app's action names with the SDK command builders.
- [ ] Add auto-cruise control for T817L, with a confirmed command
  acknowledgement and readback path.
- [ ] Add AI-tracking control for T817L, keeping it separate from motion
  detection and privacy mode.
- [ ] Investigate privacy-mode control for Indoor Cam S350 T8416. Track the
  physical camera state separately from the Home Assistant entity state.
- [ ] Investigate the shared media parser failures now reported for T8400,
  T8410, and T8425. Compare encrypted-frame handling, codec bootstrap, and
  rapid successive stream requests before changing any one model in isolation.
- [ ] Investigate the HomeBase 2 T8210 media path from issues #84 and #86.
  Keep stream corruption, fresh snapshot failure, and access-token errors as
  separate observations until the gateway summaries identify the common stage.

## Implemented and awaiting wider coverage

- [x] Add the camera motion-detection toggle. Doorbell, Garden, and Pool were
  switched off and on through the end-to-end path during local testing. The
  capability remains exposed only when the camera reports the required value
  and route.
- [ ] Add a repeatable harness assertion for motion detection on Doorbell,
  Front of House, and the T8113-Z cameras.
- [ ] Add the current device compatibility catalogue to generated support
  documentation and validate that every admitted device has a catalogue row.

## Waiting for reporter or hardware evidence

- [ ] T8224 press entity and event confirmation from issue #83. Admission and
  event handling are implemented, but the reporter has not confirmed the
  Home Assistant result yet.
- [ ] T8423 and T8124 remaining media results in issue #69.
- [ ] T8171 SoloCam E30 discovery, snapshots, events, and live video in issue
  #73.
- [ ] T814X C37 confirmation in issue #64.
- [ ] T9000 camera media lookup and HomeBase 2 capability gaps in issues #27
  and #25.
- [ ] T81A0 fresh snapshots and clip recording in issue #42.
- [ ] T8134 battery and event-picture behaviour in issue #74.
- [ ] T85D0 lock support. This remains intentionally behind the current camera
  support work, as explained to the T85D0 reporters.

## Evidence rules

Every completed hardware item should record the topology, capability, date,
app version, integration version, Home Assistant Core version when available,
and the developer or GitHub reporter who supplied the result. Raw payloads,
serials, credentials, screenshots, and video evidence remain outside Git.
