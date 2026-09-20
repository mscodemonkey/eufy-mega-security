---
kind: plan-task
task: 3
title: Unify the shared camera source lifecycle
status: ready
depends_on:
  - 1
  - 2
areas:
  - gateway-media
  - snapshots
  - recordings
risk: availability-sensitive
reviewers:
  - gateway
  - integration
---

# Task 3: Unify the shared camera source lifecycle

> Make live view, snapshot capture, startup warm-up, and recording consume one generation-safe source per camera.

## Outcome

One `SharedCameraSource` owns session generation, codec readiness, retained parameter sets and keyframe, retries, leases, linger, teardown, and replacement. Old callbacks cannot stop or satisfy a newer source. This addresses repeat-view, timeout, frame-jump, and lifecycle failures across #25, #42, #67, #73, and #78.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current ownership | `LiveStreamManager` owns viewers, recordings, FFmpeg, leases, and stop timing | `eufy_event_gateway/src/stream/live-stream-manager.ts:21` |
| Current replacement | Attaching a source destroys the prior stream and resets parameter sets without an explicit generation token | `eufy_event_gateway/src/stream/live-stream-manager.ts:282` |
| Current provider ownership | `EufyProvider` separately owns and replaces `FirstPartyPpcsSession` instances | `eufy_event_gateway/src/provider/eufy-provider.ts:146` |
| Fresh snapshot condition | Capture waits for a snapshot revision greater than the prior revision | `eufy_event_gateway/src/stream/live-stream-manager.ts:418` |

## Files

```text
eufy_event_gateway/src/stream/shared-camera-source.ts       (add: generation, readiness, leases, retry, linger, and teardown)
eufy_event_gateway/src/stream/live-stream-manager.ts        (modify: delegate source lifecycle and retain consumer orchestration)
eufy_event_gateway/src/provider/provider.ts                 (modify: return an owned source handle rather than side-channel start events)
eufy_event_gateway/src/provider/eufy-provider.ts            (modify: create and close provider source handles)
eufy_event_gateway/src/provider/simulated-provider.ts       (modify: implement the same source contract)
eufy_event_gateway/src/main.ts                              (modify: compose source events through one owner)
eufy_event_gateway/test/shared-camera-source.test.ts         (add: generation and lifecycle matrix)
eufy_event_gateway/test/live-stream-manager.test.ts          (modify: viewer, snapshot, and recording integration)
eufy_event_gateway/test/live-view-restart.test.ts            (modify: repeated-view regression)
eufy_event_gateway/test/startup-snapshot-warmup.test.ts      (modify: one bounded warm-up per process)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | First consumer | An idle camera receives a viewer or lease | Exactly one provider source opens |
| 2 | Joining consumer | A ready source has retained codec headers and a keyframe | The new consumer is primed without opening another source |
| 3 | Repeated view | The last viewer leaves and another joins during linger | The live generation is reused only after receiving fresh post-watch media |
| 4 | Replacement | Generation N ends after generation N+1 is attached | Generation N's callbacks cannot close or mutate N+1 |
| 5 | Snapshot timeout | No new complete keyframe reaches the extractor before 30 seconds | The lease fails cleanly and the shared source remains correct for other consumers |
| 6 | Recording cancellation | A recording ends, errors, or is cancelled | Its lease and timers are released without stopping active viewers |
| 7 | Stale-frame protection | Sequence restart or delayed prior-generation bytes arrive | They cannot be emitted into the current generation |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Provider contract | Source ownership becomes explicit through a handle |
| HTTP media | Existing endpoints and content types remain unchanged |
| Home Assistant | Existing live, snapshot, and recording actions remain compatible |
| Operations | Close summaries gain generation and readiness outcomes, not identifiers or payloads |

## Implementation constraints

1. A generation owns all timers, decoder state, assembler state, and provider callbacks created for it.
2. Retained parameter sets and keyframes may prime a joining consumer only within the same live generation.
3. Camera power budgets and maximum stream duration remain enforced.
4. Startup warm-up remains one attempt per camera per gateway process.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='shared camera source|live view|snapshot|recording|warmup'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] No stale generation can satisfy readiness or stop a replacement source.
- [ ] Existing HTTP and Home Assistant contracts remain compatible.
- [ ] Review findings are resolved.
