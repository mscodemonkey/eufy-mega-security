/**
 * Protects the inventory filter that decides which Mega rows become cameras.
 *
 * It keeps HomeBase parent metadata and unsupported device categories out of
 * the Home Assistant-facing camera list while retaining the validated camera
 * types used by the test hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedMegaCamera } from "../src/provider/eufy-provider.js";

test("recognizes the security camera types present in Mega inventory", () => {
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 5 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 7 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 8 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 9 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 15 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 19 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 23 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 151 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 31 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 91 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 94 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 96 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 104 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 10031 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 18 }), false);
  assert.equal(isSupportedMegaCamera({ category: "eufy_clean", deviceType: 8 }), false);
  assert.equal(isSupportedMegaCamera({ category: "other", deviceType: 23 }), false);
});
