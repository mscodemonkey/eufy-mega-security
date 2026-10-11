/**
 * Provides the process-wide support logging boundary for the gateway.
 *
 * The app launcher owns the release version and may supply a run identifier;
 * this module supplies safe fallbacks for local development. Gateway modules
 * create component loggers and emit single-purpose events through them. Every
 * physical output line carries enough context to order copied logs and assign
 * it to one release and process invocation.
 */
import { randomUUID } from "node:crypto";

/** Severity levels written to the Home Assistant app log. */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** Runtime identity shared by every component logger in one process. */
export interface LogIdentity {
  readonly version: string;
  readonly runId: string;
}

/** Injectable formatting values used by tests and the runtime emitter. */
export interface LogLineInput extends LogIdentity {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly message: string;
}

/** A component-scoped writer for diagnostic events safe for support logs. */
export interface GatewayLogger {

  /** Record routine lifecycle or state information. */
  info(event: string, message: string): void;

  /** Record a recoverable condition that may need investigation. */
  warn(event: string, message: string): void;

  /** Record a failed operation or fatal process condition. */
  error(event: string, message: string, error?: unknown): void;
}

const diagnosticObservers = new Set<(component: string, event: string, level: LogLevel) => void>();

/** Subscribe to event codes only. The session owner must unsubscribe on cleanup. */
export function observeLogEvents(observer: (component: string, event: string, level: LogLevel) => void): () => void {
  diagnosticObservers.add(observer);
  return () => { diagnosticObservers.delete(observer); };
}

const identity: LogIdentity = {
  version: safeToken(process.env.EUFY_GATEWAY_VERSION, "development"),
  runId: safeToken(process.env.EUFY_GATEWAY_RUN_ID, randomUUID().slice(0, 8)),
};

/** Return the release and process identifiers used by the active logger. */
export function getLogIdentity(): LogIdentity {
  return identity;
}

/**
 * Create a logger whose lines identify one stable gateway component.
 *
 * Callers provide event names and already-safe human-readable messages. The
 * logger deliberately does not accept arbitrary metadata objects because API
 * responses can contain credentials, signed URLs, or device identities.
 */
export function createLogger(component: string): GatewayLogger {
  const safeComponent = safeToken(component, "gateway");
  return {
    info: (event, message) => emit("INFO", safeComponent, event, message),
    warn: (event, message) => emit("WARN", safeComponent, event, message),
    error: (event, message, error) => {
      emit("ERROR", safeComponent, event, message);
      for (const frame of safeStackFrames(error)) emit("ERROR", safeComponent, `${event}_stack`, frame);
    },
  };
}

/** Format one complete, single-line support log record. */
export function formatLogLine(input: LogLineInput): string {
  const prefix = [
    safeTimestamp(input.timestamp),
    input.level,
    `version=${safeToken(input.version, "unknown")}`,
    `run=${safeToken(input.runId, "unknown")}`,
    `component=${safeToken(input.component, "gateway")}`,
    `event=${safeToken(input.event, "message")}`,
  ].join(" ");
  return `${prefix} ${safeMessage(input.message)}`;
}

function emit(level: LogLevel, component: string, event: string, message: string): void {
  const line = formatLogLine({
    timestamp: new Date().toISOString(),
    level,
    version: identity.version,
    runId: identity.runId,
    component,
    event,
    message,
  });
  for (const observer of diagnosticObservers) {

    // Diagnostic failures must never replace the operation being logged.
    try { observer(component, safeToken(event, "message"), level); } catch {}
  }
  const output = level === "WARN" || level === "ERROR" ? process.stderr : process.stdout;
  output.write(`${line}\n`);
}

function safeStackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  return error.stack.split(/\r?\n/).slice(1, 21).map((line) => line.trim()).filter(Boolean);
}

function safeTimestamp(value: string): string {
  return Number.isNaN(Date.parse(value)) ? new Date(0).toISOString() : value;
}

function safeToken(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  return normalized || fallback;
}

function safeMessage(value: string): string {
  const normalized = value.trim().replaceAll(/[\r\n\t]+/g, " ");
  const redacted = normalized
    .replaceAll(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replaceAll(/(\b(?:access_token|auth|credential|key|password|signature|token)=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(/("(?:access_token|auth|credential|key|password|signature|token)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  return redacted.slice(0, 2_000) || "No detail supplied";
}
