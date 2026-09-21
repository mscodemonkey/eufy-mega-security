/**
 * Validates and queries the contributor-maintained device capability catalogue.
 *
 * The command reads repository data only. Runtime admission remains owned by
 * the provider capability modules, which can adopt catalogue facts explicitly.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const catalogueDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "device_catalogue");
const devicesDirectory = join(catalogueDirectory, "devices");
const forbiddenReferencePattern = /sdk|eufy-security-client|mega-yfue|source_repo|file_line|verified_by|xref_mega|build\/http\/types\.js|src\/model\/|(?:no)?lib[0-9]|\blibrary\b/i;
const legacyIdentifierPattern = /(?:^|[-_])(?:no)?lib(?:[0-9_]|$)/i;

async function loadDevices() {
  const files = (await readdir(devicesDirectory)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => {
    const source = await readFile(join(devicesDirectory, file), "utf8");
    return { file, source, record: JSON.parse(source) };
  }));
}

async function validateCatalogueSources() {
  const files = (await readdir(catalogueDirectory, { recursive: true }))
    .filter((file) => file.endsWith(".json") || file.endsWith(".md"));
  const errors = [];
  for (const file of files) {
    const source = await readFile(join(catalogueDirectory, file), "utf8");
    if (forbiddenReferencePattern.test(source)) errors.push(`${file}: contains forbidden reference-source metadata`);
  }
  return errors;
}

function validateDevice(file, source, record, ids) {
  const errors = [];
  const fileStem = basename(file, ".json");
  if (forbiddenReferencePattern.test(source)) errors.push(`${file}: contains forbidden reference-source metadata`);
  if (legacyIdentifierPattern.test(fileStem)) errors.push(`${file}: contains a legacy source identifier`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fileStem)) errors.push(`${file}: filename must use lowercase kebab case`);
  if (record.$schema !== "../schema.json") errors.push(`${file}: invalid schema reference`);
  if (typeof record.id !== "string" || record.id.length === 0) errors.push(`${file}: missing id`);
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id)) errors.push(`${file}: id must use lowercase kebab case`);
  else if (ids.has(record.id)) errors.push(`${file}: duplicate id ${record.id}`);
  else ids.add(record.id);
  if (!record.identity || typeof record.identity.display_name !== "string") errors.push(`${file}: missing display name`);
  if (!Array.isArray(record.identity?.model_codes)) errors.push(`${file}: model_codes must be an array`);
  if (!record.device_registry || typeof record.device_registry !== "object") errors.push(`${file}: missing device registry`);
  if (!record.capabilities || typeof record.capabilities !== "object") errors.push(`${file}: missing capabilities`);

  for (const [kind, capabilities] of Object.entries(record.capabilities ?? {})) {
    if (!Array.isArray(capabilities)) {
      errors.push(`${file}: ${kind} must be an array`);
      continue;
    }
    const keys = new Set();
    for (const capability of capabilities) {
      const key = `${capability.key}\u0000${capability.context}`;
      if (!capability.key || !capability.context || !capability.available) errors.push(`${file}: incomplete ${kind} capability`);
      if (keys.has(key)) errors.push(`${file}: duplicate ${kind} ${capability.key} (${capability.context})`);
      keys.add(key);
      const optionValues = new Set();
      for (const option of capability.value?.options ?? []) {
        const value = JSON.stringify(option.value);
        if (optionValues.has(value)) errors.push(`${file}: duplicate option ${value} for ${capability.key}`);
        optionValues.add(value);
      }
    }
  }
  return errors;
}

function validateIdentityKeys(devices) {
  const errors = [];
  const recordsByPrimaryModel = new Map();
  for (const device of devices) {
    const primaryModel = device.record.identity?.model_codes?.[0];
    if (!primaryModel) continue;
    const key = String(primaryModel).toLowerCase();
    const records = recordsByPrimaryModel.get(key) ?? [];
    records.push(device);
    recordsByPrimaryModel.set(key, records);
  }
  for (const [primaryModel, records] of recordsByPrimaryModel) {
    for (const { file, record } of records) {
      const fileStem = basename(file, ".json");
      if (!fileStem.startsWith(`${primaryModel}-`)) {
        errors.push(`${file}: filename must start with primary model ${primaryModel}-`);
      }
      if (records.length === 1 && record.id !== primaryModel) {
        errors.push(`${file}: unique primary model must use id ${primaryModel}`);
      }
      if (records.length > 1 && !record.id.startsWith(`${primaryModel}-`)) {
        errors.push(`${file}: shared primary model id must start with ${primaryModel}-`);
      }
      if (records.length > 1 && !record.identity.variant_rule) {
        errors.push(`${file}: shared primary model requires a variant rule`);
      }
    }
  }
  for (const { file, record } of devices) {
    if (record.identity?.model_codes?.length > 0) continue;
    const fileStem = basename(file, ".json");
    if (fileStem !== record.id && !fileStem.startsWith(`${record.id}-`)) {
      errors.push(`${file}: filename must start with id ${record.id}`);
    }
  }
  return errors;
}

function findDevice(devices, query) {
  const normalized = query.toUpperCase();
  return devices.filter(({ record }) => [
    record.id,
    record.identity.display_name,
    ...record.identity.model_codes,
    ...record.identity.aliases,
  ].some((value) => String(value).toUpperCase() === normalized));
}

async function check() {
  const devices = await loadDevices();
  const ids = new Set();
  const errors = [
    ...await validateCatalogueSources(),
    ...devices.flatMap(({ file, source, record }) => validateDevice(file, source, record, ids)),
    ...validateIdentityKeys(devices),
  ];
  const capabilityCount = devices.reduce(
    (count, { record }) => count + Object.values(record.capabilities).reduce((sum, rows) => sum + rows.length, 0),
    0,
  );
  const optionCount = devices.reduce(
    (count, { record }) => count + Object.values(record.capabilities).reduce(
      (sum, rows) => sum + rows.reduce((rowSum, row) => rowSum + (row.value?.options?.length ?? 0), 0),
      0,
    ),
    0,
  );
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log(JSON.stringify({ devices: devices.length, capabilities: capabilityCount, selectableValues: optionCount }));
}

async function query(model, capabilityKey) {
  const matches = findDevice(await loadDevices(), model);
  if (matches.length === 0) throw new Error(`No device matches ${model}`);
  const output = matches.map(({ file, record }) => {
    if (!capabilityKey) return { file, ...record };
    const capabilities = Object.entries(record.capabilities).flatMap(([kind, rows]) => rows
      .filter((row) => row.key.toLowerCase() === capabilityKey.toLowerCase())
      .map((row) => ({ kind, ...row })));
    return { file, id: record.id, identity: record.identity, capabilities };
  });
  console.log(JSON.stringify(output, null, 2));
}

const [command = "check", model, capabilityKey] = process.argv.slice(2);
if (command === "check") await check();
else if (command === "query" && model) await query(model, capabilityKey);
else throw new Error("Usage: device-catalogue.mjs check | query MODEL [CAPABILITY]");
