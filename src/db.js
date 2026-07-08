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
