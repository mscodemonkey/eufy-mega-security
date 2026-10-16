/**
 * Generates the public Pages artifact from catalogue YAML and local assets.
 * This command owns only site/dist; GitHub Pages consumes its completed output.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, readdir, writeFile, mkdir, cp, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CATEGORIES, EVIDENCE, GROUPS, escapeHtml as h, safeJson, projectDevice, compareDevices, deviceConnections, connectionLabel, featureEvidence, statusDescription, deviceStatus } from './src/model.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(root, '../eufy_event_gateway/package.json'));
const { parse } = require('yaml');
const base = process.env.SITE_BASE ?? '/eufy-mega-security/';
const origin = process.env.SITE_ORIGIN ?? 'https://mscodemonkey.github.io';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('SITE_BASE must be a slash-terminated path without traversal');
const parsedOrigin = new URL(origin);
if (parsedOrigin.origin !== origin || parsedOrigin.protocol !== 'https:') throw new Error('SITE_ORIGIN must be an HTTPS origin without credentials or a path');
const href = path => base + path;
const repo = 'https://github.com/mscodemonkey/eufy-mega-security';
const kofi = 'https://ko-fi.com/mscodemonkey';
const directory = join(root, '../eufy_event_gateway/device_catalogue/devices');
const files = (await readdir(directory)).filter(file => file.endsWith('.yaml')).sort();
const devices = (await Promise.all(files.map(async file => projectDevice(parse(await readFile(join(directory, file), 'utf8')))))).sort(compareDevices);
if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error('Duplicate catalogue ID');
const images = JSON.parse(await readFile(join(root, 'assets/images.json'), 'utf8'));
const version = JSON.parse(await readFile(join(root, '../eufy_event_gateway/package.json'), 'utf8')).version;
for (const image of Object.values(images)) {
  if (!/^products\/[a-z0-9-]+\.(?:png|jpg|webp)$/.test(image.file)) throw new Error('Invalid image path');
  const bytes = await readFile(join(root, 'assets', image.file));
  const validFormat = image.file.endsWith('.png') ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : image.file.endsWith('.jpg') ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.sha256 || !validFormat) throw new Error('Image integrity check failed');
}

function asset(key, className = '', alt) {
  const image = images[key];
  return `<img class="${h(className)}" src="${h(href('assets/' + image.file))}" alt="${h(alt ?? image.alt)}" width="800" height="800" loading="${['category-image', 'hero-device-image'].includes(className) ? 'eager' : 'lazy'}" decoding="async">`;
}

function photo(device, className) {
  const entry = Object.entries(images).find(([, image]) => image.deviceId === device.id);
  return entry ? asset(entry[0], className, device.name) : `<span class="photo-unavailable ${h(className)}" role="img" aria-label="Product photo not yet available for ${h(device.name)}"><span aria-hidden="true">▧</span><small>Product photo not available yet</small></span>`;
}

function external(url, label, className = '') {
  return `<a href="${h(url)}" class="${h(className)}" rel="noopener noreferrer">${label}</a>`;
}

function shell(title, description, content, data, path = '') {
  const canonical = origin + href(path);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${h(title)} | Eufy Mega Security</title><meta name="description" content="${h(description)}"><meta property="og:title" content="${h(title)}"><meta property="og:description" content="${h(description)}"><meta property="og:type" content="website"><meta property="og:url" content="${h(canonical)}"><link rel="canonical" href="${h(canonical)}"><link rel="icon" href="${h(href('assets/icon.png'))}"><link rel="stylesheet" href="${h(href('assets/styles.css'))}"><script type="module" src="${h(href('assets/app.mjs'))}"></script></head><body><a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header"><nav class="nav-shell" aria-label="Main navigation"><a class="brand" href="${h(href(''))}">Eufy Mega Security<span class="brand-dot" aria-hidden="true"></span></a><button class="menu-toggle js-only" type="button" aria-expanded="false" aria-controls="nav-links">Menu <span aria-hidden="true">☰</span></button><div class="nav-links" id="nav-links"><a href="${h(href(''))}">Devices</a><a href="${h(href('getting-started/'))}">Get started</a>${external(repo + '#readme', 'Documentation')}${external(repo, 'GitHub')}${external(kofi, '<span aria-hidden="true">♡</span> Support the project', 'support-link')}</div></nav></header>
  <main id="main" class="page-shell">${content}</main>
  <footer class="site-footer page-shell"><div><a class="footer-brand" href="${h(href(''))}">Eufy Mega Security</a><p>A community project for your connected home.</p></div><div class="footer-links"><a href="${h(href('help/'))}">Get help</a>${external(kofi, 'Support on Ko-fi ↗')}<a href="${h(href('image-credits/'))}">Image credits</a></div><p class="footer-small">Independent community project. Not affiliated with Eufy or Anker. No analytics or telemetry from this site. Hosted by GitHub Pages.</p></footer>
  ${data ? `<script id="page-data" type="application/json">${safeJson({ base, version, ...data })}</script>` : ''}</body></html>`;
}

function card(device) {
  const status = device.admission;
  const support = deviceStatus(device);
  return `<article class="device-card" data-device="${h(device.id)}"><div class="card-top"><p class="eyebrow"><span class="evidence-badge evidence-${h(support.style)}"><span aria-hidden="true">${h(support.symbol)}</span> ${h(support.label)}</span></p><h3><a href="${h(href(`devices/${device.id}/`))}">${h(device.name)}</a></h3><p class="model-code">${h(device.models.join(' · ') || 'Model not yet confirmed')}</p></div><a class="product-image-link" href="${h(href(`devices/${device.id}/`))}" tabindex="-1" aria-hidden="true">${photo(device, 'card-image')}</a><div class="card-bottom"><a href="${h(href(`devices/${device.id}/`))}">View features <span aria-hidden="true">→</span><span class="sr-only"> for ${h(device.name)}</span></a><span>${device.id === 't85f1' ? 'Opt-in trial' : status === 'recognised' ? 'No integration entities yet' : 'Check individual features'}</span></div></article>`;
}

function categories() {
  return `<nav class="categories" aria-label="Device categories">${CATEGORIES.map(category => `<a class="category-link" data-category="${category.id}" href="#${category.id}">${asset(category.image, 'category-image', '')}<span>${category.name}</span></a>`).join('')}</nav>`;
}

function evidenceBadge(status) {
  const info = EVIDENCE[status];
  return `<span class="evidence-badge evidence-${h(status)}"><span aria-hidden="true">${h(info.symbol)}</span> ${h(info.label)}</span>`;
}

function featureSection(device, connection) {
  return Object.entries(GROUPS).map(([group, name]) => {
    const features = device.features.filter(feature => feature.group === group);
    if (!features.length) return '';
    return `<section class="feature-group"><h3>${h(name)}</h3><div class="feature-table"><table><caption class="sr-only">${h(name)} for the selected connection</caption><thead><tr><th scope="col">Feature</th><th scope="col">Status</th><th scope="col">What to expect</th></tr></thead><tbody>${features.map(feature => {
      const pair = featureEvidence(feature, connection);
      return `<tr data-feature="${h(feature.key)}"><th scope="row">${h(feature.label)}</th><td data-evidence>${evidenceBadge(pair.status)}</td><td data-description>${h(statusDescription(pair))}</td></tr>`;
    }).join('')}</tbody></table></div></section>`;
  }).join('');
}

function indexPage() {
  return shell('Your Eufy devices, at home in Home Assistant', 'Explore the device catalogue, check features for your connection and get help with Eufy Mega Security.', `
  <section class="hero"><h1>Your Eufy devices.<br><span>At home in Home Assistant.</span></h1><a class="hero-link" href="${h(href('getting-started/'))}">New here? Get started <span aria-hidden="true">→</span></a></section>
  ${categories()}
  <section class="catalogue" aria-labelledby="catalogue-heading"><div class="catalogue-intro"><div><h2 id="catalogue-heading">Explore <span id="category-title">devices.</span></h2><p>Find your device and see what works with your setup.</p></div><label class="search-field js-only">Search devices<input id="search" type="search" placeholder="Search by name or model" autocomplete="off"></label></div>
  <div class="catalogue-tools js-only"><button id="open-filters" class="button secondary mobile-filters" type="button">☷ Filters <span id="filter-count"></span></button><dialog id="filter-dialog" aria-labelledby="filter-title"><div class="filter-heading"><h3 id="filter-title">Filter devices</h3><button class="text-button" id="close-filters" type="button">Close</button></div><div id="filter-fields" class="filters"><label class="inline-filter"><span>Connection:</span><select id="connection-filter"><option value="">All</option></select></label><label class="inline-filter"><span>Feature:</span><select id="feature-filter"><option value="">All</option></select></label><label class="inline-filter"><span>Test status:</span><select id="evidence-filter"><option value="">All</option>${Object.entries(EVIDENCE).map(([key, info]) => `<option value="${key}">${h(info.label)}</option>`).join('')}</select></label><button id="clear-filters" class="text-button" type="button">Clear filters</button></div><button id="apply-filters" class="button primary apply-filters" type="button">Show devices</button></dialog><p id="result-count" class="result-count" role="status" aria-live="polite"></p></div>
  <p class="catalogue-note">A green tick means some features have been tested. Open the device to check which ones work with your connection. <a href="#evidence-guide">Understand the statuses ↓</a></p>
  <div id="catalogue-cards">${CATEGORIES.map(category => `<section id="${category.id}" class="category-section" aria-label="${category.name}"><h3 class="category-section-title">${category.name}</h3><div class="device-grid">${devices.filter(device => device.categoryId === category.id).map(card).join('')}</div></section>`).join('')}</div><div id="no-results" class="empty-state" hidden><h3>No matching devices.</h3><p>Try a different model or clear your filters.</p><button id="reset-search" class="button secondary" type="button">Reset search and filters</button></div></section>
  <section class="knowledge" id="evidence-guide"><div><h2>Know <span>what works.</span></h2><p>Check each feature for the way your device connects.</p></div><div class="knowledge-links"><span>▷ <strong>Live view</strong><small>Check video support.</small></span><span>▧ <strong>Snapshots</strong><small>Check picture support.</small></span><span>☷ <strong>Events</strong><small>Check your notifications.</small></span></div></section><details class="evidence-guide"><summary>What do the status labels mean?</summary><h3>Device badges</h3><p>Tested features means at least one feature has been confirmed on a real device. Needs testing means the integration recognises the device, but its features still need checking. Experimental means an optional trial with extra setup and limits. Own this device? Help with testing means the device is listed for reference and has no Home Assistant entities yet. If you own one, your help with testing is welcome.</p><h3>Feature results</h3><dl>${Object.values(EVIDENCE).map(info => `<div><dt>${h(info.label)}</dt><dd>${h(info.description)}</dd></div>`).join('')}</dl></details>`, { page: 'catalogue', devices });
}

function devicePage(device) {
  const connections = deviceConnections(device);
  const connection = connections[0] ?? '';
  const labels = Object.fromEntries(connections.map(id => [id, connectionLabel(id, device, devices)]));
  return shell(device.name, `Check ${device.name} features, connection-specific features and troubleshooting for Eufy Mega Security.`, `
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${h(href(''))}">Devices</a><span aria-hidden="true">/</span><a href="${h(href('') + '#' + device.categoryId)}">${h(CATEGORIES.find(category => category.id === device.categoryId).name)}</a><span aria-hidden="true">/</span><span>${h(device.name)}</span></nav>
  <section class="device-hero"><div class="detail-image">${photo(device, 'hero-device-image')}</div><div class="device-summary"><p class="eyebrow">${h(deviceStatus(device).label)}</p><h1>${h(device.name)}</h1><p class="detail-model">${h(device.models.join(' · ') || 'Model not yet confirmed')}</p><p class="detail-intro">Check features for the way your device connects.</p>${connections.length ? `<fieldset class="connection-choice" id="device-connection"><legend>Your connection</legend><div class="connection-segments">${connections.map(id => `<label><input type="radio" name="device-connection" value="${h(id)}"${id === connection ? ' checked' : ''}><span>${h(labels[id])}</span></label>`).join('')}</div></fieldset><p class="small">Feature results change with your selected connection.</p><noscript><p>JavaScript is off. The table below shows ${h(labels[connection])}.</p></noscript>` : '<p>We have not checked the connection options for this device yet.</p>'}<p class="admission-note">${device.id === 't85f1' ? 'Experimental, off by default. The trial supports one standalone T85F1 on the US cloud route and requires an API token of at least 32 characters. Lock and unlock were tested off-door. Door-load, jam detection and network-outage recovery have not been confirmed. Settings still need testing in Home Assistant. Changes made elsewhere may take several minutes to appear. Review dashboard, automation and voice-assistant access before enabling unlock.' : device.admission === 'recognised' ? 'This device is listed for reference. It does not have Home Assistant entities yet.' : 'Some features may still need testing. Check the results for your connection below.'}</p>${device.id === 't85f1' ? external(repo + '#experimental-smart-lock-e30', 'Read the E30 trial setup and limits ↗') : ''}<div class="hero-actions"><a class="button primary" href="${h(href('getting-started/'))}">Get started</a><a class="button secondary" id="device-help" href="${h(href('help/') + '?device=' + device.id + (connection ? '&connection=' + connection : ''))}">Get help with this device</a></div><a class="back-link" href="${h(href('') + '#' + device.categoryId)}">← Back to ${h(CATEGORIES.find(category => category.id === device.categoryId).name.toLowerCase())}</a></div></section>
  <section class="device-features"><p class="status-legend"><span class="evidence-badge evidence-tested"><span aria-hidden="true">✓</span> Confirmed means tested.</span><span class="evidence-badge evidence-reported"><span aria-hidden="true">≡</span> Reported means community feedback.</span><span class="evidence-badge evidence-declared"><span aria-hidden="true">!</span> Needs testing means unconfirmed.</span></p><h2>What works <span>with this setup.</span></h2><p id="selected-connection" class="section-subtitle">${connection ? h(labels[connection]) : 'Connection not yet checked'}</p>${device.features.length ? featureSection(device, connection) : '<div class="empty-state"><h3>Help fill in the picture.</h3><p>We have not checked the individual features for this device yet. If you have tried it, you can share your results through the help guide.</p></div>'}</section><section class="help-banner"><div><h2>Something <span>not quite right?</span></h2><p>Check the common fixes, then prepare a useful report.</p></div><a class="button secondary" id="bottom-device-help" href="${h(href('help/') + '?device=' + device.id)}">Get help with this device →</a></section>`, { page: 'device', device, connectionLabels: labels }, `devices/${device.id}/`);
}

function gettingStarted() {
  return shell('Get started', 'Install Eufy Mega Security and connect a dedicated Eufy guest account to Home Assistant.', `
  <section class="text-hero"><p class="eyebrow">A little setup. A more connected home.</p><h1>Eufy. Meet<br><span>Home Assistant.</span></h1><p>Two parts working together: the Eufy Mega Security app connects your devices, and the integration brings them into Home Assistant.</p></section>
  <div class="steps"><section><span class="step-number">1</span><h2>Check your device.</h2><p>Find your exact model in the catalogue and check the features for your connection. Devices that invite testing do not create Home Assistant entities yet.</p><a href="${h(href(''))}">Explore devices →</a></section><section><span class="step-number">2</span><h2>Use a guest account.</h2><p>Create a separate Eufy guest account and share only the Home and devices you want to use. Sign into Eufy's app with that guest account and confirm you can see them.</p><p>Keep your everyday account for the Eufy app. Do not post either account's credentials in a support report.</p></section><section><span class="step-number">3</span><h2>Install both parts.</h2><p>Follow the installation guide to install the app and Home Assistant integration. The app connects to Eufy. The integration connects to your app.</p>${external(repo + '#before-installing', 'Open the installation guide ↗')}</section><section><span class="step-number">4</span><h2>Restart and connect.</h2><p>After installing or updating the integration, fully restart Home Assistant. Restarting the app alone does not reload the integration.</p><p>Follow the guide to connect the integration, then check discovery, pictures and events separately.</p></section></div><section class="help-banner"><div><h2>A hand <span>getting connected.</span></h2><p>The help guide will walk you through the common checks.</p></div><a class="button primary" href="${h(href('help/'))}">Get help →</a></section>`, { page: 'started' }, 'getting-started/');
}

function helpPage() {
  const helpDevices = devices.map(device => ({ id: device.id, name: device.name, models: device.models, category: device.category, features: [{ connections: deviceConnections(device).map(id => ({ id })) }] }));
  const hubs = devices.filter(device => device.categoryId === 'homebases').map(device => ({ name: device.name, models: device.models, categoryId: device.categoryId }));
  return shell('Device help', 'Check common fixes and prepare a privacy-conscious GitHub issue for your Eufy device.', `
  <section class="text-hero compact"><p class="eyebrow">Let's work it out.</p><h1>A little help.<br><span>For your device.</span></h1><p>Start with the common checks. If you're still stuck, we'll help you prepare a useful report.</p></section>
  <section class="troubleshooting" aria-labelledby="checks-title"><h2 id="checks-title">First, <span>the quick checks.</span></h2><details open><summary>Check the device and connection</summary><p>Use the exact model and the HomeBase or NVR it connects through. Check the features on its device page. A device being integrated does not mean every feature works.</p></details><details><summary>Does it work in Eufy's app?</summary><p>Sign in with the dedicated guest account used by the integration. Confirm the shared device is visible, and try the same feature there. Tell us if it works in the app but fails in Home Assistant.</p></details><details><summary>Check both versions and restart Home Assistant</summary><p>The app and integration are updated separately. Compare both installed versions with the ${external(repo + '/releases/latest', 'latest published release')}. After updating the integration, fully restart Home Assistant.</p></details><details><summary>Missing motion or doorbell events?</summary><p>Check that notifications are enabled for that device in its active Eufy mode. Changing those settings can also change the alerts shown on your phone.</p></details><details><summary>Pictures or recordings are missing?</summary><p>Check whether the same picture or recording is visible in Eufy's app. In the report, tell us whether Local Advanced Encryption is on, off, or you're not sure. This is diagnostic context. You do not need to change the setting.</p></details><details><summary>What should I send?</summary><p>Start with the model, connection, versions and what went wrong. Do not upload complete logs or diagnostic files to a public issue. If a maintainer asks for a specific log line, share only the requested excerpt after removing private information.</p></details></section>
  <section class="report-section" aria-labelledby="report-heading"><p class="eyebrow">Still stuck?</p><h2 id="report-heading">Let's make <span>a useful report.</span></h2><p class="section-subtitle">Your answers stay in this page until you choose to share them. You'll review the report before opening GitHub.</p><div class="privacy-notice"><strong>GitHub issues are public.</strong><p>Keep passwords, verification codes, account details, serial numbers, camera or room names, network addresses and private images out of your report. Automatic checks are best-effort and cannot guarantee complete redaction.</p></div><div id="report-app"></div><noscript><p>Enable JavaScript to use the guided report, or ${external(repo + '/issues', 'search existing issues and open a report on GitHub')}. Follow the privacy guidance above.</p></noscript></section>`, { page: 'help', devices: helpDevices, hubs }, 'help/');
}

const staged = join(root, '.build-output');
const output = join(root, 'dist');
await rm(staged, { recursive: true, force: true });
await mkdir(join(staged, 'assets'), { recursive: true });
async function write(path, body) {
  const target = join(staged, path);
  if (!resolve(target).startsWith(resolve(staged) + '/')) throw new Error('Invalid output route');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}
await cp(join(root, 'assets/products'), join(staged, 'assets/products'), { recursive: true });
await cp(join(root, '../custom_components/eufy_event_gateway/brand/icon.png'), join(staged, 'assets/icon.png'));
for (const file of ['styles.css', 'app.mjs', 'model.mjs', 'support.mjs']) await cp(join(root, 'src', file), join(staged, 'assets', file));
await write('index.html', indexPage());
for (const device of devices) await write(`devices/${device.id}/index.html`, devicePage(device));
await write('getting-started/index.html', gettingStarted());
await write('help/index.html', helpPage());
await write('image-credits/index.html', shell('Image credits', 'Sources for device-identification images used in the catalogue.', `<section class="text-hero compact"><h1>Familiar faces.<br><span>Original sources.</span></h1><p>Product photos identify devices in this independent community catalogue. Eufy product names and imagery belong to their respective owners. Only verified product photos are shown. Devices without a verified photo have a placeholder.</p></section><ul class="credit-list">${Object.values(images).map(image => `<li>${h(image.alt)} · ${external(image.page, 'Official image source ↗')}</li>`).join('')}</ul><p>For image attribution questions, ${external(repo + '/issues', 'contact the project through GitHub')}.</p>`, null, 'image-credits/'));
await write('404.html', shell('Page not found', 'Return to the Eufy Mega Security device catalogue.', `<section class="text-hero"><p class="eyebrow">404</p><h1>A little lost?<br><span>Let's get you home.</span></h1><a class="button primary" href="${h(href(''))}">Explore devices →</a></section>`, null, '404.html'));
const routes = ['', 'getting-started/', 'help/', 'image-credits/', ...devices.map(device => `devices/${device.id}/`)];
await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${h(origin + href(route))}</loc></url>`).join('')}</urlset>`);
await write('.nojekyll', '');
await rm(output, { recursive: true, force: true });
await rename(staged, output);
console.log(JSON.stringify({ status: 'passed', devices: devices.length, pages: routes.length + 1, base, output: 'site/dist' }));
