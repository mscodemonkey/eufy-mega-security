/**
 * Observes existing datagrams during one read-only PPCS query. The session owns
 * its lifetime and selected channel. Failure logs consume only fixed counters,
 * never sequence numbers, identifiers, commands, names or response contents.
 */

/** Fixed notification decode stages. No stage carries response bytes or identities. */
export type PpcsControlDecodeOutcome = "clear" | "legacy" | "unsupported" | "key_unavailable"
  | "authentication_failed" | "authenticated_unreadable" | "authenticated_json";

/** Immutable progress at failure time, without a claim that hardware applied a request. */
export interface PpcsQueryEvidence {
  readonly sent: boolean;
  readonly acknowledged: boolean;
  readonly notifications: number;
  readonly selectedNotifications: number;

  /** Selected notifications with authenticated decryption and a readable JSON object. */
  readonly authenticatedNotifications: number;
  readonly matchingNotifications: number;

  /** Selected-channel decode stages, when the decoder was instrumented for this query. */
  readonly decodeOutcomes?: Readonly<Partial<Record<PpcsControlDecodeOutcome, number>>>;
}

/**
 * Own counters for a single query until its session retires. Observations never
 * send packets, retry requests, extend deadlines or admit a response. Transport
 * acknowledgements prove receipt only. Command matching is separate from the
 * caller's full query correlation and validation.
 */
export class PpcsQueryTrace {
  #sequence: number | null = null;
  #acknowledged = false;
  #notifications = 0;
  #selected = 0;
  #authenticated = 0;
  #matching = 0;
  #decodeOutcomes: Partial<Record<PpcsControlDecodeOutcome, number>> = {};

  constructor(private readonly channel: number) {}

  /** Pin the outgoing datagram solely to recognise its existing transport acknowledgement. */
  sent(sequence: number): void { this.#sequence = sequence; }

  /** Ignore acknowledgements for unrelated commands on this connection. */
  acknowledge(sequence: number): void {
    if (this.#sequence !== null && this.#sequence === sequence) this.#acknowledged = true;
  }

  /** Count readable notification progress without retaining decoded content or foreign channels. */
  notification(channel: number | null, authenticated: boolean, matching: boolean, outcome?: PpcsControlDecodeOutcome): void {
    this.#notifications = Math.min(65_535, this.#notifications + 1);
    if (channel !== this.channel) return;
    this.#selected = Math.min(65_535, this.#selected + 1);
    if (authenticated) this.#authenticated = Math.min(65_535, this.#authenticated + 1);
    if (matching) this.#matching = Math.min(65_535, this.#matching + 1);
    if (outcome) this.#decodeOutcomes[outcome] = Math.min(65_535, (this.#decodeOutcomes[outcome] ?? 0) + 1);
  }

  /** Copy the observation so later packets cannot change an already reported failure. */
  snapshot(): PpcsQueryEvidence {
    return Object.freeze({ sent: this.#sequence !== null, acknowledged: this.#acknowledged,
      notifications: this.#notifications, selectedNotifications: this.#selected,
      authenticatedNotifications: this.#authenticated, matchingNotifications: this.#matching,
      ...(Object.keys(this.#decodeOutcomes).length ? { decodeOutcomes: Object.freeze({ ...this.#decodeOutcomes }) } : {}) });
  }
}

/** Format only fixed fields, including when an invalid runtime object reaches a caller. */
export function ppcsQueryEvidenceSummary(value: PpcsQueryEvidence | undefined): string {
  if (!value) return "";
  const count = (n: unknown): number => typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, 65_535) : 0;
  return ` query_sent=${value.sent === true} query_acked=${value.acknowledged === true}`
    + ` notify_frames=${count(value.notifications)} selected_notify_frames=${count(value.selectedNotifications)}`
    + ` authenticated_notify_frames=${count(value.authenticatedNotifications)} matching_notify_frames=${count(value.matchingNotifications)}`
    + (value.decodeOutcomes ? (["clear", "legacy", "unsupported", "key_unavailable", "authentication_failed",
      "authenticated_unreadable", "authenticated_json"] as const)
      .map(stage => ` notify_decode_${stage}=${count(value.decodeOutcomes?.[stage])}`).join("") : "");
}
