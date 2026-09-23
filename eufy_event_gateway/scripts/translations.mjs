/**
 * Generates Home Assistant JSON translations from contributor-friendly YAML.
 *
 * The repository owns the YAML sources. Home Assistant consumes the generated
 * JSON files, while CI uses check mode to prevent stale or structurally
 * incomplete translations from being committed.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const action = process.argv[2] ?? "check";
if (action !== "check" && action !== "generate") {
  throw new Error("Usage: node scripts/translations.mjs check|generate");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const integration = resolve(
  repositoryRoot,
  "custom_components/eufy_event_gateway",
);
const sourceDirectory = resolve(integration, "translation_sources");
const outputDirectory = resolve(integration, "translations");
const sourceFiles = (await readdir(sourceDirectory))
  .filter((name) => name.endsWith(".yaml"))
  .sort();

if (!sourceFiles.includes("en.yaml")) {
  throw new Error("translation_sources/en.yaml is required");
}

const translations = new Map();
for (const filename of sourceFiles) {
  const locale = basename(filename, ".yaml");
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw new Error(`Invalid BCP 47 translation filename: ${filename}`);
  }
  const value = parse(await readFile(resolve(sourceDirectory, filename), "utf8"));
  if (!isRecord(value)) throw new Error(`${filename} must contain a YAML object`);
  translations.set(locale, value);
}

const english = translations.get("en");
const englishShape = leafPaths(english);
for (const [locale, value] of translations) {
  const shape = leafPaths(value);
  if (JSON.stringify(shape) !== JSON.stringify(englishShape)) {
    throw new Error(`${locale}.yaml must contain the same translation keys as en.yaml`);
  }
  for (const path of englishShape) {
    const englishValue = valueAtPath(english, path);
    const translatedValue = valueAtPath(value, path);
    if (typeof translatedValue !== "string") {
      throw new Error(`${locale}.yaml translation ${path.join(".")} must be text`);
    }
    if (JSON.stringify(placeholders(translatedValue)) !== JSON.stringify(placeholders(englishValue))) {
      throw new Error(`${locale}.yaml translation ${path.join(".")} changed its placeholders`);
    }
  }
}

const expected = new Map();
for (const [locale, value] of translations) {
  expected.set(resolve(outputDirectory, `${locale}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
expected.set(resolve(integration, "strings.json"), `${JSON.stringify(english, null, 2)}\n`);

const stale = [];
for (const [path, content] of expected) {
  if (action === "generate") {
    await writeFile(path, content);
    continue;
  }
  const current = await readFile(path, "utf8").catch(() => "");
  if (current !== content) stale.push(path.replace(`${repositoryRoot}/`, ""));
}

if (stale.length > 0) {
  throw new Error(`Generated translations are stale: ${stale.join(", ")}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafPaths(value, prefix = []) {
  if (!isRecord(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => leafPaths(value[key], [...prefix, key]));
}

function valueAtPath(value, path) {
  return path.reduce((current, key) => current[key], value);
}

function placeholders(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
}
