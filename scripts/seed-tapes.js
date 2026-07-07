#!/usr/bin/env node
'use strict';
// Dev helper: attach a local video file as the casting tape for EVERY candidate
// on a job — uploads it to Wasabi under each candidate's key and sets tape_key.
// Used to seed a demo/test board with real playback.
//   node scripts/seed-tapes.js <tenant> <password> <job> <file>
const http = require('http');
const fs = require('fs');
const wasabi = require('../src/wasabi');
const { mediaKey } = require('../src/tenant');

const [, , tenant, password, job, file] = process.argv;
if (!tenant || !password || !job || !file) {
  console.error('usage: node scripts/seed-tapes.js <tenant> <password> <job> <file>');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error('file not found: ' + file); process.exit(1); }
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
  console.log(`${cands.length} candidates on ${tenant}/${job}`);

  let done = 0;
  for (const c of cands) {
    const key = mediaKey(tenant, job, c.id, 'tape.m4v');
    await wasabi.uploadObject(key, file, 'video/mp4');
    const r = await req('PUT', `/api/casting/candidates/${c.id}`, { cookie, body: { tapeKey: key } });
    if (r.status !== 200) throw new Error(`set tape_key failed for ${c.name}: ${r.status}`);
    done++;
    process.stdout.write(`  ✓ ${c.name} (${done}/${cands.length})\n`);
  }
  console.log(`\nattached tape to ${done} candidate(s).`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
