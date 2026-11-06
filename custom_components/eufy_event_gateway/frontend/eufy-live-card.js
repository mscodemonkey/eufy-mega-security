/**
 * Eufy live view card: live video with the camera's own controls on top.
 *
 * The integration serves this file and registers it with the Home Assistant
 * frontend, so HACS users get it with the integration and install nothing
 * else. Video comes from Home Assistant's stock picture card in live mode, so
 * WebRTC, HLS and stream ownership behave exactly as on any other dashboard.
 * The controls are the integration's existing entities, found on the camera's
 * device by translation key, so a camera shows only the controls it has.
 *
 * A movement or zoom reply means the gateway accepted the request, not that
 * the camera moved. The card says so, and it never shows a requested lens
 * level as confirmed.
 */

const DOMAIN = "eufy_event_gateway";
const CARD_TYPE = "eufy-live-card";

/** Translation keys of the integration entities this card can drive. */
export const CONTROL_KEYS = Object.freeze({
  button: Object.freeze({
    nvr_left: "pan.left",
    nvr_right: "pan.right",
    nvr_up: "pan.up",
    nvr_down: "pan.down",
    nvr_zoom_1: "zoom.1",
    nvr_zoom_2: "zoom.2",
    nvr_zoom_3: "zoom.3",
    camera_ai_tracking_on: "trackingOn",
    camera_ai_tracking_off: "trackingOff",
    camera_auto_cruise_on: "cruiseOn",
    camera_auto_cruise_off: "cruiseOff",
    camera_light_on: "lightOn",
    camera_light_off: "lightOff",
    camera_preset: "preset",
    camera_preset_default: "presetDefault",
  }),
  select: Object.freeze({
    nvr_camera_view: "view",
    camera_night_vision: "night",
    camera_streaming_quality: "quality",
  }),
  switch: Object.freeze({
    camera_ai_tracking: "tracking",
    camera_auto_cruise: "cruise",
  }),
  siren: Object.freeze({
    camera_siren: "siren",
  }),
});

/** Codes the integration's client puts in "NVR control <code>" errors. */
export const FAILURE_CODES = Object.freeze(["busy", "unavailable", "rate_limited", "disabled", "outcome_unknown"]);

/** How long the S4 lens change waits for the camera's last session to close. */
export const LENS_WAIT_MS = 90000;

/** The gateway spaces NVR actions at least one second apart. */
export const ACTION_GAP_MS = 1000;

const STRINGS = {
  en: {
    camera: "Camera",
    settings: "Camera settings",
    more: "More controls",
    pan_tilt: "Pan and tilt",
    pan_tilt_short: "Pan/tilt",
    more_short: "More",
    pan_left: "Pan left",
    pan_right: "Pan right",
    pan_up: "Tilt up",
    pan_down: "Tilt down",
    back: "Back",
    night: "Night vision",
    quality: "Quality",
    quality_note: "Changing quality can restart the live view.",
    tracking: "AI tracking",
    cruise: "Auto cruise",
    presets: "Presets",
    preset_home: "Home position",
    light_on: "Light on",
    light_off: "Light off",
    turn_on: "Turn on",
    turn_off: "Turn off",
    on: "On",
    off: "Off",
    lens: "Lens",
    lens_switch: "Use the {lens} lens. Live video restarts.",
    requested: "{level} requested, not confirmed",
    siren: "Siren",
    siren_confirm: "Siren on {camera}",
    siren_sound: "Sound for 5 s",
    siren_stop: "Stop",
    cancel: "Cancel",
    play: "Start live video",
    waiting_live: "Pan and zoom work once live video is playing.",
    sending: "Sending…",
    sent_move: "Request sent. Check the picture to confirm the camera moved.",
    sent_zoom: "Request sent. Check the picture to confirm the lens changed.",
    sent_action: "Request sent. Check the camera to confirm it took effect.",
    dismiss: "Dismiss",
    confirmed: "{name}: {value}",
    unknown_move: "No confirmation came back. The camera may still have moved, so check the picture before pressing again.",
    unknown_setting: "No confirmation came back. Check the setting in Eufy before trying again.",
    busy: "The camera is busy with another request or a recording. Try again shortly.",
    rate_limited: "Too soon after the last request. Wait a moment and try again.",
    unavailable: "That control is not available on this camera right now.",
    disabled: "Camera controls are turned off in the Eufy Mega Security options.",
    failed: "That did not work: {message}",
    no_detail: "no reason was given.",
    lens_closing: "Closing the live view so the lens can change… {seconds} s",
    lens_sending: "Changing the lens…",
    lens_done: "Lens changed to {lens}. Starting live video…",
    lens_busy: "Another live view or recording is still using this camera. Close it and try again.",
    no_cameras: "No Eufy Mega Security cameras were found.",
  },
};

/** Return the card's wording for the user's language, falling back to English. */
export function strings(hass) {
  const language = hass?.locale?.language ?? hass?.language ?? "en";
  return { ...STRINGS.en, ...(STRINGS[language] ?? STRINGS[String(language).split("-")[0]] ?? {}) };
}

/** Turn a picture-card aspect ratio ("16:9", "4x3", "56.25%" or "1.78") into a CSS ratio. */
export function cssRatio(value) {
  const text = String(value ?? "").trim();
  const pair = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (pair && Number(pair[1]) > 0 && Number(pair[2]) > 0) return `${pair[1]} / ${pair[2]}`;
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent && Number(percent[1]) > 0) return `100 / ${percent[1]}`;
  return Number(text) > 0 ? text : "16 / 9";
}

/** Fill {name} placeholders in a card string. */
export function format(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** List the integration's main camera entities, sorted by their display name. */
export function eufyCameras(hass) {
  return Object.values(hass?.entities ?? {})
    .filter((entry) => entry.platform === DOMAIN && entry.entity_id.startsWith("camera.")
      && !entry.translation_key && !entry.hidden && hass.states?.[entry.entity_id])
    .map((entry) => entry.entity_id)
    .sort((a, b) => friendlyName(hass, a).localeCompare(friendlyName(hass, b)));
}

/** Return an entity's display name. */
export function friendlyName(hass, entityId) {
  return hass?.states?.[entityId]?.attributes?.friendly_name ?? entityId;
}

/**
 * Find the controls on a camera's device.
 *
 * Only available entities count: the integration withdraws availability when
 * the gateway withdraws a capability, for example zoom on the S4's Fixed lens.
 */
export function findControls(hass, cameraId) {
  const controls = { pan: {}, zoom: {}, presets: [] };
  const device = hass?.entities?.[cameraId]?.device_id;
  if (!device) return controls;
  for (const entry of Object.values(hass.entities)) {
    if (entry.device_id !== device || entry.platform !== DOMAIN) continue;
    const domain = entry.entity_id.split(".")[0];
    const role = CONTROL_KEYS[domain]?.[entry.translation_key];
    const state = hass.states?.[entry.entity_id];
    if (!role || !state || state.state === "unavailable") continue;
    if (role === "preset" || role === "presetDefault") {
      controls.presets.push({ entityId: entry.entity_id, isDefault: role === "presetDefault" });
    } else if (role.includes(".")) {
      const [group, key] = role.split(".");
      controls[group][key] = entry.entity_id;
    } else {
      controls[role] = entry.entity_id;
    }
  }
  controls.presets.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
    || friendlyName(hass, a.entityId).localeCompare(friendlyName(hass, b.entityId), undefined, { numeric: true }));
  return controls;
}

/** Read the gateway failure code from a Home Assistant service error, if it has one. */
export function failureCode(error) {
  const message = errorMessage(error);
  const match = /NVR control (busy|unavailable|rate_limited|disabled|outcome_unknown)\b/.exec(message);
  if (match) return match[1];
  return /outcome is unknown/i.test(message) ? "outcome_unknown" : null;
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  return typeof error?.message === "string" ? error.message : "";
}

/**
 * Describe a finished request.
 *
 * Kinds: "move" (pan, preset), "zoom", "action" (momentary buttons), and
 * "setting" (selects and switches, whose state the gateway confirms).
 * Tones: "sent" (accepted, not confirmed), "done" (confirmed state),
 * "unknown" (no confirmation either way) and "error" (refused).
 */
export function describeOutcome(kind, error, text, confirmed) {
  if (error === undefined) {
    if (kind === "setting") return { tone: "done", text: format(text.confirmed, confirmed ?? {}) };
    return { tone: "sent", text: kind === "move" ? text.sent_move : kind === "zoom" ? text.sent_zoom : text.sent_action };
  }
  const code = failureCode(error);
  if (code === "outcome_unknown") {
    return { tone: "unknown", text: kind === "move" || kind === "zoom" ? text.unknown_move : text.unknown_setting };
  }
  if (code) return { tone: "error", text: text[code] };
  return { tone: "error", text: format(text.failed, { message: errorMessage(error) || text.no_detail }) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Own the request flow for one card, with no DOM.
 *
 * One request runs at a time and the next waits out the gateway's action gap.
 * Nothing is retried after an uncertain reply. The only repeat is the S4 lens
 * change after "busy", which the gateway returns before it changes anything.
 */
export class LiveController {
  constructor({ callService, cameraState, startVideo, stopVideo, onChange, text, wait = sleep, now = Date.now }) {
    Object.assign(this, { callService, cameraState, startVideo, stopVideo, onChange, text, wait, now });
    this.pending = null;
    this.cooling = false;
    this.status = null;
    this.requestedZoom = new Map();
    this.lens = null;
    this._generation = 0;
  }

  /** Forget per-camera progress when the card shows a different camera. */
  reset() {
    this._generation += 1;
    this.status = null;
    this.lens = null;
    this.requestedZoom.clear();
    this.onChange();
  }

  get busy() {
    return this.pending !== null || this.cooling || this.lens !== null;
  }

  /** Press one button entity: a pan click, zoom step, preset or momentary action. */
  async press(kind, entityId, { zoomLevel, camera } = {}) {
    return this._run(kind, () => this.callService("button", "press", { entity_id: entityId }), {
      key: entityId,
      onSuccess: () => {
        if (zoomLevel !== undefined && camera) this.requestedZoom.set(camera, zoomLevel);
      },
      onFailure: () => {
        if (zoomLevel !== undefined && camera) this.requestedZoom.delete(camera);
      },
    });
  }

  /**
   * Change a setting through its select or switch entity.
   *
   * The integration returns only after the gateway confirms the new value, so
   * success reports the value that was asked for.
   */
  async setting(domain, service, data, confirmed) {
    return this._run("setting", () => this.callService(domain, service, data), { key: data.entity_id, confirmed });
  }

  /** Sound the camera siren for its default time, or stop it. */
  async siren(entityId, on) {
    return this._run("action", () => this.callService("siren", on ? "turn_on" : "turn_off", { entity_id: entityId }), { key: entityId });
  }

  async _run(kind, request, { key, confirmed, onSuccess, onFailure }) {
    if (this.busy) return false;
    const generation = this._generation;
    this.pending = key;
    this.status = { tone: "pending", text: this.text.sending };
    this.onChange();
    let outcome;
    try {
      await request();
      onSuccess?.();
      outcome = describeOutcome(kind, undefined, this.text, confirmed);
    } catch (error) {
      onFailure?.();
      outcome = describeOutcome(kind, error, this.text);
    }
    if (generation === this._generation) this.status = outcome;
    this.pending = null;
    this.cooling = true;
    this.onChange();
    await this.wait(ACTION_GAP_MS);
    this.cooling = false;
    this.onChange();
    return outcome.tone !== "error";
  }

  /**
   * Change the S4 lens (the gateway's next-source view).
   *
   * The gateway refuses a view change while any session is open, so close the
   * card's video, wait for the camera to go idle, send the change, then start
   * video again. If another viewer keeps the camera busy, say so.
   */
  async changeLens(entityId, option, lensName) {
    if (this.busy) return false;
    const generation = this._generation;
    const started = this.now();
    const deadline = started + LENS_WAIT_MS;
    const stale = () => generation !== this._generation;
    const show = (status) => {
      if (stale()) return;
      this.status = status;
      this.onChange();
    };
    this.lens = { option };
    this.requestedZoom.clear();
    this.stopVideo();
    let outcome = null;
    try {
      while (this.cameraState() === "streaming" || this.cameraState() === "recording") {
        if (stale()) return false;
        if (this.now() >= deadline) {
          outcome = { tone: "error", text: this.text.lens_busy };
          break;
        }
        show({ tone: "pending", text: format(this.text.lens_closing, { seconds: Math.round((this.now() - started) / 1000) }) });
        await this.wait(1000);
      }
      while (!outcome) {
        if (stale()) return false;
        show({ tone: "pending", text: this.text.lens_sending });
        try {
          await this.callService("select", "select_option", { entity_id: entityId, option });
          outcome = { tone: "done", text: format(this.text.lens_done, { lens: lensName }) };
        } catch (error) {
          if (failureCode(error) === "busy" && this.now() < deadline) {
            show({ tone: "pending", text: format(this.text.lens_closing, { seconds: Math.round((this.now() - started) / 1000) }) });
            await this.wait(3000);
            continue;
          }
          outcome = failureCode(error) === "busy" ? { tone: "error", text: this.text.lens_busy } : describeOutcome("setting", error, this.text);
        }
      }
    } finally {
      if (!stale()) {
        this.lens = null;
        if (outcome) this.status = outcome;
        this.startVideo();
        this.onChange();
      }
    }
    return outcome.tone === "done";
  }
}

const BaseElement = globalThis.HTMLElement ?? class {};

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; background: #000; }
  .stage { position: relative; container-type: inline-size; background: #000; color: #fff;
    --ha-card-border-radius: 0; --ha-card-border-width: 0; --ha-card-box-shadow: none; --ha-card-background: #000; }
  .video { display: block; }
  .video:empty { aspect-ratio: var(--eufy-ratio, 16 / 9); }
  .video > * { display: block; }
  .overlay { position: absolute; inset: 0; pointer-events: none; font: 500 13px/1.3 var(--ha-font-family-body, system-ui, sans-serif); }
  .overlay > * { pointer-events: auto; }
  button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button:focus-visible, select:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .4; }
  ha-icon { --mdc-icon-size: 20px; display: inline-flex; }
  .glass { background: rgba(20, 22, 26, .62); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }

  .top { position: absolute; inset: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px 22px; background: linear-gradient(rgba(0, 0, 0, .55), transparent); }
  .title { position: relative; display: inline-flex; align-items: center; gap: 2px; min-width: 0; font-size: 15px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, .6); }
  .title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title .chev { display: inline-flex; border-radius: 50%; padding: 1px; background: rgba(255, 255, 255, .16); margin-left: 4px; }
  .title .chev ha-icon { --mdc-icon-size: 16px; }
  .title select { position: absolute; inset: 0; opacity: 0; cursor: pointer; font-size: 16px; }
  .actions { display: inline-flex; gap: 2px; border-radius: 999px; padding: 2px; }
  .icon-btn { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; }
  .icon-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }

  .strip { position: absolute; right: 8px; top: 50%; transform: translateY(-58%); display: flex; flex-direction: column; gap: 2px;
    border-radius: 22px; padding: 4px 2px; }
  .strip button { display: grid; justify-items: center; gap: 1px; width: 52px; padding: 5px 0; border-radius: 16px; font-size: 10.5px; }
  .strip button[aria-pressed="true"] { background: rgba(255, 255, 255, .2); }
  .strip button:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }

  .status { position: absolute; top: 48px; left: 10px; width: max-content; max-width: calc(100% - 92px);
    display: flex; align-items: flex-start; gap: 8px; padding: 7px 12px; border-radius: 12px; font-size: 12.5px; text-align: left; }
  .status ha-icon { --mdc-icon-size: 16px; margin-top: 1px; flex: none; }
  .status.sent ha-icon { color: #8ecbff; }
  .status.done ha-icon { color: #9be59f; }
  .status.unknown ha-icon { color: #ffd479; }
  .status.error ha-icon { color: #ff8a80; }
  .status .choices { display: flex; gap: 6px; margin-top: 6px; }
  .status .choices button { padding: 4px 10px; border-radius: 999px; background: rgba(255, 255, 255, .16); }
  .status .choices button.danger { background: #c62828; }
  .spin { width: 14px; height: 14px; flex: none; margin-top: 1px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .3); border-top-color: #fff; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .pad { position: absolute; left: 10px; bottom: 10px; width: 104px; height: 104px; border-radius: 50%; display: grid;
    grid-template: 1fr 1fr 1fr / 1fr 1fr 1fr; overflow: hidden; }
  .pad button { display: grid; place-items: center; }
  .pad button:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }
  .pad .up { grid-area: 1 / 2; } .pad .left { grid-area: 2 / 1; } .pad .right { grid-area: 2 / 3; } .pad .down { grid-area: 3 / 2; }
  .pad .hub { grid-area: 2 / 2; margin: 6px; border-radius: 50%; background: rgba(0, 0, 0, .35); display: grid; place-items: center; }
  .pad button.active, .lens button.active-press { color: var(--primary-color, #03a9f4); }
  .pad ha-icon { --mdc-icon-size: 26px; }

  .lens { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; }
  .lens.beside-pad { left: 124px; transform: none; }
  .chips { display: flex; gap: 2px; border-radius: 999px; padding: 3px; }
  .chips button { min-width: 34px; height: 28px; padding: 0 9px; border-radius: 999px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .chips button:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }
  .chips button.current, .chips button.current:disabled { background: #fff; color: #111; opacity: 1; }
  .chips button.requested { box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .85); }
  .chips button.requested::after { content: "?"; font-size: 9px; vertical-align: super; margin-left: 1px; opacity: .8; }

  .hint { position: absolute; left: 50%; bottom: 48px; transform: translateX(-50%); padding: 4px 10px; border-radius: 999px; font-size: 11.5px; white-space: nowrap; }

  .menu { position: absolute; right: 66px; top: 50%; transform: translateY(-50%); width: 236px; max-width: calc(100% - 84px);
    max-height: calc(100% - 20px); overflow-y: auto; border-radius: 14px; padding: 4px 0; overscroll-behavior: contain; }
  .menu .row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 14px; text-align: left; }
  .menu .row + .row { border-top: 1px solid rgba(255, 255, 255, .08); }
  .menu .row:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
  .menu .row .label { flex: 1; min-width: 0; }
  .menu .row .value { color: rgba(255, 255, 255, .62); font-size: 12px; }
  .menu .head { font-weight: 600; }
  .menu .note { padding: 6px 14px 10px; color: rgba(255, 255, 255, .62); font-size: 11.5px; }
  .menu .check { width: 20px; }

  .play { position: absolute; inset: 0; margin: auto; width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; }
  .play ha-icon { --mdc-icon-size: 34px; }
  .empty { padding: 24px 16px; color: var(--secondary-text-color); }

  @container (max-width: 420px) {
    .pad { width: 88px; height: 88px; left: 8px; bottom: 8px; }
    .pad ha-icon { --mdc-icon-size: 22px; }
    .lens.beside-pad { left: 104px; }
    .strip button { width: 46px; font-size: 0; gap: 0; padding: 7px 0; }
    .menu { right: 58px; }
    .status { max-width: calc(100% - 80px); top: 44px; left: 8px; }
    .chips button { min-width: 30px; height: 26px; padding: 0 7px; }
  }
  @container (min-width: 720px) {
    .pad { width: 128px; height: 128px; left: 16px; bottom: 16px; }
    .pad ha-icon { --mdc-icon-size: 30px; }
    .lens { bottom: 16px; }
    .lens.beside-pad { left: 156px; }
  }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
`;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<ha-icon icon="${name}"></ha-icon>`;

/** The dashboard card: a thin view over LiveController and the stock live picture card. */
export class EufyLiveCard extends BaseElement {
  static getStubConfig(hass) {
    return { entity: eufyCameras(hass)[0] ?? "" };
  }

  static getConfigForm() {
    const camera = { entity: { filter: { integration: DOMAIN, domain: "camera" } } };
    return {
      schema: [
        { name: "entity", selector: camera },
        { name: "entities", selector: { entity: { multiple: true, filter: { integration: DOMAIN, domain: "camera" } } } },
        { name: "autoplay", selector: { boolean: {} } },
        { name: "aspect_ratio", selector: { text: {} } },
      ],
      computeLabel: (schema) => ({
        entity: "Camera",
        entities: "Cameras in the picker (leave empty for all)",
        autoplay: "Start live video when the card opens",
        aspect_ratio: "Aspect ratio",
      })[schema.name],
    };
  }

  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._camera = null;
    this._controls = { pan: {}, zoom: {}, presets: [] };
    this._ids = null;
    this._signature = "";
    this._menu = null;
    this._padOpen = true;
    this._confirm = null;
    this._live = true;
    this._videoToken = 0;
    this._statusTimer = null;
    this._controller = new LiveController({
      callService: (domain, service, data) => this._hass.callService(domain, service, data, undefined, false),
      cameraState: () => this._hass?.states?.[this._camera]?.state,
      startVideo: () => this._startVideo(),
      stopVideo: () => this._stopVideo(),
      onChange: () => this._render(true),
      text: STRINGS.en,
    });
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    if (config.entity && !String(config.entity).startsWith("camera.")) throw new Error("Choose a camera entity");
    if (config.entities !== undefined && !Array.isArray(config.entities)) throw new Error("entities must be a list of cameras");
    const changed = this._config && (config.entity !== this._config.entity || config.aspect_ratio !== this._config.aspect_ratio
      || (config.autoplay !== false) !== (this._config.autoplay !== false));
    this._config = { autoplay: true, ...config };
    this._live = this._config.autoplay !== false;
    if (changed || !this._camera) {
      this._camera = this._config.entity || this._camera || null;
      if (this._hass) this._selectCamera(this._camera || eufyCameras(this._hass)[0] || null, true);
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._controller.text = strings(hass);
    if (this._videoEl) this._videoEl.hass = hass;
    if (first || !this._camera) {
      this._selectCamera(this._camera || eufyCameras(hass)[0] || null, true);
      return;
    }
    this._render(false);
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  connectedCallback() {
    if (!this.shadowRoot) this._build();
    if (this._hass && this._camera && !this._videoEl) this._startVideo();
    this._render(true);
  }

  disconnectedCallback() {
    clearTimeout(this._statusTimer);
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><ha-card><div class="stage"><div class="video"></div><div class="overlay"></div></div></ha-card>`;
    this._videoHost = root.querySelector(".video");
    this._overlay = root.querySelector(".overlay");
    this._overlay.addEventListener("click", (event) => this._onClick(event));
    this._overlay.addEventListener("change", (event) => this._onChange(event));
  }

  _cameras() {
    const configured = (this._config?.entities ?? []).filter((id) => this._hass?.states?.[id]);
    if (configured.length) return configured;
    if (this._cameraListRef !== this._hass?.entities) {
      this._cameraListRef = this._hass?.entities;
      this._cameraList = eufyCameras(this._hass);
    }
    return this._cameraList;
  }

  _selectCamera(cameraId, force = false) {
    if (!force && cameraId === this._camera) return;
    this._camera = cameraId;
    this._menu = null;
    this._confirm = null;
    this._ids = null;
    this._live = this._config?.autoplay !== false;
    this._controller.reset();
    if (!this.shadowRoot) return;
    this._startVideo();
    this._render(true);
  }

  async _startVideo() {
    if (!this.shadowRoot || !this._hass || !this._camera) return;
    const token = ++this._videoToken;
    const config = {
      type: "picture-entity",
      entity: this._camera,
      camera_view: this._live ? "live" : "auto",
      show_name: false,
      show_state: false,
      fit_mode: "contain",
      aspect_ratio: this._config?.aspect_ratio || "16:9",
      tap_action: { action: "none" },
      hold_action: { action: "none" },
    };
    this._videoHost.style.setProperty("--eufy-ratio", cssRatio(config.aspect_ratio));
    const helpers = await window.loadCardHelpers?.();
    if (token !== this._videoToken || !helpers) return;
    const element = helpers.createCardElement(config);
    element.hass = this._hass;
    this._videoEl = element;
    this._videoHost.replaceChildren(element);
  }

  _stopVideo() {
    this._videoToken += 1;
    this._videoEl = null;
    this._videoHost?.replaceChildren();
  }

  /** Entities on the shown camera's device. The registry object changes only when entities do. */
  _relevantIds() {
    if (this._idsRef !== this._hass?.entities) {
      this._idsRef = this._hass?.entities;
      this._ids = null;
    }
    if (!this._ids) {
      const device = this._hass?.entities?.[this._camera]?.device_id;
      this._ids = Object.values(this._hass?.entities ?? {})
        .filter((entry) => device && entry.device_id === device && entry.platform === DOMAIN)
        .map((entry) => entry.entity_id);
    }
    return this._ids;
  }

  _render(force) {
    if (!this._overlay || !this._hass) return;
    const ids = this._relevantIds();
    const signature = JSON.stringify([
      this._camera, this._cameras().map((id) => [id, friendlyName(this._hass, id)]),
      this._hass.states?.[this._camera]?.state,
      ids.map((id) => [id, this._hass.states?.[id]?.state, this._hass.states?.[id]?.attributes?.options]),
    ]);
    if (!force && signature === this._signature) return;
    this._signature = signature;
    this._controls = findControls(this._hass, this._camera);
    this._overlay.innerHTML = this._camera ? this._overlayHtml() : `<div class="empty">${escapeHtml(this._controller.text.no_cameras)}</div>`;
    this._scheduleStatusClear();
  }

  _scheduleStatusClear() {
    clearTimeout(this._statusTimer);
    const status = this._controller.status;
    if (!status || status.tone === "pending" || this._controller.busy) return;
    const delay = status.tone === "sent" || status.tone === "done" ? 6000 : 15000;
    this._statusTimer = setTimeout(() => {
      if (this._controller.status === status) {
        this._controller.status = null;
        this._render(true);
      }
    }, delay);
  }

  _overlayHtml() {
    const t = this._controller.text;
    const c = this._controls;
    const hass = this._hass;
    const streaming = hass.states?.[this._camera]?.state === "streaming";
    const busy = this._controller.busy;
    const hasPan = Object.keys(c.pan).length > 0;
    const hasZoom = Object.keys(c.zoom).length > 0;
    const cameras = this._cameras();
    const parts = [];

    const cameraName = friendlyName(hass, this._camera);
    const picker = cameras.length > 1
      ? `<span class="chev">${icon("mdi:chevron-down")}</span><select data-action="camera" aria-label="${escapeHtml(t.camera)}">${cameras
        .map((id) => `<option value="${escapeHtml(id)}"${id === this._camera ? " selected" : ""}>${escapeHtml(friendlyName(hass, id))}</option>`).join("")}</select>`
      : "";
    parts.push(`<div class="top"><div class="title"><span class="name">${escapeHtml(cameraName)}</span>${picker}</div><div class="actions glass">${
      c.siren ? `<button class="icon-btn" data-action="siren" title="${escapeHtml(t.siren)}" aria-label="${escapeHtml(t.siren)}"${busy ? " disabled" : ""}>${icon("mdi:alarm-light-outline")}</button>` : ""
    }<button class="icon-btn" data-action="settings" title="${escapeHtml(t.settings)}" aria-label="${escapeHtml(t.settings)}">${icon("mdi:cog-outline")}</button></div></div>`);

    if (!this._live) {
      parts.push(`<button class="play glass" data-action="play" aria-label="${escapeHtml(t.play)}">${icon("mdi:play")}</button>`);
    }

    parts.push(`<div class="strip glass">${
      hasPan ? `<button data-action="pad" aria-pressed="${this._padOpen}" aria-label="${escapeHtml(t.pan_tilt)}">${icon("mdi:arrow-all")}<span>${escapeHtml(t.pan_tilt_short)}</span></button>` : ""
    }<button data-action="menu" aria-expanded="${this._menu !== null}" aria-label="${escapeHtml(t.more)}">${icon("mdi:dots-horizontal")}<span>${escapeHtml(t.more_short)}</span></button></div>`);

    const padShown = hasPan && this._padOpen;
    if (padShown) {
      const arrow = (dir, glyph, label) => c.pan[dir]
        ? `<button class="${dir}${this._controller.pending === c.pan[dir] ? " active" : ""}" data-action="pan" data-entity="${escapeHtml(c.pan[dir])}" aria-label="${escapeHtml(label)}"${busy || !streaming ? " disabled" : ""}>${icon(glyph)}</button>`
        : "";
      parts.push(`<div class="pad glass" role="group" aria-label="${escapeHtml(t.pan_tilt)}">${arrow("up", "mdi:menu-up", t.pan_up)}${arrow("left", "mdi:menu-left", t.pan_left)}<span class="hub">${
        this._controller.pending && Object.values(c.pan).includes(this._controller.pending) ? '<span class="spin"></span>' : ""
      }</span>${arrow("right", "mdi:menu-right", t.pan_right)}${arrow("down", "mdi:menu-down", t.pan_down)}</div>`);
    }

    const lensParts = [];
    if (c.view) {
      const view = hass.states[c.view];
      const options = view?.attributes?.options ?? [];
      if (options.length > 1) {
        lensParts.push(`<div class="chips glass" role="radiogroup" aria-label="${escapeHtml(t.lens)}">${options.map((option) => {
          const label = this._optionLabel(view, option);
          const current = option === view.state;
          const pending = this._controller.lens?.option === option;
          return `<button role="radio" aria-checked="${current}" class="${current ? "current" : ""}${pending ? " requested" : ""}" data-action="lens" data-option="${escapeHtml(option)}"${current ? "" : ` title="${escapeHtml(format(t.lens_switch, { lens: label }))}"`}${busy || current ? " disabled" : ""}>${escapeHtml(label)}</button>`;
        }).join("")}</div>`);
      }
    }
    if (hasZoom) {
      const requested = this._controller.requestedZoom.get(this._camera);
      lensParts.push(`<div class="chips glass" role="group" aria-label="${escapeHtml(t.lens)}">${Object.keys(c.zoom).sort().map((level) => {
        const isRequested = Number(level) === requested;
        const label = `${level}x`;
        return `<button class="${isRequested ? "requested" : ""}${this._controller.pending === c.zoom[level] ? " active-press" : ""}" data-action="zoom" data-level="${level}" data-entity="${escapeHtml(c.zoom[level])}"${isRequested ? ` title="${escapeHtml(format(t.requested, { level: label }))}" aria-label="${escapeHtml(format(t.requested, { level: label }))}"` : ` aria-label="${label}"`}${busy || !streaming ? " disabled" : ""}>${label}</button>`;
      }).join("")}</div>`);
    }
    if (lensParts.length) parts.push(`<div class="lens${padShown ? " beside-pad" : ""}">${lensParts.join("")}</div>`);

    if ((hasPan || hasZoom) && this._live && !streaming && !this._controller.lens) {
      parts.push(`<div class="hint glass">${escapeHtml(t.waiting_live)}</div>`);
    }

    if (this._menu !== null) parts.push(this._menuHtml());

    const status = this._confirm ? null : this._controller.status;
    if (this._confirm === "siren") {
      parts.push(`<div class="status glass unknown" role="alertdialog">${icon("mdi:alarm-light")}<div>${escapeHtml(format(t.siren_confirm, { camera: cameraName }))}<div class="choices"><button class="danger" data-action="siren-on">${escapeHtml(t.siren_sound)}</button><button data-action="siren-off">${escapeHtml(t.siren_stop)}</button><button data-action="siren-cancel">${escapeHtml(t.cancel)}</button></div></div></div>`);
    } else if (status) {
      const glyph = { sent: "mdi:send-check-outline", done: "mdi:check-circle-outline", unknown: "mdi:help-circle-outline", error: "mdi:alert-circle-outline" }[status.tone];
      const body = `${status.tone === "pending" ? '<span class="spin"></span>' : icon(glyph)}<span>${escapeHtml(status.text)}</span>`;
      parts.push(status.tone === "pending"
        ? `<div class="status glass pending" role="status" aria-live="polite">${body}</div>`
        : `<button class="status glass ${status.tone}" role="status" aria-live="polite" data-action="dismiss" title="${escapeHtml(t.dismiss)}">${body}</button>`);
    }
    return parts.join("");
  }

  _optionLabel(stateObj, option) {
    try {
      const label = this._hass.formatEntityState?.(stateObj, option);
      if (label) return label;
    } catch {

      // Older frontends have no formatter; fall back to the raw option.
    }
    return String(option).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  _shortName(entityId) {
    const name = friendlyName(this._hass, entityId);
    const device = friendlyName(this._hass, this._camera);
    return name.startsWith(`${device} `) ? name.slice(device.length + 1) : name;
  }

  _menuHtml() {
    const t = this._controller.text;
    const c = this._controls;
    const hass = this._hass;
    const busy = this._controller.busy;
    const row = (action, glyph, label, value = "", extra = "", disabled = busy) =>
      `<button class="row" data-action="${action}"${extra}${disabled ? " disabled" : ""}>${icon(glyph)}<span class="label">${escapeHtml(label)}</span>${value ? `<span class="value">${escapeHtml(value)}</span>` : ""}</button>`;
    const back = (label) => `<button class="row head" data-action="menu-back">${icon("mdi:chevron-left")}<span class="label">${escapeHtml(label)}</span></button>`;

    if (this._menu === "night" || this._menu === "quality") {
      const entityId = c[this._menu];
      const stateObj = hass.states[entityId];
      const options = stateObj?.attributes?.options ?? [];
      return `<div class="menu glass" role="menu">${back(this._menu === "night" ? t.night : t.quality)}${this._menu === "quality" ? `<div class="note">${escapeHtml(t.quality_note)}</div>` : ""}${options.map((option) =>
        `<button class="row" role="menuitemradio" aria-checked="${option === stateObj.state}" data-action="option" data-entity="${escapeHtml(entityId)}" data-option="${escapeHtml(option)}"${busy ? " disabled" : ""}><span class="check">${option === stateObj.state ? icon("mdi:check") : ""}</span><span class="label">${escapeHtml(this._optionLabel(stateObj, option))}</span></button>`).join("")}</div>`;
    }
    if (this._menu === "presets") {
      return `<div class="menu glass" role="menu">${back(t.presets)}${c.presets.map((preset) =>
        row("preset", preset.isDefault ? "mdi:home-map-marker" : "mdi:map-marker-outline", preset.isDefault ? t.preset_home : this._shortName(preset.entityId), "", ` data-entity="${escapeHtml(preset.entityId)}"`)).join("")}</div>`;
    }
    if (this._menu === "tracking" || this._menu === "cruise") {
      const on = c[`${this._menu}On`], off = c[`${this._menu}Off`];
      return `<div class="menu glass" role="menu">${back(this._menu === "tracking" ? t.tracking : t.cruise)}${
        on ? row("action", "mdi:toggle-switch-outline", t.turn_on, "", ` data-entity="${escapeHtml(on)}"`) : ""}${
        off ? row("action", "mdi:toggle-switch-off-outline", t.turn_off, "", ` data-entity="${escapeHtml(off)}"`) : ""}</div>`;
    }

    const rows = [];
    const stateLabel = (entityId) => this._optionLabel(hass.states[entityId], hass.states[entityId]?.state);
    if (c.night) rows.push(row("submenu", "mdi:weather-night", t.night, stateLabel(c.night), ' data-menu="night"', false));
    if (c.quality) rows.push(row("submenu", "mdi:high-definition-box", t.quality, stateLabel(c.quality), ' data-menu="quality"', false));
    for (const [key, label, glyph] of [["tracking", t.tracking, "mdi:target-account"], ["cruise", t.cruise, "mdi:camera-control"]]) {
      if (c[key]) {
        const on = hass.states[c[key]]?.state === "on";
        rows.push(row("toggle", glyph, label, on ? t.on : t.off, ` data-entity="${escapeHtml(c[key])}" data-on="${on}"`));
      } else if (c[`${key}On`] || c[`${key}Off`]) {
        rows.push(row("submenu", glyph, label, "", ` data-menu="${key}"`, false));
      }
    }
    if (c.presets.length) rows.push(row("submenu", "mdi:map-marker-outline", t.presets, String(c.presets.length), ' data-menu="presets"', false));
    if (c.lightOn) rows.push(row("action", "mdi:lightbulb-on-outline", t.light_on, "", ` data-entity="${escapeHtml(c.lightOn)}"`));
    if (c.lightOff) rows.push(row("action", "mdi:lightbulb-off-outline", t.light_off, "", ` data-entity="${escapeHtml(c.lightOff)}"`));
    rows.push(row("settings", "mdi:cog-outline", t.settings, "", "", false));
    return `<div class="menu glass" role="menu">${rows.join("")}</div>`;
  }

  _onChange(event) {
    if (event.target?.dataset?.action === "camera") this._selectCamera(event.target.value);
  }

  _onClick(event) {
    const target = event.target.closest?.("button[data-action]");
    if (!target || target.disabled) return;
    const { action, entity, option, level, menu } = target.dataset;
    const controller = this._controller;
    switch (action) {
      case "settings":
        this._menu = null;
        this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: this._camera }, bubbles: true, composed: true }));
        break;
      case "play":
        this._live = true;
        this._startVideo();
        break;
      case "pad":
        this._padOpen = !this._padOpen;
        break;
      case "menu":
        this._menu = this._menu === null ? "main" : null;
        break;
      case "menu-back":
        this._menu = "main";
        break;
      case "submenu":
        this._menu = menu;
        break;
      case "pan":
        controller.press("move", entity);
        return;
      case "zoom":
        controller.press("zoom", entity, { zoomLevel: Number(level), camera: this._camera });
        return;
      case "preset":
        this._menu = null;
        controller.press("move", entity);
        return;
      case "action":
        this._menu = null;
        controller.press("action", entity);
        return;
      case "option": {
        const name = this._menu === "night" ? controller.text.night : controller.text.quality;
        this._menu = null;
        controller.setting("select", "select_option", { entity_id: entity, option }, {
          name, value: this._optionLabel(this._hass.states[entity], option),
        });
        return;
      }
      case "toggle": {
        const on = target.dataset.on === "true";
        this._menu = null;
        controller.setting("switch", on ? "turn_off" : "turn_on", { entity_id: entity }, {
          name: this._shortName(entity), value: on ? controller.text.off : controller.text.on,
        });
        return;
      }
      case "lens": {
        const view = this._hass.states[this._controls.view];
        controller.changeLens(this._controls.view, option, this._optionLabel(view, option));
        return;
      }
      case "siren":
        this._menu = null;
        this._confirm = "siren";
        break;
      case "siren-on":
      case "siren-off":
        this._confirm = null;
        controller.siren(this._controls.siren, action === "siren-on");
        return;
      case "siren-cancel":
        this._confirm = null;
        break;
      case "dismiss":
        controller.status = null;
        break;
      default:
        return;
    }
    this._render(true);
  }
}

if (globalThis.customElements && !customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, EufyLiveCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TYPE,
    name: "Eufy live view",
    description: "Live video with pan, zoom, lens and camera controls on top.",
    preview: false,
    documentationURL: "https://github.com/mscodemonkey/eufy-mega-security/blob/main/docs/LIVE_VIEW_CARD.md",
  });
}
