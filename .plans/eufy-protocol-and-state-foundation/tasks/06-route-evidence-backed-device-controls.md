---
kind: plan-task
task: 6
title: Route evidence-backed device controls
status: ready
depends_on:
  - 4
  - 5
areas:
  - gateway-controls
  - home-assistant
  - device-capabilities
risk: hardware-sensitive
reviewers:
  - gateway
  - integration
---

# Task 6: Route evidence-backed device controls

> Put camera enablement, privacy, siren, and battery entities behind one route-aware capability boundary with verified readback.

## Outcome

Controls are exposed only when the resolved device role, route, command family, and observed state support them. Camera enablement uses the correct alias and polarity, sirens use explicit device-side durations and stop commands, and ambiguous privacy or battery behaviour remains unavailable until evidence settles it. This joins the control concerns in #30, #61, #75, and #79 without granting unrelated controls to a whole model family.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current switch gate | The camera switch requires a current reading and a ready command route | `eufy_event_gateway/src/provider/eufy-provider.ts:527` |
| Current aliases | Enablement reads 2001 before 1035 | `eufy_event_gateway/src/provider/eufy-provider.ts:793` |
| Siren protocol | Station duration uses command 1201 and attached-camera duration uses command 1202, with duration zero as explicit stop | Issue #61 protocol evidence |
| Privacy boundary | #75 accepts no switch until a trustworthy state and polarity can be read back | Issue #75 |
| Sensor boundary | #30 still requires evidence for T8900, T8910, and the T85V0 backup battery representation | Issue #30 |

## Files

```text
eufy_event_gateway/src/provider/control-router.ts                 (add: select command target and require matching readback evidence)
eufy_event_gateway/src/provider/capabilities/camera-control.ts    (add: enablement aliases, polarity, and privacy evidence)
eufy_event_gateway/src/provider/capabilities/siren-control.ts     (add: station and attached duration commands)
eufy_event_gateway/src/provider/capabilities/battery-capability.ts (add: explicit primary and backup battery evidence)
eufy_event_gateway/src/provider/provider.ts                       (modify: typed control and capability contracts)
eufy_event_gateway/src/provider/eufy-provider.ts                  (modify: delegate controls to the router)
eufy_event_gateway/src/stream/first-party-ppcs.ts                 (modify: execute route-selected direct commands)
eufy_event_gateway/src/stream/homebase-ppcs.ts                    (modify: execute station and attached commands)
eufy_event_gateway/src/domain/types.ts                            (modify: publish control capabilities and observed state)
eufy_event_gateway/src/server.ts                                  (modify: validate and expose supported control operations)
eufy_event_gateway/test/control-router.test.ts                    (add: route, polarity, readback, duration, and stop cases)
eufy_event_gateway/test/device-capabilities.test.ts               (modify: sensor and battery capability cases)
custom_components/eufy_event_gateway/client.py                    (modify: typed control calls)
custom_components/eufy_event_gateway/switch.py                    (modify: render only readback-backed switches)
custom_components/eufy_event_gateway/siren.py                     (add: native siren entity for proven devices)
custom_components/eufy_event_gateway/services.yaml                (modify: describe duration and explicit stop behaviour)
custom_components/eufy_event_gateway/strings.json                 (modify: user-facing entity and service text)
custom_components/eufy_event_gateway/translations/en.json         (modify: translated entity and service text)
tests/test_switch.py                                               (add: enablement and privacy gating)
tests/test_siren.py                                                (add: duration and stop behaviour)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Camera enablement | A supported route has observed 1035 or 2001 state | The switch uses the matching command alias and confirms changed readback |
| 2 | Missing readback | Neither enablement alias is observed | No switch is exposed and no optimistic state is invented |
| 3 | Privacy ambiguity | A model has a suspected privacy command but no stable readable state | No privacy switch is exposed |
| 4 | Station siren | A proven HomeBase receives a bounded duration | Command 1201 carries the requested device-side duration |
| 5 | Attached siren | A proven child camera receives a bounded duration | Command 1202 targets the owning station and child channel |
| 6 | Explicit stop | An active siren is turned off | The same routed command is sent with duration zero |
| 7 | Backup battery | A T85V0 reports distinct primary and backup evidence | Two stable battery identities are exposed without duplicating one value |
| 8 | Unproven family | A related device lacks protocol evidence | The capability remains absent even when its model prefix resembles a supported device |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Owns command selection, route targeting, and readback requirements |
| Home Assistant | Adds native siren support and removes optimistic control states |
| Device catalogue | Grants narrow capabilities from evidence, not family resemblance |
| Support | Can distinguish unsupported, unavailable, sent, and confirmed control states |

## Implementation constraints

1. A successful send is not a confirmed state change. Readback must determine entity state.
2. Privacy mode stays hidden until repeated state transitions establish parameter identity and polarity.
3. Siren duration is enforced by the device. Host timers may provide UI convenience but cannot replace explicit stop.
4. New TypeScript and Python files must carry file-level documentation, and every public boundary must meet the repository documentation rules.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='control router|camera enable|privacy|siren|battery'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `python3 -m compileall custom_components/eufy_event_gateway` must pass.
4. `python3 -m unittest tests.test_switch tests.test_siren` must pass with Home Assistant boundaries stubbed at the client and coordinator interfaces.
5. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] Privacy remains unavailable until its evidence gate is satisfied.
- [ ] Every exposed control has explicit route, command, and readback evidence.
- [ ] Review findings are resolved.
