#!/usr/bin/env node
'use strict';
// Bulk-import headshots + tapes from a folder, matched to candidates BY NAME.
// Fits the SFTP workflow: drop the casting house's media folder on the box, run this.
//
//   node scripts/import-media.js <tenant> <job> <folder> [--replace-headshot] [--dry]
//
// ── Naming convention (either layout, and you can mix them) ──────────────────
//   A) Flat files, each named by the candidate:
//        "Brian Le.jpg"          -> Brian Le headshot   (jpg/jpeg/png/webp/heic/gif)
//        "Brian Le.mp4"          -> Brian Le tape "Take 1" (mp4/mov/m4v/webm)
//        "Brian Le - Slate.mp4"  -> Brian Le tape labelled "Slate"
//        "Brian Le (2).mp4"      -> Brian Le tape "Take 2"
//   B) One sub-folder per candidate:
//        "Brian Le/headshot.jpg" -> Brian Le headshot
//        "Brian Le/scene-1.mp4"  -> Brian Le tape (label = file name)
//
// Match is by normalised name (case / spaces / underscores ignored). Idempotent:
// a candidate that already has a headshot is skipped (unless --replace-headshot);
// a tape whose label already exists on that candidate is skipped. Unmatched files
// are reported, never fatal. --dry previews without uploading or writing.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const wasabi = require('../src/wasabi');
const { mediaKey } = require('../src/tenant');
const { rand, mediaId } = require('../src/ids');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [tenant, job, folder] = args.filter((a) => !a.startsWith('--'));
const REPLACE = flags.has('--replace-headshot');
const DRY = flags.has('--dry');
if (!tenant || !job || !folder) {
  console.error('usage: node scripts/import-media.js <tenant> <job> <folder> [--replace-headshot] [--dry]');
  process.exit(1);
}
if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { console.error('not a folder: ' + folder); process.exit(1); }

const IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif' };
const VID = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' };
const normName = (s) => String(s || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

const project = db.prepare('SELECT id FROM casting_projects WHERE tenant = ? AND job = ?').get(tenant, job);
if (!project) { console.error(`no project ${tenant}/${job}`); process.exit(1); }
const cands = db.prepare('SELECT id, name, headshot_key FROM casting_candidates WHERE project_id = ?').all(project.id);
const byName = new Map(cands.map((c) => [normName(c.name), c]));

// Collect (candidateName, label, filePath, ext) jobs from the folder tree.
const files = [];
for (const ent of fs.readdirSync(folder, { withFileTypes: true })) {
  if (ent.name.startsWith('.')) continue;
  if (ent.isDirectory()) {                                   // layout B: folder per candidate
    const sub = path.join(folder, ent.name);
    for (const f of fs.readdirSync(sub)) {
      if (f.startsWith('.')) continue;
      const ext = path.extname(f).slice(1).toLowerCase();
      const stem = path.basename(f, path.extname(f));
      files.push({ name: ent.name, label: /^headshot$/i.test(stem) ? '' : stem, file: path.join(sub, f), ext });
    }
  } else {                                                   // layout A: flat "<Name>[ - label|(n)].ext"
    const ext = path.extname(ent.name).slice(1).toLowerCase();
    let stem = path.basename(ent.name, path.extname(ent.name));
    let name = stem, label = '';
    let m = stem.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (m) { name = m[1]; label = 'Take ' + m[2]; }
    else { const i = stem.indexOf(' - '); if (i >= 0) { name = stem.slice(0, i); label = stem.slice(i + 3); } }
    files.push({ name, label, file: path.join(folder, ent.name), ext });
  }
}

(async () => {
  let heads = 0, tapes = 0, skipped = 0;
  const unmatched = [];
  for (const it of files) {
    const cand = byName.get(normName(it.name));
    const isImg = it.ext in IMG, isVid = it.ext in VID;
    if (!cand || (!isImg && !isVid)) { unmatched.push(path.basename(it.file) + (cand ? ' (unknown type)' : ' (no candidate match)')); continue; }

    if (isImg) {
      if (cand.headshot_key && !REPLACE) { skipped++; continue; }
      const key = mediaKey(tenant, job, cand.id, `headshot-${rand(6)}.${it.ext === 'jpeg' ? 'jpg' : it.ext}`);
      console.log(`  ${DRY ? '[dry] ' : ''}headshot  ${cand.name}  ← ${path.basename(it.file)}`);
      if (!DRY) {
        await wasabi.uploadObject(key, it.file, IMG[it.ext]);
        if (cand.headshot_key && cand.headshot_key !== key) { try { await wasabi.deleteObject(cand.headshot_key); } catch (e) {} }
        db.prepare("UPDATE casting_candidates SET headshot_key = ?, updated_at = datetime('now') WHERE id = ?").run(key, cand.id);
        cand.headshot_key = key;
      }
      heads++;
    } else {
      const ord = db.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM casting_media WHERE candidate_id = ? AND kind = 'tape'").get(cand.id).n;
      const label = it.label || `Take ${ord + 1}`;
      const dup = db.prepare("SELECT 1 FROM casting_media WHERE candidate_id = ? AND kind = 'tape' AND label = ?").get(cand.id, label);
      if (dup) { skipped++; continue; }
      const key = mediaKey(tenant, job, cand.id, `take-${ord + 1}-${rand(4)}.${it.ext}`);
      console.log(`  ${DRY ? '[dry] ' : ''}tape      ${cand.name}  "${label}"  ← ${path.basename(it.file)}`);
      if (!DRY) {
        await wasabi.uploadObject(key, it.file, VID[it.ext]);
        db.prepare("INSERT INTO casting_media (id, candidate_id, tenant, project_id, kind, key, label, ord) VALUES (?, ?, ?, ?, 'tape', ?, ?, ?)")
          .run(mediaId(), cand.id, tenant, project.id, key, label, ord);
      }
      tapes++;
    }
  }
  console.log(`\n${DRY ? '[dry] ' : ''}${heads} headshot(s), ${tapes} tape(s), ${skipped} skipped (already present).`);
  if (unmatched.length) console.log('unmatched:\n  - ' + unmatched.join('\n  - '));
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
