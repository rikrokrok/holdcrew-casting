'use strict';
// Client presentation pages (spec §"Client presentation = curated pages"). Two routers:
//   • producer  — gated (mounted under /api/casting): the PM builds/curates pages.
//   • public    — ungated (mounted under /present): a passive, tokenized lookbook the
//                 client reviews. No controls, no login; approvals come back off-platform.
// A page is a named, multi-instance object with ordered items (individuals + combos);
// per-item the PM picks which take plays. The public side only ever reads via the token.
const express = require('express');
const db = require('./db');
const wasabi = require('./wasabi');
const { pageId, pageItemId, shareToken } = require('./ids');

const eff = (req) => req.tenant.slug;

// ── shared row helpers ───────────────────────────────────────────────────────
const qProjectByJob = db.prepare('SELECT * FROM casting_projects WHERE tenant = ? AND job = ?');
const qPage = db.prepare('SELECT * FROM casting_pages WHERE id = ? AND tenant = ?');
const qPageByToken = db.prepare('SELECT * FROM casting_pages WHERE token = ?');
const qRoleRow = db.prepare('SELECT id, name, character FROM casting_roles WHERE id = ?');
const qCandRow = db.prepare('SELECT id, name, headshot_key FROM casting_candidates WHERE id = ?');
const qTapes = db.prepare("SELECT id, key, label FROM casting_media WHERE candidate_id = ? AND kind = 'tape' ORDER BY ord, created_at");
const qAsg = db.prepare('SELECT status, rank FROM casting_assignments WHERE candidate_id = ? AND role_id = ?');
const qItems = db.prepare('SELECT * FROM casting_page_items WHERE page_id = ? ORDER BY ord, created_at');

const itemCount = (pid) => db.prepare('SELECT COUNT(*) AS n FROM casting_page_items WHERE page_id = ?').get(pid).n;
const toPage = (p) => ({ id: p.id, name: p.name, token: p.token, intro: p.intro || '', ord: p.ord, items: itemCount(p.id) });

// The chosen tape for a candidate: the picked take_id if still present, else the
// lead (first) tape. Returns { id, key, label } or null.
function chosenTake(candId, takeId) {
  const tapes = qTapes.all(candId);
  if (!tapes.length) return null;
  const pick = takeId && tapes.find((t) => t.id === takeId);
  const t = pick || tapes[0];
  return { id: t.id, key: t.key, label: t.label || '' };
}
// Actor as the client sees them: name + photo key + the one take that plays.
function actorShape(cand, takeId) {
  return { name: cand.name, headshotKey: cand.headshot_key || null, take: chosenTake(cand.id, takeId) };
}

// Resolve a page into the client-facing lookbook (ordered items; media as keys the
// viewer fetches back through /present/<token>/media). Pure read.
function buildLookbook(page) {
  const out = [];
  for (const it of qItems.all(page.id)) {
    if (it.kind === 'combo') {
      const combo = db.prepare('SELECT * FROM casting_combos WHERE id = ?').get(it.ref_id);
      if (!combo) continue;
      const slots = db.prepare('SELECT role_id, candidate_id FROM casting_combo_slots WHERE combo_id = ? ORDER BY ord').all(combo.id);
      const roles = slots.map((s) => {
        const role = qRoleRow.get(s.role_id), cand = qCandRow.get(s.candidate_id);
        if (!role || !cand) return null;
        return { role: { name: role.name, character: role.character }, actor: actorShape(cand, null) };
      }).filter(Boolean);
      if (roles.length) out.push({ kind: 'combo', name: combo.name, grp: combo.grp || '', roles });
    } else {
      const cand = qCandRow.get(it.ref_id);
      if (!cand) continue;
      const role = it.role_id ? qRoleRow.get(it.role_id) : null;
      const asg = it.role_id ? qAsg.get(it.ref_id, it.role_id) : null;
      out.push({
        kind: 'individual',
        role: role ? { name: role.name, character: role.character } : null,
        actor: actorShape(cand, it.take_id),
        backup: !!(asg && asg.rank === 'backup'),
      });
    }
  }
  return { page: { name: page.name, intro: page.intro || '' }, items: out };
}

// ══ Producer router (gated) ══════════════════════════════════════════════════
const producer = express.Router();

// List pages for a job.
producer.get('/pages', (req, res) => {
  const p = qProjectByJob.get(eff(req), String(req.query.job || '').trim());
  if (!p) return res.json({ pages: [] });
  const rows = db.prepare('SELECT * FROM casting_pages WHERE project_id = ? ORDER BY ord, created_at').all(p.id);
  res.json({ pages: rows.map(toPage) });
});

// Full page detail (items resolved for the editor).
producer.get('/pages/:id', (req, res) => {
  const page = qPage.get(req.params.id, eff(req));
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const items = qItems.all(page.id).map((it) => ({
    id: it.id, kind: it.kind, refId: it.ref_id, roleId: it.role_id || null,
    takeId: it.take_id || null, showBackup: !!it.show_backup, ord: it.ord,
  }));
  res.json({ ...toPage(page), items });
});

producer.post('/pages', (req, res) => {
  const t = eff(req);
  const job = String(req.body?.job || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!job || !name) return res.status(400).json({ error: 'job_and_name_required' });
  const p = qProjectByJob.get(t, job);
  if (!p) return res.status(404).json({ error: 'board_not_found' });
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_pages WHERE project_id = ?').get(p.id).n;
  const id = pageId();
  db.prepare('INSERT INTO casting_pages (id, project_id, tenant, name, token, intro, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, t, name, shareToken(), String(req.body?.intro || '').trim(), ord);
  res.status(201).json(toPage(db.prepare('SELECT * FROM casting_pages WHERE id = ?').get(id)));
});

producer.put('/pages/:id', (req, res) => {
  const page = qPage.get(req.params.id, eff(req));
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : page.name;
  const intro = req.body?.intro !== undefined ? String(req.body.intro).trim() : (page.intro || '');
  const ord = req.body?.ord !== undefined ? Number(req.body.ord) : page.ord;
  if (!name) return res.status(400).json({ error: 'name_required' });
  db.prepare("UPDATE casting_pages SET name = ?, intro = ?, ord = ?, updated_at = datetime('now') WHERE id = ?").run(name, intro, ord, page.id);
  res.json(toPage(db.prepare('SELECT * FROM casting_pages WHERE id = ?').get(page.id)));
});

producer.delete('/pages/:id', (req, res) => {
  const page = qPage.get(req.params.id, eff(req));
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  db.prepare('DELETE FROM casting_pages WHERE id = ?').run(page.id); // items cascade
  res.status(204).end();
});

// Rotate the share token (revokes the old link).
producer.post('/pages/:id/rotate', (req, res) => {
  const page = qPage.get(req.params.id, eff(req));
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const token = shareToken();
  db.prepare("UPDATE casting_pages SET token = ?, updated_at = datetime('now') WHERE id = ?").run(token, page.id);
  res.json({ ok: true, token });
});

// Add an item (individual candidate for a role, or a combo).
producer.post('/pages/:id/items', (req, res) => {
  const t = eff(req);
  const page = qPage.get(req.params.id, t);
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const kind = req.body?.kind === 'combo' ? 'combo' : 'individual';
  const refId = String(req.body?.refId || '').trim();
  if (!refId) return res.status(400).json({ error: 'ref_required' });
  // validate the ref belongs to this tenant + project
  if (kind === 'combo') {
    const cb = db.prepare('SELECT project_id, tenant FROM casting_combos WHERE id = ?').get(refId);
    if (!cb || cb.tenant !== t || cb.project_id !== page.project_id) return res.status(404).json({ error: 'combo_not_found' });
  } else {
    const cand = db.prepare('SELECT project_id, tenant FROM casting_candidates WHERE id = ?').get(refId);
    if (!cand || cand.tenant !== t || cand.project_id !== page.project_id) return res.status(404).json({ error: 'candidate_not_found' });
  }
  const roleId = kind === 'individual' && req.body?.roleId ? String(req.body.roleId) : null;
  const ord = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_page_items WHERE page_id = ?').get(page.id).n;
  const id = pageItemId();
  db.prepare('INSERT INTO casting_page_items (id, page_id, tenant, kind, ref_id, role_id, take_id, show_backup, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, page.id, t, kind, refId, roleId, req.body?.takeId ? String(req.body.takeId) : null, req.body?.showBackup ? 1 : 0, ord);
  db.prepare("UPDATE casting_pages SET updated_at = datetime('now') WHERE id = ?").run(page.id);
  res.status(201).json({ id, kind, refId, roleId, takeId: req.body?.takeId || null, showBackup: !!req.body?.showBackup, ord });
});

// Update an item (take pick / show_backup / order).
producer.put('/pages/:id/items/:itemId', (req, res) => {
  const t = eff(req);
  const page = qPage.get(req.params.id, t);
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const it = db.prepare('SELECT * FROM casting_page_items WHERE id = ? AND page_id = ?').get(req.params.itemId, page.id);
  if (!it) return res.status(404).json({ error: 'item_not_found' });
  const takeId = req.body?.takeId !== undefined ? (req.body.takeId ? String(req.body.takeId) : null) : it.take_id;
  const showBackup = req.body?.showBackup !== undefined ? (req.body.showBackup ? 1 : 0) : it.show_backup;
  const ord = req.body?.ord !== undefined ? Number(req.body.ord) : it.ord;
  db.prepare('UPDATE casting_page_items SET take_id = ?, show_backup = ?, ord = ? WHERE id = ?').run(takeId, showBackup, ord, it.id);
  db.prepare("UPDATE casting_pages SET updated_at = datetime('now') WHERE id = ?").run(page.id);
  res.json({ id: it.id, takeId, showBackup: !!showBackup, ord });
});

producer.delete('/pages/:id/items/:itemId', (req, res) => {
  const page = qPage.get(req.params.id, eff(req));
  if (!page) return res.status(404).json({ error: 'page_not_found' });
  const info = db.prepare('DELETE FROM casting_page_items WHERE id = ? AND page_id = ?').run(req.params.itemId, page.id);
  if (!info.changes) return res.status(404).json({ error: 'item_not_found' });
  res.status(204).end();
});

// ══ Public router (ungated — token is the only key) ══════════════════════════
const pub = express.Router();

// The lookbook JSON.
pub.get('/:token/data', (req, res) => {
  const page = qPageByToken.get(String(req.params.token || ''));
  if (!page) return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'no-store');
  res.json(buildLookbook(page));
});

// Token-scoped media presign: the key must live under the page's tenant prefix, so
// a token can only ever surface its own project's media.
pub.get('/:token/media', async (req, res) => {
  const page = qPageByToken.get(String(req.params.token || ''));
  if (!page) return res.status(404).json({ error: 'not_found' });
  const key = String(req.query.key || '');
  if (!key || !key.startsWith(page.tenant + '/')) return res.status(403).json({ error: 'forbidden' });
  try {
    const url = await wasabi.presignKey(key);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, url);
  } catch (e) {
    res.status(502).json({ error: 'presign_failed' });
  }
});

module.exports = { producer, public: pub, buildLookbook };
