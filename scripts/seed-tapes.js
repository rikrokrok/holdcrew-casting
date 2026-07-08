#!/usr/bin/env node
'use strict';
// Dev helper: give every candidate on a job up to N casting tapes, using a local
// video file for each take (uploads to Wasabi + attaches a casting_media row).
// Idempotent top-up: a candidate that already has >= N tapes is left alone.
//   node scripts/seed-tapes.js <tenant> <password> <job> <file> [count=1]
const http = require('http');
const fs = require('fs');
const wasabi = require('../src/wasabi');
const { mediaKey } = require('../src/tenant');

const [, , tenant, password, job, file, countArg] = process.argv;
if (!tenant || !password || !job || !file) {
  console.error('usage: node scripts/seed-tapes.js <tenant> <password> <job> <file> [count=1]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error('file not found: ' + file); process.exit(1); }
const COUNT = Math.max(1, Number(countArg) || 1);
const PORT = Number(process.env.CASTING_PORT) || 4100;
const HOST = `${tenant}.casting.holdcrew.com`;

function req(method, path, { cookie = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: {
      Host: HOST,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = null; } resolve({ status: res.statusCode, headers: res.headers, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/login', { body: { password } });
  const sc = (login.headers['set-cookie'] || []).find((c) => c.startsWith('cs_session='));
  if (!sc) throw new Error('login failed: ' + login.status);
  const cookie = sc.split(';')[0];

  const board = (await req('GET', `/api/casting/board?job=${encodeURIComponent(job)}`, { cookie })).json;
  const cands = board.candidates || [];
  console.log(`${cands.length} candidates on ${tenant}/${job}; topping up to ${COUNT} take(s) each`);

  let added = 0;
  for (const c of cands) {
    const have = (c.tapes || []).length;
    for (let n = have + 1; n <= COUNT; n++) {
      const key = mediaKey(tenant, job, c.id, `take-${n}.m4v`);
      await wasabi.uploadObject(key, file, 'video/mp4');
      const r = await req('POST', `/api/casting/candidates/${c.id}/media`, { cookie, body: { key, label: `Take ${n}` } });
      if (r.status !== 201) throw new Error(`attach failed for ${c.name} take ${n}: ${r.status}`);
      added++;
    }
    process.stdout.write(`  ✓ ${c.name} — ${Math.max(have, COUNT)} take(s)\n`);
  }
  console.log(`\nadded ${added} take(s).`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
