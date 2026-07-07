'use strict';
require('dotenv').config();

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const cfg = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: path.join(ROOT, 'data'),
  PORT: Number(process.env.CASTING_PORT) || 4100,

  // Subdomain base + dev fallback tenant (see src/tenant.js).
  baseDomain: (process.env.CASTING_BASE_DOMAIN || 'casting.holdcrew.com').toLowerCase(),
  defaultTenant: (process.env.CASTING_DEFAULT_TENANT || '').toLowerCase(),

  // One-time seed for the dev tenant's password; real passwords live in the DB.
  password: process.env.CASTING_PASSWORD || '',

  wasabi: {
    endpoint: process.env.WASABI_ENDPOINT || 'https://s3.wasabisys.com',
    region: process.env.WASABI_REGION || 'us-east-1',
    // Dedicated casting bucket (NOT the reels bucket).
    bucket: process.env.WASABI_CASTING_BUCKET || 'holdcrew-casting',
    accessKey: process.env.WASABI_ACCESS_KEY || '',
    secretKey: process.env.WASABI_SECRET_KEY || '',
    ttl: Number(process.env.SIGNED_URL_TTL) || 7200,
  },
};

cfg.wasabi.configured = Boolean(cfg.wasabi.accessKey && cfg.wasabi.secretKey);

module.exports = cfg;
