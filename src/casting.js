'use strict';
// Casting data layer + REST API (producer-side, gated by auth). Tenant isolation
// is the #1 rule: every query filters by tenant, and every child record is checked
// to belong to the requesting tenant + its project before mutation.
//
// Shape returned to the front-end (see casting.html): a board =
//   { project, roles:[{id,name,character,ord}],
//     candidates:[{...fields, assignments:{ <roleId>: status }}] }
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const db = require('./db');
const wasabi = require('./wasabi');
const holdcrew = require('./holdcrew');
const pipeline = require('./pipeline');
const { mediaKey } = require('./tenant');
const { serveMedia, writeBuffer, writeFromFile, removeLocal } = require('./media');
const { projectId, roleId, candidateId, assignmentId, mediaId, comboId, comboSlotId, rand } = require('./ids');

const router = express.Router();

// requireAuth (mounted upstream) guarantees a resolved, active tenant.
const eff = (req) => req.tenant.slug;

// 'submitted' = assigned to a role (in the General Call) but not yet shortlisted;
// it's the base an actor lands at when their role is known (CSV/import or the
// card's role picker). Shortlisting promotes them onto the Selects board. The
// valid status vocabulary + the three-axis model behind it live in src/pipeline.js.

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
    sessionFee: row.session_fee || '',
    usageFee: row.usage_fee || '',
    usageTerms: row.usage_terms || '',
    headshotKey: row.headshot_key || null,
    tapes: [],                 // filled by the board from casting_media
    source: row.source || null,
  };
}

// Tapes for a candidate (ordered), shaped for the front-end.
const qTapes = db.prepare("SELECT id, key, label FROM casting_media WHERE candidate_id = ? AND kind = 'tape' ORDER BY ord, created_at");
const tapesFor = (candId) => qTapes.all(candId).map((m) => ({ id: m.id, key: m.key, label: m.label || '' }));

// Combo (assembled option) row -> API shape { id, grp, name, note, ord, slots:{roleId:candId} }.
const qComboSlots = db.prepare('SELECT role_id, candidate_id FROM casting_combo_slots WHERE combo_id = ? ORDER BY ord');
function toCombo(row) {
  const slots = {};
  for (const s of qComboSlots.all(row.id)) slots[s.role_id] = s.candidate_id;
  return { id: row.id, grp: row.grp || '', name: row.name, note: row.note || '', ord: row.ord, slots };
}
const qCombo = db.prepare('SELECT * FROM casting_combos WHERE id = ? AND tenant = ?');

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
  set('session_fee', body.sessionFee);
  set('usage_fee', body.usageFee);
  set('usage_terms', body.usageTerms);
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
  const asg = db.prepare(`SELECT candidate_id, role_id, status, ${pipeline.AXIS_COLS} FROM casting_assignments WHERE project_id = ?`).all(p.id);
  // Two views of each assignment: `assignments[roleId] = status` (the derived
  // furthest stage the current board renders, unchanged) and `pipeline[roleId] =
  // {status, rank, disposition, ms, gaps}` (the three axes the audit UI consumes).
  const byCand = {}, pipeByCand = {};
  for (const a of asg) {
    (byCand[a.candidate_id] ||= {})[a.role_id] = a.status;
    (pipeByCand[a.candidate_id] ||= {})[a.role_id] = pipeline.shape(a);
  }
  const combos = db.prepare('SELECT * FROM casting_combos WHERE project_id = ? ORDER BY ord, created_at').all(p.id);
  const pages = db.prepare('SELECT id, name, token, ord FROM casting_pages WHERE project_id = ? ORDER BY ord, created_at').all(p.id)
    .map((pg) => ({ ...pg, items: db.prepare('SELECT COUNT(*) AS n FROM casting_page_items WHERE page_id = ?').get(pg.id).n }));
  res.json({
    project: { id: p.id, job: p.job, title: p.title },
    roles,
    candidates: cands.map((c) => ({ ...toCand(c), assignments: byCand[c.id] || {}, pipeline: pipeByCand[c.id] || {}, tapes: tapesFor(c.id) })),
    combos: combos.map(toCombo),
    pages,
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

// ── Headshot upload — the raw image body is written to the local media store ──
// The photo IS the identifier in casting, so this is core. Key includes a random
// so each upload is a fresh path (no stale-cache on replace); the old object is
// deleted. Wasabi is retired — the on-disk store is the source of truth.
const rawImage = express.raw({ type: ['image/*'], limit: '20mb' });
router.post('/candidates/:id/headshot', rawImage, async (req, res) => {
  const t = eff(req);
  const cand = qCand.get(req.params.id, t);
  if (!cand) return res.status(404).json({ error: 'candidate_not_found' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty_body' });
  const ct = (req.headers['content-type'] || 'image/jpeg').toLowerCase().split(';')[0];
  const ext = ct.endsWith('png') ? 'png' : ct.endsWith('webp') ? 'webp' : ct.endsWith('gif') ? 'gif' : 'jpg';
  const project = db.prepare('SELECT job FROM casting_projects WHERE id = ?').get(cand.project_id);
  const key = mediaKey(t, project.job, cand.id, `headshot-${rand(6)}.${ext}`);
  try {
    writeBuffer(key, buf);
    if (cand.headshot_key && cand.headshot_key !== key) removeLocal(cand.headshot_key);
    db.prepare("UPDATE casting_candidates SET headshot_key = ?, updated_at = datetime('now') WHERE id = ?").run(key, cand.id);
    res.status(201).json({ ok: true, headshotKey: key });
  } catch (e) {
    res.status(500).json({ error: 'upload_failed', detail: e.message });
  }
});

// ── Tape (self-tape / take) upload — video streams to a temp file then Wasabi ─
// Videos are big, so we stream to disk (not buffer in memory) and add a
// casting_media 'tape' row (a candidate has MANY takes). ?label names the take.
router.post('/candidates/:id/tape', (req, res) => {
  const t = eff(req);
  const cand = qCand.get(req.params.id, t);
  if (!cand) return res.status(404).json({ error: 'candidate_not_found' });
  let ct = (req.headers['content-type'] || '').toLowerCase().split(';')[0];
  if (!ct || ct === 'application/octet-stream') ct = 'video/mp4';
  if (!/^video\//.test(ct)) return res.status(415).json({ error: 'not_video' });
  const ext = ct.includes('quicktime') ? 'mov' : ct.includes('webm') ? 'webm' : ct.includes('m4v') ? 'm4v' : 'mp4';
  const label = String(req.query.label || '').trim().slice(0, 60);
  const project = db.prepare('SELECT job FROM casting_projects WHERE id = ?').get(cand.project_id);
  const ord = db.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_media WHERE candidate_id = ? AND kind = 'tape'").get(cand.id).n;
  const key = mediaKey(t, project.job, cand.id, `take-${ord + 1}-${rand(4)}.${ext}`);
  const tmp = path.join(os.tmpdir(), `cast-tape-${cand.id}-${Date.now()}.${ext}`);
  const ws = fs.createWriteStream(tmp);
  let done = false;
  const cleanup = () => { try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (e) {} };
  const fail = (code, err) => { if (done) return; done = true; try { ws.destroy(); } catch (e) {} cleanup(); res.status(code).json({ error: err }); };
  req.on('error', () => fail(400, 'stream_error'));
  ws.on('error', () => fail(500, 'write_error'));
  ws.on('finish', async () => {
    if (done) return;
    try {
      if (!fs.statSync(tmp).size) return fail(400, 'empty_body');
      writeFromFile(key, tmp);   // moves tmp into the local store (Wasabi retired)
      const id = mediaId();
      const lbl = label || `Take ${ord + 1}`;
      db.prepare("INSERT INTO casting_media (id, candidate_id, tenant, project_id, kind, key, label, ord) VALUES (?, ?, ?, ?, 'tape', ?, ?, ?)")
        .run(id, cand.id, t, cand.project_id, key, lbl, ord);
      done = true;
      res.status(201).json({ id, key, label: lbl, ord });
    } catch (e) {
      fail(502, 'upload_failed');
    } finally {
      cleanup();
    }
  });
  req.pipe(ws);
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
  // Transitional single-select write: applyLegacyStatus stores the picked status
  // verbatim AND syncs the three axes to match (see src/pipeline.js). A brand-new
  // row is created at the 'submitted' base first, then set to the wanted status
  // (default 'shortlist', preserving the old assign-defaults-to-shortlist behaviour).
  const existing = db.prepare('SELECT id, status FROM casting_assignments WHERE candidate_id = ? AND role_id = ?').get(cid, rid);
  const wanted = pipeline.LEGACY[req.body?.status] ? req.body.status : null;
  let id, status;
  if (existing) {
    id = existing.id;
    status = wanted ? pipeline.applyLegacyStatus(db, id, wanted) : existing.status;
  } else {
    id = assignmentId();
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_assignments WHERE role_id = ?').get(rid).n;
    db.prepare('INSERT INTO casting_assignments (id, project_id, tenant, candidate_id, role_id, status, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, cand.project_id, t, cid, rid, 'submitted', ord);
    status = pipeline.applyLegacyStatus(db, id, wanted || 'shortlist');
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

// Ensure a (candidate × role) assignment exists for this tenant, creating it at the
// 'submitted' base if missing. Returns { cand, role, asgId } or null (bad ids /
// cross-project). Shared by the commitments and the pipeline-axis primitives.
function ensureAsg(t, candId, roleId) {
  const cand = qCand.get(candId, t);
  const role = qRole.get(roleId, t);
  if (!cand || !role || cand.project_id !== role.project_id) return null;
  let asg = db.prepare('SELECT id FROM casting_assignments WHERE candidate_id = ? AND role_id = ?').get(cand.id, role.id);
  if (!asg) {
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_assignments WHERE role_id = ?').get(role.id).n;
    const id = assignmentId();
    db.prepare('INSERT INTO casting_assignments (id, project_id, tenant, candidate_id, role_id, status, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, cand.project_id, t, cand.id, role.id, 'submitted', ord);
    asg = { id };
  }
  return { cand, role, asgId: asg.id };
}

// ── Booked / Confirmed → promote to the HoldCrew Job Log (the cross-system write)
// The two committing milestones. Ticking one marks the assignment (local truth via
// the pipeline axes) AND upserts a Talent row into that job's HoldCrew Job Log via
// v3-talent-save — Booked writes it pending (blank Hold Status: a tentative talent,
// not yet on the call sheet), Confirmed writes it Confirmed (which syncs to the call
// sheet/DPR). The local tick always succeeds; the Job Log write is reported honestly
// — on failure the tick stands and the UI says retry. Reached from the Booked/Confirmed
// buttons AND from ticking those milestones on the audit strip, so it lives here once.
// Mirror casting's derived committing state into the HoldCrew Job Log. The milestones
// are independently tickable (audit strip), so we ALWAYS re-derive the Job Log status
// from the FURTHEST committing milestone rather than the one just tapped:
//   • tick an earlier stage → a Confirmed talent STAYS Confirmed (no accidental
//     downgrade — Brian Le, 2026-07-12; order can't be assumed);
//   • un-tick Confirmed/Booked → they downgrade to pending (''), which drops them off
//     the call sheet (Eric: must be able to downgrade).
// Confirmed iff the confirmed milestone is set; otherwise pending. The local tick always
// stands; the Job Log write is reported honestly (retry on failure).
async function syncTalentToJobLog(t, cand, role, asgId) {
  const confirmed = !!db.prepare('SELECT ms_confirmed FROM casting_assignments WHERE id = ?').get(asgId).ms_confirmed;
  const project = db.prepare('SELECT job FROM casting_projects WHERE id = ?').get(cand.project_id);
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
    sessionCost: cand.session_fee || '',   // usage/buyout/fees ride along (placeholder)
    usageCost: cand.usage_fee || '',
    status: confirmed ? 'Confirmed' : '',
  };
  try {
    const jobLog = await holdcrew.promoteToJobLog(t, project.job, talent);
    return { promoted: true, jobLog };
  } catch (e) {
    return { promoted: false, error: e.message };
  }
}

// Set a committing milestone (Booked/Confirmed) then re-sync the Job Log. Reached from the
// Booked/Confirmed buttons; the audit strip drives the same seam via setMilestone + sync.
async function commitMilestone(t, cand, role, asgId, milestone) {
  const status = pipeline.setMilestone(db, asgId, milestone, true);
  const out = await syncTalentToJobLog(t, cand, role, asgId);
  return { status, ...out };
}

async function commitToRole(req, res, milestone) {
  const r = ensureAsg(eff(req), req.params.id, String(req.body?.roleId || ''));
  if (!r) return res.status(404).json({ error: 'candidate_or_role_not_found' });
  const out = await commitMilestone(eff(req), r.cand, r.role, r.asgId, milestone);
  res.json({ ok: true, company: eff(req), ...out });
}

// hold/book route names kept for the current UI; they set the Booked/Confirmed
// milestones (spec rename Hold→Booked, Book→Confirmed).
router.post('/candidates/:id/hold', (req, res) => commitToRole(req, res, 'booked'));
router.post('/candidates/:id/book', (req, res) => commitToRole(req, res, 'confirmed'));

// ── Pipeline axes (independent, timestamped) — the audit UI drives these ──────
// Tick/untick one progress milestone. Ticking Booked/Confirmed also promotes to the
// Job Log (same seam as the buttons); every other tick is local-only.
router.put('/assignments/milestone', async (req, res) => {
  const t = eff(req);
  const r = ensureAsg(t, String(req.body?.candidateId || ''), String(req.body?.roleId || ''));
  if (!r) return res.status(404).json({ error: 'candidate_or_role_not_found' });
  const milestone = String(req.body?.milestone || '');
  if (!pipeline.MS_COL[milestone]) return res.status(400).json({ error: 'bad_milestone' });
  const on = req.body?.on !== false && req.body?.on !== 'false';
  const status = pipeline.setMilestone(db, r.asgId, milestone, on);
  // Booked/Confirmed changes re-sync the Job Log EITHER direction: ticking (incl. an
  // earlier stage) never downgrades a Confirmed talent; un-ticking Confirmed/Booked
  // downgrades them (off the call sheet). Every other tick is local-only.
  if (milestone === 'booked' || milestone === 'confirmed') {
    const out = await syncTalentToJobLog(t, r.cand, r.role, r.asgId);
    return res.json({ ok: true, candidateId: r.cand.id, roleId: r.role.id, milestone, on, status, company: t, ...out });
  }
  res.json({ ok: true, candidateId: r.cand.id, roleId: r.role.id, milestone, on, status });
});

// Rank (primary|backup) and disposition (''|pass|unavailable) — the other two axes.
router.put('/assignments/rank', (req, res) => {
  const r = ensureAsg(eff(req), String(req.body?.candidateId || ''), String(req.body?.roleId || ''));
  if (!r) return res.status(404).json({ error: 'candidate_or_role_not_found' });
  res.json({ ok: true, candidateId: r.cand.id, roleId: r.role.id, ...pipeline.setRank(db, r.asgId, String(req.body?.rank || '')) });
});
router.put('/assignments/disposition', (req, res) => {
  const r = ensureAsg(eff(req), String(req.body?.candidateId || ''), String(req.body?.roleId || ''));
  if (!r) return res.status(404).json({ error: 'candidate_or_role_not_found' });
  res.json({ ok: true, candidateId: r.cand.id, roleId: r.role.id, ...pipeline.setDisposition(db, r.asgId, String(req.body?.disposition || '')) });
});

// ── Combinations (named assembled casts for client options) ──────────────────
router.post('/combos', (req, res) => {
  const t = eff(req);
  const job = String(req.body?.job || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!job || !name) return res.status(400).json({ error: 'job_and_name_required' });
  const p = getOrCreateProject(t, job);
  const grp = String(req.body?.grp || '').trim();
  const note = String(req.body?.note || '').trim();
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_combos WHERE project_id = ?').get(p.id).n;
  const id = comboId();
  db.prepare('INSERT INTO casting_combos (id, project_id, tenant, grp, name, note, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, t, grp, name, note, ord);
  res.status(201).json(toCombo(db.prepare('SELECT * FROM casting_combos WHERE id = ?').get(id)));
});

router.put('/combos/:id', (req, res) => {
  const row = qCombo.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'combo_not_found' });
  const grp  = req.body?.grp  !== undefined ? String(req.body.grp).trim()  : row.grp;
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
  const note = req.body?.note !== undefined ? String(req.body.note).trim() : (row.note || '');
  const ord  = req.body?.ord  !== undefined ? Number(req.body.ord)         : row.ord;
  if (!name) return res.status(400).json({ error: 'name_required' });
  db.prepare("UPDATE casting_combos SET grp = ?, name = ?, note = ?, ord = ?, updated_at = datetime('now') WHERE id = ?")
    .run(grp, name, note, ord, row.id);
  res.json(toCombo(db.prepare('SELECT * FROM casting_combos WHERE id = ?').get(row.id)));
});

router.delete('/combos/:id', (req, res) => {
  const row = qCombo.get(req.params.id, eff(req));
  if (!row) return res.status(404).json({ error: 'combo_not_found' });
  db.prepare('DELETE FROM casting_combos WHERE id = ?').run(row.id); // slots cascade
  res.status(204).end();
});

// Duplicate a combo + its slots — the fast path to a variant (rename, swap a few).
router.post('/combos/:id/duplicate', (req, res) => {
  const t = eff(req);
  const row = qCombo.get(req.params.id, t);
  if (!row) return res.status(404).json({ error: 'combo_not_found' });
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_combos WHERE project_id = ?').get(row.project_id).n;
  const newName = (String(req.body?.name || '').trim()) || (row.name + ' copy');
  const id = comboId();
  db.transaction(() => {
    db.prepare('INSERT INTO casting_combos (id, project_id, tenant, grp, name, note, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, row.project_id, t, row.grp, newName, row.note, ord);
    for (const s of db.prepare('SELECT role_id, candidate_id, ord FROM casting_combo_slots WHERE combo_id = ?').all(row.id)) {
      db.prepare('INSERT INTO casting_combo_slots (id, combo_id, tenant, role_id, candidate_id, ord) VALUES (?, ?, ?, ?, ?, ?)')
        .run(comboSlotId(), id, t, s.role_id, s.candidate_id, s.ord);
    }
  })();
  res.status(201).json(toCombo(db.prepare('SELECT * FROM casting_combos WHERE id = ?').get(id)));
});

// Set (or clear) a combo's pick for one role. candidateId '' | null clears the slot.
router.put('/combos/:id/slots', (req, res) => {
  const t = eff(req);
  const combo = qCombo.get(req.params.id, t);
  if (!combo) return res.status(404).json({ error: 'combo_not_found' });
  const rid = String(req.body?.roleId || '');
  const role = qRole.get(rid, t);
  if (!role || role.project_id !== combo.project_id) return res.status(404).json({ error: 'role_not_found' });
  const cid = req.body?.candidateId ? String(req.body.candidateId) : '';
  if (!cid) {
    db.prepare('DELETE FROM casting_combo_slots WHERE combo_id = ? AND role_id = ?').run(combo.id, rid);
    return res.json({ ok: true, roleId: rid, candidateId: '' });
  }
  const cand = qCand.get(cid, t);
  if (!cand || cand.project_id !== combo.project_id) return res.status(404).json({ error: 'candidate_not_found' });
  const existing = db.prepare('SELECT id FROM casting_combo_slots WHERE combo_id = ? AND role_id = ?').get(combo.id, rid);
  if (existing) {
    db.prepare('UPDATE casting_combo_slots SET candidate_id = ? WHERE id = ?').run(cid, existing.id);
  } else {
    const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_combo_slots WHERE combo_id = ?').get(combo.id).n;
    db.prepare('INSERT INTO casting_combo_slots (id, combo_id, tenant, role_id, candidate_id, ord) VALUES (?, ?, ?, ?, ?, ?)')
      .run(comboSlotId(), combo.id, t, rid, cid, ord);
  }
  res.json({ ok: true, roleId: rid, candidateId: cid });
});

// ── Media (headshots / tapes) — 302 to a short-lived presigned Wasabi GET ────
// Tenant-scoped: a key must live under the requesting tenant's prefix, so one
// tenant can never presign another's media.
router.get('/media', async (req, res) => {
  const t = eff(req);
  const key = String(req.query.key || '');
  if (!key || !key.startsWith(t + '/')) return res.status(403).json({ error: 'forbidden' });
  // Local-disk-first (Wasabi retired/erased); serveMedia falls back to a presign
  // only if the object still lives in a configured bucket. See src/media.js.
  return serveMedia(key, res);
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
