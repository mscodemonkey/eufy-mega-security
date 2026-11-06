/**
 * Verifies the provider's copyable model names against known catalogue aliases.
 * These pure fixtures own no network or inventory state. Support logging consumes
 * their result, so unknown lookalikes must not reveal private inventory strings.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { safePushLogSummary } from "../src/provider/eufy-provider.js";

const press = { eventType: 3103, messageType: 18, notificationStyle: 1, pictureUrl: null, alarmType: null };

for (const [model, deviceType] of [["T85V0", 203], ["T85V01Y1", 203], ["T8W11C", 10010], ["T8E00", 301], ["T8N00", 300]] as const) {
  test(`preserves the known ${model} model in support logs`, () => {
    const line = safePushLogSummary(press, { model, deviceType, category: "eufy_security" }, true, true);
    assert.match(line, new RegExp(`^model=${model} `));
    if (model === "T85V0") assert.match(line, /handling=doorbell_press/);
  });
}

for (const model of ["T85V0-private", "T85V0123456789", "T8W11C\nprivate", "private@example.invalid"]) {
  test("withholds an unknown model even when it resembles a catalogue alias", () => {
    const line = safePushLogSummary(press, { model, deviceType: 203, category: "eufy_security" }, true, true);
    assert.match(line, /^model=unknown /);
    assert.equal(line.includes(model), false);
  });
}
