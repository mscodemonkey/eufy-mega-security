---
kind: plan-task
task: 9
title: Build the split streaming test harness
status: ready
depends_on:
  - 1
  - 2
  - 3
  - 4
areas:
  - test-harness
  - gateway-media
  - home-assistant
  - operations
risk: privacy-sensitive
reviewers:
  - gateway
  - integration
  - release
---

# Task 9: Build the split streaming test harness

> Test known-camera streaming at the gateway boundary and Home Assistant behaviour at a separate adapter boundary, with one optional end-to-end bridge for release evidence.

## Outcome

The Eufy gateway can be tested against named, known cameras without Home Assistant being involved. The Home Assistant integration can be tested against a deterministic fake gateway contract without a camera, cloud account, or PPCS session. A separate bridge may run both against a deployed product and report only bounded outcomes. This prevents a Home Assistant entity problem from being mistaken for a decoder failure, and prevents a live camera success from masking an integration regression.

## Resolved facts

| Fact | Value | Source |
|---|---|---|
| Existing live smoke path | `stream_smoke.py` discovers the gateway URL and token from Home Assistant's private config entry, then streams through the deployed integration | `/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_smoke.py:1` |
| Existing report boundary | The current worker returns camera names, byte counts, elapsed time, start-code counts, and pass or fail status | `/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_smoke.py:74` |
| Existing orchestration | `qa.py` can deploy or restore Home Assistant and optionally run the live stream smoke worker | `/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/qa.py:92` |
| Privacy boundary | Tokens, serials, stream URLs, raw payloads, and device identifiers stay on the private target and never enter reports | Local automation README, Eufy stream-smoke contract |

## Files

```text
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/gateway_stream.py  (add: direct gateway API and known-camera stream harness)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/ha_adapter_stream.py (add: fake-gateway Home Assistant adapter harness)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_matrix.py    (add: bounded matrix runner and report aggregation)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_smoke.py     (modify: retain the deployed Home Assistant bridge as an explicit end-to-end mode)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/qa.py               (modify: call the bridge only when explicitly requested)
/Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/automation.json      (modify: register the split harness workflows and evidence boundaries)
eufy_event_gateway/test/stream-contract-fixtures.test.ts                                                (add: deterministic gateway response and media fixtures)
tests/test_fake_gateway_contract.py                                                                        (add: adapter-facing fake gateway contract cases)
```

## Harness boundaries

| Harness | Real dependency | Primary assertion | Must not claim |
|---|---|---|---|
| Gateway stream | Known camera, Eufy account, gateway process | Route, protection, first complete access unit, codec, repeat view, cancellation, and bounded media output | Home Assistant entity health |
| Home Assistant adapter | Fake gateway contract and Home Assistant test boundary | Coordinator updates, availability, image revisions, entities, controls, and error translation | Eufy hardware or PPCS success |
| End-to-end bridge | Deployed gateway plus Home Assistant plus selected known cameras | Product wiring and release smoke evidence | Which internal layer caused a failure without the isolated harness result |

## Behaviours to test

| # | Behaviour | Given / when | Expect |
|---|---|---|---|
| 1 | Known-camera admission | The direct harness selects a configured camera name | The gateway resolves one camera and reports only a bounded identity label |
| 2 | First stream | A known camera starts through the gateway API | First complete access unit arrives within the configured window with bytes, codec, and structural counters |
| 3 | Repeat stream | The same camera stops and starts again | The second generation produces fresh media and cannot be satisfied by stale retained bytes |
| 4 | Snapshot and cancellation | A snapshot lease starts, completes, or times out | The harness reports completion or bounded timeout and confirms no leaked gateway session |
| 5 | Fake gateway adapter | Home Assistant receives deterministic valid, unavailable, malformed, and revision-changing responses | Coordinator and entities expose the expected state without any camera or Eufy credential |
| 6 | Failure attribution | The gateway harness fails while the adapter harness passes, or the reverse | The aggregate report identifies the failing boundary rather than collapsing both into one failure |
| 7 | End-to-end bridge | The deployed product runs the selected camera matrix | The bridge records product wiring evidence and links to the isolated results |
| 8 | Report redaction | Any harness completes or fails | Reports contain no tokens, serials, stream URLs, peer endpoints, keys, raw payloads, or media bytes |

## Cross-surface impact

| Surface | Change or verified non-impact |
|---|---|
| Gateway | Gains deterministic contract fixtures and a direct known-camera harness outside the product repository |
| Home Assistant | Gains adapter tests that do not require a live camera or Eufy account |
| Local automation | Owns orchestration, redaction, compact results, camera selection, and optional deployment bridge |
| Operations | Release QA can distinguish protocol, adapter, and wiring failures before public issue updates |
| Hardware | Known-camera runs remain opt-in, bounded, and never treat route readiness as successful playback |

## Implementation constraints

1. Store camera selection and credentials in ignored local configuration or remote Home Assistant state, never in Git or result files.
2. The direct gateway harness must use the public gateway API boundary, not private decoder imports or test-only shortcuts.
3. The adapter harness must use a fake gateway contract and must not open a real Eufy session.
4. The end-to-end bridge is evidence collection only. It cannot replace isolated gateway or adapter tests.
5. A failed known-camera run must preserve the compact failure result and leave the target runtime unchanged.
6. Do not remove or stop the development app from a harness run. Cleanup belongs to Task 8 after live release verification.

## Verification

1. `python3 -m unittest tests.test_fake_gateway_contract` must pass without network access or Home Assistant credentials.
2. `npm --prefix eufy_event_gateway test -- --test-name-pattern='stream contract|media fixture'` must pass.
3. `python3 /Users/martinjsteven/Projects/codex-local-automation/projects/eufy-mega-security/stream_matrix.py --help` must succeed without contacting a device.
4. A configured direct gateway run must produce one compact result per known camera and separate first-view, repeat-view, snapshot, and cancellation outcomes.
5. `python3 /Users/martinjsteven/Projects/codex-local-automation/maintenance/scan_redactions.py /Users/martinjsteven/Projects/codex-local-automation/results` must pass for generated reports.

## Done checklist

- [ ] Gateway and Home Assistant harnesses run independently.
- [ ] Deterministic adapter tests pass without a camera or Eufy account.
- [ ] Known-camera runs cover first view, repeat view, snapshot, and cancellation.
- [ ] End-to-end bridge results identify wiring failures without replacing isolated evidence.
- [ ] Reports contain bounded, redacted evidence only.
- [ ] Automation register and README usage are updated.
- [ ] Review findings are resolved.
