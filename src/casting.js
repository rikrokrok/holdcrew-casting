'use strict';
// Casting data layer + REST API (producer-side, gated by auth). Tenant isolation
// is the #1 rule: every query filters by tenant, and every child record is checked
// to belong to the requesting tenant + its project before mutation.
//
// Shape returned to the front-end (see casting.html): a board =
//   { project, roles:[{id,name,character,ord}],
//     candidates:[{...fields, assignments:{ <roleId>: status }}] }
const express = require('express');
const db = require('./db');
const wasabi = require('./wasabi');
const holdcrew = require('./holdcrew');
const { projectId, roleId, candidateId, assignmentId, mediaId } = require('./ids');

const router = express.Router();

// requireAuth (mounted upstream) guarantees a resolved, active tenant.
const eff = (req) => req.tenant.slug;

// 'submitted' = assigned to a role (in the General Call) but not yet shortlisted;
// it's the base an actor lands at when their role is known (CSV/import or the
// card's role picker). Shortlisting promotes them onto the Selects board.
const STATUSES = new Set(['submitted', 'shortlist', 'callback', 'recommend', 'backup', 'select', 'hold', 'booked', 'pass']);

// ── project resolution (one board per tenant+job) ────────────────────────────
const qProject = db.prepare('SELECT * FROM casting_projects WHERE tenant = ? AND job = ?');
function getOrCreateProject(tenant, job) {
  let p = qProject.get(tenant, job);
  if (!p) {
    const id = projectId();
    db.prepare('INSERT INTO casting_projects (id, tenant, job, title) VALUES (?, ?, ?, ?)')
      .run(id, tenant, job, job);
    p = db.prepare('SELECT * FROM casting_projects WHERE id = ?').get(id);
  }
  return p;
}
// Resolve a project the tenant already owns (no create) — for mutations by job.
function ownedProject(tenant, job) {
  return job ? qProject.get(tenant, job) : null;
}

// Find or create a role by name within a project (used by CSV import so roles
// come from the data). Case-insensitive match.
function getOrCreateRole(projectId, tenant, name) {
  let r = db.prepare('SELECT * FROM casting_roles WHERE project_id = ? AND lower(name) = lower(?)').get(projectId, name);
  if (!r) {
    const id = roleId();
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_roles WHERE project_id = ?').get(projectId).n;
    db.prepare('INSERT INTO casting_roles (id, project_id, tenant, name, character, ord) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, tenant, name, '', ord);
    r = db.prepare('SELECT * FROM casting_roles WHERE id = ?').get(id);
  }
  return r;
}

// ── candidate row <-> API shape ──────────────────────────────────────────────
function toCand(row) {
  return {
    id: row.id,
    name: row.name,
    number: row.number || '',
    pronouns: row.pronouns || '',
    email: row.email || '',
    phone: row.phone || '',
    agency: row.agency || '',
    agent: row.agent || '',
    agentEmail: row.agent_email || '',
    agentPhone: row.agent_phone || '',
    height: row.height || '',
    weight: row.weight || '',
    hair: row.hair || '',
    eyes: row.eyes || '',
    union: row.union_status || '',
    avail: { travel: row.avail_travel || '', fitting: row.avail_fitting || '', shoot: row.avail_shoot || '' },
    note: row.note || '',
    headshotKey: row.headshot_key || null,
    tapes: [],                 // filled by the board from casting_media
    source: row.source || null,
  };
}

// Tapes for a candidate (ordered), shaped for the front-end.
const qTapes = db.prepare("SELECT id, key, label FROM casting_media WHERE candidate_id = ? AND kind = 'tape' ORDER BY ord, created_at");
const tapesFor = (candId) => qTapes.all(candId).map((m) => ({ id: m.id, key: m.key, label: m.label || '' }));

// API body -> column map. Only keys present in `body` are returned (partial-safe).
function fromBody(body) {
  const out = {};
  const set = (col, val) => { if (val !== undefined) out[col] = val === null ? null : String(val); };
  set('name', body.name);
  set('number', body.number);
  set('pronouns', body.pronouns);
  set('email', body.email);
  set('phone', body.phone);
  set('agency', body.agency);
  set('agent', body.agent);
  set('agent_email', body.agentEmail);
  set('agent_phone', body.agentPhone);
  set('height', body.height);
  set('weight', body.weight);
  set('hair', body.hair);
  set('eyes', body.eyes);
  set('union_status', body.union);
  if (body.avail !== undefined) {
    set('avail_travel', body.avail?.travel ?? null);
    set('avail_fitting', body.avail?.fitting ?? null);
    set('avail_shoot', body.avail?.shoot ?? null);
  }
  set('note', body.note);
  set('headshot_key', body.headshotKey);
  set('tape_key', body.tapeKey);
  set('source', body.source);
  set('ext_ref', body.extRef);
  return out;
}

// ── Board (get-or-create the project, return roles + candidates + assignments) ─
router.get('/board', (req, res) => {
  const t = eff(req);
  const job = String(req.query.job || '').trim();
  if (!job) return res.status(400).json({ error: 'job_required' });
  const p = getOrCreateProject(t, job);
  const roles = db.prepare('SELECT id, name, character, ord FROM casting_roles WHERE project_id = ? ORDER BY ord, created_at').all(p.id);
  const cands = db.prepare('SELECT * FROM casting_candidates WHERE project_id = ? ORDER BY created_at').all(p.id);
  const asg = db.prepare('SELECT candidate_id, role_id, status FROM casting_assignments WHERE project_id = ?').all(p.id);
  const byCand = {};
  for (const a of asg) (byCand[a.candidate_id] ||= {})[a.role_id] = a.status;
  res.json({
    project: { id: p.id, job: p.job, title: p.title },
    roles,
    candidates: cands.map((c) => ({ ...toCand(c), assignments: byCand[c.id] || {}, tapes: tapesFor(c.id) })),
  });
});

// ── Candidate media (tapes) — attach / list / remove ─────────────────────────
router.post('/candidates/:id/media', (req, res) => {
  const cand = qCand.get(req.params.id, eff(req));
  if (!cand) return res.status(404).json({ error: 'candidate_not_found' });
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key_required' });
  const kind = req.body?.kind === 'headshot' ? 'headshot' : 'tape';
  const label = String(req.body?.label || '').trim();
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_media WHERE candidate_id = ? AND kind = ?').get(cand.id, kind).n;
  const id = mediaId();
  db.prepare('INSERT INTO casting_media (id, candidate_id, tenant, project_id, kind, key, label, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, cand.id, eff(req), cand.project_id, kind, key, label || null, ord);
  res.status(201).json({ id, key, label, kind, ord });
});

router.delete('/media/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM casting_media WHERE id = ? AND tenant = ?').get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'media_not_found' });
  db.prepare('DELETE FROM casting_media WHERE id = ?').run(row.id);
  res.status(204).end();
});

// ── Roles ────────────────────────────────────────────────────────────────────
router.post('/roles', (req, res) => {
  const t = eff(req);
  const job = String(req.body?.job || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!job || !name) return res.status(400).json({ error: 'job_and_name_required' });
  const p = getOrCreateProject(t, job);
  const dup = db.prepare('SELECT 1 FROM casting_roles WHERE project_id = ? AND lower(name) = lower(?)').get(p.id, name);
  if (dup) return res.status(409).json({ error: 'role_exists' });
  const character = String(req.body?.character || '').trim();
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_roles WHERE project_id = ?').get(p.id).n;
  const id = roleId();
  db.prepare('INSERT INTO casting_roles (id, project_id, tenant, name, character, ord) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, p.id, t, name, character, ord);
  res.status(201).json({ id, name, character, ord });
});

const qRole = db.prepare('SELECT * FROM casting_roles WHERE id = ? AND tenant = ?');
router.put('/roles/:id', (req, res) => {
  const row = qRole.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'role_not_found' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
  const character = req.body?.character !== undefined ? String(req.body.character).trim() : row.character;
  const ord = req.body?.ord !== undefined ? Number(req.body.ord) : row.ord;
  db.prepare('UPDATE casting_roles SET name = ?, character = ?, ord = ? WHERE id = ?')
    .run(name, character, ord, row.id);
  res.json({ id: row.id, name, character, ord });
});

router.delete('/roles/:id', (req, res) => {
  const row = qRole.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'role_not_found' });
  db.prepare('DELETE FROM casting_roles WHERE id = ?').run(row.id); // assignments cascade
  res.status(204).end();
});

// ── Candidates ───────────────────────────────────────────────────────────────
router.post('/candidates', (req, res) => {
  const t = eff(req);
  const job = String(req.body?.job || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!job || !name) return res.status(400).json({ error: 'job_and_name_required' });
  const p = getOrCreateProject(t, job);
  const cols = fromBody(req.body);
  cols.name = name;
  const id = candidateId();
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO casting_candidates (id, project_id, tenant, ${keys.join(', ')})
    VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(id, p.id, t, ...keys.map((k) => cols[k]));
  res.status(201).json(toCand(db.prepare('SELECT * FROM casting_candidates WHERE id = ?').get(id)));
});

const qCand = db.prepare('SELECT * FROM casting_candidates WHERE id = ? AND tenant = ?');
router.put('/candidates/:id', (req, res) => {
  const row = qCand.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'candidate_not_found' });
  const cols = fromBody(req.body);
  delete cols.ext_ref; // identity/import key isn't hand-editable
  const keys = Object.keys(cols);
  if (keys.length) {
    db.prepare(`UPDATE casting_candidates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => cols[k]), row.id);
  }
  res.json(toCand(db.prepare('SELECT * FROM casting_candidates WHERE id = ?').get(row.id)));
});

router.delete('/candidates/:id', (req, res) => {
  const row = qCand.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'candidate_not_found' });
  db.prepare('DELETE FROM casting_candidates WHERE id = ?').run(row.id); // assignments cascade
  res.status(204).end();
});

// ── Assignments (candidate x role + status) ──────────────────────────────────
// Upsert: assign a candidate to a role and/or set the per-role status. Both the
// candidate and the role must belong to the requesting tenant + the same project.
router.put('/assignments', (req, res) => {
  const t = eff(req);
  const cid = String(req.body?.candidateId || '');
  const rid = String(req.body?.roleId || '');
  const cand = qCand.get(cid, t);
  const role = qRole.get(rid, t);
  if (!cand || !role) return res.status(404).json({ error: 'candidate_or_role_not_found' });
  if (cand.project_id !== role.project_id) return res.status(400).json({ error: 'cross_project' });
  const existing = db.prepare('SELECT id, status FROM casting_assignments WHERE candidate_id = ? AND role_id = ?').get(cid, rid);
  const wanted = STATUSES.has(req.body?.status) ? req.body.status : null;
  let status;
  if (existing) {
    status = wanted || existing.status;
    db.prepare("UPDATE casting_assignments SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, existing.id);
  } else {
    status = wanted || 'shortlist';
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_assignments WHERE role_id = ?').get(rid).n;
    db.prepare('INSERT INTO casting_assignments (id, project_id, tenant, candidate_id, role_id, status, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(assignmentId(), cand.project_id, t, cid, rid, status, ord);
  }
  res.json({ ok: true, candidateId: cid, roleId: rid, status });
});

router.delete('/assignments', (req, res) => {
  const t = eff(req);
  const cid = String(req.body?.candidateId || '');
  const rid = String(req.body?.roleId || '');
  // Scope the delete to the tenant via the candidate (cheap + safe).
  if (!qCand.get(cid, t)) return res.status(404).json({ error: 'candidate_not_found' });
  db.prepare('DELETE FROM casting_assignments WHERE candidate_id = ? AND role_id = ? AND tenant = ?').run(cid, rid, t);
  res.status(204).end();
});

// ── Hold / Book → promote to the HoldCrew Job Log (the single cross-system write)
// Hold and Book are the two commitments. Both mark the (candidate × role)
// assignment (local truth) AND upsert a Talent row into that job's HoldCrew Job
// Log via v3-talent-save — Hold writes it pending (blank Hold Status, so it's a
// tentative talent, not yet on the call sheet), Book writes it Confirmed (which
// syncs to the call sheet/DPR). The local commit always succeeds; the Job Log
// write is reported honestly — on failure the commit stands and the UI says retry.
async function commitToRole(req, res, castingStatus, holdStatus) {
  const t = eff(req);
  const cand = qCand.get(req.params.id, t);
  if (!cand) return res.status(404).json({ error: 'candidate_not_found' });
  const rid = String(req.body?.roleId || '');
  const role = qRole.get(rid, t);
  if (!role) return res.status(404).json({ error: 'role_not_found' });
  if (cand.project_id !== role.project_id) return res.status(400).json({ error: 'cross_project' });
  const project = db.prepare('SELECT * FROM casting_projects WHERE id = ?').get(cand.project_id);

  // 1) local truth: upsert the assignment status.
  const existing = db.prepare('SELECT id FROM casting_assignments WHERE candidate_id = ? AND role_id = ?').get(cand.id, rid);
  if (existing) {
    db.prepare("UPDATE casting_assignments SET status = ?, updated_at = datetime('now') WHERE id = ?").run(castingStatus, existing.id);
  } else {
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_assignments WHERE role_id = ?').get(rid).n;
    db.prepare('INSERT INTO casting_assignments (id, project_id, tenant, candidate_id, role_id, status, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(assignmentId(), cand.project_id, t, cand.id, rid, castingStatus, ord);
  }

  // 2) cross-system: promote to the Job Log (character = the role's character, or
  // the role name if none). holdStatus '' = pending hold, 'Confirmed' = booked.
  const talent = {
    name: cand.name,
    email: cand.email || '',
    phone: cand.phone || '',
    character: role.character || role.name,
    agentName: cand.agent || '',
    agency: cand.agency || '',
    agentEmail: cand.agent_email || '',
    agentPhone: cand.agent_phone || '',
    union: cand.union_status || '',
    notes: cand.note || '',
    status: holdStatus,
  };
  try {
    const jobLog = await holdcrew.promoteToJobLog(t, project.job, talent);
    res.json({ ok: true, status: castingStatus, promoted: true, company: t, jobLog });
  } catch (e) {
    res.json({ ok: true, status: castingStatus, promoted: false, company: t, error: e.message });
  }
}

router.post('/candidates/:id/hold', (req, res) => commitToRole(req, res, 'hold', ''));
router.post('/candidates/:id/book', (req, res) => commitToRole(req, res, 'booked', 'Confirmed'));

// ── Media (headshots / tapes) — 302 to a short-lived presigned Wasabi GET ────
// Tenant-scoped: a key must live under the requesting tenant's prefix, so one
// tenant can never presign another's media.
router.get('/media', async (req, res) => {
  const t = eff(req);
  const key = String(req.query.key || '');
  if (!key || !key.startsWith(t + '/')) return res.status(403).json({ error: 'forbidden' });
  try {
    const url = await wasabi.presignKey(key);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, url);
  } catch (e) {
    res.status(502).json({ error: 'presign_failed' });
  }
});

// ── Import (CSV/Fillout) — upsert candidates into the General Call pool ───────
// Keyed on ext_ref (normalised name) so re-running an import (agency resubmits,
// a second wave) updates existing candidates and adds new ones without dupes.
// Empty incoming values never overwrite existing data (merge, not clobber).
const normName = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
router.post('/import', (req, res) => {
  const t = eff(req);
  const job = String(req.body?.job || '').trim();
  const rows = Array.isArray(req.body?.candidates) ? req.body.candidates : null;
  if (!job || !rows) return res.status(400).json({ error: 'job_and_candidates_required' });
  const p = getOrCreateProject(t, job);
  const findByRef = db.prepare('SELECT id FROM casting_candidates WHERE project_id = ? AND ext_ref = ?');
  let added = 0, updated = 0, skipped = 0;
  const findAsg = db.prepare('SELECT id FROM casting_assignments WHERE candidate_id = ? AND role_id = ?');
  const tx = db.transaction((list) => {
    for (const raw of list) {
      const name = String(raw?.name || '').trim();
      if (!name) { skipped++; continue; }
      const ref = normName(name);
      const cols = fromBody(raw);
      cols.name = name;
      cols.source = raw.source || 'csv-import';
      // Drop empty values so a blank CSV cell can't wipe existing data on re-import.
      const clean = {};
      for (const [k, v] of Object.entries(cols)) if (v !== undefined && v !== null && v !== '') clean[k] = v;
      const existing = findByRef.get(p.id, ref);
      let cid;
      if (existing) {
        cid = existing.id;
        const keys = Object.keys(clean);
        if (keys.length) {
          db.prepare(`UPDATE casting_candidates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...keys.map((k) => clean[k]), existing.id);
        }
        updated++;
      } else {
        cid = candidateId();
        clean.ext_ref = ref;
        const keys = Object.keys(clean);
        db.prepare(`INSERT INTO casting_candidates (id, project_id, tenant, ${keys.join(', ')})
          VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')})`)
          .run(cid, p.id, t, ...keys.map((k) => clean[k]));
        added++;
      }
      // Preassigned role from the CSV — put them "in" for that role at 'submitted'
      // (create the role if new; never downgrade an existing assignment's status).
      const roleName = String(raw?.role || '').trim();
      if (roleName) {
        const role = getOrCreateRole(p.id, t, roleName);
        if (!findAsg.get(cid, role.id)) {
          const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_assignments WHERE role_id = ?').get(role.id).n;
          db.prepare('INSERT INTO casting_assignments (id, project_id, tenant, candidate_id, role_id, status, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(assignmentId(), p.id, t, cid, role.id, 'submitted', ord);
        }
      }
    }
  });
  tx(rows);
  res.json({ ok: true, added, updated, skipped });
});

module.exports = router;
