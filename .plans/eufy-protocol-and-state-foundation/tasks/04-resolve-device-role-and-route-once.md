---
kind: plan-task
task: 4
title: Resolve device role and route once
status: ready
depends_on:
  - 2
areas:
  - gateway-provider
  - device-catalogue
  - ppcs-routing
risk: hardware-sensitive
reviewers:
  - gateway
  - integration
---

# Task 4: Resolve device role and route once

> Replace scattered admission and topology inference with one evidence-backed device role and route decision.

## Outcome

Every inventory row resolves to a canonical role, transport family, owning station, topology, channel, peer readiness, and capability evidence. Admission, media, controls, diagnostics, and Home Assistant consume that result. This covers the shared routing causes in #27, #41, #83, and the classification portions of #67, #73, and #78.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current route rule | Parentless or self-parented rows are direct, all other rows use the named parent | `eufy_event_gateway/src/provider/eufy-provider.ts:1060` |
| Current admission | Camera support is a numeric set in the capability catalogue | `eufy_event_gateway/src/provider/camera-capability-core.ts:11` |
| T9000 boundary | Type 27 is excluded as non-camera but is not a discovered station | `eufy_event_gateway/src/provider/camera-capability-core.ts:25` and `eufy_event_gateway/src/provider/eufy-provider.ts:936` |
| Conflicting identity | #83 reports model T8224 as C30 with type 96, while the numeric family evidence identifies type 96 as the adjacent C31 family | Issue #83 |
| Non-camera boundary | T85D0 type 202 remains outside the camera/media route | `eufy_event_gateway/src/provider/camera-capability-core.ts:25` |

## Files

```text
eufy_event_gateway/src/provider/device-catalogue.ts          (add: model and numeric role evidence without protocol behaviour)
eufy_event_gateway/src/provider/device-routing.ts            (add: canonical resolved route contract)
eufy_event_gateway/src/provider/camera-capability-core.ts    (modify: consume resolved roles)
eufy_event_gateway/src/provider/device-capabilities-core.ts  (modify: consume one decision instead of reclassifying)
eufy_event_gateway/src/provider/eufy-provider.ts             (modify: use resolved routes for media, controls, and diagnostics)
eufy_event_gateway/src/stream/first-party-ppcs.ts            (modify: accept an explicit lookup and media profile)
eufy_event_gateway/test/device-classification.test.ts         (modify: T9000, T8200, T8224, T85D0, and T85V0)
eufy_event_gateway/test/device-routing.test.ts                (add: direct, attached, missing parent, and station profiles)
eufy_event_gateway/test/eufy-provider.test.ts                 (modify: provider integration)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | T9000 station | Type 27 or model prefix T9000 owns attached cameras | Role is station, controls remain unverified, child routing targets the station |
| 2 | Standalone T8200 | A mains doorbell owns its peer record | Role is doorbell camera with no battery capability and a doorbell-specific media profile |
| 3 | T8224 discrepancy | Model T8224 arrives with type 96 and a direct credential shape | It is not named from the numeric type, and admission requires a complete direct route fixture |
| 4 | T85 family split | Type 202 and type 203 arrive | Type 202 is non-camera, type 203 is a video doorbell camera |
| 5 | Missing parent | A child names a station absent from inventory | Route remains unavailable and is never guessed as direct |
| 6 | Diagnostics | Any route fails | The summary names role, topology, and failed prerequisite without serials, credentials, or endpoints |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | One route decision feeds admission, media, controls, and diagnostics |
| Home Assistant | Entities remain evidence-gated and do not appear merely from a model prefix |
| Support | Model and type contradictions become explicit diagnostic facts |
| Documentation | Update device baselines and capability matrix only after hardware evidence |

## Implementation constraints

1. A model name may refine a role but must not silently overwrite the reported numeric type.
2. Station classification does not grant station controls.
3. Route readiness does not claim first-frame, playback, event, or hardware success.
4. T8224 commercial naming remains the inventory value until the reporter evidence is reconciled.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='classification|routing|T9000|T8200|T8224|T85'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] Admission, route, and hardware-success claims remain separate.
- [ ] Device catalogue entries record evidence instead of inheriting unrelated family behaviour.
- [ ] Review findings are resolved.
