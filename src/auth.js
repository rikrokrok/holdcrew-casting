'use strict';
// Per-tenant gate for the producer-side casting builder. Each tenant has its own
// password (tenants.password); a tenant with no password is LOCKED (unprovisioned
// → deny). Session = signed HttpOnly cookie, HMAC keyed on the tenant's password
// AND bound to the slug, so a cookie is only ever valid for its own tenant.
// Changing a password invalidates that tenant's sessions. `authTenant` /
// `tenantPassword` are the seams for the future shared identity / subscription
// registry. The public client-presentation routes (task 7) stay ungated.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');
const { PUBLIC_DIR } = require('./config');

const COOKIE = 'cs_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const pwStmt = db.prepare('SELECT password FROM tenants WHERE slug = ?');

// Tenant an auth decision applies to: only a known + active tenant (resolved by
// subdomain, or the dev default). Unknown/disabled/apex → null (deny). No legacy
// apex-builder fallback (casting is multi-tenant from day one).
function authTenant(req) {
  return req.tenant ? req.tenant.slug : null;
}

// SEAM: where a tenant's shared secret comes from (later: shared registry / users).
function tenantPassword(slug) {
  if (!slug) return null;
  const r = pwStmt.get(slug);
  return r && r.password ? r.password : null;
}

function sign(secret, slug, exp) {
  return crypto.createHmac('sha256', secret).update(`${slug}.${exp}`).digest('base64url');
}
function makeToken(secret, slug) {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(secret, slug, exp)}`;
}
function validFor(secret, slug, token) {
  if (!token || !token.includes('.')) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = sign(secret, slug, exp);
  return mac.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
}

function authed(req) {
  const slug = authTenant(req);
  const secret = tenantPassword(slug);
  if (!secret) return false; // unknown/disabled/unprovisioned → locked
  return validFor(secret, slug, cookieToken(req));
}

function requireAuth(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: 'auth_required' });
}

// Only allow same-origin path redirects (no open-redirect via //host or http://).
const safeNext = (v) => (/^\/[^/]/.test(String(v || '')) ? String(v) : '/');

// Serve a gated page if authed, else bounce to login carrying the intended path.
const page = (file) => (req, res) => (authed(req)
  ? res.sendFile(path.join(PUBLIC_DIR, file))
  : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));

const router = express.Router();

router.get('/login', (req, res) => {
  if (authed(req)) return res.redirect(safeNext(req.query.next));
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

router.post('/api/login', (req, res) => {
  const slug = authTenant(req);
  const secret = tenantPassword(slug);
  const pw = String(req.body?.password || '');
  // Uniform failure for missing/unprovisioned secret or mismatch (no info leak).
  const ok = !!secret && pw.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: 'bad_password' });
  res.cookie(COOKIE, makeToken(secret, slug), {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: TTL_MS, path: '/',
  });
  res.json({ ok: true });
});

router.post('/api/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

module.exports = { router, requireAuth, page, authed, tenantPassword };
