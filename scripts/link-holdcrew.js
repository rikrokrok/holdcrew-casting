#!/usr/bin/env node
'use strict';
// Link a casting tenant to its HoldCrew company so Hold/Book can promote
// candidates into that company's Job Log (via the v3-talent-save webhook, which
// authenticates with the company's registry token). ONE slug — the casting tenant
// slug IS the HoldCrew company slug. Reads the token from the HoldCrew company
// registry through the util-sheet-write `get` op and stores it on the tenant.
// Re-run any time the company's token rotates.
//
//   node scripts/link-holdcrew.js <slug>
//
// The token is never printed. Run on the droplet (needs the local util webhook).
const fs = require('fs');
const http = require('http');
const db = require('../src/db');

const REGISTRY_SHEET = '13kcNKAi4GhUTfVioay2MgRspD6ZlxSw4jSlm7MNw3i4';
const UTIL_URL = 'http://127.0.0.1:5678/webhook/util-sheet-write';
const UTIL_TOKEN_FILE = '/root/.holdcrew_util_token';

const [, , slug] = process.argv;
if (!slug) {
  console.error('usage: node scripts/link-holdcrew.js <slug>');
  process.exit(1);
}
const hcSlug = slug.trim().toLowerCase();

const tenant = db.prepare('SELECT slug FROM tenants WHERE slug = ?').get(slug);
if (!tenant) {
  console.error(`no casting tenant '${slug}' — onboard it first (scripts/onboard-tenant.js).`);
  process.exit(1);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = null; } resolve({ status: res.statusCode, json: j, raw: buf }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  const utilToken = fs.readFileSync(UTIL_TOKEN_FILE, 'utf8').trim();
  const resp = await postJson(UTIL_URL, { token: utilToken, op: 'get', sheetId: REGISTRY_SHEET, range: 'Companies!A:E' });
  const values = resp.json && resp.json.values;
  if (!Array.isArray(values) || !values.length) throw new Error('could not read the company registry (' + resp.status + ')');
  const H = values[0].map((h) => (h || '').toString().trim().toLowerCase());
  const iSlug = H.indexOf('slug'), iToken = H.indexOf('token'), iActive = H.indexOf('active'), iName = H.indexOf('name');
  const match = values.slice(1).find((row) => (row[iSlug] || '').trim().toLowerCase() === hcSlug);
  if (!match) throw new Error(`HoldCrew company '${hcSlug}' not found in the registry.`);
  const token = (match[iToken] || '').trim();
  if (!token) throw new Error(`HoldCrew company '${hcSlug}' has no token in the registry.`);
  if ((match[iActive] || '').trim().toLowerCase() !== 'yes') console.warn(`  ⚠ company '${hcSlug}' is not marked active in the registry.`);

  db.prepare('UPDATE tenants SET hc_token = ? WHERE slug = ?').run(token, slug);
  console.log(`linked '${slug}' → HoldCrew company '${hcSlug}' (${(match[iName] || '').trim()}). Hold/Book will now promote to that Job Log.`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
