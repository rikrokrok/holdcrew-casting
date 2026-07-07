#!/usr/bin/env node
'use strict';
// Onboard a casting tenant (a HoldCrew production company).
//   node scripts/onboard-tenant.js <slug> "<Name>" [password]
// Idempotent: re-running updates the name and (if given) the password. A tenant
// with no password is LOCKED until one is set. Mirrors reels' onboard model;
// bulk-seeding from the HoldCrew company registry / shared subscription registry
// is the future path (this is the manual mechanism until then).
const db = require('../src/db');

const [, , slug, name, password] = process.argv;

if (!slug || !name) {
  console.error('usage: node scripts/onboard-tenant.js <slug> "<Name>" [password]');
  process.exit(1);
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) {
  console.error(`bad slug "${slug}" — must be a DNS label (a-z 0-9 -, 1-40 chars).`);
  process.exit(1);
}
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'casting', 'reels', 'mail', 'ftp']);
if (RESERVED.has(slug)) {
  console.error(`slug "${slug}" is reserved.`);
  process.exit(1);
}

const existing = db.prepare('SELECT slug, password FROM tenants WHERE slug = ?').get(slug);
if (existing) {
  db.prepare('UPDATE tenants SET name = ? WHERE slug = ?').run(name, slug);
  if (password) db.prepare('UPDATE tenants SET password = ? WHERE slug = ?').run(password, slug);
  console.log(`updated tenant '${slug}' (${name})${password ? ' + password set' : ''}` +
    `${!password && !existing.password ? ' — still LOCKED (no password)' : ''}`);
} else {
  db.prepare('INSERT INTO tenants (slug, name, password) VALUES (?, ?, ?)')
    .run(slug, name, password || null);
  console.log(`created tenant '${slug}' (${name})${password ? ' + password set' : ' — LOCKED until a password is set'}`);
}
