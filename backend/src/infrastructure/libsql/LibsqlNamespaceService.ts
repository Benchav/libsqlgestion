import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { getPublicDatabaseSettings } from '../../application/settings/PlatformSettingsService';

export type NamespaceRuntimeMetadata = {
  provider: 'sqld-namespace';
  namespace: string;
  internalUrl: string;
  backendUrl: string;
  connectionUrl: string;
  publicUrl: string;
  publicHost: string;
};

export class LibsqlNamespaceService {
  private readonly adminUrl = process.env.LIBSQL_ADMIN_URL?.trim() || 'http://sqld:9090';
  private readonly internalBaseUrl = process.env.LIBSQL_INTERNAL_URL?.trim() || 'http://sqld:8080';
  private readonly authDir = process.env.LIBSQL_AUTH_DIR?.trim() || path.join(process.cwd(), 'data', 'sqld');

  private keyPairCache: { privateKey: crypto.KeyObject; publicKeyPem: string } | null = null;

  isEnabled(): boolean {
    return Boolean(process.env.LIBSQL_ADMIN_URL || process.env.LIBSQL_ENABLE_NAMESPACES === 'true');
  }

  ensureAuthKeys(): { privateKey: crypto.KeyObject; publicKeyPem: string } {
    if (this.keyPairCache) {
      return this.keyPairCache;
    }

    fs.mkdirSync(this.authDir, { recursive: true });
    const keyPath = path.join(this.authDir, 'auth.key');
    const pemPath = path.join(this.authDir, 'auth.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(pemPath)) {
      try {
        const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
        const publicKeyPem = fs.readFileSync(pemPath, 'utf8');
        const privateKey = crypto.createPrivateKey(privateKeyPem);
        this.keyPairCache = { privateKey, publicKeyPem };
        return this.keyPairCache;
      } catch (err) {
        console.warn('[LibsqlNamespaceService] Error reading existing auth keys, generating new pair:', err);
      }
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim() + '\n';
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim() + '\n';

    fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(pemPath, publicKeyPem, { mode: 0o644 });

    this.keyPairCache = { privateKey, publicKeyPem };
    return this.keyPairCache;
  }

  generateToken(namespace: string, expiresInSeconds = Number(process.env.LIBSQL_RUNTIME_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 365)): string {
    const { privateKey } = this.ensureAuthKeys();
    const issuedAt = Math.floor(Date.now() / 1000);

    const payload = {
      a: 'rw',
      ns: namespace,
      iat: issuedAt - 60,
      nbf: issuedAt - 60,
      exp: issuedAt + Math.max(300, expiresInSeconds),
    };

    const header = this.base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
    const encodedPayload = this.base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${header}.${encodedPayload}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);

    return `${signingInput}.${this.base64UrlEncode(signature)}`;
  }

  verifyToken(token: string): { ns: string; a?: string; exp?: number } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [headerB64, payloadB64, sigB64] = parts;
      const signingInput = `${headerB64}.${payloadB64}`;
      const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const { publicKeyPem } = this.ensureAuthKeys();
      const publicKey = crypto.createPublicKey(publicKeyPem);
      const isValid = crypto.verify(null, Buffer.from(signingInput), publicKey, signature);
      if (!isValid) return null;

      const payloadJson = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) return null;
      if (payload.nbf && payload.nbf > now) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = new URL('/health', this.adminUrl);
      const res = await this.httpRequest(url.href, { method: 'GET', timeoutMs: 2000 });
      return res.statusCode >= 200 && res.statusCode < 400;
    } catch {
      return false;
    }
  }

  async createNamespace(namespace: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = new URL(`/v1/namespaces/${encodeURIComponent(namespace)}/create`, this.adminUrl);
      const res = await this.httpRequest(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeoutMs: 5000,
      });

      // 200 OK, 201 Created, or 409 Conflict (already exists) are all successful
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true };
      }
      if (res.statusCode === 409 || res.body.includes('already exists')) {
        return { ok: true };
      }

      return { ok: false, error: `sqld admin returned ${res.statusCode}: ${res.body}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async deleteNamespace(namespace: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = new URL(`/v1/namespaces/${encodeURIComponent(namespace)}`, this.adminUrl);
      const res = await this.httpRequest(url.href, {
        method: 'DELETE',
        timeoutMs: 5000,
      });

      if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 404) {
        return { ok: true };
      }
      return { ok: false, error: `sqld admin returned ${res.statusCode}: ${res.body}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  buildNamespaceUrls(namespace: string): {
    internalUrl: string;
    backendUrl: string;
    connectionUrl: string;
    publicUrl: string;
    publicHost: string;
  } {
    const settings = getPublicDatabaseSettings();
    const publicProtocol = settings.protocol || process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'https';
    const publicDomain = settings.domain || process.env.DATABASE_PUBLIC_DOMAIN?.trim() || 'localhost';
    const publicHost = settings.host || process.env.DATABASE_PUBLIC_HOST?.trim() || 'localhost';

    const internalUrl = `${this.internalBaseUrl.replace(/\/$/, '')}/dev/${namespace}`;
    const backendUrl = internalUrl;

    const publicUrl = publicDomain && publicDomain !== 'localhost'
      ? `${publicProtocol}://${namespace}.${publicDomain.replace(/^\.+/, '')}`
      : `${publicProtocol}://${publicHost}:8080/dev/${namespace}`;

    return {
      internalUrl,
      backendUrl,
      connectionUrl: backendUrl,
      publicUrl,
      publicHost,
    };
  }

  private base64UrlEncode(value: Buffer): string {
    return value
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private httpRequest(
    urlString: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(urlString);
      const reqOptions: http.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeoutMs || 5000,
      };

      const req = http.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`HTTP request timed out after ${options.timeoutMs}ms`));
      });

      req.on('error', reject);

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}
