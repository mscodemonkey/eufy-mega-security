/**
 * Builds reviewed, privacy-checked GitHub reports without sending any requests.
 * The browser owns drafts in memory; only visitor actions transfer a report.
 */

/** The only permitted destination for a prepared support report. */
export const ISSUE_URL = 'https://github.com/mscodemonkey/eufy-mega-security/issues/new';

/** Fixed symptoms keep report titles free of visitor-authored markup. */
export const SYMPTOMS = Object.freeze(['Not discovered', 'Missing events', 'Snapshot problem', 'Live view problem', 'Recording problem', 'Control problem', 'Wrong value or state', 'Other']);

/** Conservative URL ceiling; larger reports remain complete for manual copying. */
export const MAX_ISSUE_URL_BYTES = 6000;

/** Remove invisible controls while preserving readable multiline descriptions. */
export function cleanText(value, singleLine = false) {
  const text = String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  return singleLine ? text.replace(/[\n\t]/g, ' ').trim() : text.trim();
}

/** Best-effort checks flag likely secrets or private identifiers, never values. */
export function privacyFindings(value) {
  const text = cleanText(value).toLowerCase();
  const patterns = [
    ['credentials', /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*["']?\s*[:=]\s*["']?(?!redacted\b|none\b|null\b)[^\s"',}]{4,}/i],
    ['authentication material', /-----begin .*private key-----|\bgh[pousr]_[a-z0-9_]{20,}|\bbearer\s+\S{12,}|\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i],
    ['device identifiers', /(?:serial(?:_number)?|device[_ -]?(?:id|sn)|station[_ -]?sn|p2p[_ -]?did)\s*["']?\s*[:=]\s*["']?[a-z0-9_-]{6,}|\bt[a-z0-9]{14,}\b|\b(?:[a-f0-9]{2}:){5}[a-f0-9]{2}\b/i],
    ['network details', /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b|\b[\w-]+\.local\b|(?:rtsp|rtsps|webrtc):\/\/|https?:\/\/(?:localhost|[^\s/]+:[^\s/]+@)/i],
    ['email address', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
    ['verification code or key', /\b\d{6}\b|\b[a-f0-9]{32,}\b|\b[a-z0-9+/]{64,}={0,2}\b/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function fenced(value) {
  const text = cleanText(value);
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text || 'Not supplied'}\n${fence}`;
}

function inline(value) {
  return cleanText(value, true).replace(/[\\`*_{}[\]()<>#+.!|~@]/g, '\\$&');
}

/** Validate a draft and prepare the exact complete report shown for review. */
export function prepareReport(device, draft) {
  const errors = [];
  const connections = device ? [...new Set(device.features.flatMap(feature => feature.connections.map(pair => pair.id)))] : [];
  if (!SYMPTOMS.includes(draft.symptom)) errors.push('Choose a problem from the list.');
  if (draft.connection && !connections.includes(draft.connection)) errors.push('Choose a listed connection or Not sure.');
  for (const field of ['official', 'encryption']) if (!['Yes', 'No', 'Not sure'].includes(draft[field])) errors.push(`Choose a valid ${field} answer.`);
  for (const field of ['integrationVersion', 'gatewayVersion', 'firmware', 'hubFirmware']) {
    const value = draft[field] ?? '';
    if ((['integrationVersion', 'gatewayVersion'].includes(field) && !value) || (value && !/^[A-Za-z0-9._+\-]{1,40}$/.test(value))) errors.push('Use version numbers only, or unknown if you cannot find a required version.');
  }
  for (const [field, limit] of [['expected', 1000], ['actual', 1000], ['steps', 1500]]) {
    if ([...String(draft[field] ?? '')].length > limit) errors.push(`${field} is too long. Keep it under ${limit} characters.`);
  }
  if (!cleanText(draft.actual)) errors.push('Describe what happened.');
  const media = /Snapshot|Live view|Recording/.test(draft.symptom);
  const title = `${device?.models[0] || device?.name || 'Device not listed'} - ${draft.symptom}`;
  const body = [
    '## Device and setup',
    `Device: ${inline(device?.name ?? 'Not listed')}`,
    `Model: ${inline(device?.models.join(', ') || 'Not listed')}`,
    `Connection: ${inline(draft.connection || 'Not sure')}`,
    `Integration version: ${inline(draft.integrationVersion)}`,
    `Gateway version: ${inline(draft.gatewayVersion)}`,
    `Device firmware: ${inline(draft.firmware || 'Not sure')}`,
    `HomeBase / NVR firmware: ${inline(draft.hubFirmware || 'Not applicable / not sure')}`,
    `Works in the official Eufy app: ${draft.official}`,
    ...(media ? [`Local Advanced Encryption enabled: ${draft.encryption}`] : []),
    '', '## Problem', inline(draft.symptom), '', '## Expected behaviour', fenced(draft.expected),
    '', '## Actual behaviour', fenced(draft.actual), '', '## Steps to reproduce', fenced(draft.steps),
    '', 'Prepared with the device help guide. No logs or diagnostic files are included.',
  ].join('\n');
  const findings = [...new Set([...privacyFindings(Object.values(draft).join('\n')), ...privacyFindings(`${title}\n${body}`)])];
  if (findings.length) errors.push(`Remove possible private information before sharing: ${findings.join(', ')}. These checks cannot guarantee complete redaction.`);
  const url = new URL(ISSUE_URL);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  const withinLimit = new TextEncoder().encode(url.href).length <= MAX_ISSUE_URL_BYTES;
  return { title, body, errors: [...new Set(errors)], url: errors.length ? null : withinLimit ? url.href : ISSUE_URL, requiresCopy: !withinLimit };
}
