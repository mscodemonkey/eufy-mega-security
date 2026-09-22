/**
 * Tests the gateway's HTTP authentication helpers and challenge presentation.
 *
 * Cases cover bearer comparison, HMAC stream-token expiry/signatures, and safe
 * CAPTCHA page output without binding a listening server.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { captchaDataUri, captchaResultMessage, createStreamToken, isBearerAuthorized, validateStreamToken } from "../src/server.js";

test("compares bearer credentials without accepting malformed values", () => {
  assert.equal(isBearerAuthorized("Bearer long-random-token", "long-random-token"), true);
  assert.equal(isBearerAuthorized("Bearer wrong-token", "long-random-token"), false);
  assert.equal(isBearerAuthorized(undefined, "long-random-token"), false);
});

test("limits stream URLs to one camera and a ten-minute retry window", () => {
  const token = createStreamToken("T8113ABC", 1_600, "long-random-token");
  assert.equal(validateStreamToken("T8113ABC", token, "long-random-token", 1_000), true);
  assert.equal(validateStreamToken("T8113OTHER", token, "long-random-token", 1_000), false);
  assert.equal(validateStreamToken("T8113ABC", token, "long-random-token", 1_601), false);
  assert.equal(validateStreamToken("T8113ABC", token, "wrong-token", 1_000), false);
  assert.equal(validateStreamToken(
    "T8113ABC",
    createStreamToken("T8113ABC", 1_661, "long-random-token"),
    "long-random-token",
    1_000,
  ), false);
});

test("renders Eufy CAPTCHA image data without allowing attribute injection", () => {
  assert.equal(captchaDataUri("YWJj"), "data:image/jpeg;base64,YWJj");
  assert.equal(
    captchaDataUri('data:image/png;base64,YWJj\" onerror=\"alert(1)'),
    "data:image/png;base64,YWJj&quot; onerror=&quot;alert(1)",
  );
});

test("keeps CAPTCHA results in the app with clear retry and success messages", () => {
  assert.match(captchaResultMessage(true), /Try the new challenge/);
  assert.match(captchaResultMessage(false), /accepted/);
  assert.doesNotMatch(captchaResultMessage(false), /close this page/i);
});
