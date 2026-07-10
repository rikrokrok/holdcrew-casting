'use strict';
// The talent pipeline model — see PLAN.md §"Pipeline, Combos & Client Presentation".
//
// Each (candidate × role) assignment carries THREE orthogonal axes, not a single
// advancing status, so a PM can see the whole picture incl. gaps (e.g. Booked ✓ but
// Client-approved ✗, which a linear status would hide):
//   • progress   — five independently-tickable, TIMESTAMPED milestones:
//                    shortlist < recco < approved < booked < confirmed
//   • rank       — primary | backup   (a backup runs the same progress ticks)
//   • disposition— '' | pass | unavailable
//
// `casting_assignments.status` is kept as a DERIVED "furthest stage" so the current
// board + combos keep rendering unchanged (spec build-order step 1). It is retired
// when the board UI is rebuilt to read milestones directly (step 2). Two writers keep
// it honest: legacy single-select writes store the picked status verbatim AND sync the
// axes (applyLegacyStatus); the new independent primitives edit one axis then RE-derive
// status from the axes (refreshStatus). Both agree via the LEGACY table below.
//
// Pure/DB-runner split (no require('./db') here) so db.js can call it during its
// migration without a require cycle: functions that touch the DB take the handle.

const LADDER = ['shortlist', 'recco', 'approved', 'booked', 'confirmed'];
const MS_COL = {
  shortlist: 'ms_shortlist', recco: 'ms_recco', approved: 'ms_approved',
  booked: 'ms_booked', confirmed: 'ms_confirmed',
};

// Legacy single-status → { level (0..5 up the ladder), rank, disp }. Drives the
// one-time backfill and the transitional single-select translation. Cumulative:
// level N fills milestones 1..N (legacy status was linear, so no gaps existed).
const LEGACY = {
  submitted: { level: 0, rank: 'primary', disp: '' },
  shortlist: { level: 1, rank: 'primary', disp: '' },
  callback:  { level: 1, rank: 'primary', disp: '' },   // folds to shortlist (dropped from the pipeline)
  backup:    { level: 1, rank: 'backup',  disp: '' },
  recommend: { level: 2, rank: 'primary', disp: '' },    // = recco
  select:    { level: 3, rank: 'primary', disp: '' },    // legacy "select" == client-approved tier
  hold:      { level: 4, rank: 'primary', disp: '' },    // legacy "hold"   == Booked  (pending)
  booked:    { level: 5, rank: 'primary', disp: '' },    // legacy "booked" == Confirmed
  pass:      { level: 0, rank: 'primary', disp: 'pass' },
};

const AXIS_COLS = 'ms_shortlist, ms_recco, ms_approved, ms_booked, ms_confirmed, rank, disposition';

// Furthest milestone reached (0 = none). Pure.
const levelOf = (a) =>
  a.ms_confirmed ? 5 : a.ms_booked ? 4 : a.ms_approved ? 3 : a.ms_recco ? 2 : a.ms_shortlist ? 1 : 0;

// Derive the transitional board status from the axes (inverse of LEGACY). Only a
// 'pass' disposition short-circuits (matches the old terminal Pass bucket);
// 'unavailable' falls through to the progress level so a booked-but-unavailable
// talent still reads as booked (the flag surfaces in the step-2 audit UI).
// Backup is treated as a standing that SUPERSEDES the pre-commitment tiers: once a
// contender on the selects board is marked a backup they read as "Backup" (so the
// tap is visible on the board — Eric 2026-07-10), while their progress ticks stay
// recorded on the strip. A booked/confirmed backup still shows the commitment. Pure.
function deriveStatus(a) {
  if (a.disposition === 'pass') return 'pass';
  if (a.ms_confirmed) return 'booked';
  if (a.ms_booked)    return 'hold';
  if (a.rank === 'backup' && (a.ms_shortlist || a.ms_recco || a.ms_approved)) return 'backup';
  if (a.ms_approved)  return 'select';
  if (a.ms_recco)     return 'recommend';
  if (a.ms_shortlist) return 'shortlist';
  return 'submitted';
}

// A later milestone ticked while an earlier one is empty = an audit gap (the
// amber flag). Returns the list of skipped earlier stages. Pure.
function gaps(a) {
  const out = [];
  let seenLater = false;
  for (let i = LADDER.length - 1; i >= 0; i--) {
    if (a[MS_COL[LADDER[i]]]) seenLater = true;
    else if (seenLater) out.push(LADDER[i]);
  }
  return out.reverse();
}

// Assignment row → the pipeline block the front-end consumes (step 2). Pure.
function shape(a) {
  return {
    status: a.status,
    rank: a.rank || 'primary',
    disposition: a.disposition || '',
    ms: {
      shortlist: a.ms_shortlist || null, recco: a.ms_recco || null,
      approved: a.ms_approved || null, booked: a.ms_booked || null,
      confirmed: a.ms_confirmed || null,
    },
    gaps: gaps(a),
  };
}

// ── DB runners (take the handle) ─────────────────────────────────────────────
const now = (db) => db.prepare("SELECT datetime('now') AS n").get().n;

// Recompute + persist `status` from the current axes of one assignment. Used
// after every independent-axis edit so the board reflects it.
function refreshStatus(db, id) {
  const a = db.prepare(`SELECT ${AXIS_COLS} FROM casting_assignments WHERE id = ?`).get(id);
  const st = deriveStatus(a);
  db.prepare('UPDATE casting_assignments SET status = ? WHERE id = ?').run(st, id);
  return st;
}

// Fill milestones to a cumulative ladder `level` (0..5), PRESERVING existing
// earlier timestamps and clearing everything above. Returns a @-params object.
function ladderVals(a, level, ts) {
  const v = {};
  LADDER.forEach((k, i) => { v[MS_COL[k]] = i < level ? (a[MS_COL[k]] || ts) : null; });
  return v;
}

// One-time backfill: reconstruct the axes from a pre-pipeline single status,
// leaving `status` itself untouched (so the board is unchanged). Cumulative.
function backfillFromStatus(db, id, status) {
  const map = LEGACY[status] || LEGACY.submitted;
  const a = db.prepare(`SELECT ${Object.values(MS_COL).join(', ')} FROM casting_assignments WHERE id = ?`).get(id);
  const v = ladderVals(a, map.level, now(db));
  db.prepare(`UPDATE casting_assignments SET ms_shortlist=@ms_shortlist, ms_recco=@ms_recco,
    ms_approved=@ms_approved, ms_booked=@ms_booked, ms_confirmed=@ms_confirmed,
    rank=@rank, disposition=@disp WHERE id=@id`)
    .run({ ...v, rank: map.rank, disp: map.disp, id });
}

// Transitional single-select write (the drawer dropdown / combo bulk-recommend):
// store the picked status VERBATIM (board shows exactly what was chosen) and sync
// the axes to match. 'pass' overlays disposition without wiping progress; 'submitted'
// resets to base; any progress pick clears a stale pass. Returns the stored status.
function applyLegacyStatus(db, id, status) {
  const map = LEGACY[status];
  if (!map) return null;
  const a = db.prepare(`SELECT ${Object.values(MS_COL).join(', ')} FROM casting_assignments WHERE id = ?`).get(id);
  const ts = now(db);
  let v, rank, disp;
  if (status === 'pass') { v = a; rank = a.rank || 'primary'; disp = 'pass'; }          // keep progress
  else { v = ladderVals(a, map.level, ts); rank = map.rank; disp = map.disp; }           // set + clear pass
  db.prepare(`UPDATE casting_assignments SET ms_shortlist=@ms_shortlist, ms_recco=@ms_recco,
    ms_approved=@ms_approved, ms_booked=@ms_booked, ms_confirmed=@ms_confirmed,
    rank=@rank, disposition=@disp, status=@status, updated_at=@ts WHERE id=@id`)
    .run({
      ms_shortlist: v.ms_shortlist ?? null, ms_recco: v.ms_recco ?? null,
      ms_approved: v.ms_approved ?? null, ms_booked: v.ms_booked ?? null,
      ms_confirmed: v.ms_confirmed ?? null, rank, disp, status, ts, id,
    });
  return status;
}

// Independent-axis primitives (the true 3-axis model — the step-2 UI drives these).
function setMilestone(db, id, milestone, on) {
  const col = MS_COL[milestone];
  if (!col) throw new Error('bad_milestone');
  const ts = now(db);
  if (on) db.prepare(`UPDATE casting_assignments SET ${col} = COALESCE(${col}, ?), updated_at = ? WHERE id = ?`).run(ts, ts, id);
  else    db.prepare(`UPDATE casting_assignments SET ${col} = NULL, updated_at = ? WHERE id = ?`).run(ts, id);
  return refreshStatus(db, id);
}
function setRank(db, id, rank) {
  const r = rank === 'backup' ? 'backup' : 'primary';
  db.prepare("UPDATE casting_assignments SET rank = ?, updated_at = datetime('now') WHERE id = ?").run(r, id);
  return { rank: r, status: refreshStatus(db, id) };
}
function setDisposition(db, id, disposition) {
  const d = disposition === 'pass' || disposition === 'unavailable' ? disposition : '';
  db.prepare("UPDATE casting_assignments SET disposition = ?, updated_at = datetime('now') WHERE id = ?").run(d, id);
  return { disposition: d, status: refreshStatus(db, id) };
}

module.exports = {
  LADDER, MS_COL, LEGACY, AXIS_COLS,
  levelOf, deriveStatus, gaps, shape,
  refreshStatus, backfillFromStatus, applyLegacyStatus, setMilestone, setRank, setDisposition,
};
