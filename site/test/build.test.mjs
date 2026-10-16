/** Verify the published artifact, routes and base paths against source records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('build contains exactly the catalogue routes, local links and permitted assets', async () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
  const sourceFiles = (await readdir(join(root, '../eufy_event_gateway/device_catalogue/devices'))).filter(file => file.endsWith('.yaml'));
  const pages = await readdir(join(root, 'dist/devices'));
  assert.equal(pages.length, sourceFiles.length);
  const entries = await readdir(join(root, 'dist'), { recursive: true, withFileTypes: true });
  for (const entry of entries.filter(entry => entry.isFile())) {
    const path = join(entry.parentPath, entry.name);
    assert.match(entry.name, /(?:\.html|\.css|\.mjs|\.png|\.jpg|\.webp|sitemap\.xml|\.nojekyll)$/);
    if (!entry.name.endsWith('.html')) continue;
    const html = await readFile(path, 'utf8');
    assert.ok(!html.includes('PRIVATE_CANARY'));
    assert.ok(!html.includes('tested_by'));
    assert.ok(!html.includes('source_repo'));
    assert.ok(!html.includes('/Users/'));
    assert.ok(!html.includes('project-memory'));
    for (const [, raw] of html.matchAll(/(?:src|href)="(\/eufy-mega-security\/[^"?#]*)/g)) {
      const relative = raw.slice('/eufy-mega-security/'.length);
      await access(join(root, 'dist', relative.endsWith('/') || !relative ? relative + 'index.html' : relative));
    }
  }
  const home = await readFile(join(root, 'dist/index.html'), 'utf8');
  assert.match(home, /connect-src 'none'/);
  assert.match(home, /https:\/\/ko-fi.com\/mscodemonkey/);
  assert.ok(!home.includes('amazon.'));
  const e30 = await readFile(join(root, 'dist/devices/t85f1/index.html'), 'utf8');
  assert.match(e30, /Experimental, off by default/);
  assert.match(e30, /tested off-door/);
  assert.match(e30, /US cloud route/);
  assert.match(e30, /data-feature="controls:unlock"/);
  assert.ok(!e30.includes('It does not have Home Assistant entities yet'));
  assert.ok(!home.includes('Device-declared'));
  assert.ok(!home.includes('Category image for'));
  const missing = await readFile(join(root, 'dist/404.html'), 'utf8');
  assert.match(missing, /href="\/eufy-mega-security\/"/);
});

test('alternate root base works and invalid base configuration fails', async () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root, env: { ...process.env, SITE_BASE: '/' } });
  const home = await readFile(join(root, 'dist/index.html'), 'utf8');
  assert.match(home, /href="\/assets\/styles.css"/);
  assert.throws(() => execFileSync(process.execPath, ['build.mjs'], { cwd: root, env: { ...process.env, SITE_BASE: '//elsewhere/' }, stdio: 'pipe' }));
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
});
