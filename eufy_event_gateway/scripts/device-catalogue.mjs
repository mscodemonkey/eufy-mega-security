/**
 * Validates and queries the contributor-maintained device capability catalogue.
 *
 * The command reads repository data only. Runtime admission remains owned by
 * the provider capability modules, which can adopt catalogue facts explicitly.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const catalogueDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "device_catalogue");
const devicesDirectory = join(catalogueDirectory, "devices");

async function loadDevices() {
  const files = (await readdir(devicesDirectory)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => ({
    file,
    record: JSON.parse(await readFile(join(devicesDirectory, file), "utf8")),
  })));
}

function validateDevice(file, record, ids) {
  const errors = [];
  if (record.$schema !== "../schema.json") errors.push(`${file}: invalid schema reference`);
  if (typeof record.id !== "string" || record.id.length === 0) errors.push(`${file}: missing id`);
  else if (ids.has(record.id)) errors.push(`${file}: duplicate id ${record.id}`);
  else ids.add(record.id);
  if (!record.identity || typeof record.identity.display_name !== "string") errors.push(`${file}: missing display name`);
  if (!Array.isArray(record.identity?.model_codes)) errors.push(`${file}: model_codes must be an array`);
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
  const errors = devices.flatMap(({ file, record }) => validateDevice(file, record, ids));
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
