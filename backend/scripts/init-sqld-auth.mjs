import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2] || '/data';
fs.mkdirSync(targetDir, { recursive: true });

const keyPath = path.join(targetDir, 'auth.key');
const pemPath = path.join(targetDir, 'auth.pem');

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim() + '\n';
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim() + '\n';

  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(pemPath, publicKeyPem, { mode: 0o644 });
}

function hasValidKeyPair() {
  if (!fs.existsSync(keyPath) || !fs.existsSync(pemPath)) {
    return false;
  }

  try {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    const publicKey = crypto.createPublicKey(fs.readFileSync(pemPath, 'utf8'));
    const challenge = Buffer.from('libsqlite-auth-key-check');
    const signature = crypto.sign(null, challenge, privateKey);
    return crypto.verify(null, challenge, publicKey, signature);
  } catch (error) {
    console.warn('[sqld-auth-init] Existing auth keys are invalid, regenerating:', error?.message || error);
    return false;
  }
}

if (!hasValidKeyPair()) {
  generateKeys();
  console.log(`[sqld-auth-init] Generated new auth keys in ${targetDir}`);
} else {
  console.log(`[sqld-auth-init] Reusing existing auth keys in ${targetDir}`);
}
