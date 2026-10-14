/**
 * Owns the opt-in E30 inventory, operation leases and polling lifecycle.
 * EufyProvider supplies authenticated inventory and credentials. This registry
 * publishes only normalized lock facts to GatewayState, retires stale bindings
 * before cancellation, and never reports broker acceptance as physical state.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { MegaDevice } from "../mega/types.js";
import { maskSmartLockState, isE30LockSettingChange, type E30LockSettingChange, type SmartLockSettings, type SmartLockState } from "../domain/types.js";
import { createLogger } from "../logging.js";
import { bounded, E30MqttSession, E30_STATUS_QUERY_TIMEOUT_MS } from "./e30-lock-mqtt.js";
import { E30LockError, validateE30Identity, type E30LockIdentity, type E30MqttCredentials, type E30Observation, type E30SettingsObservation, type E30AudibleVolume, type E30NotificationSetting, parseE30NotificationMode } from "./e30-lock-protocol.js";

const logger = createLogger("e30-lock");

/** Experimental polling cadence; cache GETs never wake the lock. */
export const E30_LOCK_POLL_MS = 300_000;

/**
 * Exact-model enum admitted by two independent settled queries per value,
 * each matched to an owner physical confirmation on the off-door E30.
 */
export const E30_LOCK_STATE_CODES: { readonly locked: number; readonly unlocked: number } | null = { locked: 4, unlocked: 3 };

/** Narrow owned session boundary, allowing failure/race tests without network access. */
export interface E30LockSession {
  open(): Promise<void>;
  query(): Promise<E30Observation>;
  actuate(locked: boolean, onDispatch: () => void): Promise<void>;
  querySettings?(): Promise<E30SettingsObservation>;
  setSoundVolume?(volume: E30AudibleVolume, onDispatch: () => void): Promise<void>;
  setAutoLock?(enabled: boolean, onDispatch: () => void): Promise<void>;
  setNotification?(setting: E30NotificationSetting, enabled: boolean, currentMode: number, onDispatch: () => void): Promise<void>;
  close(): void;
}

/** Provider-owned dependencies; callbacks receive no protocol or credential fields. */
export interface E30LockProviderOptions {
  readonly freshDevices?: () => Promise<readonly MegaDevice[]>;
  readonly credentials: () => Promise<E30MqttCredentials>;
  readonly changed: (locks: readonly SmartLockState[]) => void;

  /** Current account's acting display name, kept private and used only inside encrypted commands. */
  readonly accountName?: string;
  readonly session?: (identity: E30LockIdentity, credentials: E30MqttCredentials, signal: AbortSignal) => E30LockSession;

  /** Synthetic enum admission for isolated tests; production uses the hardware-evidenced constant. */
  readonly stateCodes?: { readonly locked: number; readonly unlocked: number };
}

/**
 * One opt-in lock registry per EufyProvider generation. It owns operation
 * controllers and its polling timer. close() retires everything synchronously;
 * late credential reads or device replies cannot publish state or commands.
 */
export class E30LockProvider {
  readonly #identities = new Map<string, E30LockIdentity>();
  readonly #states = new Map<string, SmartLockState>();
  readonly #operations = new Map<string, AbortController>();
  readonly #lastRefresh = new Map<string, number>();
  readonly #lastWrite = new Map<string, number>();
  readonly #rawStates = new Map<string, number>();
  #lastNotificationRead = 0;
  #inventoryConfirmed = true;
  #closed = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #stateCodes: { readonly locked: number; readonly unlocked: number } | null;

  constructor(private readonly options: E30LockProviderOptions) {
    this.#stateCodes = options.stateCodes ? { ...options.stateCodes } : E30_LOCK_STATE_CODES;
  }

  /** Replace exact-model bindings from successful cloud inventory without blocking camera startup. */
  inventory(devices: readonly MegaDevice[], initial = false): void {
    if (this.#closed) return;
    if (!initial && devices.length === 0) {
      this.#inventoryConfirmed = false;
      for (const controller of this.#operations.values()) controller.abort();
      for (const serial of this.#states.keys()) this.#invalidate(serial);
      this.#emit();
      return;
    }
    this.#inventoryConfirmed = true;
    const next = new Map<string, E30LockIdentity>();
    for (const row of devices) {
      const identity = e30InventoryIdentity(row, this.options.accountName);
      if (row.device_model === "T85F1" && row.device_type === 206 && !identity) {
        const member = row.member as Record<string, unknown> | undefined;
        logger.info("e30_lock_admission", `admitted=false serial_length=${row.device_sn.length} owner_present=${typeof member?.admin_user_id === "string"} short_id_present=${typeof member?.short_user_id === "string"} name_present=${Boolean(this.options.accountName || member?.nick_name)} self_parent=${!row.parent_sn || row.parent_sn === row.device_sn} self_station=${!row.station_sn || row.station_sn === row.device_sn}`);
      }
      if (identity) next.set(identity.serial, identity);
    }
    for (const [serial, previous] of this.#identities) {
      if (JSON.stringify(previous) === JSON.stringify(next.get(serial))) continue;
      this.#operations.get(serial)?.abort();
      this.#identities.delete(serial); this.#states.delete(serial); this.#rawStates.delete(serial);
    }
    const added: string[] = [];
    for (const [serial, identity] of next) {
      if (!this.#identities.has(serial)) added.push(serial);
      this.#identities.set(serial, identity);
      if (!this.#states.has(serial)) this.#states.set(serial, { serial, name: identity.name, model: "T85F1",
        state: "unknown", available: false, batteryPercent: null, stateObservedAt: null });
    }
    this.#emit();
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.#poll([...this.#identities.keys()]); }, E30_LOCK_POLL_MS);
      this.#timer.unref();
    }
    void this.#poll(added);
  }

  /** Return cache snapshots only, suppressing stale state without opening MQTT. */
  list(): SmartLockState[] {
    return [...this.#states.values()].map(state => maskSmartLockState(state));
  }

  /** Explicit read-only refresh; repeated calls are throttled and never queued. */
  async refresh(serial: string, signal?: AbortSignal): Promise<SmartLockState> {
    return this.#operate(serial, undefined, signal);
  }

  /** Actuate once from freshly queried prestate, then confirm with independent queries. */
  async setLocked(serial: string, locked: boolean, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState> {
    if (!this.#stateCodes || this.#identities.size !== 1) throw new E30LockError("unavailable");
    return this.#operate(serial, locked, signal, onDispatch);
  }

  /** Share motor authority, lease and throttle for one closed settings operation. */
  async setSetting(serial: string, change: E30LockSettingChange, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState> {
    if (!isE30LockSettingChange(change) || !this.#stateCodes || this.#identities.size !== 1) throw new E30LockError("unavailable");
    return this.#operate(serial, change, signal, onDispatch);
  }

  /** Retire authority and all sockets before the composition root awaits other cleanup. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const controller of this.#operations.values()) controller.abort();
    this.#identities.clear(); this.#states.clear();
  }

  async #operate(serial: string, desired?: boolean | E30LockSettingChange, externalSignal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState> {
    const identity = this.#identities.get(serial);
    if (!identity || this.#closed || !this.#inventoryConfirmed) throw new E30LockError("unavailable");
    if (this.#operations.size) throw new E30LockError("busy");
    const throttle = desired === undefined ? this.#lastRefresh : this.#lastWrite;
    if (Date.now() - (throttle.get(serial) ?? 0) < 10_000) throw new E30LockError("rate_limited");
    const changingSettings = typeof desired === "object";
    const deadline = Date.now() + (changingSettings ? 90_000 : 45_000);
    const reserve = changingSettings ? (desired.setting === "autoLock" ? 35_000 : 30_000)
      : desired !== undefined ? 20_000 : 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(changingSettings ? 90_000 : 45_000)]);
    const read = <T>(work: Promise<T>, limit: number): Promise<T> => {
      const remaining = deadline - Date.now() - reserve;
      if (remaining <= 0) {

        // Callers have already started this read. Retiring it must not leave an orphaned rejection.
        void work.catch(() => undefined);
        throw new E30LockError("unavailable");
      }
      return bounded(work, signal, Math.min(limit, remaining));
    };
    let dispatched = false;
    const externalAbort = (): void => { if (!dispatched) controller.abort(); };
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    this.#operations.set(serial, controller);
    if (desired === undefined) this.#lastRefresh.set(serial, Date.now());
    let session: E30LockSession | undefined;
    let stage: "credentials" | "connect" | "query" | "write" | "readback" = "credentials";
    const check = (): void => {
      if (signal.aborted || this.#closed || this.#identities.get(serial) !== identity || !this.#inventoryConfirmed) throw new E30LockError("unavailable");
    };
    try {
      const credentials = await read(this.options.credentials(), 30_000);
      check();
      if (desired !== undefined && !identity.administrator && identity.adminUserId !== credentials.userId) throw new E30LockError("unavailable");
      session = this.options.session?.(identity, credentials, signal) ?? new E30MqttSession(identity, credentials, signal);
      stage = "connect";
      await read(session.open(), 45_000); check();
      stage = "query";
      const before = await read(session.query(), E30_STATUS_QUERY_TIMEOUT_MS); check();
      let state = this.#observe(identity, before);
      if (desired === undefined) {
        await this.#refreshSettings(identity, session, signal, check);
        return maskSmartLockState(this.#states.get(serial)!);
      }
      if (typeof desired === "object") {
        stage = "write";
        return await this.#changeSettings(identity, session, desired, signal, deadline, check, read,
          () => { check(); dispatched = true; this.#lastWrite.set(serial, Date.now()); onDispatch?.(); });
      }
      if (state.state === "unknown") {
        this.#invalidate(serial); this.#emit();
        throw new E30LockError("unavailable");
      }
      if ((state.state === "locked") === desired) return state;
      stage = "write";
      const motorBudget = (): void => { if (deadline - Date.now() < 20_000) throw new E30LockError("unavailable"); };
      motorBudget();
      await bounded(session.actuate(desired, () => { check(); motorBudget(); dispatched = true; this.#lastWrite.set(serial, Date.now()); onDispatch?.(); }), signal, 3_000);
      stage = "readback";
      const start = Date.now();

      // The provider caps the complete readback window even though a transport status read permits longer.
      for (const at of [3_000, 8_000, 13_000]) {
        await delay(Math.max(0, start + at - Date.now()), undefined, { signal }); check();
        const observation = await bounded(session.query(), signal, Math.max(1, start + 15_000 - Date.now())); check();
        state = this.#observe(identity, observation);
        if (state.state === (desired ? "locked" : "unlocked")) return state;
      }
      throw new E30LockError("outcome_unknown");
    } catch (error) {
      if (!this.#closed && this.#identities.get(serial) === identity) {
        logger.warn("e30_lock_operation_unavailable", `stage=${stage} dispatched=${dispatched}`);
        if (changingSettings) {
          if (dispatched) this.#clearSettings(serial);
        } else if (desired === undefined || dispatched) this.#invalidate(serial);
        this.#emit();
      }
      if (dispatched) throw new E30LockError("outcome_unknown");
      throw error instanceof E30LockError ? error : new E30LockError("unavailable");
    } finally {
      controller.abort(); session?.close();
      externalSignal?.removeEventListener("abort", externalAbort);
      if (this.#operations.get(serial) === controller) this.#operations.delete(serial);
    }
  }

  async #mode(identity: E30LockIdentity, signal: AbortSignal, check: () => void): Promise<number> {
    if (!this.options.freshDevices) throw new E30LockError("unavailable");
    const rows = (await bounded(this.options.freshDevices(), signal, 20_000))
      .filter(row => row.device_model === "T85F1" && row.device_type === 206);
    check();
    if (rows.length !== 1 || JSON.stringify(e30InventoryIdentity(rows[0]!, this.options.accountName)) !== JSON.stringify(identity)) throw new E30LockError("unavailable");
    const mode = parseE30NotificationMode(rows[0]!.params);
    if (mode === null) throw new E30LockError("unavailable");
    return mode;
  }

  #settings(serial: string, patch: Partial<SmartLockSettings>): SmartLockState {
    const state = this.#states.get(serial);
    if (!state) throw new E30LockError("unavailable");
    const settings: SmartLockSettings = { volume: null, autoLock: null, notifications: null, lockedNotifications: null,
      unlockedNotifications: null, observedAt: null, notificationsObservedAt: null, ...state.settings, ...patch };
    this.#states.set(serial, { ...state, settings }); this.#emit();
    return maskSmartLockState(this.#states.get(serial)!);
  }

  #deviceSettings(identity: E30LockIdentity, value: E30SettingsObservation): void {
    this.#settings(identity.serial, { volume: value.volume, autoLock: value.autoLockEnabled, observedAt: new Date().toISOString() });
  }

  #notificationSettings(identity: E30LockIdentity, mode: number): void {
    this.#settings(identity.serial, { notifications: Boolean(mode & 1), unlockedNotifications: Boolean(mode & 2),
      lockedNotifications: Boolean(mode & 4), notificationsObservedAt: new Date().toISOString() });
  }

  async #refreshSettings(identity: E30LockIdentity, session: E30LockSession, signal: AbortSignal, check: () => void): Promise<void> {
    if (session.querySettings) {
      try { const value = await bounded(session.querySettings(), signal, 5_000); check(); this.#deviceSettings(identity, value); }
      catch { check(); this.#settings(identity.serial, { volume: null, autoLock: null, observedAt: null }); }
    }
    if (this.options.freshDevices && Date.now() - this.#lastNotificationRead >= 60_000) {
      this.#lastNotificationRead = Date.now();
      try { const mode = await this.#mode(identity, signal, check); check(); this.#notificationSettings(identity, mode); }
      catch { check(); this.#settings(identity.serial, { notifications: null, lockedNotifications: null, unlockedNotifications: null, notificationsObservedAt: null }); }
    }
  }

  async #changeSettings(identity: E30LockIdentity, session: E30LockSession, change: E30LockSettingChange,
    signal: AbortSignal, deadline: number, check: () => void,
    read: <T>(work: Promise<T>, limit: number) => Promise<T>, dispatch: () => void): Promise<SmartLockState> {
    if (this.#rawStates.get(identity.serial) !== this.#stateCodes?.locked || !session.querySettings) throw new E30LockError("unavailable");
    const first = await read(session.querySettings(), 5_000); check(); this.#deviceSettings(identity, first);
    const second = await read(session.querySettings(), 5_000); check(); this.#deviceSettings(identity, second);
    const observed = performance.now();
    const same = (value: E30SettingsObservation): boolean => first.compareStableFields(second, value, "sound").unchanged
      && first.compareStableFields(second, value, "autoLock").unchanged;
    if (first.autoLockEnabled === null || second.autoLockEnabled === null || !same(second)) throw new E30LockError("unavailable");
    const notification = change.setting !== "volume" && change.setting !== "autoLock";
    let mode: number | undefined, desiredMode: number | undefined, modeObserved = 0;
    if (notification) {
      mode = await read(this.#mode(identity, signal, check), 20_000); check(); modeObserved = performance.now();
      this.#notificationSettings(identity, mode);
      const mask = change.setting === "notifications" ? 1 : change.setting === "unlockedNotifications" ? 2 : 4;
      desiredMode = change.value ? mode | mask : mode & ~mask;
      if (mode === desiredMode) return maskSmartLockState(this.#states.get(identity.serial)!);
    } else if (change.setting === "volume" ? second.volume === change.value : second.autoLockEnabled === change.value) {
      return maskSmartLockState(this.#states.get(identity.serial)!);
    }
    let started = 0;
    const onDispatch = (): void => {
      check();
      if (deadline - Date.now() < 30_000 || performance.now() - observed >= 10_000
        || (notification && performance.now() - modeObserved >= 10_000)) throw new E30LockError("unavailable");
      dispatch(); started = Date.now();
    };
    if (change.setting === "volume" && session.setSoundVolume) await session.setSoundVolume(change.value, onDispatch);
    else if (change.setting === "autoLock" && session.setAutoLock) await session.setAutoLock(change.value, onDispatch);
    else if (notification && session.setNotification) await session.setNotification(change.setting as E30NotificationSetting, change.value as boolean, mode!, onDispatch);
    else throw new E30LockError("unavailable");
    let confirmed = false;
    for (const at of [3_000, 8_000, 13_000]) {
      await delay(Math.max(0, started + at - Date.now()), undefined, { signal }); check();
      const remaining = started + 15_000 - Date.now();
      if (remaining <= 0) throw new E30LockError("outcome_unknown");
      if (notification) {
        const after = await bounded(this.#mode(identity, signal, check), signal, remaining); check();
        this.#notificationSettings(identity, after);
        if (after === desiredMode) { confirmed = true; break; }
        if (after !== mode) throw new E30LockError("outcome_unknown");
      } else {
        const after = await bounded(session.querySettings(), signal, remaining); check(); this.#deviceSettings(identity, after);
        const comparison = first.compareStableFields(second, after, change.setting === "volume" ? "sound" : "autoLock");
        if (!comparison.unchanged) throw new E30LockError("outcome_unknown");
        if ((change.setting === "volume" ? after.volume : after.autoLockEnabled) === change.value) { confirmed = true; break; }
      }
    }
    if (!confirmed) throw new E30LockError("outcome_unknown");
    if (notification) {
      const after = await bounded(session.querySettings(), signal, 5_000); check();
      if (!same(after)) throw new E30LockError("outcome_unknown"); this.#deviceSettings(identity, after);
    }
    const status = await bounded(session.query(), signal, 5_000); check();
    if (status.rawState !== this.#stateCodes?.locked) throw new E30LockError("outcome_unknown");
    return this.#observe(identity, status);
  }

  #clearSettings(serial: string): void {
    if (this.#states.get(serial)?.settings) this.#settings(serial, { volume: null, autoLock: null, notifications: null,
      lockedNotifications: null, unlockedNotifications: null, observedAt: null, notificationsObservedAt: null });
  }

  #observe(identity: E30LockIdentity, observation: E30Observation): SmartLockState {
    const codes = this.#stateCodes;
    const state: SmartLockState = { ...this.#states.get(identity.serial), serial: identity.serial, name: identity.name, model: "T85F1",
      state: codes && observation.rawState === codes.locked ? "locked"
        : codes && observation.rawState === codes.unlocked ? "unlocked" : "unknown",
      available: true, batteryPercent: observation.batteryPercent, stateObservedAt: new Date().toISOString() };
    if (this.#rawStates.get(identity.serial) !== observation.rawState) {
      logger.info("e30_lock_observed", `raw_state=${observation.rawState} battery_percent=${observation.batteryPercent ?? "unknown"}`);
      this.#rawStates.set(identity.serial, observation.rawState);
    }
    this.#states.set(identity.serial, state); this.#emit();
    return maskSmartLockState(state);
  }

  #invalidate(serial: string): void {
    this.#clearSettings(serial);
    const state = this.#states.get(serial);
    if (state) this.#states.set(serial, { ...state, state: "unknown", available: false, batteryPercent: null });
  }

  #emit(): void { if (!this.#closed) this.options.changed(this.list()); }

  async #poll(serials: readonly string[]): Promise<void> {
    for (const serial of serials) {
      if (this.#closed) return;
      if (this.#operations.size) continue;
      try { await this.refresh(serial); }
      catch { if (!this.#closed) logger.warn("e30_lock_read_unavailable", "E30 state query unavailable"); }
    }
  }
}

/** Project an exact standalone route and minimal private membership from untrusted inventory. */
export function e30InventoryIdentity(row: MegaDevice, accountName?: string): E30LockIdentity | null {
  if (row.device_model !== "T85F1" || row.device_type !== 206 || typeof row.device_sn !== "string"
    || (row.parent_sn && row.parent_sn !== row.device_sn) || (row.station_sn && row.station_sn !== row.device_sn)) return null;
  const member = row.member as Record<string, unknown> | undefined;
  if (!member) return null;
  const identity: E30LockIdentity = { serial: row.device_sn, name: row.device_name ?? "Smart Lock E30",
    adminUserId: typeof member.admin_user_id === "string" ? member.admin_user_id : "",
    shortUserId: typeof member.short_user_id === "string" ? member.short_user_id : "",
    userName: accountName || (typeof member.nick_name === "string" ? member.nick_name : ""),
    administrator: member.member_type === 1 || member.member_type === 2 };
  try { validateE30Identity(identity, false); return identity; } catch { return null; }
}
