"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const routes_1 = __importDefault(require("./presentation/http/routes"));
const AuthService_1 = require("./application/auth/AuthService");
const security_1 = require("./presentation/http/plugins/security");
const cookies_1 = require("./infrastructure/security/cookies");
const csrf_1 = require("./presentation/http/csrf");
function buildServer() {
    const app = (0, fastify_1.default)({ logger: true, trustProxy: true });
    const authService = new AuthService_1.AuthService();
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
    app.register(routes_1.default, { prefix: '/api/v1' });
    return app;
}
