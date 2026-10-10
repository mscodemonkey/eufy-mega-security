/**
 * Covers the configuration boundary from environment strings to typed values.
 *
 * These tests protect defaults, numeric validation, path normalization, and
 * the rule that a non-loopback HTTP listener requires a strong API token.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("allows a token-free gateway only on loopback", () => {
  assert.equal(loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated" }).host, "127.0.0.1");
  assert.throws(
    () => loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated", EUFY_GATEWAY_HOST: "0.0.0.0" }),
    /API_TOKEN is required/,
  );
});

test("allows LAN binding when an API token is configured", () => {
  const config = loadConfig({
    EUFY_GATEWAY_PROVIDER: "simulated",
    EUFY_GATEWAY_HOST: "0.0.0.0",
    EUFY_GATEWAY_API_TOKEN: "a-long-random-token-with-32-chars!",
  });
  assert.equal(config.apiToken, "a-long-random-token-with-32-chars!");
});

test("rejects weak API tokens", () => {
  assert.throws(
    () => loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated", EUFY_GATEWAY_API_TOKEN: "too-short" }),
    /at least 32 characters/,
  );
});

test("passes through a temporary Eufy email verification code", () => {
  const config = loadConfig({
    EUFY_GATEWAY_PROVIDER: "simulated",
    EUFY_VERIFY_CODE: " 123456 ",
  });
  assert.equal(config.eufy.verifyCode, "123456");
});

test("private image capture defaults off and accepts only explicit booleans with a token", () => {
  assert.equal(loadConfig({}).captureFailedEventImages, false);
  for (const value of ["true", " TRUE "]) {
    assert.throws(() => loadConfig({ EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES: value }), /requires EUFY_GATEWAY_API_TOKEN/);
    assert.equal(loadConfig({ EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES: value, EUFY_GATEWAY_API_TOKEN: "x".repeat(32) }).captureFailedEventImages, true);
  }
  for (const value of ["", "false", " FALSE "]) assert.equal(loadConfig({ EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES: value }).captureFailedEventImages, false);
  for (const value of ["1", "yes", "invalid"]) assert.throws(() => loadConfig({ EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES: value }), /must be true or false/);
});
