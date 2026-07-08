'use strict';
// The one cross-system seam: promote a Booked casting candidate into the
// company's HoldCrew Job Log as a confirmed Talent row. We reuse HoldCrew's
// canonical, already-live `v3-talent-save` webhook (idempotent upsert by
// name+job) rather than reinventing the Job Log write — casting owns curation,
// HoldCrew owns the job record.
//
// Auth: the company presents its registry token (stored per casting tenant; the
// casting tenant slug == the HoldCrew company slug). The caller passes the slug
// from the authenticated request (never client input), so a booking can only
// ever write to that company's own Job Log.
const cfg = require('./config');
const db = require('./db');

// HoldCrew stores/looks up a job by its tab title (Job_<suffix>); casting's ?job=
// is the bare suffix, exactly like job.html's suffix→tab rule.
const jobTab = (job) => {
  const j = String(job || '').trim();
  return /^Job_/i.test(j) ? j : 'Job_' + j;
};

const qLink = db.prepare('SELECT hc_slug, hc_token FROM tenants WHERE slug = ?');

// talent: { name, email, phone, character, agentName, agency, agentEmail,
//           agentPhone, union, notes, status }  (v3-talent-save's field names)
async function promoteToJobLog(slug, job, talent) {
  const row = qLink.get(slug);
  const token = row && row.hc_token;
  if (!token) throw new Error('holdcrew_not_linked'); // run scripts/link-holdcrew.js
  const company = (row && row.hc_slug) || slug;       // HoldCrew slug may differ

  const url = cfg.hcWebhookUrl + '/v3-talent-save';
  const payload = { company, token, tab: jobTab(job), ...talent };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* non-JSON => treat as failure below */ }
  // v3-talent-save answers { ok:true, rowIndex } on success; anything else is a
  // failure we surface honestly (never a silent swallow).
  if (!r.ok || !j || j.ok !== true) {
    throw new Error((j && (j.error || j.message)) || ('promote_http_' + r.status));
  }
  return { rowIndex: j.rowIndex };
}

module.exports = { promoteToJobLog, jobTab };
