# Gateway scaling baseline

Use this baseline when reviewing inventory refresh or live-session changes.
It exercises production gateway policy with synthetic response rows, peer
lookups, sockets and media children. Keep real Home Assistant observations in
a separate record.

## What the fixtures check

| Workload | Checks |
| --- | --- |
| 1, 10 and 50 cameras | The camera under test can confirm a fresh motion change while another HomeBase's key lookup is pending. The first complete publication includes the expected cameras. The existing follow-up request waits for its own inventory read. The single-camera enablement fixture covers the other switch path. |
| One and three viewers of one H.265 camera | The viewers share one source and one H.264 converter. The snapshot extractor is counted separately. An early viewer cancellation leaves the other views active. |
| Two H.265 cameras | Independent sources deliver their own bytes. A stalled source and its media children retire. The healthy camera continues to deliver data. An explicit reopen starts a fresh source. Idle cleanup releases the remaining sources and children. |

The motion fixtures include one HomeBase for the camera under test and a second
discovered HomeBase with a controlled pending key. Additional synthetic cameras
exercise inventory projection without initiating network discovery. The fixture
records time to switch confirmation and time to the first full inventory
publication separately. Publication includes time spent at the controlled
lookup gate.

The media fixture uses mock timers for stall and idle deadlines. It counts
in-memory stand-ins for media children and marks a child inactive once it
receives termination. That describes manager ownership. A real process can take
longer to exit. The reopen sample also counts converter starts, so a short-lived
replacement remains visible even when steady-state counts are unchanged.

## Run the baseline

From `eufy_event_gateway`, use Node 24 and the locked dependencies installed by
`npm ci`. Run on an otherwise quiet host. Run the same test command and sample
counts for a later comparison.

```sh
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { arch, cpus, platform } from "node:os";

const warmups = 3;
const samples = 15;
const prefix = "# scaling-sample ";
const cases = new Map();
for (let index = 0; index < warmups + samples; index++) {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test", "--test-reporter=tap",
    "--test-name-pattern=connection key at|scaling baseline",
    "test/provider-motion-reliability.test.ts", "test/live-stream-manager.test.ts",
  ], { encoding: "utf8", env: { ...process.env, EUFY_SCALING_SAMPLES: "1" }, timeout: 30_000 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw result.error ?? new Error("Scaling fixture failed");
  }
  if (index < warmups) continue;
  const rows = result.stdout.split("\n").filter(line => line.startsWith(prefix));
  assert.equal(rows.length, 5);
  for (const line of rows) {
    const { scenario, ...metrics } = JSON.parse(line.slice(prefix.length));
    const casesForScenario = cases.get(scenario) ?? [];
    casesForScenario.push(metrics);
    cases.set(scenario, casesForScenario);
  }
}
const percentile = (values, fraction) => {
  const ordered = values.toSorted((a, b) => a - b);
  return Math.round(ordered[Math.ceil(values.length * fraction) - 1] * 1000) / 1000;
};
const results = Object.fromEntries([...cases].map(([scenario, rows]) => {
  assert.equal(rows.length, samples);
  const metrics = Object.fromEntries(Object.keys(rows[0]).map(key => {
    const values = rows.map(row => row[key]);
    if (key.endsWith("Ms")) return [key, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
    const distinct = [...new Set(values.map(value => JSON.stringify(value)))];
    return [key, distinct.map(value => JSON.parse(value))];
  }));
  return [scenario, metrics];
}));
console.log(JSON.stringify({
  schema: 1, workload: "synthetic", node: process.version,
  hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  warmups, samplesPerScenario: samples, timingUnit: "ms", results,
}, null, 2));
JS
```

The three warm-up rounds prime the host and file caches. Each measured round
starts a fresh Node test process. p50 and p95 use nearest rank. The timings
describe instrumented software work on the machine sampled. In-memory media
latency excludes camera wake-up, radio, FFmpeg work, HLS and display rendering.
Treat the resource counts and ordering assertions as the regression contract.
Timing values are descriptive and have no fixed CI threshold. Attach the tested
commit to any retained report.

## Compare with a live installation

Use a verified gateway and integration source and an authorised representative
view. Collect a normal open and reopen on the same model, route, codec and
viewing client. Leave current recording and capture ownership in place. If a
case already has an active capture or a pause instruction, arrange the handoff
before sampling that case. Avoid additional views when they would interrupt
normal recording or another viewer.

Record the gateway and integration versions, source revision, hardware class,
scenario, sample count, request-to-first-media timing, viewer count and source
count. Include the viewer converter and snapshot extractor counts separately,
plus process CPU and memory during the same observation window when supported.
Keep hardware model and topology with the results and omit private identities.
Call out missing telemetry explicitly.

Use the maintained Home Assistant QA and stream evidence tools for the selected
route. Gateway stream smoke reports the first payload and sustained delivery.
Record browser or Home Assistant first picture separately when that is the
quantity being investigated. Compare like-for-like samples across the same
route and hardware before treating a resource difference as a bottleneck.
