'use strict';
const crypto = require('crypto');

// URL-safe base62 ids. Record ids are short + human-ish; share tokens are longer
// (unguessable — a send token is the only thing protecting a client presentation).
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function rand(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

module.exports = {
  projectId:    () => 'p_' + rand(10),
  roleId:       () => 'ro_' + rand(9),
  candidateId:  () => 'c_' + rand(10),
  assignmentId: () => 'a_' + rand(10),
  shareToken:   () => rand(22),
  rand,
};
