#!/usr/bin/env node
'use strict';
// DEMO helper: give every candidate on a job a placeholder headshot from pravatar
// (real-ish faces — NOT the real people behind the names; for demo/sample boards
// only, so the visual product isn't all cartoon avatars). Idempotent: skips any
// candidate that already has a headshot, and uses distinct indexed faces so no two
// candidates share one. Swap any real photo in later via the UI.
//   node scripts/seed-headshots.js <tenant> <job>
const https = require('https');
const db = require('../src/db');
const wasabi = require('../src/wasabi');
const { mediaKey } = require('../src/tenant');
const { rand } = require('../src/ids');

const [, , tenant, job] = process.argv;
if (!tenant || !job) {
  console.error('usage: node scripts/seed-headshots.js <tenant> <job>');
  process.exit(1);
}

function fetchImg(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 4) {
        res.resume();
        return resolve(fetchImg(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: (res.headers['content-type'] || 'image/jpeg').split(';')[0] }));
    }).on('error', reject);
  });
}

(async () => {
  const p = db.prepare('SELECT id FROM casting_projects WHERE tenant = ? AND job = ?').get(tenant, job);
  if (!p) { console.error(`no project ${tenant}/${job}`); process.exit(1); }
  const cands = db.prepare('SELECT id, name, headshot_key FROM casting_candidates WHERE project_id = ? ORDER BY created_at').all(p.id);
  let n = 0, img = 1;
  for (const c of cands) {
    if (c.headshot_key) { console.log(`  skip ${c.name} (already has a headshot)`); continue; }
    const { buf, type } = await fetchImg(`https://i.pravatar.cc/512?img=${img}`);
    if (!/^image\//.test(type)) throw new Error(`non-image from pravatar for ${c.name}: ${type}`);
    const ext = type.includes('png') ? 'png' : 'jpg';
    const key = mediaKey(tenant, job, c.id, `headshot-${rand(6)}.${ext}`);
    await wasabi.uploadBuffer(key, buf, type);
    db.prepare("UPDATE casting_candidates SET headshot_key = ?, updated_at = datetime('now') WHERE id = ?").run(key, c.id);
    console.log(`  ✓ ${c.name} → img ${img}`);
    n++; img = (img % 70) + 1;
  }
  console.log(`\nset ${n} placeholder headshot(s) on ${tenant}/${job}.`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
