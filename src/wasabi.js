'use strict';
// Wasabi (S3-compatible) access for the dedicated holdcrew-casting bucket.
// Mints short-lived presigned GET URLs (browser follows our 302 and range-reads
// the tape straight from Wasabi — zero egress through this droplet) and streams
// uploads from disk. Generic by-key (casting media has mixed extensions: jpg
// headshots, m4v/mp4 tapes), unlike reels' slug-based presignSpot.
const fs = require('fs');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { wasabi } = require('./config');

let client = null;
function s3() {
  if (!wasabi.configured) throw new Error('Wasabi credentials not configured (WASABI_ACCESS_KEY / WASABI_SECRET_KEY).');
  if (!client) {
    client = new S3Client({
      endpoint: wasabi.endpoint,
      region: wasabi.region,
      credentials: { accessKeyId: wasabi.accessKey, secretAccessKey: wasabi.secretKey },
    });
  }
  return client;
}

async function presignKey(key) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: wasabi.bucket, Key: key }), { expiresIn: wasabi.ttl });
}

async function uploadObject(key, filePath, contentType = 'application/octet-stream') {
  const { size } = fs.statSync(filePath);
  await s3().send(new PutObjectCommand({
    Bucket: wasabi.bucket, Key: key, Body: fs.createReadStream(filePath),
    ContentLength: size, ContentType: contentType,
  }));
}

// In-memory upload (headshots arrive as a raw request body Buffer — no temp file).
async function uploadBuffer(key, buffer, contentType = 'application/octet-stream') {
  await s3().send(new PutObjectCommand({
    Bucket: wasabi.bucket, Key: key, Body: buffer,
    ContentLength: buffer.length, ContentType: contentType,
  }));
}

async function deleteObject(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: wasabi.bucket, Key: key }));
}

module.exports = { presignKey, uploadObject, uploadBuffer, deleteObject };
