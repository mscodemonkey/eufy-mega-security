/**
 * Protects the shell launcher's Home Assistant Supervisor boundary.
 *
 * The app owns automatic discovery only when Supervisor supplies its token;
 * standalone Docker deployments consume the same launcher without that host.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("guards Supervisor discovery for standalone Docker launches", async () => {
  const launcher = await readFile(new URL("../run.sh", import.meta.url), "utf8");
  const guardedDiscovery = /if \[ -n "\$\{SUPERVISOR_TOKEN:-\}" \]; then[\s\S]*Authorization: Bearer \$SUPERVISOR_TOKEN[\s\S]*http:\/\/supervisor\/discovery[\s\S]*\nfi/;

  assert.match(launcher, guardedDiscovery);
});
