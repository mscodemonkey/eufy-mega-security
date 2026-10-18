/**
 * Checks the explicit RTC option mirrors and app-owned translation boundary.
 * The test reads tracked sources only and changes an in-memory copy for its
 * negative case. It cannot generate integration translations or contact HA.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirrors = ["eufy_event_gateway/config.yaml", "eufy_event_gateway/run.sh", "eufy_event_gateway/src/config.ts",
  "eufy_event_gateway/src/main.ts", "eufy_event_gateway/src/provider/eufy-provider.ts", "eufy_event_gateway/src/server.ts",
  "eufy_event_gateway/translations/en.yaml", "README.md", "eufy_event_gateway/README.md", "docs/GENERAL_RTC_TEST.md",
  "CHANGELOG.md", "eufy_event_gateway/CHANGELOG.md", "eufy_event_gateway/test/config.test.ts",
  "eufy_event_gateway/test/provider-general-rtc.test.ts", "eufy_event_gateway/test/server-general-rtc.test.ts"];

function validateMirrors(values: ReadonlyMap<string, string>): void {
  for (const path of mirrors) assert.match(values.get(path) ?? "", /experimental_general_rtc|experimentalGeneralRtc|EXPERIMENTAL_GENERAL_RTC/, path);
}

test("option mirrors are explicit and removing one from a temporary copy fails", async () => {
  const values = new Map(await Promise.all(mirrors.map(async path => [path, await readFile(resolve(root, path), "utf8")] as const)));
  validateMirrors(values);
  const broken = new Map(values); broken.set(mirrors[0]!, values.get(mirrors[0]!)!.replaceAll("experimental_general_rtc", "removed_fixture_key"));
  assert.throws(() => validateMirrors(broken));
  const config = parse(values.get(mirrors[0]!)!) as { options: Record<string, unknown>; schema: Record<string, unknown> };
  assert.equal(config.options.experimental_general_rtc, false); assert.equal(config.schema.experimental_general_rtc, "bool?");
  assert.match(values.get("eufy_event_gateway/run.sh")!, /export EUFY_GATEWAY_EXPERIMENTAL_GENERAL_RTC=.*experimental_general_rtc \/\/ false/);
  const page = await readFile(resolve(root, "eufy_event_gateway/src/diagnostics/page.ts"), "utf8");
  assert.match(page, /Experimental general camera video test/);
});

test("app locales contain the owner-account description and integration sources gain no app option", async () => {
  const directory = resolve(root, "eufy_event_gateway/translations");
  const locales = (await readdir(directory)).filter(name => name.endsWith(".yaml"));
  assert.ok(locales.includes("en.yaml"));
  for (const locale of locales) {
    const value = parse(await readFile(resolve(directory, locale), "utf8")) as { configuration: Record<string, { name: string; description: string }> };
    const option = value.configuration.experimental_general_rtc;
    assert.ok(option); assert.equal(typeof option.name, "string"); assert.equal(typeof option.description, "string");
    if (locale === "en.yaml") for (const phrase of ["owner", "guest", "PIN", "Eufy", "unconfirmed", "Off by default"]) assert.ok(option.description.includes(phrase));
  }
  const integration = resolve(root, "custom_components/eufy_event_gateway");
  for (const path of ["strings.json", ...(await readdir(resolve(integration, "translation_sources")))
    .filter(name => name.endsWith(".yaml")).map(name => `translation_sources/${name}`)]) {
    assert.doesNotMatch(await readFile(resolve(integration, path), "utf8"), /experimental_general_rtc|experimental_doorbell_rtc/);
  }
});
