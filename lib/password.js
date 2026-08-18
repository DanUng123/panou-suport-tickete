// Hashing de parole cu scrypt, nativ din Node.js (modulul "crypto") --
// nu necesita npm install (spre deosebire de bcrypt/argon2).
// Format stocat: "<salt-hex>:<hash-hex>"

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const suppliedHashBuffer = crypto.scryptSync(password, salt, 64);
    if (hashBuffer.length !== suppliedHashBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, suppliedHashBuffer);
  } catch (e) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
