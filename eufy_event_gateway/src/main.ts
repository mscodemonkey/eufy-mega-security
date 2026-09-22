/**
 * Composition root for one gateway process.
 *
 * This module creates configuration, snapshot storage, normalized state, the
 * real or simulated provider, stream management, and the authenticated HTTP
 * server in dependency order. It also attaches provider callbacks and owns
 * process shutdown. It is intentionally not a home for business rules: if a
 * change needs to parse Eufy data, alter state policy, or change an endpoint,
 * it belongs in the neighbouring boundary module instead.
 */
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { GatewayState } from "./domain/gateway-state.js";
import { createLogger, getLogIdentity } from "./logging.js";
import { EufyProvider } from "./provider/eufy-provider.js";
import type { CameraProvider, ProviderEvents } from "./provider/provider.js";
import type { CaptchaProvider } from "./provider/provider.js";
import { SimulatedProvider } from "./provider/simulated-provider.js";
import { GatewayServer } from "./server.js";
import { StartupSnapshotWarmup } from "./startup-snapshot-warmup.js";
import { SnapshotStore } from "./storage/snapshot-store.js";
import { LiveStreamManager, type ViewerTranscoderSummary } from "./stream/live-stream-manager.js";

const logger = createLogger("gateway");
const providerLogger = createLogger("provider");
const processLogger = createLogger("process");
const logIdentity = getLogIdentity();

function fatal(event: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown process failure";
  processLogger.error(event, `Eufy gateway is stopping after an unexpected process failure: ${message}`, error);
  process.exit(1);
}

process.once("uncaughtException", (error) => fatal("uncaught_exception", error));
process.once("unhandledRejection", (error) => fatal("unhandled_rejection", error));
logger.info("gateway_start", `Eufy Mega Security starting with Node.js ${process.version}`);

const config = loadConfig();
const state = new GatewayState();
const snapshots = new SnapshotStore(config.dataDirectory);
await snapshots.initialize();

let simulatedProvider: SimulatedProvider | null = null;
let provider: CameraProvider;
let captchaProvider: CaptchaProvider | null = null;
if (config.provider === "simulated") {
  simulatedProvider = new SimulatedProvider();
  provider = simulatedProvider;
} else {
  if (!config.eufy.username || !config.eufy.password) {
    throw new Error("EUFY_USERNAME and EUFY_PASSWORD are required when EUFY_GATEWAY_PROVIDER=eufy");
  }
  const eufyProvider = new EufyProvider({
    username: config.eufy.username,
    password: config.eufy.password,
    country: config.eufy.country,
    persistentDirectory: join(config.dataDirectory, "eufy-client"),
    maxStreamSeconds: config.maxStreamSeconds,
    ...(config.eufy.verifyCode ? { verifyCode: config.eufy.verifyCode } : {}),
  });
  provider = eufyProvider;
  captchaProvider = eufyProvider;
}

const streams = new LiveStreamManager(state, snapshots, provider, config.streamGraceMilliseconds);
streams.on("ffmpeg-error", (detail: string) => {
  logger.warn("ffmpeg_error", `Camera media conversion reported an error: ${detail}`);
});
streams.on("warning", (error: unknown) => {
  const detail = error instanceof Error ? error.message : "Unknown media pipeline warning";
  logger.warn("media_pipeline_warning", `Camera media pipeline reported a recoverable warning: ${detail}`);
});
streams.on("viewer-transcoder-stopped", (detail: ViewerTranscoderSummary) => {
  const input = detail.inputCadence;
  const output = detail.outputCadence;
  logger.info(
    "viewer_transcoder_stopped",
    [
      "H.265 viewer conversion stopped:",
      `input_bytes=${detail.inputBytes}`,
      `output_bytes=${detail.outputBytes}`,
      `output_chunks=${detail.outputChunks}`,
      `bootstrap_ready=${detail.bootstrapReady}`,
      `input_samples=${input.samples}`,
      `input_duration_ms=${input.durationMilliseconds}`,
      `input_max_gap_ms=${input.maximumGapMilliseconds}`,
      `input_gaps_500ms=${input.gapsAtLeast500Milliseconds}`,
      `input_gaps_1000ms=${input.gapsAtLeast1000Milliseconds}`,
      `input_gaps_2000ms=${input.gapsAtLeast2000Milliseconds}`,
      `output_samples=${output.samples}`,
      `output_duration_ms=${output.durationMilliseconds}`,
      `output_max_gap_ms=${output.maximumGapMilliseconds}`,
      `output_gaps_500ms=${output.gapsAtLeast500Milliseconds}`,
      `output_gaps_1000ms=${output.gapsAtLeast1000Milliseconds}`,
      `output_gaps_2000ms=${output.gapsAtLeast2000Milliseconds}`,
      `client_backpressure_events=${detail.clientBackpressureEvents}`,
      `client_max_writable_bytes=${detail.maximumClientWritableBytes}`,
    ].join(" "),
  );
});
const startupSnapshots = new StartupSnapshotWarmup(
  (serial) => state.hasCamera(serial) && state.getCamera(serial).snapshot !== null,
  (serial) => streams.captureStartupSnapshot(serial),
  (error) => {
    const message = error instanceof Error ? error.message : "Snapshot capture failed";
    logger.warn("initial_snapshot_unavailable", `Initial camera snapshot unavailable: ${message}`);
  },
);

// Provider callbacks are the only bridge from Eufy-specific code into the
// gateway state. This keeps the HTTP server and Home Assistant API unaware of
// Mega packet formats and authentication details.
const providerEvents: ProviderEvents = {
  camera(identity) {
    state.registerCamera(identity);
    const stored = snapshots.getInfo(identity.serial);
    if (stored) state.restoreSnapshot(identity.serial, stored);
    else if (identity.streamSupported) startupSnapshots.enqueue(identity.serial);
  },
  station(station) {
    state.registerStation(station);
  },
  sensor(sensor) {
    state.registerSensor(sensor);
  },
  connection(connectionState, detail) {
    state.updateConnection(connectionState, detail);
    if (connectionState === "connected") startupSnapshots.start();
    const suffix = detail ? `: ${detail}` : "";
    if (connectionState === "error") providerLogger.error("connection_error", `Eufy connection ${connectionState}${suffix}`);
    else providerLogger.info(`connection_${connectionState.replace("-", "_")}`, `Eufy connection ${connectionState}${suffix}`);
  },
  motion(serial, detected) {
    if (state.hasCamera(serial)) state.recordMotion(serial, detected);
  },
  person(serial, detected, personName) {
    if (state.hasCamera(serial)) state.recordPerson(serial, detected, personName);
  },
  detection(serial, kind, detected) {
    if (state.hasCamera(serial)) state.recordDetection(serial, kind, detected);
  },
  doorbell(serial, pressed) {
    if (state.hasCamera(serial)) state.recordDoorbell(serial, pressed);
  },
  sensorContact(serial, open) {
    state.updateSensorContact(serial, open);
  },
  sensorMotion(serial, detected) {
    state.recordSensorMotion(serial, detected);
  },
  snapshot(serial, data, contentType) {
    if (!state.hasCamera(serial)) return;
    void snapshots.write(serial, data, contentType, "event").then((info) => state.updateSnapshot(serial, info));
  },
  pushDiagnostic(diagnostic) {
    state.recordPushDiagnostic(diagnostic);
  },
  inventory(diagnostics) {
    state.updateInventoryDiagnostics(diagnostics);
  },
  cameraCapabilities(manifests) {
    state.updateCameraCapabilities(manifests);
  },
  deviceCapabilities(manifests) {
    state.updateDeviceCapabilities(manifests);
  },
  streamStarted(serial, video, codecHint) {
    if (state.hasCamera(serial)) streams.attachSource(serial, video, codecHint);
  },
  streamStopped(serial) {
    if (state.hasCamera(serial)) streams.markStopped(serial);
  },
};

const server = new GatewayServer(config, state, snapshots, streams, provider, simulatedProvider, captchaProvider);
await server.listen();
logger.info(
  "gateway_listening",
  `Eufy gateway ${logIdentity.version} listening on http://${config.host}:${config.port} (${config.provider} provider)`,
);

void provider.start(providerEvents).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Provider failed to start";
  state.updateConnection("error", message);
  providerLogger.error("provider_start_failed", `Eufy provider failed: ${message}`);
});

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("gateway_stop", `Eufy gateway stopping: ${reason}`);
  startupSnapshots.stop();
  state.close();
  await server.close();
  await streams.close();
  await provider.close();
}

process.on("SIGINT", () => void shutdown("sigint").finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("supervisor_sigterm").finally(() => process.exit(0)));
