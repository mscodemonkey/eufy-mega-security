/**
 * Checks the shipped quiet-hours YAML and its deliberately simple expressions.
 * Tests own time/state fixtures. Home Assistant separately renders these same
 * templates during owned QA, without enabling a persistent automation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const document = parse(readFileSync(new URL("../../blueprints/automation/eufy_event_gateway/doorbell_quiet_hours.yaml", import.meta.url), "utf8"), {
  customTags: [{ tag: "!input", resolve: (value: string) => ({ input: value }) }],
});

function evaluate(template: string, variables: Record<string, unknown>): unknown {
  const expression = template.trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim();
  const worker = "import json,sys\nr=json.load(sys.stdin)\nv=r['variables']\nv['states']=lambda entity:v['state']\nv['state_attr']=lambda entity,key:v['attribute']\nprint(json.dumps(eval('('+r['expression']+')', {'__builtins__':{}},v)))";
  const result = spawnSync("python3", ["-c", worker], { input: JSON.stringify({ expression, variables }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("quiet interval follows the shipped expression across midnight and exact boundaries", () => {
  for (const [start, end, at, expected] of [
    ["22:00:00", "07:00:00", "21:59:59", false], ["22:00:00", "07:00:00", "22:00:00", true],
    ["22:00:00", "07:00:00", "00:00:00", true], ["22:00:00", "07:00:00", "06:59:59", true],
    ["22:00:00", "07:00:00", "07:00:00", false], ["09:00:00", "17:00:00", "09:00:00", true],
    ["09:00:00", "17:00:00", "17:00:00", false], ["09:00:00", "09:00:00", "09:00:00", false],
  ]) assert.equal(evaluate(document.variables.quiet_now, { quiet_start: start, quiet_end: end, current_time: at }), expected);
});

test("blueprint refuses wrong switches, unknown state and redundant calls", () => {
  for (const [state, attribute, quiet, allowed] of [
    ["on", "homebase_doorbell_chime", true, true], ["off", "homebase_doorbell_chime", true, false],
    ["off", "homebase_doorbell_chime", false, true], ["unavailable", "homebase_doorbell_chime", true, false],
    ["on", "motion_detection", true, false], ["on", null, true, false],
  ]) {
    const variables = { state, attribute, quiet_now: quiet, chime_entity: "fixture" };
    assert.equal(document.condition.every((row: { value_template: string }) => evaluate(row.value_template, variables)), allowed);
  }
  assert.equal(evaluate(document.action[0].service, { quiet_now: true }), "switch.turn_off");
  assert.equal(evaluate(document.action[0].service, { quiet_now: false }), "switch.turn_on");
  assert.deepEqual(document.action[0].target.entity_id, { input: "doorbell_chime" });
  assert.equal(document.trigger.length, 6);
  assert.deepEqual(document.trigger.slice(0, 2).map((row: { at: unknown }) => row.at), [{ input: "quiet_start" }, { input: "quiet_end" }]);
  assert.deepEqual(document.trigger.slice(4).map((row: { from: string }) => row.from), ["unavailable", "unknown"]);
});
