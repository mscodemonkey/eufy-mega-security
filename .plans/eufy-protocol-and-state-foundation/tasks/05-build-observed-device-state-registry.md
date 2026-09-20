---
kind: plan-task
task: 5
title: Build an observed device state registry
status: ready
depends_on:
  - 4
areas:
  - gateway-provider
  - cloud-state
  - home-assistant
risk: hardware-sensitive
reviewers:
  - gateway
  - integration
---

# Task 5: Build an observed device state registry

> Merge bulk inventory, per-device cloud parameters, and realtime observations without allowing stale data to overwrite fresher state.

## Outcome

The gateway owns one in-memory state registry for each admitted device. It records values with source and observation time, applies explicit precedence and expiry rules, and publishes only meaningful changes. This addresses the shared state causes behind #79 and #85 while giving later controls and entities a reliable readback boundary.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current refresh model | Each cloud refresh rebuilds readings from the bulk device list | `eufy_event_gateway/src/provider/eufy-provider.ts:506` |
| Current cloud surface | The client exposes the bulk `/v2/house/device_list` request but not the per-device parameter-list request | `eufy_event_gateway/src/mega/client.ts:159` |
| Current parameter aliases | Camera enabled state accepts parameter 2001 before 1035, while battery uses 1101 | `eufy_event_gateway/src/provider/eufy-provider.ts:793` |
| Missing switch evidence | #79 has neither 1035 nor 2001 in bulk inventory and no observed change after app toggles | Issue #79 |
| Battery discrepancy | #85 reports the integration trailing the vendor app by seven to ten percentage points | Issue #85 |

## Files

```text
eufy_event_gateway/src/provider/device-state-registry.ts       (add: source-aware value registry, expiry, and change emission)
eufy_event_gateway/src/mega/client.ts                          (modify: add the per-device parameter-list request and owner-only fallback)
eufy_event_gateway/src/provider/eufy-provider.ts               (modify: feed bulk, per-device, push, and P2P observations into the registry)
eufy_event_gateway/src/domain/types.ts                         (modify: expose observed value metadata needed across the gateway boundary)
eufy_event_gateway/src/domain/gateway-state.ts                 (modify: publish deduplicated registry changes)
eufy_event_gateway/test/device-state-registry.test.ts          (add: precedence, expiry, deletion, and deduplication cases)
eufy_event_gateway/test/mega-client.test.ts                    (modify: per-device request and error 20004 fallback)
eufy_event_gateway/test/eufy-provider.test.ts                  (modify: provider integration for enabled and battery state)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Source precedence | A fresh per-device or realtime value conflicts with older bulk inventory | The fresher authoritative observation wins |
| 2 | Newer cloud correction | A later bulk row has a newer vendor update time than a cached overlay | The bulk value replaces the older overlay |
| 3 | Missing parameter | Bulk inventory omits 1035 and 2001 | The registry records unknown rather than defaulting camera state |
| 4 | Owner-only endpoint | The per-device endpoint returns error 20004 | Refresh continues with bulk inventory and a stable capability diagnostic |
| 5 | Battery evidence | Battery 1101 changes through cloud or realtime evidence | The exact observed percentage is published without calibration or interpolation |
| 6 | Restart boundary | The gateway process restarts | The in-memory registry is rebuilt from current observations and does not claim persisted freshness |
| 7 | Deduplication | Repeated sources report the same effective value | No redundant Home Assistant update is emitted |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Becomes the owner of observation precedence and freshness |
| Home Assistant | Consumes the unchanged effective-value contract without recreating source precedence |
| Cloud client | Adds a narrow per-device parameter request with a supported fallback |
| Diagnostics | Reports source, age, and availability without values that may identify a household |

## Implementation constraints

1. Error 20004 is a stable owner-only capability outcome, not a retry storm or authentication failure.
2. Missing data remains unknown. It must not be converted to false, zero, or an inferred percentage.
3. Parameter-specific freshness rules must be explicit and tested.
4. Registry state is process-owned and ephemeral. Disk persistence is outside this plan.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='state registry|device params|battery|enabled'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] Unknown, stale, and observed values remain distinguishable.
- [ ] Owner-only accounts continue operating without repeated failed requests.
- [ ] Review findings are resolved.
