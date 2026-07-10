'use strict';
// HoldCrew Casting service — task 1 scaffold: boot, tenant resolve, health, static.
// Auth (task 2), the casting data-layer routers (task 3), media/Wasabi (task 6),
// and the client-presentation token routes (task 7) mount here as they land.
const express = require('express');
const path = require('path');
const cfg = require('./config');
const db = require('./db'); // ensure schema at boot
const tenant = require('./tenant');
const auth = require('./auth');
const castingRouter = require('./casting');
const pages = require('./pages');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

// Resolve req.tenant from the subdomain on every request (attach-only for now).
app.use(tenant.resolve);

// ── Health (public) ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const projects = db.prepare('SELECT COUNT(*) AS c FROM casting_projects').get().c;
  res.json({
    ok: true,
    service: 'holdcrew-casting',
    tenant: req.tenant ? req.tenant.slug : null,   // resolved + active
    requestedTenant: req.tenantSlug,               // what the host asked for
    projects,
    wasabi: cfg.wasabi.configured ? 'configured' : 'MISSING_CREDENTIALS',
    bucket: cfg.wasabi.bucket,
  });
});

// ── Auth: login page + login/logout (public) ────────────────────────────────
app.use(auth.router);

// ── Casting data API (producer-side; gated per tenant) ───────────────────────
app.use('/api/casting', auth.requireAuth, castingRouter);
app.use('/api/casting', auth.requireAuth, pages.producer);   // presentation-page CRUD

// ── Client presentation (public, token-only — no login) ──────────────────────
// /present/<token>/{data,media} = the lookbook JSON + token-scoped media presign;
// /present/<token> = the passive viewer page. The token is the only credential.
app.use('/present', pages.public);
app.get('/present/:token', (_req, res) => res.sendFile(path.join(cfg.PUBLIC_DIR, 'present.html')));

// ── Gated board page (the producer-side builder) ─────────────────────────────
// Registered before static so /casting(.html) can't be served ungated.
app.get(['/casting', '/casting.html'], auth.page('casting.html'));

// ── Static (landing, login, css) ─────────────────────────────────────────────
app.use(express.static(cfg.PUBLIC_DIR, { extensions: ['html'] }));

app.listen(cfg.PORT, '127.0.0.1', () => {
  console.log(`HoldCrew Casting on http://127.0.0.1:${cfg.PORT}  ` +
    `(wasabi: ${cfg.wasabi.configured ? 'ok' : 'MISSING'}, bucket: ${cfg.wasabi.bucket})`);
});

module.exports = app;
