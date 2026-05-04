"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueCsrfToken = issueCsrfToken;
exports.requireCsrf = requireCsrf;
const crypto_1 = __importDefault(require("crypto"));
const cookies_1 = require("../../infrastructure/security/cookies");
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = 'libsqlite.csrfToken.v2';
const CSRF_EXEMPT_PATHS = [
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/refresh',
    '/api/v1/health',
    '/api/v1/ready',
];
function issueCsrfToken() {
    return crypto_1.default.randomBytes(32).toString('hex');
}
function requireCsrf(request, reply) {
    if (SAFE_METHODS.has(request.method))
        return true;
    if (CSRF_EXEMPT_PATHS.some((path) => request.url.startsWith(path)))
        return true;
    const cookies = (0, cookies_1.parseCookies)(request.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE_NAME] || cookies['libsqlite.csrfToken'];
    const headerToken = request.headers['x-csrf-token-v2'] || request.headers['x-csrf-token'];
    const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!cookieToken || !provided || cookieToken !== provided) {
        reply.code(403).send({ error: 'invalid csrf token' });
        return false;
    }
    return true;
}
