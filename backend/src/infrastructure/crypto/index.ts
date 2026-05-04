import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGO = 'aes-256-gcm';
const MASTER_KEY_FILE = process.env.MASTER_KEY_FILE || path.join(process.cwd(), 'data', 'master.key');

function loadMasterKey() {
  const envKey = process.env.MASTER_KEY;
  if (envKey) {
    return envKey;
  }

  fs.mkdirSync(path.dirname(MASTER_KEY_FILE), { recursive: true });
  if (!fs.existsSync(MASTER_KEY_FILE)) {
    fs.writeFileSync(MASTER_KEY_FILE, crypto.randomBytes(32).toString('hex'));
  }

  return fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
}

const key = Buffer.from(loadMasterKey(), 'hex');

export function encrypt(plainText: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(data: string) {
  const b = Buffer.from(data, 'base64');
  const iv = b.slice(0, 12);
  const tag = b.slice(12, 28);
  const encrypted = b.slice(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
