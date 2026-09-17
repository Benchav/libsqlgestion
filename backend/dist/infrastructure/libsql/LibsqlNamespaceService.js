"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LibsqlNamespaceService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const http_1 = __importDefault(require("http"));
const PlatformSettingsService_1 = require("../../application/settings/PlatformSettingsService");
class LibsqlNamespaceService {
    constructor() {
        this.adminUrl = process.env.LIBSQL_ADMIN_URL?.trim() || 'http://sqld:9090';
        this.internalBaseUrl = process.env.LIBSQL_INTERNAL_URL?.trim() || 'http://sqld:8080';
        this.authDir = process.env.LIBSQL_AUTH_DIR?.trim() || path_1.default.join(process.cwd(), 'data', 'sqld');
        this.keyPairCache = null;
    }
    isEnabled() {
        return Boolean(process.env.LIBSQL_ADMIN_URL || process.env.LIBSQL_ENABLE_NAMESPACES === 'true');
    }
    ensureAuthKeys() {
        if (this.keyPairCache) {
            return this.keyPairCache;
        }
        fs_1.default.mkdirSync(this.authDir, { recursive: true });
        const keyPath = path_1.default.join(this.authDir, 'auth.key');
        const pemPath = path_1.default.join(this.authDir, 'auth.pem');
        if (fs_1.default.existsSync(keyPath) && fs_1.default.existsSync(pemPath)) {
            try {
                const privateKeyPem = fs_1.default.readFileSync(keyPath, 'utf8');
                const publicKeyPem = fs_1.default.readFileSync(pemPath, 'utf8');
                const privateKey = crypto_1.default.createPrivateKey(privateKeyPem);
                this.keyPairCache = { privateKey, publicKeyPem };
                return this.keyPairCache;
            }
            catch (err) {
                console.warn('[LibsqlNamespaceService] Error reading existing auth keys, generating new pair:', err);
            }
        }
        const { publicKey, privateKey } = crypto_1.default.generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim() + '\n';
        const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim() + '\n';
        fs_1.default.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
        fs_1.default.writeFileSync(pemPath, publicKeyPem, { mode: 0o644 });
        this.keyPairCache = { privateKey, publicKeyPem };
        return this.keyPairCache;
    }
    generateToken(namespace, expiresInSeconds = Number(process.env.LIBSQL_RUNTIME_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 365)) {
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
        const signature = crypto_1.default.sign(null, Buffer.from(signingInput), privateKey);
        return `${signingInput}.${this.base64UrlEncode(signature)}`;
    }
    verifyToken(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3)
                return null;
            const [headerB64, payloadB64, sigB64] = parts;
            const signingInput = `${headerB64}.${payloadB64}`;
            const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            const { publicKeyPem } = this.ensureAuthKeys();
            const publicKey = crypto_1.default.createPublicKey(publicKeyPem);
            const isValid = crypto_1.default.verify(null, Buffer.from(signingInput), publicKey, signature);
            if (!isValid)
                return null;
            const payloadJson = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            const payload = JSON.parse(payloadJson);
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now)
                return null;
            if (payload.nbf && payload.nbf > now)
                return null;
            return payload;
        }
        catch {
            return null;
        }
    }
    async isAvailable() {
        try {
            const url = new URL('/health', this.adminUrl);
            const res = await this.httpRequest(url.href, { method: 'GET', timeoutMs: 2000 });
            return res.statusCode >= 200 && res.statusCode < 400;
        }
        catch {
            return false;
        }
    }
    async createNamespace(namespace) {
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
        }
        catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    }
    async deleteNamespace(namespace) {
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
        }
        catch (err) {
            return { ok: false, error: err?.message || String(err) };
        }
    }
    buildNamespaceUrls(namespace) {
        const settings = (0, PlatformSettingsService_1.getPublicDatabaseSettings)();
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
    base64UrlEncode(value) {
        return value
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }
    httpRequest(urlString, options) {
        return new Promise((resolve, reject) => {
            const targetUrl = new URL(urlString);
            const reqOptions = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || 80,
                path: targetUrl.pathname + targetUrl.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: options.timeoutMs || 5000,
            };
            const req = http_1.default.request(reqOptions, (res) => {
                const chunks = [];
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
exports.LibsqlNamespaceService = LibsqlNamespaceService;
