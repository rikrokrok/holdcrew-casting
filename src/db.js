'use strict';
// SQLite store for HoldCrew Casting. Mirrors the reels db.js idiom: base schema
// via CREATE TABLE IF NOT EXISTS, later changes gated by PRAGMA user_version.
// WAL keeps the nightly file-copy backup safe.
//
// Data model (see PLAN.md): a casting_project per (tenant, job); a role registry;
// a flat candidate pool (Cattle Call); (candidate x role) assignments carrying the
// selection status (Selects board); tokenized client-presentation sends.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA_DIR, { recursive: true });

const db = new Database(path.join(cfg.DATA_DIR, 'casting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Tenants = HoldCrew production companies (one per subdomain,
  -- <company>.casting.holdcrew.com). Real seeding comes from the HoldCrew company
  -- registry (task 2); a dev tenant is seeded below so local dev is testable.
  -- password NULL = LOCKED (unprovisioned); status active|disabled gates resolve.
  CREATE TABLE IF NOT EXISTS tenants (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    password    TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One casting board per (tenant, job). job = HoldCrew job suffix (loose link).
  CREATE TABLE IF NOT EXISTS casting_projects (
    id          TEXT PRIMARY KEY,
    tenant      TEXT NOT NULL,
    job         TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant, job)
  );
  CREATE INDEX IF NOT EXISTS idx_projects_tenant ON casting_projects(tenant);

  -- Role registry, typed up front. name = "LEAD", character = "The Writer".
  CREATE TABLE IF NOT EXISTS casting_roles (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    tenant      TEXT NOT NULL,
    name        TEXT NOT NULL,
    character   TEXT NOT NULL DEFAULT '',
    ord         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_roles_project ON casting_roles(project_id);

  -- Cattle Call pool. One row per person; details stored ONCE (assignments
  -- reference the candidate, so no per-role duplication). union_status avoids the
  -- reserved word 'union'. *_key columns are Wasabi keys in the holdcrew-casting
  -- bucket (<tenant>/<job>/<candidate>/{headshot.jpg,tape.mp4}); NULL = none yet.
  CREATE TABLE IF NOT EXISTS casting_candidates (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    tenant        TEXT NOT NULL,
    name          TEXT NOT NULL,
    pronouns      TEXT,
    email         TEXT,
    phone         TEXT,
    agency        TEXT,
    agent         TEXT,
    agent_email   TEXT,
    agent_phone   TEXT,
    height        TEXT,
    weight        TEXT,
    hair          TEXT,
    eyes          TEXT,
    union_status  TEXT,
    avail_travel  TEXT,
    avail_fitting TEXT,
    avail_shoot   TEXT,
    note          TEXT,
    headshot_key  TEXT,
    tape_key      TEXT,
    source        TEXT,                          -- e.g. 'fillout-import'
    ext_ref       TEXT,                          -- importer dedupe key (name-normalised)
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_candidates_project ON casting_candidates(project_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_extref  ON casting_candidates(project_id, ext_ref);

  -- Selects board: the (candidate x role) rows carrying selection status. A person
  -- can be Select for LEAD and Pass for FRIEND at once. ord = manual order in a role.
  CREATE TABLE IF NOT EXISTS casting_assignments (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    tenant        TEXT NOT NULL,
    candidate_id  TEXT NOT NULL REFERENCES casting_candidates(id) ON DELETE CASCADE,
    role_id       TEXT NOT NULL REFERENCES casting_roles(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'shortlist', -- shortlist|callback|recommend|backup|select|booked|pass
    ord           INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (candidate_id, role_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_project ON casting_assignments(project_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_role    ON casting_assignments(role_id);

  -- Tokenized client-presentation link (mirrors reels 'sends'). min_tier = the
  -- lowest status shown to the client (default 'select'); role_id NULL = whole board.
  CREATE TABLE IF NOT EXISTS casting_sends (
    token       TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    role_id     TEXT,
    min_tier    TEXT NOT NULL DEFAULT 'select',
    expiry      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sends_project ON casting_sends(project_id);
`);

// Casting/slate number (freeform: "12" or "a01"). Added after first ship, so
// migrate the live table. Idempotent.
if (!db.prepare('PRAGMA table_info(casting_candidates)').all().some((c) => c.name === 'number')) {
  db.exec('ALTER TABLE casting_candidates ADD COLUMN number TEXT');
}

// Usage / buyout / fees — captured at booking, feed HoldCrew Talent (session &
// usage costs). Placeholder for now (editable + persisted; ride along at Book via
// v3-talent-save's sessionCost/usageCost columns). Idempotent.
for (const col of ['session_fee', 'usage_fee', 'usage_terms']) {
  if (!db.prepare('PRAGMA table_info(casting_candidates)').all().some((c) => c.name === col)) {
    db.exec(`ALTER TABLE casting_candidates ADD COLUMN ${col} TEXT`);
  }
}

// HoldCrew linkage: a Held/Booked candidate is promoted into that company's
// HoldCrew Job Log via the v3-talent-save webhook, which authenticates with the
// company's registry slug + token. ONE slug — the casting tenant slug IS the
// HoldCrew company slug (Eric, 2026-07-08). Store just the token; set by
// scripts/link-holdcrew.js. hc_token NULL = not linked → Hold/Book still record
// locally but can't write the Job Log (surfaced honestly to the user).
if (!db.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'hc_token')) {
  db.exec('ALTER TABLE tenants ADD COLUMN hc_token TEXT');
}
// Drop the short-lived hc_slug bridge if a prior build added it (one-slug now).
try {
  if (db.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'hc_slug')) {
    db.exec('ALTER TABLE tenants DROP COLUMN hc_slug');
  }
} catch (e) { /* older sqlite w/o DROP COLUMN — harmless to leave the unused column */ }

// Pipeline axes (spec §"Pipeline, Combos & Client Presentation"): the (candidate
// × role) assignment carries three orthogonal axes instead of a single status —
// five timestamped progress milestones, a rank (primary|backup), and a disposition
// (''|pass|unavailable). `status` stays as a derived "furthest stage" so the current
// board/combos keep rendering (see src/pipeline.js). Columns added idempotently;
// the reconstruction of the axes from the pre-pipeline status is a one-time backfill
// gated on user_version so it can never double-run.
{
  const pipeline = require('./pipeline');
  const acols = db.prepare('PRAGMA table_info(casting_assignments)').all().map((c) => c.name);
  const add = (name, decl) => { if (!acols.includes(name)) db.exec(`ALTER TABLE casting_assignments ADD COLUMN ${name} ${decl}`); };
  add('ms_shortlist', 'TEXT');
  add('ms_recco', 'TEXT');
  add('ms_approved', 'TEXT');
  add('ms_booked', 'TEXT');
  add('ms_confirmed', 'TEXT');
  add('rank', "TEXT NOT NULL DEFAULT 'primary'");
  add('disposition', "TEXT NOT NULL DEFAULT ''");
  if (db.pragma('user_version', { simple: true }) < 1) {
    const rows = db.prepare('SELECT id, status FROM casting_assignments').all();
    db.transaction(() => { for (const r of rows) pipeline.backfillFromStatus(db, r.id, r.status); })();
    db.pragma('user_version = 1');
    if (rows.length) console.log(`[migrate] pipeline axes backfilled for ${rows.length} assignment(s)`);
  }
}

// Media files (casting tapes / headshots). A candidate has MANY takes, not one,
// so tapes live here (one row per file) rather than a single tape_key column.
db.exec(`
  CREATE TABLE IF NOT EXISTS casting_media (
    id           TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES casting_candidates(id) ON DELETE CASCADE,
    tenant       TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'tape',   -- tape | headshot
    key          TEXT NOT NULL,                  -- Wasabi object key
    label        TEXT,                           -- e.g. "Slate", "Scene 1", "Take 2"
    ord          INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_media_candidate ON casting_media(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_media_project ON casting_media(project_id);
`);

// Combinations ("combos" / groups): named, freely-labelled assembled options —
// one actor per role — for presenting the client alternative casts (e.g. an
// "Older Family" vs a "Younger Family"). grp = an optional free-text cluster
// label ('' = ungrouped). No structural anchor: each combo is an independent
// cast; overlap between combos (a reused actor) is incidental, not enforced.
db.exec(`
  CREATE TABLE IF NOT EXISTS casting_combos (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    tenant      TEXT NOT NULL,
    grp         TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    note        TEXT,
    ord         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_combos_project ON casting_combos(project_id);

  -- one pick per role per combo (a "family" has one dad); a candidate can be a
  -- slot in many combos.
  CREATE TABLE IF NOT EXISTS casting_combo_slots (
    id           TEXT PRIMARY KEY,
    combo_id     TEXT NOT NULL REFERENCES casting_combos(id) ON DELETE CASCADE,
    tenant       TEXT NOT NULL,
    role_id      TEXT NOT NULL REFERENCES casting_roles(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES casting_candidates(id) ON DELETE CASCADE,
    ord          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (combo_id, role_id)
  );
  CREATE INDEX IF NOT EXISTS idx_comboslots_combo ON casting_combo_slots(combo_id);
`);

// Client presentation pages (spec §"Client presentation = curated pages"). A page
// is a first-class, named, multi-instance object (create → name → assign): the PM
// curates which reccos/combos the client sees, which take plays, and whether each
// role's backups are shown. Each page has its own unguessable token = a passive,
// tokenized lookbook (reels 'sends' lineage, promoted to a named object). The client
// only reviews; approvals come back off-platform and the PM records them on the pipeline.
db.exec(`
  CREATE TABLE IF NOT EXISTS casting_pages (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES casting_projects(id) ON DELETE CASCADE,
    tenant      TEXT NOT NULL,
    name        TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,           -- public /present/<token> link
    intro       TEXT,                            -- optional note shown atop the lookbook
    ord         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pages_project ON casting_pages(project_id);
  CREATE INDEX IF NOT EXISTS idx_pages_token   ON casting_pages(token);

  -- Items on a page, in order. kind='individual' → ref_id = candidate_id shown for
  -- role_id (the client's options for one role); kind='combo' → ref_id = combo_id
  -- (an assembled cast presented as one block). take_id = which tape plays (NULL =
  -- latest); show_backup = also include that role's backups.
  CREATE TABLE IF NOT EXISTS casting_page_items (
    id          TEXT PRIMARY KEY,
    page_id     TEXT NOT NULL REFERENCES casting_pages(id) ON DELETE CASCADE,
    tenant      TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'individual',   -- individual | combo
    ref_id      TEXT NOT NULL,                        -- candidate_id | combo_id
    role_id     TEXT,                                 -- individual: which role
    take_id     TEXT,                                 -- chosen casting_media tape (NULL = latest)
    show_backup INTEGER NOT NULL DEFAULT 0,
    ord         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pageitems_page ON casting_page_items(page_id);
`);

// Migrate the legacy single tape_key -> a casting_media 'Take 1' row. Idempotent
// (skips a candidate whose tape_key is already represented).
{
  const legacy = db.prepare("SELECT id, tenant, project_id, tape_key FROM casting_candidates WHERE tape_key IS NOT NULL AND tape_key <> ''").all();
  const has = db.prepare('SELECT 1 FROM casting_media WHERE candidate_id = ? AND key = ?');
  const ins = db.prepare("INSERT INTO casting_media (id, candidate_id, tenant, project_id, kind, key, label, ord) VALUES (?, ?, ?, ?, 'tape', ?, 'Take 1', 0)");
  const crypto = require('crypto');
  let n = 0;
  for (const r of legacy) {
    if (!has.get(r.id, r.tape_key)) { ins.run('m_' + crypto.randomBytes(8).toString('hex').slice(0, 10), r.id, r.tenant, r.project_id, r.tape_key); n++; }
  }
  if (n) console.log(`[migrate] moved ${n} legacy tape_key -> casting_media`);
}

// Dev tenant so local dev / boot check is testable before the real HoldCrew-
// company seeding (task 2). Password stays NULL (locked) unless CASTING_PASSWORD
// seeds it, mirroring reels' one-time password seed.
if (cfg.defaultTenant) {
  db.prepare('INSERT OR IGNORE INTO tenants (slug, name) VALUES (?, ?)')
    .run(cfg.defaultTenant, cfg.defaultTenant);
  if (cfg.password) {
    const t = db.prepare('SELECT password FROM tenants WHERE slug = ?').get(cfg.defaultTenant);
    if (t && !t.password) {
      db.prepare('UPDATE tenants SET password = ? WHERE slug = ?').run(cfg.password, cfg.defaultTenant);
    }
  }
}

module.exports = db;
