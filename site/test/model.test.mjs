/** Website contract tests keep catalogue declarations separate from evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, EVIDENCE, projectDevice, matchesDevice, featureEvidence, escapeHtml, safeJson, compareDevices, deviceStatus, statusDescription, updatedDate } from '../src/model.mjs';
import { prepareReport, privacyFindings, MAX_ISSUE_URL_BYTES, ISSUE_URL } from '../src/support.mjs';

const source = (extra = {}) => ({ id: 'example', name: 'Example camera', category: 'camera', models: ['T8170'], aliases: ['Friendly camera'], integration: { status: 'supported', handler: 'camera' }, capabilities: { media: { live_view: { connections: { direct: { status: 'tested', tested_on: '2026-10-16', tested_by: 'PRIVATE_CANARY' }, T8030: { status: 'failing' } }, read: { parameter: 999888777 }, notes: 'PRIVATE_CANARY' }, snapshot: { connections: { T8030: { status: 'tested' } } } } }, notes: 'PRIVATE_CANARY', source: 'PRIVATE_CANARY', ...extra });
const device = projectDevice(source());
const draft = (extra = {}) => ({ symptom: 'Live view problem', connection: 'direct', integrationVersion: '0.1.158', gatewayVersion: 'unknown', firmware: '', hubFirmware: '', official: 'Yes', encryption: 'Not sure', expected: 'A picture', actual: 'The stream never starts.', steps: 'Open the device.', ...extra });

test('public projection removes protocol, contributor and private-note fields', () => {
  const text = JSON.stringify(device);
  for (const forbidden of ['PRIVATE_CANARY', '999888777', 'tested_by', 'handler', 'parameter', 'source', 'notes']) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(device.features[0].connections[0].testedOn, '2026-10-16');
});

test('every category maps and unfamiliar categories fail rather than disappear', () => {
  assert.equal(CATEGORIES.flatMap(category => category.types).length, 15);
  const names = { camera: 'camera', doorbell: 'doorbell', homebase: 'HomeBase', hub_adjacent: 'hub', nvr: 'NVR',
    smart_lock: 'lock', security_sensor: 'sensor', siren: 'siren', keypad: 'keypad', remote: 'remote',
    smart_drop: 'delivery box', smart_safe: 'safe', tracker: 'tracker', chime: 'chime', passive_accessory: 'accessory' };
  for (const category of CATEGORIES.flatMap(item => item.types)) {
    const projected = projectDevice(source({ category, integration: { status: 'recognised' } }));
    assert.ok(projected.categoryId);
    assert.equal(deviceStatus(projected).label, `Own this ${names[category]}? Help with testing.`);
  }
  for (const category of ['future', 'constructor']) {
    assert.equal(deviceStatus({ ...device, category, admission: 'recognised' }).label, 'Own this device? Help with testing.');
  }
  assert.throws(() => projectDevice(source({ category: 'future' })));
});

test('all seven evidence statuses remain distinct and malformed evidence fails', () => {
  assert.deepEqual(Object.keys(EVIDENCE), ['tested', 'reported', 'mixed', 'declared', 'failing', 'unsupported', 'unknown']);
  assert.equal(new Set(Object.values(EVIDENCE).map(item => item.label)).size, 6);
  for (const status of ['tested', 'reported']) {
    assert.equal(EVIDENCE[status].label, 'Working');
    assert.equal(EVIDENCE[status].symbol, '✓');
  }
  assert.notEqual(EVIDENCE.tested.description, EVIDENCE.reported.description);
  assert.match(EVIDENCE.declared.description, /haven.t checked/);
  const invalid = source(); invalid.capabilities.media.live_view.connections.direct.status = 'supported';
  assert.throws(() => projectDevice(invalid));
  const date = source(); date.capabilities.media.live_view.connections.direct.tested_on = '2026-02-30';
  assert.throws(() => projectDevice(date));
});

test('facets must match the same feature and connection, not unrelated evidence', () => {
  assert.equal(matchesDevice(device, { connection: 'direct', feature: 'media:snapshot', evidence: 'tested' }), false);
  assert.equal(matchesDevice(device, { connection: 'T8030', feature: 'media:live_view', evidence: 'tested' }), false);
  assert.equal(matchesDevice(device, { connection: 'T8030', feature: 'media:live_view', evidence: 'failing' }), true);
  assert.equal(matchesDevice(device, { query: 'ＦＲＩＥＮＤＬＹ T8170' }), true);
  assert.equal(featureEvidence(device.features[1], 'direct').status, 'unknown');
  assert.equal(matchesDevice(device, { connection: 'direct', evidence: 'unsupported' }), false);
});

test('catalogue text cannot inject HTML, attributes or JSON islands', () => {
  const text = '</script><script>alert("x")</script>&\u2028';
  assert.ok(!escapeHtml(text).includes('<'));
  assert.ok(!safeJson({ text }).includes('<'));
  assert.deepEqual(JSON.parse(safeJson({ text })), { text });
});

test('admission and evidence sorting is deterministic', () => {
  const only = projectDevice(source({ id: 'only', integration: { status: 'recognised' } }));
  const admitted = projectDevice(source({ id: 'admitted', capabilities: {} }));
  assert.ok(compareDevices(admitted, only) < 0);
  assert.ok(compareDevices(device, admitted) < 0);
  assert.equal(compareDevices(device, device), 0);
});

test('reports validate enums and contain no automatic GitHub mentions', () => {
  const report = prepareReport(device, draft({ actual: '@someone #12\n# Heading\n```\n</script>' }));
  assert.deepEqual(report.errors, []);
  assert.match(report.body, /````text/);
  assert.equal(new URL(report.url).origin + new URL(report.url).pathname, ISSUE_URL);
  assert.ok(prepareReport(device, draft({ connection: 'invented' })).errors.length);
  assert.ok(prepareReport(device, draft({ symptom: '<script>' })).errors.length);
  assert.ok(prepareReport(device, draft({ actual: 'x'.repeat(1001) })).errors.length);
});

test('private material blocks every prepared outgoing URL but model/version text passes', () => {
  assert.deepEqual(privacyFindings('T8170 0.1.158 HomeBase 3'), []);
  for (const value of ['192.168.1.20', 'aa:bb:cc:dd:ee:ff', 'person@example.com', '123456', 'T8010P12345678901', '-----BEGIN PRIVATE KEY-----', 'password' + '=private-value', 'ghp_' + 'a'.repeat(30)]) {
    const report = prepareReport(device, draft({ actual: value }));
    assert.ok(report.errors.length, value);
    assert.equal(report.url, null);
  }
  assert.ok(privacyFindings('pass\u200bword' + '=private-value').length);
});

test('long encoded reports use the full copy fallback without truncating text', () => {
  const text = '🙂'.repeat(900);
  const report = prepareReport(device, draft({ actual: text, expected: text, steps: text }));
  assert.deepEqual(report.errors, []);
  assert.equal(report.requiresCopy, true);
  assert.equal(report.url, ISSUE_URL);
  assert.equal(report.body.split(text).length, 4);
  const short = prepareReport(device, draft());
  assert.ok(new TextEncoder().encode(short.url).length <= MAX_ISSUE_URL_BYTES);
});

test('device badges distinguish admission, confirmed features and the E30 trial', () => {
  assert.equal(deviceStatus(device).label, 'Working features');
  assert.equal(deviceStatus({ ...device, admission: 'recognised' }).label, 'Own this camera? Help with testing.');
  assert.equal(deviceStatus({ ...device, features: [] }).label, 'Needs testing');
  assert.equal(deviceStatus({ ...device, id: 't85f1', admission: 'recognised' }).label, 'Experimental');
  assert.equal(deviceStatus(device).style, 'tested');
  const only = status => ({ ...device, features: [{ connections: [{ id: 'direct', status }] }] });
  assert.deepEqual(deviceStatus(only('reported')), { label: 'Working features', symbol: '✓', style: 'reported' });
  for (const status of ['declared', 'unknown', 'failing', 'mixed', 'unsupported']) {
    assert.equal(deviceStatus(only(status)).label, 'Needs testing');
  }
  for (const [testedOn, expected] of [['2026-09-18', '18 Sep 2026'], ['2026-01-05', '05 Jan 2026'],
    ['2024-02-29', '29 Feb 2024'], ['0000-02-29', '29 Feb 0000'], [undefined, 'Not recorded'],
    ['invalid', 'Not recorded'], ['2026-02-30', 'Not recorded'], [42, 'Not recorded']]) {
    const pair = Object.freeze({ status: 'reported', testedOn });
    assert.equal(updatedDate(pair), expected);
    assert.equal(pair.testedOn, testedOn);
  }
  for (const status of Object.keys(EVIDENCE)) {
    assert.doesNotMatch(statusDescription({ status, testedOn: '2026-09-18' }), /Last (checked|reported|updated)|\d{4}-\d{2}-\d{2}/);
  }
});
