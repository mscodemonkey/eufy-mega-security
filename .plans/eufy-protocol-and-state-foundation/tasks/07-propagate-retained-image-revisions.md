---
kind: plan-task
task: 7
title: Propagate retained image revisions
status: ready
depends_on:
  - 3
areas:
  - gateway-media
  - home-assistant
risk: integration-sensitive
reviewers:
  - gateway
  - integration
---

# Task 7: Propagate retained image revisions

> Make each valid retained image revision visible to Home Assistant without creating a second image entity or forcing a stream restart.

## Outcome

Event thumbnails and completed live snapshots rotate the existing camera entity image token as soon as a new retained revision is available. The gateway keeps atomic media ownership, while Home Assistant responds to revision changes rather than inferring them from stream state. This completes #74 and keeps the invalid-image repair in #86 within the shared media pipeline.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Atomic storage | Snapshot writes already produce a monotonic revision after atomic replacement | `eufy_event_gateway/src/storage/snapshot-store.ts:68` |
| Gateway event | Snapshot changes already emit a `snapshot-updated` state event | `eufy_event_gateway/src/domain/gateway-state.ts:278` |
| Current integration gate | The camera image token rotates after stream state settles to idle or error | `custom_components/eufy_event_gateway/camera.py:90` |
| User-visible symptom | #74 reports that the retained event image is correct only after manual refresh | Issue #74 |
| Corruption boundary | #86 invalid bytes originate before retention and are repaired by Tasks 1 to 3 | Issue #86 and this plan's media boundary |

## Files

```text
eufy_event_gateway/src/domain/types.ts                         (modify: distinguish retained image revision and source)
eufy_event_gateway/src/storage/snapshot-store.ts               (modify: publish revision metadata for each atomic commit)
eufy_event_gateway/src/domain/gateway-state.ts                 (modify: include retained revision in state and SSE changes)
eufy_event_gateway/src/main.ts                                 (modify: connect event and live retention to one revision path)
eufy_event_gateway/test/snapshot-store.test.ts                 (modify: revision and atomicity cases)
eufy_event_gateway/test/gateway-state.test.ts                  (modify: state and SSE propagation)
custom_components/eufy_event_gateway/camera.py                 (modify: rotate the token on retained revision changes)
custom_components/eufy_event_gateway/coordinator.py            (modify: retain revision changes through coordinator updates)
tests/test_camera.py                                            (add: event and live image refresh cases)
tests/test_coordinator.py                                       (add: revision propagation)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Event image | A push event commits a new retained image while the camera is idle | The existing camera entity URL changes immediately |
| 2 | Live snapshot | A shared live source commits a completed snapshot | The token changes once after the atomic commit |
| 3 | Duplicate revision | Coordinator refresh repeats the same revision | The image URL remains stable |
| 4 | Failed write | Snapshot encoding or atomic replacement fails | No new revision or partial image is published |
| 5 | Stream independence | A retained event image arrives while a live stream is active | The image token changes without restarting the stream |
| 6 | Entity stability | Revisions change repeatedly | One camera entity remains registered and no companion image entity appears |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Publishes retained image source and revision after atomic commit |
| Home Assistant | Uses revision as the cache invalidation signal |
| Media pipeline | Remains responsible for byte validity before retention |
| Entity model | Keeps the existing camera entity as the single retained-image surface |

## Implementation constraints

1. Never publish a revision before the file is fully committed.
2. Revision values are opaque monotonic identifiers within one gateway process.
3. Token changes must not create coordinator loops or stream lifecycle side effects.
4. This task must not mask malformed media with image-library retries.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='snapshot store|snapshot updated|revision'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `python3 -m compileall custom_components/eufy_event_gateway` must pass.
4. `python3 -m unittest tests.test_camera tests.test_coordinator` must pass with Home Assistant boundaries stubbed at the client and coordinator interfaces.
5. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] Event and live revisions both invalidate the existing camera image URL.
- [ ] Failed media never advances the visible revision.
- [ ] Review findings are resolved.
