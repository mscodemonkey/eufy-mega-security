---
kind: plan-task
task: 2
title: Make media protection topology-neutral
status: ready
depends_on:
  - 1
areas:
  - gateway-media
  - mega-client
risk: security-sensitive
reviewers:
  - gateway
  - security
---

# Task 2: Make media protection topology-neutral

> Give direct and attached cameras an explicit, authenticated path to the media key required by their wire format.

## Outcome

Direct ECC media can resolve its camera cipher key before decoding, while HomeBase-attached media continues to derive its level-two session key from the gateway exchange. Clear and legacy RSA media remain compatible. This addresses the shared encrypted-frame failure in #69, #67, and #78.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Current key plumbing | The provider supplies `resolveCipherKey` only for HomeBase-attached routes | `eufy_event_gateway/src/provider/eufy-provider.ts:146` |
| Current key installation | The decoder receives an ECC private key only from the attached gateway-info exchange | `eufy_event_gateway/src/stream/first-party-ppcs.ts:855` |
| Authentication boundary | AES-GCM output is emitted only after tag verification | `eufy_event_gateway/src/stream/first-party-ppcs.ts:174` |
| Direct hardware evidence | T8423 and T8417 receive sign-code 1 media but report `encrypted-frame-rejected` | Issues #69 and #67 |

## Files

```text
eufy_event_gateway/src/stream/ppcs-video-decoder.ts       (add: own clear, RSA, ECC, media-key, and authentication state)
eufy_event_gateway/src/stream/first-party-ppcs.ts         (modify: delegate media protection and accept a pre-resolved direct key)
eufy_event_gateway/src/provider/eufy-provider.ts          (modify: cache and supply cipher keys independently of topology)
eufy_event_gateway/src/mega/client.ts                     (modify only if a bounded cipher lookup helper is needed)
eufy_event_gateway/test/first-party-ppcs.test.ts           (modify: direct and attached integration cases)
eufy_event_gateway/test/ppcs-video-decoder.test.ts         (add: synthetic authenticated and legacy vectors)
eufy_event_gateway/test/eufy-provider.test.ts              (modify: topology-neutral resolver wiring)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Direct authenticated keyframe | A direct camera has a valid inventory cipher ID and matching ECC key | ECIES unwrap and AES-GCM authentication produce one decoded chunk |
| 2 | Direct authenticated delta | A valid keyframe established a media key | Later authenticated frames reuse that key and authenticate |
| 3 | Invalid authentication | The tag, IV, or envelope is altered | No bytes are emitted and the rejection counter advances |
| 4 | Attached level two | Gateway-info supplies a cipher ID and negotiated session key | Control negotiation and attached media continue unchanged |
| 5 | Legacy compatibility | A valid RSA-wrapped frame arrives | It is decoded and handed to the access-unit assembler even when it is a continuation |
| 6 | Missing direct key | A direct camera reports protected media without a resolvable cipher ID or key | The session fails safely with a bounded structural diagnostic |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Protection selection and key lifetime move out of the monolithic session |
| Mega API | Cipher lookup remains cached and bounded, with no key material logged |
| Home Assistant | No API or entity change |
| Documentation | Document direct versus attached key acquisition without exposing secrets |

## Implementation constraints

1. The direct media key identity comes from the camera record. The attached control key identity continues to come from gateway-info.
2. Never downgrade an authentication failure into clear output.
3. Never log cipher IDs together with device identity, key bytes, IVs, tags, or media payloads.
4. Zeroise or release per-stream media-key buffers on close and generation replacement.

## Verification

1. `npm --prefix eufy_event_gateway test -- --test-name-pattern='authenticated|ECC|RSA|cipher'` must pass.
2. `npm --prefix eufy_event_gateway run typecheck` must exit 0.
3. `npm --prefix eufy_event_gateway run check` must pass.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Relevant typecheck, lint, build, and test gates pass.
- [ ] Authentication failure cannot emit media.
- [ ] Clear and legacy RSA fixtures remain green.
- [ ] Hardware confirmation remains outstanding until reporters validate affected direct cameras.
