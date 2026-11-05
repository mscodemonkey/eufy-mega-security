/**
 * Owns preparation, PIN accounting and retirement of a private general RTC lease.
 * EufyProvider owns admission and its parent reservation. The manual HTTP route
 * owns the isolated recorder. No observations here enter shared device state.
 */
import type { PassThrough } from "node:stream";
import type { MegaClient } from "../mega/client.js";
import type { MegaInventory } from "../mega/types.js";
import { GeneralRtcError, type GeneralRtcStage } from "../stream/general-rtc-protocol.js";
import { GeneralRtcSession, type GeneralRtcSessionOptions } from "../stream/general-rtc-session.js";
import { HOMEBASE_DEVICE_TYPES } from "./homebase-capability-core.js";
import { isSupportedCameraType } from "./device-capabilities-core.js";
import type { MegaInventoryDevice } from "./eufy-provider.js";

/** Minimal immutable device facts compared before and after the private clip. */
export interface GeneralRtcBinding {
  readonly child: { readonly serial: string; readonly model: string; readonly type: number; readonly category: string;
    readonly parent: string; readonly channel: number; readonly administrator: string };
  readonly parent: { readonly serial: string; readonly model: string; readonly type: number; readonly category: string; readonly administrator: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawParent(row: Record<string, unknown>): string {
  const values = [row.parent_sn, row.station_sn].filter(value => value !== undefined && value !== null && value !== "");
  if (values.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    || new Set(values).size > 1) throw new GeneralRtcError("inventory", "topology");
  return values[0] as string | undefined ?? String(row.device_sn);
}

/** Validate raw ownership and duplicate topology before accepting normalized facts. */
export function generalRtcBinding(inventory: MegaInventory, serial: string, userId: string,
  normalize: (inventory: MegaInventory) => readonly MegaInventoryDevice[]): GeneralRtcBinding {
  const rows = inventory.devices;
  const children = rows.filter(row => row.device_sn === serial);
  if (children.length !== 1) throw new GeneralRtcError("inventory", "topology");
  const child = children[0]!;
  const parentSerial = rawParent(child);
  const parents = rows.filter(row => row.device_sn === parentSerial);
  if (parents.length !== 1) throw new GeneralRtcError("inventory", "topology");
  const parent = parents[0]!;
  const administrator = child.member?.admin_user_id;
  if (typeof administrator !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(administrator)
    || administrator !== userId || parent.member?.admin_user_id !== administrator) throw new GeneralRtcError("inventory", "ownership");
  const channel = child.device_channel ?? child.channel;
  if (!Number.isInteger(channel) || channel! < 0 || channel! > 254
    || child.device_channel !== undefined && child.channel !== undefined && child.device_channel !== child.channel) throw new GeneralRtcError("inventory", "topology");
  for (const row of rows) {
    if (row === child) continue;
    const owner = rawParent(row);
    if (parentSerial === serial && owner === serial
      || parentSerial !== serial && owner === parentSerial && (row.device_channel ?? row.channel) === channel) throw new GeneralRtcError("inventory", "topology");
  }
  const normalized = normalize(inventory);
  const c = normalized.find(row => row.serial === serial), p = normalized.find(row => row.serial === parentSerial);
  if (!c || !p || !isSupportedCameraType(c) || c.deviceType === null || p.deviceType === null
    || c.category !== "eufy_security" || p.category !== "eufy_security"
    || parentSerial !== serial && !HOMEBASE_DEVICE_TYPES.has(p.deviceType)
    || (p.model === "T8N00" && p.deviceType === 300) || (p.model === "T9000" && p.deviceType === 27)
    || c.model === "T8224" && c.deviceType === 96
    || !/^[A-Za-z0-9_-]{1,128}$/.test(serial) || !/^[A-Za-z0-9_-]{1,128}$/.test(parentSerial)) throw new GeneralRtcError("inventory", "topology");
  return { child: { serial, model: c.model, type: c.deviceType, category: c.category, parent: parentSerial,
    channel: channel!, administrator }, parent: { serial: parentSerial, model: p.model, type: p.deviceType,
    category: p.category, administrator } };
}

/**
 * Process-owned advisory PIN limiter, reset only by a confirmed success or restart.
 * It retains at most eight users, never evicts a lockout and uses a monotonic clock.
 */
export class GeneralRtcPinLimiter {
  readonly #users = new Map<string, { at: number; failures: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Refuse current cooldowns and lockouts without allocating state or sending a PIN. */
  check(user: string): void {
    const state = this.#users.get(user);
    if (state?.failures === 3) throw new GeneralRtcError("locked");
    if (state && this.now() - state.at < 60_000) throw new GeneralRtcError("cooldown");
    if (!state && this.#users.size >= 8 && ![...this.#users.values()].some(row => row.failures < 3 && this.now() - row.at >= 60_000)) {
      throw new GeneralRtcError([...this.#users.values()].every(row => row.failures === 3) ? "locked" : "cooldown");
    }
  }

  /** Begin cooldown at actual fetch dispatch, leaving the outcome pending. */
  dispatch(user: string): void {
    this.check(user);
    if (!this.#users.has(user) && this.#users.size >= 8) {
      const oldest = [...this.#users].filter(([, row]) => row.failures < 3 && this.now() - row.at >= 60_000)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) throw new GeneralRtcError("cooldown");
      this.#users.delete(oldest[0]);
    }
    this.#users.set(user, { at: this.now(), failures: this.#users.get(user)?.failures ?? 0 });
  }

  /** Count exactly one dispatched rejection, including ambiguous transport failures. */
  reject(user: string): void {
    const state = this.#users.get(user);
    if (state) state.failures = Math.min(3, state.failures + 1);
  }

  /** Reset consecutive rejections only after Eufy confirms code zero. */
  confirm(user: string): void {
    const state = this.#users.get(user);
    if (state) state.failures = 0;
  }
}

/** Prepared callbacks retain the parent lease through the final ownership recheck. */
export interface PreparedGeneralRtcTrial {

  /** Stop media only, allowing the private recorder to retire its source before rechecking. */
  stop(): Promise<void>;

  /** Recheck fresh inventory and hub flags once, discarding media on any change. */
  verify(): Promise<void>;
}

/** Closure-owned provider handle used solely by the private diagnostic recorder. */
export interface GeneralRtcTrialLease {

  /** Check fresh ownership and preflight, then send at most one consented PIN request. */
  prepare(pin: string): Promise<PreparedGeneralRtcTrial>;

  /** Attach only the private recorder and start the already prepared socket call once. */
  start(ready: (output: PassThrough) => void): Promise<void>;

  /** Cancel work and retire this lease's parent reservation, including on provider shutdown. */
  release(stage?: GeneralRtcStage): Promise<void>;
}

/** Provider-owned hooks contain all shared state and reservation side effects. */
export interface GeneralRtcTrialOptions {
  readonly client: MegaClient;
  readonly initial: GeneralRtcBinding;
  readonly limiter: GeneralRtcPinLimiter;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly normalize: (inventory: MegaInventory) => readonly MegaInventoryDevice[];

  /** Release only the symbol captured by this lease, never a replacement operation's token. */
  readonly releaseReservation: () => void;

  /** Remove this exact retired handle from the provider's active-lease map. */
  readonly retired: () => void;
  readonly now?: () => number;

  /** Offline fixtures replace the socket-owning constructor without changing production calls. */
  readonly createSession?: (options: GeneralRtcSessionOptions) => GeneralRtcSession;
}

/**
 * Owns one default-off preparation and call until explicit release or shutdown.
 * Parent reservation stays held after media stops and through final readback.
 * Every network request uses the existing client queue with a closed endpoint.
 */
export class GeneralRtcTrial implements GeneralRtcTrialLease {
  readonly #controller = new AbortController();
  readonly #account;
  readonly #now: () => number;
  readonly #deadline: NodeJS.Timeout;
  readonly #bindingTimer: NodeJS.Timeout;
  #prepared = false;
  #started = false;
  #retired = false;
  #failure: GeneralRtcError | null = null;
  #session: GeneralRtcSession | null = null;
  #ready: ((output: PassThrough) => void) | null = null;
  #closing: Promise<void> | null = null;
  readonly #abort = (): void => { void this.release("cancelled").catch(() => undefined); };

  constructor(private readonly options: GeneralRtcTrialOptions) {
    this.#account = options.client.generalRtcAccount()!;
    this.#now = options.now ?? (() => performance.now());
    this.#deadline = setTimeout(() => { void this.release("deadline").catch(() => undefined); }, 175_000);
    this.#bindingTimer = setInterval(() => {
      try { this.#check(); } catch { void this.release("binding").catch(() => undefined); }
    }, 1_000);
    options.signal.addEventListener("abort", this.#abort, { once: true });
  }

  #check(): void {
    if (this.#failure) throw this.#failure;
    if (this.#retired || this.options.signal.aborted || this.#controller.signal.aborted) throw new GeneralRtcError("cancelled");
    const current = this.options.client.generalRtcAccount();
    if (!this.options.current() || !current || current.token !== this.#account.token || current.securityHost !== this.#account.securityHost
      || current.cipher?.bindingKey !== this.#account.cipher?.bindingKey) throw new GeneralRtcError("binding", "binding");
  }

  async #inventory(signal: AbortSignal): Promise<GeneralRtcBinding> {
    this.#check();
    const inventory = await this.options.client.generalRtcInventory(signal);
    this.#check();
    return generalRtcBinding(inventory, this.options.initial.child.serial, this.#account.userId, this.options.normalize);
  }

  async #hubs(signal: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    let matched = 0, supported = false;
    for (let page = 0; page <= 4; page++) {
      this.#check();
      const rows = await this.options.client.generalRtcHubs(page, signal);
      this.#check();
      if (rows.length > 100) throw new GeneralRtcError("inventory", "shape");
      for (const row of rows) {
        if (!record(row) || typeof row.station_sn !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.station_sn)
          || seen.has(row.station_sn)) throw new GeneralRtcError("inventory", "topology");
        seen.add(row.station_sn);
        if (row.station_sn === this.options.initial.parent.serial) {
          matched++; supported = row.is_support_web_rtc_stream === true || row.is_support_web_rtc_stream === 1;
        }
      }
      if (rows.length < 100) {
        if (matched !== 1 || !supported) throw new GeneralRtcError("inventory", "rtc_flag");
        return;
      }
    }
    throw new GeneralRtcError("inventory", "shape");
  }

  /** Prepare once before the recorder starts its startup timeout, without forcing authentication. */
  async prepare(pin: string): Promise<PreparedGeneralRtcTrial> {
    if (this.#prepared || !/^[\x20-\x7e]{1,32}$/.test(pin)) throw new GeneralRtcError("admission");
    this.#prepared = true;
    const at = this.#now(), deadline = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any([this.#controller.signal, this.options.signal, deadline]);
    try {
      const binding = await this.#inventory(signal);
      if (JSON.stringify(binding) !== JSON.stringify(this.options.initial)) throw new GeneralRtcError("binding", "binding");
      await this.#hubs(signal);
      const params = await this.options.client.generalRtcParams(signal);
      this.#check();
      if (params.length) {
        const first = params[0];
        if (!record(first) || typeof first.param_value !== "string" || Buffer.byteLength(first.param_value) > 8192) throw new GeneralRtcError("preflight", "shape");
        let value: unknown;
        try { value = JSON.parse(first.param_value); } catch { throw new GeneralRtcError("preflight", "shape"); }
        if (!record(value)) throw new GeneralRtcError("preflight", "shape");
        const prefixes = value.need_start_pn;
        if (prefixes !== undefined && prefixes !== null && prefixes !== "") {
          if (!Array.isArray(prefixes) || prefixes.length > 64 || prefixes.some(prefix => typeof prefix !== "string" || prefix.length < 1 || prefix.length > 32)) throw new GeneralRtcError("preflight", "shape");
          if (prefixes.some(prefix => this.options.initial.parent.serial.startsWith(prefix))) throw new GeneralRtcError("preflight_required");
        }
      }
      if (this.#now() - at > 30_000 || signal.aborted) throw new GeneralRtcError("budget", "timeout");
      this.#check();
      let dispatched = false;
      try {
        await this.options.client.generalRtcVerifyPin(pin, signal, () => {
          this.#check(); this.options.limiter.dispatch(this.#account.userId); dispatched = true;
        });
        this.options.limiter.confirm(this.#account.userId);
      } catch (error) {
        if (dispatched) this.options.limiter.reject(this.#account.userId);
        throw error;
      }
      this.#check();
      const sign = await this.options.client.generalRtcSign(signal);
      this.#check();
      const create = this.options.createSession ?? (options => new GeneralRtcSession(options));
      this.#session = create({ host: this.#account.smartHost!, token: this.#account.token, sign, pin,
        parent: binding.parent.serial, child: binding.child.serial, administrator: binding.child.administrator,
        channel: binding.child.channel, cipher: this.#account.cipher!, signal: this.#controller.signal,
        current: () => { try { this.#check(); return true; } catch { return false; } },
        ready: output => { this.#check(); if (!this.#ready) throw new GeneralRtcError("video"); this.#ready(output); },
      });
      let verified = false;
      return {
        stop: async () => { await this.#session?.close(); },
        verify: async () => {
          if (verified) throw new GeneralRtcError("admission");
          verified = true;
          const limit = AbortSignal.timeout(30_000);
          const recheck = AbortSignal.any([this.#controller.signal, this.options.signal, limit]);
          try {
            const fresh = await this.#inventory(recheck);
            await this.#hubs(recheck);
            this.#check();
            if (JSON.stringify(fresh) !== JSON.stringify(binding)) throw new GeneralRtcError("binding", "binding");
          } catch (error) {
            if (limit.aborted) throw new GeneralRtcError("budget", "timeout");
            throw error instanceof GeneralRtcError ? error : new GeneralRtcError("inventory", "response");
          }
        },
      };
    } catch (error) {
      if (this.#failure) throw this.#failure;
      if (this.options.signal.aborted) throw new GeneralRtcError("cancelled");
      if (deadline.aborted) throw new GeneralRtcError("budget", "timeout");
      throw error instanceof GeneralRtcError ? error : new GeneralRtcError("inventory", "response");
    }
  }

  /** Start the prepared session once with an isolated recorder callback. */
  async start(ready: (output: PassThrough) => void): Promise<void> {
    this.#check();
    if (!this.#session || this.#started) throw new GeneralRtcError("admission");
    this.#started = true; this.#ready = ready;
    await this.#session.start();
  }

  /** Cancel this lease and release only its parent reservation after bounded media cleanup. */
  release(stage: GeneralRtcStage = "cancelled"): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#failure ??= new GeneralRtcError(stage);
    this.#retired = true;
    clearTimeout(this.#deadline); clearInterval(this.#bindingTimer);
    this.options.signal.removeEventListener("abort", this.#abort);
    this.#controller.abort();
    this.#closing = (async () => {
      try { await this.#session?.close(); }
      finally { this.options.releaseReservation(); this.options.retired(); }
    })();
    return this.#closing;
  }
}
