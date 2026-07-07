'use strict';
// Tenant resolution. Maps request Host -> tenant via the leftmost subdomain label:
//   upshot.casting.holdcrew.com -> 'upshot'
//   casting.holdcrew.com (apex) -> '' (no tenant)
// Attach-only: sets req.tenant / req.tenantSlug; per-route enforcement comes with
// the data layer (task 3). Casting's tenants are HoldCrew production companies.
const db = require('./db');
const cfg = require('./config');

const BASE_DOMAIN = cfg.baseDomain;
const DEFAULT_TENANT = cfg.defaultTenant;

const getTenantStmt = db.prepare('SELECT slug, name, status FROM tenants WHERE slug = ?');
const getTenant = (slug) => (slug ? getTenantStmt.get(slug) : undefined);

// Leftmost label under BASE_DOMAIN; '' for the apex or anything not directly under it.
function slugFromHost(host) {
  if (!host) return '';
  const h = host.toLowerCase().split(':')[0]; // strip port
  if (h === BASE_DOMAIN) return ''; // apex
  if (h.endsWith('.' + BASE_DOMAIN)) {
    const label = h.slice(0, -(BASE_DOMAIN.length + 1));
    if (label && !label.includes('.')) return label;
  }
  return '';
}

function resolve(req, _res, next) {
  let slug = slugFromHost(req.headers.host);
  if (!slug && DEFAULT_TENANT) slug = DEFAULT_TENANT; // dev convenience (localhost/IP)
  req.tenantSlug = slug || null;                       // what the host asked for
  const row = slug ? getTenant(slug) : undefined;
  req.tenant = row && row.status === 'active' ? row : null; // resolved + active only
  next();
}

// Wasabi key for a candidate's media object in the holdcrew-casting bucket.
// filename e.g. 'headshot.jpg' | 'tape.mp4'.
const mediaKey = (tenant, job, candidateId, filename) => `${tenant}/${job}/${candidateId}/${filename}`;

module.exports = { resolve, slugFromHost, getTenant, mediaKey, BASE_DOMAIN };
