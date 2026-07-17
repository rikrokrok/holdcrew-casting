'use strict';
// Media serving. Objects live in a local on-disk store under DATA_DIR/media/<key>
// (Wasabi was retired/erased). If a key isn't on disk and Wasabi is still
// configured, fall back to a presigned redirect so any future re-upload keeps
// working. Keys are the same tenant-scoped paths callers already guard on.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const wasabi = require('./wasabi');

const MEDIA_DIR = path.join(cfg.DATA_DIR, 'media');

const CT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

// Resolve key -> absolute path inside MEDIA_DIR, refusing traversal escapes.
function localPath(key) {
  const p = path.resolve(MEDIA_DIR, key);
  if (p !== MEDIA_DIR && !p.startsWith(MEDIA_DIR + path.sep)) return null;
  return p;
}

// The caller has already authorized `key` (tenant/token prefix check).
async function serveMedia(key, res) {
  const lp = localPath(key);
  if (lp && fs.existsSync(lp) && fs.statSync(lp).isFile()) {
    res.set('Cache-Control', 'no-store');
    res.type(CT[path.extname(lp).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(lp).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (wasabi && cfg.wasabi.configured) {
    try {
      const url = await wasabi.presignKey(key);
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (e) { /* fall through to 404 */ }
  }
  return res.status(404).json({ error: 'media_not_found' });
}

// ── Local writes (Wasabi retired) ────────────────────────────────────────────
// The store IS the source of truth now, so uploads land on disk. Callers mint a
// tenant-scoped key (mediaKey); we refuse any key that escapes MEDIA_DIR.

function ensureDirFor(lp) { fs.mkdirSync(path.dirname(lp), { recursive: true }); }

// Write a buffer (headshot) to the store, returning the absolute path written.
function writeBuffer(key, buf) {
  const lp = localPath(key);
  if (!lp) throw new Error('bad_key');
  ensureDirFor(lp);
  fs.writeFileSync(lp, buf);
  return lp;
}

// Move an already-written temp file (tape) into the store (same-fs rename, else copy).
function writeFromFile(key, srcPath) {
  const lp = localPath(key);
  if (!lp) throw new Error('bad_key');
  ensureDirFor(lp);
  try { fs.renameSync(srcPath, lp); }
  catch (e) { fs.copyFileSync(srcPath, lp); try { fs.unlinkSync(srcPath); } catch (_) {} }
  return lp;
}

// Best-effort delete of a superseded object (old headshot on replace). Non-fatal.
function removeLocal(key) {
  const lp = localPath(key);
  if (lp && fs.existsSync(lp)) { try { fs.unlinkSync(lp); } catch (e) { /* orphan, non-fatal */ } }
}

module.exports = { serveMedia, localPath, MEDIA_DIR, writeBuffer, writeFromFile, removeLocal };
