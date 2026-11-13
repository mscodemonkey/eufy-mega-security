/**
 * Reduces existing reply headers to fixed diagnostic observations. The session
 * owns the selected command, channel and lifetime. Provider failure logging
 * consumes these counters without changing acceptance, retries or device state.
 */

/** Declared reply protection, without keys, header values or response contents. */
export type PpcsReplyProtection = "clear" | "legacy" | "level2_short" | "level2_extended" | "unsupported" | "mixed";

/** Classify only the known protection markers, keeping all other values opaque. */
export function ppcsReplyProtection(sign: number): PpcsReplyProtection {
  return sign === 0 ? "clear" : sign === 1 ? "legacy" : sign === 2 ? "level2_short"
    : sign === 8 ? "level2_extended" : "unsupported";
}

/** Preserve disagreement between replies rather than hiding it behind the last frame. */
export function mergeReplyProtection(previous: PpcsReplyProtection | undefined, sign: number): PpcsReplyProtection {
  const current = ppcsReplyProtection(sign);
  return previous === undefined || previous === current ? current : "mixed";
}

/** Validate the closed vocabulary again before it crosses a failure-log boundary. */
export function replyProtectionSummary(value: unknown): string {
  return ["clear", "legacy", "level2_short", "level2_extended", "unsupported", "mixed"].includes(value as string)
    ? String(value) : "unobserved";
}

/** Immutable observations from one owned receipt wait, separate from physical effect. */
export interface PpcsControlReceiptEvidence {
  readonly notificationFrames: number;
  readonly selectedNotifications: number;
  readonly resultFrames: number;
  readonly selectedFrames: number;
  readonly matchingFrames: number;
  readonly decodedFrames: number;
  readonly protection?: PpcsReplyProtection;
}

/**
 * Own finite counters for one command's existing receipt wait. Foreign-channel
 * and foreign-command results cannot contribute a selected protection form.
 * Snapshot copies survive session cleanup without retaining private headers.
 */
export class PpcsControlReceiptTrace {
  #result = 0;
  #notifications = 0;
  #selectedNotifications = 0;
  #selected = 0;
  #matching = 0;
  #decoded = 0;
  #protection: PpcsReplyProtection | undefined;

  constructor(private readonly command: number, private readonly channel: number) {}

  /** Observe a result header before acceptance filters, without admitting it. */
  frame(command: number, channel: number | null, sign: number, result: boolean): void {
    if (command === 1351) {
      this.#notifications = Math.min(65_535, this.#notifications + 1);
      if (channel === this.channel) this.#selectedNotifications = Math.min(65_535, this.#selectedNotifications + 1);
    }
    if (!result) return;
    this.#result = Math.min(65_535, this.#result + 1);
    if (channel !== this.channel) return;
    this.#selected = Math.min(65_535, this.#selected + 1);
    if (command !== this.command) return;
    this.#matching = Math.min(65_535, this.#matching + 1);
    this.#protection = mergeReplyProtection(this.#protection, sign);
  }

  /** Count a readable correlated result, including an explicit device rejection. */
  decoded(): void { this.#decoded = Math.min(65_535, this.#decoded + 1); }

  /** Retain counts after the session releases its pending command and resources. */
  snapshot(): PpcsControlReceiptEvidence {
    return Object.freeze({ notificationFrames: this.#notifications, selectedNotifications: this.#selectedNotifications,
      resultFrames: this.#result, selectedFrames: this.#selected,
      matchingFrames: this.#matching, decodedFrames: this.#decoded,
      ...(this.#protection === undefined ? {} : { protection: this.#protection }) });
  }
}

/** Project fixed counts and a validated enum, ignoring arbitrary runtime fields. */
export function controlReceiptSummary(value: PpcsControlReceiptEvidence | undefined): string {
  if (!value) return "";
  const count = (n: unknown): number => typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, 65_535) : 0;
  return ` result_frames=${count(value.resultFrames)} selected_result_frames=${count(value.selectedFrames)}`
    + ` matching_result_frames=${count(value.matchingFrames)} decoded_result_frames=${count(value.decodedFrames)}`
    + ` result_protection=${replyProtectionSummary(value.protection)}`
    + ` receipt_notify_frames=${count(value.notificationFrames)} selected_receipt_notify_frames=${count(value.selectedNotifications)}`;
}
