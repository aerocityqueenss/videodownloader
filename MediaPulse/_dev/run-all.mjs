/**
 * run-all.mjs — one command that validates the whole extension.
 *
 *   1. manifest.json parses and every file it references exists
 *   2. every JavaScript file parses
 *   3. background.js logic        (mocked chrome API)
 *   4. content.js DOM scanning    (mocked DOM)
 *   5. popup rendering/UX         (real Chromium)
 *   6. icon dimensions/transparency
 *
 * Run:  node _dev/run-all.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const node = process.execPath;

let failures = 0;
const report = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* --- 1. manifest + referenced files ------------------------------------- */
console.log('\n== manifest ==');

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  report('manifest.json parses', true);
} catch (err) {
  report('manifest.json parses', false, err.message);
}

if (manifest) {
  report('manifest_version is 3', manifest.manifest_version === 3, `got ${manifest.manifest_version}`);

  const required = ['activeTab', 'scripting', 'downloads', 'webRequest'];
  const perms = manifest.permissions || [];
  for (const p of required) report(`permission "${p}"`, perms.includes(p));

  report('host_permissions covers <all_urls>', (manifest.host_permissions || []).includes('<all_urls>'));

  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);

  for (const file of [...new Set(referenced)]) {
    const abs = resolve(root, file);
    report(`referenced file exists: ${file}`, existsSync(abs) && statSync(abs).isFile());
  }

  const matchesAll = (manifest.content_scripts || []).some((cs) => (cs.matches || []).includes('<all_urls>'));
  report('content script matches <all_urls>', matchesAll);
}

/* --- 2. syntax ---------------------------------------------------------- */
console.log('\n== syntax ==');

for (const file of ['background.js', 'content.js', 'popup.js']) {
  try {
    execFileSync(node, ['--check', resolve(root, file)], { stdio: 'pipe' });
    report(`${file} parses`, true);
  } catch (err) {
    report(`${file} parses`, false, String(err.stderr || err.message).split('\n')[0]);
  }
}

/* --- 3-6. behavioural suites ------------------------------------------- */
const suites = [
  ['background.js logic', 'test-background.mjs'],
  ['content.js scanning', 'test-content.mjs'],
  ['popup rendering', 'test-popup.mjs'],
  ['end-to-end pipeline', 'e2e-pipeline.mjs']
];

for (const [label, script] of suites) {
  console.log(`\n== ${label} ==`);
  let out = '';
  let ok = false;
  try {
    out = execFileSync(node, [resolve(here, script)], { stdio: 'pipe', encoding: 'utf8' });
    ok = true;
  } catch (err) {
    // A failing suite exits non-zero; its stdout still holds the results.
    out = String(err.stdout || '');
  }

  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('FAIL')) console.log(`   ${trimmed}`);
  }

  const summary = out.trim().split('\n').filter(Boolean).pop() || 'no output';
  const passedAll = /^(\d+) passed, 0 failed$/.test(summary);
  report(label, ok && passedAll, summary);
}

/* --- 7. icons ----------------------------------------------------------- */
console.log('\n== icons ==');
try {
  const out = execFileSync(node, [resolve(here, 'check-icons.mjs')], { stdio: 'pipe', encoding: 'utf8' });
  report('icons valid', /0 failed/.test(out), out.trim().split('\n').pop());
} catch (err) {
  const out = String(err.stdout || '');
  report('icons valid', false, out.trim().split('\n').pop() || 'checker failed');
}

/* --- summary ------------------------------------------------------------ */
console.log(`\n${'='.repeat(52)}`);
if (failures === 0) console.log('ALL CHECKS PASSED');
else console.log(`${failures} CHECK(S) FAILED`);
console.log('='.repeat(52));
process.exitCode = failures === 0 ? 0 : 1;
