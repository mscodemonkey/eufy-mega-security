/**
 * Exact live-start bindings from the November 14 and 19 Android model indexes.
 * Only public catalogue model codes with one resolved binding are included.
 * These strings describe static handlers and never dispatch commands.
 */
const bindings: ReadonlyMap<string, readonly string[]> = new Map([
  ["OpenLiveStreamParser", ["T8111", "T8112", "T8113", "T8140", "T8142", "T8152", "T8161", "T8203"]],
  ["OpenLiveStreamParser1350_V3", ["T8110", "T8110E", "T8144", "T814X", "T814XS", "T817L", "T8210", "T8210C", "T8214", "T8220", "T8531", "T8E00", "T8N00", "T8P10"]],
  ["OpenLiveStreamParser1350_V3 (v1)", ["T86P2"]],
  ["OpenLiveStreamParser1350_V3 (v2)", ["T8170", "T8201"]],
  ["OpenLiveStreamParser1350_V3 (v3)", ["T8420"]],
  ["OpenLiveStreamParser1350_V3 (v4)", ["T8530"]],
  ["OpenLiveStreamParser1350_V3 (v6)", ["T8172", "T8215", "T8404"]],
  ["OpenLiveStreamParser1350_V3 (v8)", ["T8223", "T8224"]],
  ["OpenLiveStreamParser1700_V2", ["T8400", "T8410", "T8414", "T8419", "T8441", "T8W11"]],
  ["OpenLiveStreamParser1700_V3", ["T81A0", "T8423", "T8426", "T8452", "T84A1", "T9000"]],
  ["OpenLiveStreamParser1700_V4", ["T8122", "T8123", "T8124", "T8130", "T8131", "T8134", "T8160", "T8162", "T8171", "T8173", "T8410C", "T8417", "T8425", "T8790", "T8B00", "T8W11C"]],
  ["OpenLiveStreamParser1700_V5", ["T8213"]],
]);

/** Look up the independently identified handler without substituting a related model. */
export function liveBinding(model: string): string | undefined {
  for (const [handler, models] of bindings) {
    if (models.includes(model)) return handler;
  }
  return undefined;
}

const operationModels: ReadonlyMap<string, readonly string[]> = new Map([
  ["Detection sensitivity", [
    "T8110", "T8110E", "T8111", "T8112", "T8113", "T8122", "T8123", "T8124", "T8130", "T8131",
    "T8134", "T814X", "T814XS", "T8170", "T8171", "T8173", "T817L", "T8214", "T8215", "T8223",
    "T8224", "T8400", "T8410", "T8410C", "T8420", "T8425", "T8426", "T86P2", "T8B00", "T8E00",
    "T8P10", "T8W11",
  ]],
  ["Event playback", [
    "T8110", "T8110E", "T8111", "T8112", "T8113", "T8122", "T8123", "T8124", "T8130", "T8131",
    "T8134", "T8140", "T8142", "T8144", "T814X", "T814XS", "T8152", "T8160", "T8161", "T8162",
    "T8170", "T8171", "T8172", "T8173", "T817L", "T81A0", "T8201", "T8203", "T8210", "T8210C",
    "T8213", "T8214", "T8215", "T8220", "T8223", "T8224", "T8400", "T8404", "T8410", "T8410C",
    "T8414", "T8417", "T8419", "T8420", "T8423", "T8425", "T8426", "T8441", "T8452", "T84A1",
    "T8530", "T8531", "T8600", "T86P2", "T8790", "T8B00", "T8W11", "T8W11C",
  ]],
  ["Live quality", [
    "T8110", "T8110E", "T8111", "T8112", "T8140", "T8142", "T814X", "T814XS", "T8160", "T8162",
    "T8170", "T8171", "T8173", "T817L", "T8214", "T8215", "T8223", "T8224", "T8400", "T8410",
    "T8410C", "T8414", "T8416", "T8417", "T8423", "T8425", "T8426", "T86P2", "T8E00", "T8P10",
    "T8W11C",
  ]],
  ["Motion detection", [
    "T8110", "T8110E", "T814X", "T814XS", "T8172", "T817L", "T8400", "T8404", "T8410", "T8410C",
    "T8419", "T8420", "T8W11",
  ]],
  ["Night vision", [
    "T8110", "T8110E", "T8111", "T8112", "T8124", "T8130", "T8131", "T8144", "T814X", "T814XS",
    "T8162", "T8170", "T8171", "T8172", "T8173", "T817L", "T81A0", "T8201", "T8214", "T8215",
    "T8223", "T8224", "T8400", "T8404", "T8410", "T8410C", "T8414", "T8419", "T8420", "T8423",
    "T84A1", "T8531", "T8E00", "T8P10", "T8W11", "T8W11C",
  ]],
  ["Security mode", [
    "T8010", "T8023", "T8025", "T8026", "T8030", "T8110", "T8110E", "T8111", "T8112", "T8113",
    "T8122", "T8123", "T8124", "T8130", "T8131", "T8134", "T8140", "T8142", "T8144", "T814X",
    "T814XS", "T8152", "T8160", "T8161", "T8162", "T8170", "T8171", "T8172", "T8173", "T817L",
    "T81A0", "T8201", "T8203", "T8210", "T8210C", "T8213", "T8214", "T8215", "T8220", "T8223",
    "T8224", "T8400", "T8404", "T8410", "T8410C", "T8414", "T8416", "T8417", "T8419", "T8420",
    "T8423", "T8425", "T8426", "T8441", "T8452", "T84A1", "T8531", "T8600", "T86P2", "T8B00",
    "T8E00", "T8N00", "T8P10", "T8W11", "T8W11C", "T9000",
  ]],
  ["Speaker volume", [
    "T8110", "T8110E", "T8113", "T8140", "T8142", "T8144", "T814X", "T814XS", "T8160", "T8161",
    "T8162", "T817L", "T8425", "T8426", "T86P2", "T8E00", "T8P10",
  ]],
  ["Spotlight", [
    "T8110", "T8110E", "T814X", "T814XS", "T8170", "T8171", "T8173", "T817L", "T8214", "T8215",
    "T8420", "T8425", "T8426", "T86P2", "T8E00", "T8P10",
  ]],
  ["Storage status", [
    "T8010", "T8025", "T8030", "T8110", "T8110E", "T814X", "T814XS", "T817L", "T8215", "T8416",
    "T86P2", "T8N00", "T9000",
  ]],
  ["Talkback", [
    "T8110", "T8110E", "T8111", "T8112", "T8113", "T8122", "T8123", "T8124", "T8130", "T8131",
    "T8134", "T8140", "T8142", "T8144", "T814X", "T814XS", "T8152", "T8160", "T8161", "T8162",
    "T8170", "T8171", "T8172", "T8173", "T817L", "T81A0", "T8201", "T8203", "T8210", "T8210C",
    "T8213", "T8214", "T8215", "T8220", "T8223", "T8224", "T8400", "T8404", "T8410", "T8410C",
    "T8414", "T8417", "T8419", "T8420", "T8423", "T8425", "T8426", "T8441", "T8452", "T84A1",
    "T8530", "T8531", "T8600", "T86P2", "T8790", "T8B00", "T8E00", "T8N00", "T8P10", "T8W11",
    "T8W11C",
  ]],
  ["Thumbnail", [
    "T8025", "T8030", "T8172", "T81A0", "T8214", "T8215", "T8223", "T8224", "T8404", "T86P2",
    "T8E00", "T8N00", "T8P10", "T9000",
  ]],
]);

/** Return reviewed operation bindings as source evidence, independent of gateway admission. */
export function referenceOperations(model: string): string[] {
  return [...operationModels].filter(([, models]) => models.includes(model)).map(([operation]) => operation);
}
