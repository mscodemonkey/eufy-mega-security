/**
 * Enhances static catalogue pages without contacting the gateway or a backend.
 * Page state and report drafts live only in this document's lifetime.
 */

import { CATEGORIES, EVIDENCE, GROUPS, matchesDevice, featureEvidence, connectionLabel, statusDescription, updatedDate } from './model.mjs';
import { ISSUE_URL, SYMPTOMS, prepareReport } from './support.mjs';

document.documentElement.classList.add('js');
const $ = selector => document.querySelector(selector);
const menu = $('.menu-toggle');
menu?.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(expanded));
  $('#nav-links').classList.toggle('is-open', expanded);
});
const island = $('#page-data');
const data = island ? JSON.parse(island.textContent) : null;

function badge(pair) {
  const info = EVIDENCE[pair.status];
  const span = document.createElement('span');
  span.className = `evidence-badge evidence-${pair.status}`;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = info.symbol;
  span.append(icon, ` ${info.label}`);
  return span;
}

if (data?.page === 'catalogue') {
  const categories = new Set(CATEGORIES.map(category => category.id));
  let category = categories.has(location.hash.slice(1)) ? location.hash.slice(1) : 'cameras';
  const connectionSelect = $('#connection-filter');
  const featureSelect = $('#feature-filter');
  const evidenceSelect = $('#evidence-filter');
  const dialog = $('#filter-dialog');
  const trigger = $('#open-filters');
  const narrow = matchMedia('(max-width: 720px)');
  const allConnections = [...new Set(data.devices.flatMap(device => device.features.flatMap(feature => feature.connections.map(pair => pair.id))))].sort();
  for (const id of allConnections) connectionSelect.add(new Option(connectionLabel(id, null, data.devices), id));
  const features = new Map(data.devices.flatMap(device => device.features.map(feature => [feature.key, feature])));
  for (const [key, feature] of [...features].sort((a, b) => a[1].label < b[1].label ? -1 : 1)) featureSelect.add(new Option(`${feature.label} · ${GROUPS[feature.group]}`, key));
  const cards = new Map([...document.querySelectorAll('[data-device]')].map(card => [card.dataset.device, card]));

  function update() {
    const filters = { category, query: $('#search').value, connection: connectionSelect.value, feature: featureSelect.value, evidence: evidenceSelect.value };
    let count = 0;
    for (const device of data.devices) {
      const visible = matchesDevice(device, filters);
      cards.get(device.id).hidden = !visible;
      if (visible) count++;
    }
    for (const group of CATEGORIES) {
      $(`#${group.id}`).hidden = group.id !== category;
      const link = $(`[data-category="${group.id}"]`);
      if (group.id === category) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    $('#category-title').textContent = `${CATEGORIES.find(group => group.id === category).name.toLowerCase()}.`;
    $('#result-count').textContent = `${count} ${count === 1 ? 'device' : 'devices'}`;
    $('#no-results').hidden = count > 0;
    const selected = [connectionSelect.value, featureSelect.value, evidenceSelect.value].filter(Boolean).length;
    $('#filter-count').textContent = selected ? `(${selected})` : '';
  }

  function reset() {
    connectionSelect.value = featureSelect.value = evidenceSelect.value = '';
    $('#search').value = '';
    update();
  }

  function closeDialog() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    trigger.focus();
  }

  function layoutFilters() {
    if (!narrow.matches) dialog.setAttribute('open', '');
    else if (dialog.open && !dialog.matches(':modal')) dialog.removeAttribute('open');
  }

  trigger.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('#close-filters').focus();
  });
  $('#close-filters').addEventListener('click', closeDialog);
  $('#apply-filters').addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  $('#clear-filters').addEventListener('click', reset);
  $('#reset-search').addEventListener('click', reset);
  $('#search').addEventListener('input', update);
  for (const select of [connectionSelect, featureSelect, evidenceSelect]) select.addEventListener('change', update);
  narrow.addEventListener('change', layoutFilters);
  for (const link of document.querySelectorAll('[data-category]')) link.addEventListener('click', event => {
    event.preventDefault();
    category = link.dataset.category;
    history.replaceState(null, '', `#${category}`);
    update();
  });
  layoutFilters();
  update();
}

if (data?.page === 'device' && $('#device-connection')) {
  function updateConnection() {
    const connection = $('input[name="device-connection"]:checked').value;
    $('#selected-connection').textContent = data.connectionLabels[connection];
    for (const feature of data.device.features) {
      const row = [...document.querySelectorAll('[data-feature]')].find(item => item.dataset.feature === feature.key);
      const pair = featureEvidence(feature, connection);
      row.querySelector('[data-evidence]').replaceChildren(badge(pair));
      row.querySelector('[data-description]').textContent = statusDescription(pair);
      const updated = updatedDate(pair);
      if (updated !== 'Not recorded') {
        const time = document.createElement('time');
        time.dateTime = pair.testedOn;
        time.textContent = updated;
        row.querySelector('[data-updated]').replaceChildren(time);
      } else row.querySelector('[data-updated]').replaceChildren(document.createTextNode(updated));
    }
    const helpUrl = new URL('../help/', import.meta.url);
    helpUrl.searchParams.set('device', data.device.id);
    helpUrl.searchParams.set('connection', connection);
    for (const id of ['device-help', 'bottom-device-help']) $(`#${id}`).href = helpUrl.href;
  }
  $('#device-connection').addEventListener('change', updateConnection);
  updateConnection();
}

if (data?.page === 'help') {
  const root = $('#report-app');
  root.innerHTML = `<form id="report-form" novalidate><div class="form-grid"><label>Device<select name="device"><option value="">Not listed / not sure</option></select></label><label>Connection<select name="connection"><option value="">Not sure</option></select></label><label>What isn't working?<select name="symptom"></select></label><label>Does it work in Eufy's app?<select name="official"><option>Not sure</option><option>Yes</option><option>No</option></select></label><label>Integration version<input name="integrationVersion" maxlength="40" required placeholder="Version or unknown" autocomplete="off"></label><label>Gateway app version<input name="gatewayVersion" maxlength="40" required placeholder="Version or unknown" autocomplete="off"></label><label>Device firmware <span class="optional">optional</span><input name="firmware" maxlength="40" placeholder="Version or leave blank" autocomplete="off"></label><label>HomeBase / NVR firmware <span class="optional">optional</span><input name="hubFirmware" maxlength="40" placeholder="Version or leave blank" autocomplete="off"></label><label id="encryption-field" hidden>Local Advanced Encryption enabled?<select name="encryption"><option>Not sure</option><option value="Yes">On</option><option value="No">Off</option></select><span class="field-help">Diagnostic context only. There is no need to change it.</span></label></div><a id="existing-issues" class="existing-issues" href="https://github.com/mscodemonkey/eufy-mega-security/issues" target="_blank" rel="noopener noreferrer">Check existing issues for this device ↗</a><label>What did you expect? <span class="optional">up to 1,000 characters</span><textarea name="expected" rows="3" maxlength="1000" placeholder="Describe the feature you expected to work. Do not include logs or private details."></textarea></label><label>What happened instead? <span class="optional">up to 1,000 characters</span><textarea name="actual" rows="4" maxlength="1000" required placeholder="Describe the problem in your own words."></textarea></label><label>How can we reproduce it? <span class="optional">up to 1,500 characters</span><textarea name="steps" rows="4" maxlength="1500" placeholder="Tell us what you tried, one step at a time."></textarea></label><p id="report-errors" class="form-error" role="alert" tabindex="-1"></p><button class="button primary" id="review-report" type="submit">Review my report →</button></form><section id="report-review" class="report-review" hidden aria-labelledby="review-heading"><h3 id="review-heading" tabindex="-1">Your report. Ready to check.</h3><p>Read this carefully. Opening GitHub puts the report into its new-issue form and URL. You'll sign in and submit it there.</p><textarea id="report-preview" readonly rows="16" aria-label="Complete report to share"></textarea><label class="privacy-check"><input id="privacy-confirm" type="checkbox"><span>I've checked this report and removed private information, including passwords, account details, serials, camera names and network addresses.</span></label><p id="long-report" hidden>This report is too long for a prefilled link. Copy or download the full report, then paste it into the blank GitHub issue.</p><div class="review-actions"><button type="button" class="button primary" id="open-github" disabled>Open on GitHub ↗</button><button type="button" class="button secondary" id="copy-report" disabled>Copy report</button><button type="button" class="button secondary" id="download-report" disabled>Download report</button></div><p id="copy-status" role="status"></p></section>`;
  const form = $('#report-form');
  let reviewed = null;
  const field = name => form.elements.namedItem(name);
  for (const device of data.devices) field('device').add(new Option(`${device.name}${device.models.length ? ` (${device.models[0]})` : ''}`, device.id));
  for (const symptom of SYMPTOMS) field('symptom').add(new Option(symptom, symptom));
  for (const name of ['integrationVersion', 'gatewayVersion']) field(name).placeholder = `e.g. ${data.version} or unknown`;
  const params = new URLSearchParams(location.search);
  const known = data.devices.find(device => device.id === params.get('device'));
  if (known) field('device').value = known.id;

  function currentDevice() {
    return data.devices.find(device => device.id === field('device').value);
  }

  function chooseDevice() {
    const device = currentDevice();
    field('connection').replaceChildren(new Option('Not sure', ''));
    const connections = device?.features[0]?.connections ?? [];
    for (const pair of connections) field('connection').add(new Option(connectionLabel(pair.id, device, data.hubs), pair.id));
    const search = new URL('https://github.com/mscodemonkey/eufy-mega-security/issues');
    search.searchParams.set('q', `is:issue ${device?.models[0] ?? device?.id ?? ''}`.trim());
    $('#existing-issues').href = search.href;
  }

  function clearReview() {
    reviewed = null;
    $('#report-review').hidden = true;
    $('#privacy-confirm').checked = false;
    for (const id of ['open-github', 'copy-report', 'download-report']) $(`#${id}`).disabled = true;
    $('#encryption-field').hidden = !/Snapshot|Live view|Recording/.test(field('symptom').value);
  }

  function draft() {
    return Object.fromEntries(new FormData(form));
  }

  function authorizedReport() {
    if (!reviewed || !$('#privacy-confirm').checked) return null;
    const checked = prepareReport(currentDevice(), draft());
    if (checked.errors.length || checked.body !== reviewed.body || checked.title !== reviewed.title) {
      clearReview();
      return null;
    }
    return checked;
  }

  chooseDevice();
  if (known && [...field('connection').options].some(option => option.value === params.get('connection'))) field('connection').value = params.get('connection');
  field('device').addEventListener('change', chooseDevice);
  form.addEventListener('input', clearReview);
  form.addEventListener('change', clearReview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const result = prepareReport(currentDevice(), draft());
    $('#report-errors').textContent = result.errors.join(' ');
    if (result.errors.length) { $('#report-errors').focus(); return; }
    reviewed = result;
    $('#report-preview').value = `${result.title}\n\n${result.body}`;
    $('#report-review').hidden = false;
    $('#privacy-confirm').checked = false;
    for (const id of ['open-github', 'copy-report', 'download-report']) $(`#${id}`).disabled = true;
    $('#long-report').hidden = !result.requiresCopy;
    $('#review-heading').focus();
  });
  $('#privacy-confirm').addEventListener('change', () => {
    const allowed = Boolean(authorizedReport());
    for (const id of ['open-github', 'copy-report', 'download-report']) $(`#${id}`).disabled = !allowed;
  });
  $('#open-github').addEventListener('click', () => {
    const report = authorizedReport();
    if (report) window.open(report.url, '_blank', 'noopener,noreferrer');
  });
  $('#copy-report').addEventListener('click', async () => {
    const report = authorizedReport();
    if (!report) return;
    try { await navigator.clipboard.writeText(`${report.title}\n\n${report.body}`); $('#copy-status').textContent = 'Report copied. Paste it into your GitHub issue.'; }
    catch { $('#report-preview').focus(); $('#report-preview').select(); $('#copy-status').textContent = 'Copy is unavailable here. The complete report is selected so you can copy it manually.'; }
  });
  $('#download-report').addEventListener('click', () => {
    const report = authorizedReport();
    if (!report) return;
    const url = URL.createObjectURL(new Blob([`${report.title}\n\n${report.body}`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'eufy-device-report.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  clearReview();
}
