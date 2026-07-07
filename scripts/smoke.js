#!/usr/bin/env node
'use strict';
// Local integration smoke test — runs against a server on 127.0.0.1:$CASTING_PORT.
// Exercises: auth gate, board get-or-create, role/candidate/assignment CRUD, and
// tenant isolation (upshot cookie rejected on iq; iq sees none of upshot's data).
// Assumes tenants 'upshot' + 'iq' are onboarded with the passwords below.
const http = require('http');

const PORT = Number(process.env.CASTING_PORT) || 4100;
const PW = { upshot: 'upshot-test-pw', iq: 'iq-test-pw' };

function req(method, path, { host = '127.0.0.1', cookie = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: {
        Host: host,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Extract the cs_session cookie value from a Set-Cookie header (bypasses curl's
// Secure-attribute enforcement — we send it back manually over http).
function sessionCookie(res) {
  const sc = (res.headers['set-cookie'] || []).find((c) => c.startsWith('cs_session='));
  return sc ? sc.split(';')[0] : '';
}

async function login(slug) {
  const host = `${slug}.casting.holdcrew.com`;
  const r = await req('POST', '/api/login', { host, body: { password: PW[slug] } });
  if (r.status !== 200) throw new Error(`login ${slug} failed: ${r.status} ${r.raw}`);
  const c = sessionCookie(r);
  if (!c) throw new Error(`login ${slug}: no cookie`);
  return { host, cookie: c };
}

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  passed++; console.log('  ✓ ' + label);
}

(async () => {
  // Health is public
  const h = await req('GET', '/api/health');
  ok(h.status === 200 && h.json.service === 'holdcrew-casting', 'health public + ok');

  // Gate: no cookie → 401 (via a real subdomain host so a tenant resolves)
  const gated = await req('GET', '/api/casting/board?job=SMOKE', { host: 'upshot.casting.holdcrew.com' });
  ok(gated.status === 401, 'casting API blocked without auth');

  // Bad password → 401
  const bad = await req('POST', '/api/login', { host: 'upshot.casting.holdcrew.com', body: { password: 'nope' } });
  ok(bad.status === 401, 'bad password rejected');

  const U = await login('upshot');
  ok(true, 'upshot login → cookie');

  // Board get-or-create (empty)
  let board = (await req('GET', '/api/casting/board?job=SMOKE', U)).json;
  ok(board.project && board.project.job === 'SMOKE', 'board get-or-create project');
  ok(board.roles.length === 0 && board.candidates.length === 0, 'new board is empty');

  // Create a role
  const role = (await req('POST', '/api/casting/roles', { ...U, body: { job: 'SMOKE', name: 'LEAD', character: 'The Writer' } })).json;
  ok(role.id && role.name === 'LEAD', 'role created');
  const dup = await req('POST', '/api/casting/roles', { ...U, body: { job: 'SMOKE', name: 'lead' } });
  ok(dup.status === 409, 'duplicate role name rejected');

  // Create a candidate
  const cand = (await req('POST', '/api/casting/candidates', { ...U, body: {
    job: 'SMOKE', name: 'Brian Le', pronouns: 'He/Him', agency: 'Noble Caplan Abrams',
    union: 'Non-Union', avail: { travel: 'ok', fitting: 'ok', shoot: 'ok' },
  } })).json;
  ok(cand.id && cand.name === 'Brian Le', 'candidate created');
  ok(cand.union === 'Non-Union' && cand.avail.travel === 'ok', 'candidate fields round-trip');

  // Assign candidate → role, set status
  const asg = (await req('PUT', '/api/casting/assignments', { ...U, body: { candidateId: cand.id, roleId: role.id, status: 'select' } })).json;
  ok(asg.ok && asg.status === 'select', 'assignment upserted with status');

  // Board now reflects it
  board = (await req('GET', '/api/casting/board?job=SMOKE', U)).json;
  ok(board.roles.length === 1 && board.candidates.length === 1, 'board shows role + candidate');
  ok(board.candidates[0].assignments[role.id] === 'select', 'assignment status on board');

  // Change status, then unassign
  await req('PUT', '/api/casting/assignments', { ...U, body: { candidateId: cand.id, roleId: role.id, status: 'callback' } });
  board = (await req('GET', '/api/casting/board?job=SMOKE', U)).json;
  ok(board.candidates[0].assignments[role.id] === 'callback', 'status update persists');
  await req('DELETE', '/api/casting/assignments', { ...U, body: { candidateId: cand.id, roleId: role.id } });
  board = (await req('GET', '/api/casting/board?job=SMOKE', U)).json;
  ok(Object.keys(board.candidates[0].assignments).length === 0, 'unassign removes it');

  // ── Tenant isolation ──
  // upshot cookie must be rejected on the iq subdomain
  const crossed = await req('GET', '/api/casting/board?job=SMOKE', { host: 'iq.casting.holdcrew.com', cookie: U.cookie });
  ok(crossed.status === 401, 'upshot cookie rejected on iq (cross-tenant)');

  // iq logs in and sees a fresh, empty board for the same job name — no upshot data
  const I = await login('iq');
  const iqBoard = (await req('GET', '/api/casting/board?job=SMOKE', I)).json;
  ok(iqBoard.roles.length === 0 && iqBoard.candidates.length === 0, 'iq sees none of upshot data (isolation)');
  ok(iqBoard.project.id !== board.project.id, 'iq gets its own project for the same job name');

  // iq cannot mutate upshot's role/candidate ids
  const steal = await req('PUT', '/api/casting/assignments', { ...I, body: { candidateId: cand.id, roleId: role.id, status: 'booked' } });
  ok(steal.status === 404, 'iq cannot touch upshot records');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
