---
kind: plan-task
task: 1
title: Reassemble complete PPCS media access units
status: ready
depends_on: []
areas:
  - gateway-media
risk: regression-sensitive
reviewers:
  - gateway
  - release
---

# Task 1: Reassemble complete PPCS media access units

> Restore complete T8210 media output by decoding every transport chunk and emitting only complete video access units.

## Outcome

The PPCS media path recognises 64,000-byte continuation chunks, joins chunks with the same sequence and timestamp, and never passes a truncated access unit to the normaliser, FFmpeg, snapshots, recordings, or viewers. This repairs the v0.1.58 regression class behind #84 and #86 without changing session negotiation or device admission.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current legacy acceptance | Each encrypted frame is accepted only when its decoded body starts with Annex B | `eufy_event_gateway/src/stream/first-party-ppcs.ts:161` |
| Current output boundary | Each accepted command 1300 frame is normalised and written independently | `eufy_event_gateway/src/stream/first-party-ppcs.ts:798` |
| Regression evidence | T8210 reports a 64,151-byte frame shape and corrupted or invalid output after v0.1.58 | Issues #84 and #86 |
| Safety rule | Incomplete units are dropped and counted, never emitted | Approved architecture decision |

## Files

```text
eufy_event_gateway/src/stream/ppcs-access-unit-assembler.ts    (add: parse chunk identity and assemble complete units)
eufy_event_gateway/src/stream/first-party-ppcs.ts              (modify: decode chunks before assembly and normalisation)
eufy_event_gateway/test/ppcs-access-unit-assembler.test.ts      (add: synthetic single, split, dropped, and interleaved units)
eufy_event_gateway/test/first-party-ppcs.test.ts                (modify: integration coverage and safe counters)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Single-chunk unit | A decoded frame shorter than 64,000 bytes starts with Annex B | One unchanged access unit is emitted |
| 2 | Split unit | A full 64,000-byte chunk is followed by a shorter chunk with the same sequence and timestamp | No output after the first chunk, then one concatenated unit |
| 3 | Continuation without start code | The second decoded chunk begins mid-NAL | It is appended instead of rejected |
| 4 | Lost continuation | An open full chunk is followed by a different unit | The incomplete unit is dropped and the new complete unit is emitted |
| 5 | Protection independence | Clear, RSA-wrapped, and authenticated chunks use the same assembler contract | Assembly results are identical after successful decoding |
| 6 | Privacy-safe diagnostics | A unit is dropped | Counters report sizes and counts without media bytes, keys, serials, or peer details |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Emits complete access units instead of transport chunks |
| Home Assistant | No contract change, valid stream and JPEG bytes replace truncated output |
| Operations and release | Add split-unit and dropped-unit counters to the existing close summary |
| Documentation | Record the access-unit boundary in `docs/MEGA_PLATFORM.md` |

## Implementation constraints

1. Decode every chunk independently because each encrypted continuation carries its own wrapper.
2. Do not use Annex B presence alone to decide whether decryption succeeded.
3. Bound retained chunk bytes and discard on identity change, parser reset, session close, or decoder failure.
4. Synthetic fixtures must contain no captured camera imagery or identifying payloads.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='access unit|video frame'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] The pre-v0.1.58 T8210 split-frame shape has a deterministic regression fixture.
- [ ] Diagnostics remain structural and privacy-safe.
- [ ] Review findings are resolved.
