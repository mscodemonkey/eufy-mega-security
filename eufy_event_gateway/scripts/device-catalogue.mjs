/**
 * Validates and queries the contributor-maintained device capability catalogue.
 *
 * The command validates human-edited records and generates the immutable
 * identity and admission tables consumed by provider capability modules.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const catalogueDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "device_catalogue");
const devicesDirectory = join(catalogueDirectory, "devices");
const generatedRuntimeFile = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "provider", "devices", "generated-catalogue.ts");
const generatedSupportFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "GENERATED_DEVICE_SUPPORT.md");
const forbiddenReferencePattern = /sdk|eufy-security-client|mega-yfue|source_repo|file_line|verified_by|xref_mega|build\/http\/types\.js|src\/model\/|(?:no)?lib[0-9]|\blibrary\b/i;
const legacyIdentifierPattern = /(?:^|[-_])(?:no)?lib(?:[0-9_]|$)/i;
const deviceExtensions = [".yaml"];
const capabilityGroups = ["readable", "controls", "media", "events"];
const supportStatuses = ["tested", "reported", "mixed", "declared", "failing", "unsupported", "unknown"];
const connectionPattern = /^(?:direct|T[A-Z0-9]+)$/;
const simplifiedCapabilityFields = new Set(["connections", "requires_parameter", "read", "write", "values", "notes", "source"]);
const capabilityConnectionFields = new Set(["status", "tested_on", "tested_by", "notes"]);

function isDeviceFile(file) {
  return deviceExtensions.some((extension) => file.endsWith(extension));
}

function deviceFileStem(file) {
  const extension = deviceExtensions.find((candidate) => file.endsWith(candidate));
  return extension ? basename(file, extension) : basename(file);
}

function parseDevice(_file, source) {
  return parse(source);
}

function deviceModels(record) {
  return record.models;
}

function deviceName(record) {
  return record.name;
}

function deviceAliases(record) {
  return record.aliases ?? [];
}

async function loadDevices() {
  const files = (await readdir(devicesDirectory)).filter(isDeviceFile).sort();
  return Promise.all(files.map(async (file) => {
    const source = await readFile(join(devicesDirectory, file), "utf8");
    return { file, source, record: parseDevice(file, source) };
  }));
}

async function validateCatalogueSources() {
  const files = (await readdir(catalogueDirectory, { recursive: true }))
    .filter((file) => isDeviceFile(file) || file.endsWith(".md"));
  const errors = [];
  for (const file of files) {
    const source = await readFile(join(catalogueDirectory, file), "utf8");
    if (forbiddenReferencePattern.test(source)) errors.push(`${file}: contains forbidden reference-source metadata`);
  }
  return errors;
}

function validateDevice(file, source, record, ids) {
  const errors = [];
  const fileStem = deviceFileStem(file);
  if (forbiddenReferencePattern.test(source)) errors.push(`${file}: contains forbidden reference-source metadata`);
  if (legacyIdentifierPattern.test(fileStem)) errors.push(`${file}: contains a legacy source identifier`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fileStem)) errors.push(`${file}: filename must use lowercase kebab case`);
  if (!record || typeof record !== "object" || Array.isArray(record)) return [...errors, `${file}: device record must be a map`];
  if (typeof record.id !== "string" || record.id.length === 0) errors.push(`${file}: missing id`);
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id)) errors.push(`${file}: id must use lowercase kebab case`);
  else if (ids.has(record.id)) errors.push(`${file}: duplicate id ${record.id}`);
  else ids.add(record.id);

  if (record.schema !== 1) errors.push(`${file}: schema must be 1`);
  return [...errors, ...validateSimplifiedDevice(file, record)];
}

function validateSimplifiedDevice(file, record) {
  const errors = [];
  const allowedTopLevel = new Set([
    "schema", "id", "name", "category", "integration", "aliases", "models", "device_type", "alternate_device_types", "notes", "capabilities", "ignored",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) errors.push(`${file}: unknown top-level field ${key}`);
  }
  if (typeof record.name !== "string" || record.name.length === 0) errors.push(`${file}: missing name`);
  if (![
      "camera", "doorbell", "homebase", "hub_adjacent", "nvr", "smart_lock",
      "security_sensor", "siren", "keypad", "remote", "smart_drop", "smart_safe",
      "tracker", "chime", "passive_accessory",
    ].includes(record.category)) {
    errors.push(`${file}: category is invalid`);
  }
  const integration = record.integration;
  if (!integration || typeof integration !== "object" || Array.isArray(integration)) {
    errors.push(`${file}: integration must be a map`);
  } else {
    const allowedIntegrationFields = new Set(["status", "handler"]);
    for (const key of Object.keys(integration)) {
      if (!allowedIntegrationFields.has(key)) errors.push(`${file}: integration has unknown field ${key}`);
    }
    if (!["supported", "ready_to_test", "recognised"].includes(integration.status)) {
      errors.push(`${file}: integration status is invalid`);
    }
    if (integration.handler !== undefined && !["camera", "sensor", "homebase"].includes(integration.handler)) {
      errors.push(`${file}: integration handler is invalid`);
    }
    if (["supported", "ready_to_test"].includes(integration.status) && integration.handler === undefined) {
      errors.push(`${file}: ${integration.status} integration must name its handler`);
    }
    if (["supported", "ready_to_test"].includes(integration.status) && !Number.isSafeInteger(record.device_type)) {
      errors.push(`${file}: ${integration.status} integration must have a numeric device_type`);
    }
  }
  if (record.aliases !== undefined
    && (!Array.isArray(record.aliases)
      || record.aliases.some((alias) => typeof alias !== "string" || alias.length === 0)
      || new Set(record.aliases).size !== record.aliases.length)) {
    errors.push(`${file}: aliases must be a unique array of non-empty names`);
  }
  if (!Array.isArray(record.models) || record.models.some((model) => typeof model !== "string" || model.length === 0)) {
    errors.push(`${file}: models must be an array of model codes`);
  }
  if (record.device_type !== null && !Number.isSafeInteger(record.device_type)) {
    errors.push(`${file}: device_type must be an integer or null`);
  }
  if (record.alternate_device_types !== undefined) {
    if (!Array.isArray(record.alternate_device_types)) {
      errors.push(`${file}: alternate_device_types must be an array`);
    } else {
      const values = new Set();
      for (const alternate of record.alternate_device_types) {
        if (!alternate || typeof alternate !== "object" || Array.isArray(alternate)) {
          errors.push(`${file}: alternate device type must be a map`);
          continue;
        }
        if (!Number.isSafeInteger(alternate.value)) errors.push(`${file}: alternate device type value must be an integer`);
        if (alternate.value === record.device_type || values.has(alternate.value)) errors.push(`${file}: alternate device type values must be unique`);
        values.add(alternate.value);
        if (!["tested", "reported", "mixed", "declared", "unknown"].includes(alternate.status)) {
          errors.push(`${file}: alternate device type status is invalid`);
        }
        for (const key of Object.keys(alternate)) {
          if (!["value", "status", "notes"].includes(key)) errors.push(`${file}: alternate device type has unknown field ${key}`);
        }
      }
    }
  }
  if (record.notes !== undefined && (typeof record.notes !== "string" || record.notes.length === 0)) {
    errors.push(`${file}: notes must be a non-empty string`);
  }
  if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)) {
    errors.push(`${file}: capabilities must be a map`);
    return errors;
  }
  for (const [group, entries] of Object.entries(record.capabilities)) {
    if (!capabilityGroups.includes(group)) errors.push(`${file}: unknown capability group ${group}`);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      errors.push(`${file}: ${group} must be a named map`);
      continue;
    }
    for (const [name, capability] of Object.entries(entries)) {
      if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
        errors.push(`${file}: ${group}.${name} must be a map`);
        continue;
      }
      for (const key of Object.keys(capability)) {
        if (!simplifiedCapabilityFields.has(key)) errors.push(`${file}: ${group}.${name} has unknown field ${key}`);
      }
      if (!capability.connections || typeof capability.connections !== "object" || Array.isArray(capability.connections)
        || Object.keys(capability.connections).length === 0) {
        errors.push(`${file}: ${group}.${name} connections must be a non-empty map`);
      } else {
        for (const [connection, result] of Object.entries(capability.connections)) {
          if (!connectionPattern.test(connection)) errors.push(`${file}: ${group}.${name} uses invalid connection ${connection}`);
          if (!result || typeof result !== "object" || Array.isArray(result) || !supportStatuses.includes(result.status)) {
            errors.push(`${file}: ${group}.${name} has invalid result for ${connection}`);
            continue;
          }
          for (const key of Object.keys(result)) {
            if (!capabilityConnectionFields.has(key)) errors.push(`${file}: ${group}.${name}.${connection} has unknown field ${key}`);
          }
          if (result.tested_by !== undefined
            && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(result.tested_by)) {
            errors.push(`${file}: ${group}.${name}.${connection} tested_by must be a GitHub username without @`);
          }
        }
      }
      if (group === "controls" && !capability.write) errors.push(`${file}: controls.${name} must define write`);
      if (group === "readable" && !capability.read) errors.push(`${file}: readable.${name} must define read`);
      if (capability.read) {
        const hasParameter = capability.read.parameter !== undefined;
        const hasField = capability.read.field !== undefined;
        if (hasParameter === hasField) errors.push(`${file}: ${group}.${name} read must define exactly one parameter or field`);
        if (hasParameter && (!Number.isSafeInteger(capability.read.parameter) || capability.read.parameter < 1)) {
          errors.push(`${file}: ${group}.${name} read parameter must be a positive integer`);
        }
        if (hasField && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(capability.read.field)) {
          errors.push(`${file}: ${group}.${name} read field must use snake case`);
        }
      }
      if (capability.requires_parameter !== undefined
        && (!Number.isSafeInteger(capability.requires_parameter) || capability.requires_parameter < 1)) {
        errors.push(`${file}: ${group}.${name} requires_parameter must be a positive integer`);
      }
      if (capability.write) {
        const hasCommand = capability.write.command !== undefined;
        const hasAction = capability.write.action !== undefined;
        if (hasCommand === hasAction) errors.push(`${file}: ${group}.${name} write must define exactly one command or action`);
        if (hasCommand && (!Number.isSafeInteger(capability.write.command) || capability.write.command < 1)) {
          errors.push(`${file}: ${group}.${name} write command must be a positive integer`);
        }
        if (hasAction && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(capability.write.action)) {
          errors.push(`${file}: ${group}.${name} write action must use snake case`);
        }
      }
      const input = capability.write?.input;
      if (input !== undefined) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          errors.push(`${file}: ${group}.${name} write input must be a map`);
        } else {
          if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input.name ?? "")) {
            errors.push(`${file}: ${group}.${name} write input name must use snake case`);
          }
          if (input.type !== "integer") errors.push(`${file}: ${group}.${name} write input type must be integer`);
          if (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || input.minimum > input.maximum) {
            errors.push(`${file}: ${group}.${name} write input must have a valid integer range`);
          }
        }
      }
      if (capability.values !== undefined && (!capability.values || typeof capability.values !== "object" || Array.isArray(capability.values))) {
        errors.push(`${file}: ${group}.${name} values must be a map`);
      }
    }
  }
  if (record.ignored !== undefined && (!record.ignored || typeof record.ignored !== "object" || Array.isArray(record.ignored))) {
    errors.push(`${file}: ignored must be a named map`);
  }
  return errors;
}

function validateIdentityKeys(devices) {
  const errors = [];
  const recordsByPrimaryModel = new Map();
  for (const device of devices) {
    const primaryModel = deviceModels(device.record)?.[0];
    if (!primaryModel) continue;
    const key = String(primaryModel).toLowerCase();
    const records = recordsByPrimaryModel.get(key) ?? [];
    records.push(device);
    recordsByPrimaryModel.set(key, records);
  }
  for (const [primaryModel, records] of recordsByPrimaryModel) {
    for (const { file, record } of records) {
      const fileStem = deviceFileStem(file);
      if (!fileStem.startsWith(`${primaryModel}-`)) {
        errors.push(`${file}: filename must start with primary model ${primaryModel}-`);
      }
      if (records.length === 1 && record.id !== primaryModel) {
        errors.push(`${file}: unique primary model must use id ${primaryModel}`);
      }
      if (records.length > 1 && !record.id.startsWith(`${primaryModel}-`)) {
        errors.push(`${file}: shared primary model id must start with ${primaryModel}-`);
      }
    }
  }
  for (const { file, record } of devices) {
    if (deviceModels(record)?.length > 0) continue;
    const fileStem = deviceFileStem(file);
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
    deviceName(record),
    ...deviceAliases(record),
    ...(deviceModels(record) ?? []),
  ].some((value) => String(value).toUpperCase() === normalized));
}

function countCapabilities(record) {
  return Object.values(record.capabilities).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
}

function countSelectableValues(record) {
  return Object.values(record.capabilities).reduce(
    (sum, entries) => sum + Object.values(entries).reduce(
      (entrySum, entry) => entrySum + Object.keys(entry.values ?? {}).length,
      0,
    ),
    0,
  );
}

function runtimeModule(devices) {
  const records = devices
    .flatMap(({ record }) => {
      const identity = {
        id: record.id,
        name: record.name,
        category: record.category,
        models: record.models,
      };
      const primary = Number.isSafeInteger(record.device_type) ? [{
        ...identity,
        deviceType: record.device_type,
        status: record.integration.status,
        handler: record.integration.handler ?? null,
      }] : [];
      const alternates = (record.alternate_device_types ?? []).map((alternate) => ({
        ...identity,
        deviceType: alternate.value,
        status: ["tested", "reported"].includes(alternate.status) ? record.integration.status : "recognised",
        handler: ["tested", "reported"].includes(alternate.status) ? record.integration.handler ?? null : null,
      }));
      return [...primary, ...alternates];
    })
    .sort((left, right) => left.deviceType - right.deviceType || left.id.localeCompare(right.id));
  const typesForHandler = (handler) => [...new Set(records
    .filter(({ status, handler: candidate }) => candidate === handler && status !== "recognised")
    .map(({ deviceType }) => deviceType))].sort((left, right) => left - right);
  const knownNonCameraTypes = [...new Set(records
    .filter(({ category }) => !["camera", "doorbell"].includes(category))
    .map(({ deviceType }) => deviceType))]
    .filter((deviceType) => !records.some(({ category, deviceType: candidate }) => candidate === deviceType && ["camera", "doorbell"].includes(category)))
    .sort((left, right) => left - right);
  const knownCameraTypes = [...new Set(records
    .filter(({ category }) => ["camera", "doorbell"].includes(category))
    .map(({ deviceType }) => deviceType))].sort((left, right) => left - right);
  const knownHomeBaseTypes = [...new Set(records
    .filter(({ category }) => category === "homebase")
    .map(({ deviceType }) => deviceType))].sort((left, right) => left - right);
  return `/**
 * Generated runtime identity and admission data from the human-edited device catalogue.
 *
 * The catalogue generator owns this file. Provider capability modules consume
 * these immutable records and must not add device identities independently.
 */

/** One catalogue record with a confirmed numeric inventory type. */
export interface GeneratedCatalogueDevice {
  readonly deviceType: number;
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly models: readonly string[];
  readonly status: "supported" | "ready_to_test" | "recognised";
  readonly handler: "camera" | "sensor" | "homebase" | null;
}

/** Every typed device known to the contributor-maintained catalogue. */
export const GENERATED_CATALOGUE_DEVICES: readonly GeneratedCatalogueDevice[] = ${JSON.stringify(records, null, 2)} as const;

/** Device types admitted to the implemented camera handler. */
export const GENERATED_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set(${JSON.stringify(typesForHandler("camera"))});

/** Device types admitted to the implemented standalone-sensor handler. */
export const GENERATED_SENSOR_DEVICE_TYPES: ReadonlySet<number> = new Set(${JSON.stringify(typesForHandler("sensor"))});

/** Known HomeBase types evaluated by the HomeBase capability handler. */
export const GENERATED_HOMEBASE_DEVICE_TYPES: ReadonlySet<number> = new Set(${JSON.stringify(knownHomeBaseTypes)});

/** Known camera-like types, including recognised devices not yet admitted. */
export const GENERATED_KNOWN_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set(${JSON.stringify(knownCameraTypes)});

/** Known non-camera types that must not enter camera review or admission. */
export const GENERATED_NON_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set(${JSON.stringify(knownNonCameraTypes)});
`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function supportDocument(devices) {
  const rows = devices
    .map(({ record }) => record)
    .filter(({ integration }) => ["supported", "ready_to_test"].includes(integration.status))
    .sort((left, right) => left.models[0].localeCompare(right.models[0]))
    .map((record) => `| ${markdownCell(record.models.join(", "))} | ${markdownCell(record.name)} | ${record.device_type} | ${record.integration.handler} | ${record.integration.status} |`);
  return `# Generated device support catalogue

This document is generated from \`eufy_event_gateway/device_catalogue/\`. Edit the
device YAML records, then run \`npm run catalogue:generate\`. The detailed
hardware evidence and topology-specific results remain in
\`DEVICE_COMPATIBILITY_MATRIX.md\`.

| Model | Device | Type | Handler | Status |
| --- | --- | ---: | --- | --- |
${rows.join("\n")}
`;
}

async function generatedRuntimeMismatch(devices) {
  const expected = runtimeModule(devices);
  try {
    return await readFile(generatedRuntimeFile, "utf8") === expected ? null : expected;
  } catch (error) {
    if (error?.code === "ENOENT") return expected;
    throw error;
  }
}

async function generatedSupportMismatch(devices) {
  const expected = supportDocument(devices);
  try {
    return await readFile(generatedSupportFile, "utf8") === expected ? null : expected;
  } catch (error) {
    if (error?.code === "ENOENT") return expected;
    throw error;
  }
}

async function check() {
  const devices = await loadDevices();
  const ids = new Set();
  const errors = [
    ...await validateCatalogueSources(),
    ...devices.flatMap(({ file, source, record }) => validateDevice(file, source, record, ids)),
    ...validateIdentityKeys(devices),
  ];
  if (await generatedRuntimeMismatch(devices) !== null) {
    errors.push("generated runtime catalogue is stale; run npm run catalogue:generate");
  }
  if (await generatedSupportMismatch(devices) !== null) {
    errors.push("generated support catalogue is stale; run npm run catalogue:generate");
  }
  const capabilityCount = devices.reduce(
    (count, { record }) => count + countCapabilities(record),
    0,
  );
  const optionCount = devices.reduce(
    (count, { record }) => count + countSelectableValues(record),
    0,
  );
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log(JSON.stringify({ devices: devices.length, capabilities: capabilityCount, selectableValues: optionCount }));
}

async function generate() {
  const devices = await loadDevices();
  const ids = new Set();
  const errors = [
    ...await validateCatalogueSources(),
    ...devices.flatMap(({ file, source, record }) => validateDevice(file, source, record, ids)),
    ...validateIdentityKeys(devices),
  ];
  if (errors.length > 0) throw new Error(errors.join("\n"));
  await writeFile(generatedRuntimeFile, runtimeModule(devices), "utf8");
  await writeFile(generatedSupportFile, supportDocument(devices), "utf8");
  console.log(JSON.stringify({ runtime: generatedRuntimeFile, support: generatedSupportFile }));
}

async function query(model, capabilityKey) {
  const matches = findDevice(await loadDevices(), model);
  if (matches.length === 0) throw new Error(`No device matches ${model}`);
  const output = matches.map(({ file, record }) => {
    if (!capabilityKey) return { file, ...record };
    const capabilities = Object.entries(record.capabilities).flatMap(([group, entries]) => {
      const capability = entries[capabilityKey];
      return capability ? [{ group, name: capabilityKey, ...capability }] : [];
    });
    return { file, id: record.id, name: record.name, models: record.models, capabilities };
  });
  console.log(JSON.stringify(output, null, 2));
}

const [command = "check", model, capabilityKey] = process.argv.slice(2);
if (command === "check") await check();
else if (command === "generate") await generate();
else if (command === "query" && model) await query(model, capabilityKey);
else throw new Error("Usage: device-catalogue.mjs check | generate | query MODEL [CAPABILITY]");
