"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const compress_1 = __importDefault(require("@fastify/compress"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const routes_1 = __importDefault(require("./presentation/http/routes"));
const AuthService_1 = require("./application/auth/AuthService");
const security_1 = require("./presentation/http/plugins/security");
const cookies_1 = require("./infrastructure/security/cookies");
const csrf_1 = require("./presentation/http/csrf");
const validations_1 = require("./types/validations");
function buildServer() {
    const app = (0, fastify_1.default)({ logger: true, trustProxy: true });
    const authService = new AuthService_1.AuthService();
    app.register(compress_1.default, { global: true });
    app.register(multipart_1.default, {
        limits: {
            fileSize: Number(process.env.MAX_UPLOAD_SIZE_BYTES || 524288000),
        },
    });
    app.register(security_1.securityPlugin);
    app.addHook('preHandler', async (request, reply) => {
        if (!(0, csrf_1.requireCsrf)(request, reply)) {
            return reply;
        }
    });
    app.decorate('authenticate', async function (request, reply) {
        const authorization = request.headers.authorization;
        const cookies = (0, cookies_1.parseCookies)(request.headers.cookie);
        const accessToken = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length).trim()
            : cookies['libsqlite.accessToken'];
        if (!accessToken) {
            return reply.code(401).send({ error: 'missing session' });
        }
        const user = await authService.validateAccessToken(accessToken);
        if (!user) {
            return reply.code(401).send({ error: 'invalid or expired token' });
        }
        request.user = { sub: user.id, email: user.email };
    });
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof validations_1.ValidationError) {
            return reply.status(422).send({
                error: error.message,
                code: 'VALIDATION_ERROR',
                details: error.issues,
            });
        }
        if (error.statusCode === 429) {
            return reply.status(429).send({
                error: 'too many requests',
                code: 'RATE_LIMITED',
            });
        }
        requestErrorLogger(_request, error);
        return reply.status(error.statusCode || 500).send({
            error: error.message || 'internal server error',
            code: 'INTERNAL_ERROR',
        });
    });
    app.register(routes_1.default, { prefix: '/api/v1' });
    return app;
}
const requestErrorLogger = (_request, error) => {
    if (error.statusCode === 429 || error.statusCode === 401 || error.statusCode === 403) {
        return;
    }
    console.error(`[${new Date().toISOString()}] Request error: ${error.message}`, {
        method: _request?.method || 'unknown',
        url: _request?.url || 'unknown',
        statusCode: error.statusCode,
    });
};
