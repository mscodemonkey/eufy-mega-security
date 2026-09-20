---
kind: plan-task
task: 8
title: Run the cross-topology release gate
status: draft
depends_on:
  - 3
  - 4
  - 5
  - 6
  - 7
  - 9
areas:
  - release
  - support
  - operations
risk: release-critical
reviewers:
  - gateway
  - integration
  - release
---

# Task 8: Run the cross-topology release gate

> Prove the shared architecture across device topologies, publish one coherent release, and remove the development app only after the live product is verified.

## Outcome

The combined change passes automated, hosted, and available hardware checks as one release candidate. Each issue receives a claim limited to the evidence actually obtained. The production release is verified independently from its tag and archive, then the development app is stopped and deleted while production health remains green.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Release gates | The gateway package exposes `check`, `build`, and `release:check` scripts | `eufy_event_gateway/package.json` |
| Proof boundaries | Admission, route readiness, first frame, playback, events, and hardware success are separate claims | Established support and release policy |
| C37 status | #64 has shipped code but still needs reporter confirmation | Issue #64 |
| Repeat view status | #25 needs confirmation against the current architecture rather than its older release | Issue #25 |
| Cleanup order | The development app is removed only after the live product release and health checks complete | Approved operational requirement |

## Files

```text
eufy_event_gateway/package.json                         (verify: release scripts remain authoritative)
custom_components/eufy_event_gateway/manifest.json     (modify during release: synchronise the selected version)
eufy_event_gateway/package-lock.json                    (modify during release: synchronise the selected version)
README.md                                               (modify: supported capability and evidence matrix)
docs/MEGA_PLATFORM.md                                   (modify: media, routing, state, and control boundaries)
CHANGELOG.md                                            (modify: integration release record)
eufy_event_gateway/CHANGELOG.md                         (modify: gateway release record)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_matrix.py (verify: split gateway, adapter, and bridge evidence before release)
```

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Direct protection matrix | Clear, RSA-wrapped, and authenticated direct fixtures are replayed | Each reaches the same decoded access-unit contract |
| 2 | Attached topology matrix | HomeBase 2 and HomeBase 3 fixtures exercise child routing | Station, channel, protection, and stream ownership stay explicit |
| 3 | Codec matrix | H.264 and H.265 sources start, stop, and restart | First and repeat viewing produce valid output without stale generations |
| 4 | Retained media | Event image, live snapshot, and clip paths consume shared media | Bytes are valid and each consumer receives the correct revision or final file |
| 5 | Cancellation | The final consumer leaves during startup and active playback | The generation closes once with no leaked process, timer, or PPCS session |
| 6 | Controls | Enablement and supported sirens run through direct and attached routes | Send, readback, duration, and explicit stop behaviour match the capability contract |
| 7 | Public claims | An issue lacks reporter hardware confirmation | It remains open or is described as awaiting confirmation |
| 8 | Split harness evidence | Gateway, adapter, and end-to-end harnesses run for the release candidate | A failure is attributed to the correct boundary |
| 9 | Deployment cleanup | The live product release, archive, and health checks are verified | The development app is stopped and deleted, then production health is checked again |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | One release contains the compatible media, route, state, and control contracts |
| Home Assistant | Version, manifest, entities, services, and translations ship together |
| GitHub | Tag, release record, hosted checks, and downloadable archive are verified separately |
| Runtime | Development is removed only after production is demonstrably live and healthy |
| Support | Follow-ups request only the remaining evidence and use no exact release number |

## Implementation constraints

1. Freeze releases that alter media or routing until Tasks 1 to 3 pass their regression suites together.
2. Run `npm --prefix eufy_event_gateway run release:check` before selecting or publishing a version.
3. Confirm tag, GitHub release, downloadable archive, and live runtime health independently.
4. Do not close hardware issues from synthetic, inventory, or route evidence alone.
5. Stop and delete the development app only after the live product release has completed and passed health checks.
6. Read the exact runtime target before cleanup, preserve production data and credentials, and verify production health after removal.

## Verification

1. `npm --prefix eufy_event_gateway run check` must pass.
2. `npm --prefix eufy_event_gateway run build` must pass.
3. `npm --prefix eufy_event_gateway run release:check` must pass.
4. `python3 -m compileall custom_components/eufy_event_gateway` must pass.
5. `git diff --check` must pass.
6. Hosted gateway, integration, hassfest, CodeQL, and language checks must pass.
7. Available hardware evidence must cover direct, attached, first-view, repeat-view, snapshot, clip, cancellation, and implemented controls.
8. The split streaming harness must produce separate gateway, Home Assistant adapter, and optional end-to-end results.
9. Production `/health`, inventory, push, and PPCS checks must be recorded after deployment and again after development-app removal.

## Done checklist

- [ ] Every listed behaviour is covered and green.
- [ ] Local and hosted release gates pass on the release commit.
- [ ] Package, lockfile, manifest, and both changelogs carry one selected version.
- [ ] Tag, release, archive, and live production health are independently verified.
- [ ] Issue updates separate code availability from reporter-confirmed hardware success.
- [ ] The development app has been stopped and deleted after live release verification.
- [ ] Production remains healthy after development-app removal.
- [ ] Review findings are resolved.
