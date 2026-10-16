/**
 * Projects the maintained catalogue into public website data and pure filters.
 * The build owns input validation; browser pages consume only this safe model.
 */

/** Public navigation groups, including every maintained catalogue category. */
export const CATEGORIES = Object.freeze([
  { id: 'cameras', name: 'Cameras', types: ['camera'], image: 'solocam-s340' },
  { id: 'doorbells', name: 'Doorbells', types: ['doorbell'], image: 'doorbell-e340' },
  { id: 'homebases', name: 'HomeBases', types: ['homebase', 'hub_adjacent', 'nvr'], image: 'homebase-3' },
  { id: 'locks', name: 'Locks', types: ['smart_lock'], image: 'category-lock' },
  { id: 'sensors', name: 'Sensors', types: ['security_sensor'], image: 'motion-sensor' },
  { id: 'accessories', name: 'Accessories', types: ['siren', 'keypad', 'remote', 'smart_drop', 'smart_safe', 'tracker', 'chime', 'passive_accessory'], image: 'minibase-chime' },
]);

/** Evidence labels preserve the distinction between declaration and testing. */
export const EVIDENCE = Object.freeze({
  tested: { label: 'Confirmed', symbol: '✓', description: 'This feature has been tested on a real device with this connection.' },
  reported: { label: 'Reported', symbol: '≡', description: "Someone has reported that this works with their setup. We haven't checked it ourselves yet." },
  mixed: { label: 'Mixed results', symbol: '±', description: 'This works for some people, but others have had problems with this connection.' },
  declared: { label: 'Needs testing', symbol: '!', description: "This feature is listed for this device, but we haven't checked it with Home Assistant yet." },
  failing: { label: 'Not working', symbol: '!', description: 'This feature was tried with this connection and did not work.' },
  unsupported: { label: 'Not available', symbol: '−', description: 'This feature is not available with this connection.' },
  unknown: { label: 'Unconfirmed', symbol: '?', description: "We don't yet know whether this feature works with this connection." },
});

/** Admission labels describe entity creation without promising all features. */
export const ADMISSION = Object.freeze({
  supported: 'Integrated', ready_to_test: 'Ready to test', recognised: 'Catalogue only',
});

/** User-facing sections for device features. */
export const GROUPS = Object.freeze({ media: 'Pictures & video', events: 'Events', controls: 'Settings & actions', readable: 'Device information' });

const deviceTypeNames = Object.freeze({
  camera: 'camera', doorbell: 'doorbell', homebase: 'HomeBase', hub_adjacent: 'hub', nvr: 'NVR',
  smart_lock: 'lock', security_sensor: 'sensor', siren: 'siren', keypad: 'keypad', remote: 'remote',
  smart_drop: 'delivery box', smart_safe: 'safe', tracker: 'tracker', chime: 'chime', passive_accessory: 'accessory',
});

const labels = {
  lock_state: 'Lock status', lock: 'Lock', unlock: 'Unlock', auto_lock: 'Auto-lock', auto_lock_timer: 'Auto-lock delay',
  sound_volume: 'Sound volume', notifications: 'Notifications', locked_notifications: 'Lock notifications', unlocked_notifications: 'Unlock notifications',
  live_view: 'Live view', snapshot: 'Snapshots', recording: 'Recordings', recordings: 'Recordings',
  clip: 'Video clips', motion: 'Motion events', person: 'Person events', pet: 'Pet events',
  vehicle: 'Vehicle events', doorbell: 'Doorbell presses', battery_level: 'Battery level',
  battery_charging: 'Battery charging', battery_temperature: 'Battery temperature',
  current_mode: 'Guard mode', station_current_mode: 'Effective guard mode',
  pan_tilt: 'Pan and tilt', pan_and_tilt: 'Pan and tilt', enabled: 'Device enabled',
  ai_tracking: 'AI tracking', motion_detection: 'Motion detection', night_vision: 'Night vision',
};

/** Escape catalogue content for HTML text and quoted attributes. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** JSON islands cannot terminate their script element or inject markup. */
export function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Normalize search text without depending on the browser's locale. */
export function searchText(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

/** Produce a readable feature label without exposing numeric protocol fields. */
export function featureLabel(key) {
  return labels[key] ?? key.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
}

/** Validate and copy only approved public fields from one catalogue record. */
export function projectDevice(record) {
  const category = CATEGORIES.find(group => group.types.includes(record.category));
  if (!category || !Object.hasOwn(ADMISSION, record.integration?.status) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id)) {
    throw new Error('Invalid public catalogue identity, category or admission');
  }
  const features = [];
  for (const group of Object.keys(GROUPS)) {
    for (const [key, feature] of Object.entries(record.capabilities?.[group] ?? {})) {
      const connections = Object.entries(feature.connections ?? {}).map(([id, entry]) => {
        if (!/^(?:direct|T[A-Z0-9]+)$/.test(id) || !Object.hasOwn(EVIDENCE, entry.status)) throw new Error('Invalid connection evidence');
        const date = entry.tested_on;
        if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid evidence date');
        return { id, status: entry.status, ...(date ? { testedOn: date } : {}) };
      });
      features.push({ key: `${group}:${key}`, label: featureLabel(key), group, connections });
    }
  }
  return {
    id: record.id, name: String(record.name), models: [...(record.models ?? [])], aliases: [...(record.aliases ?? [])],
    category: record.category, categoryId: category.id, admission: record.integration.status, features,
  };
}

/** Source-listed connection choices; absence never invents a supported route. */
export function deviceConnections(device) {
  return [...new Set(device.features.flatMap(feature => feature.connections.map(connection => connection.id)))].sort((a, b) => a === 'direct' ? -1 : b === 'direct' ? 1 : a.localeCompare(b));
}

/** Label hubs from catalogue identities, retaining model codes for precision. */
export function connectionLabel(id, device, devices = []) {
  if (id === 'direct') return ['homebase', 'hub_adjacent', 'nvr'].includes(device?.category) ? 'Device itself' : 'Direct';
  const hub = devices.find(item => item.categoryId === 'homebases' && item.models.includes(id));
  return hub ? `${hub.name} (${id})` : id;
}

/** Match every selected evidence facet on one feature and connection pair. */
export function matchesDevice(device, filters = {}) {
  const { category = '', query = '', connection = '', feature = '', evidence = '' } = filters;
  if (category && device.categoryId !== category) return false;
  const words = searchText(query).trim().split(/\s+/).filter(Boolean);
  const haystack = searchText([device.id, device.name, ...device.models, ...device.aliases].join(' '));
  if (!words.every(word => haystack.includes(word))) return false;
  if (!connection && !feature && !evidence) return true;
  return device.features.some(item => (!feature || item.key === feature) && item.connections.some(pair =>
    (!connection || pair.id === connection) && (!evidence || pair.status === evidence)));
}

/** Stable catalogue order puts admitted devices first and tested evidence next. */
export function compareDevices(a, b) {
  const admission = device => device.admission === 'recognised' && device.id !== 't85f1' ? 1 : 0;
  const tested = device => device.features.flatMap(item => item.connections).filter(item => item.status === 'tested').length;
  return admission(a) - admission(b) || tested(b) - tested(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Absent evidence is unconfirmed, and distinct from explicit unavailability. */
export function featureEvidence(feature, connection) {
  return feature.connections.find(pair => pair.id === connection) ?? { id: connection, status: 'unknown' };
}

/** Keep static and interactive feature explanations and date labels identical. */
export function statusDescription(pair) {
  const dateLabel = pair.status === 'tested' ? 'Last checked' : pair.status === 'reported' ? 'Last reported' : 'Last updated';
  return `${EVIDENCE[pair.status].description}${pair.testedOn ? ` ${dateLabel} ${pair.testedOn}.` : ''}`;
}

/** Describe tested features separately from entity creation and opt-in trials. */
export function deviceStatus(device) {
  if (device.id === 't85f1') return { label: 'Experimental', symbol: '!', style: 'experimental' };
  if (device.admission === 'recognised') {
    const type = Object.hasOwn(deviceTypeNames, device.category) ? deviceTypeNames[device.category] : 'device';
    return { label: `Own this ${type}? Help with testing.`, symbol: '−', style: 'unsupported' };
  }
  if (device.features.some(feature => feature.connections.some(pair => pair.status === 'tested'))) return { label: 'Tested features', symbol: '✓', style: 'tested' };
  return { label: 'Needs testing', symbol: '!', style: 'declared' };
}
