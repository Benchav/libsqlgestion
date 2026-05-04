"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const routes_1 = __importDefault(require("./presentation/http/routes"));
const AuthService_1 = require("./application/auth/AuthService");
function buildServer() {
    const app = (0, fastify_1.default)({ logger: true });
    const authService = new AuthService_1.AuthService();
    app.decorate('authenticate', async function (request, reply) {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'missing bearer token' });
        }
        const accessToken = authorization.slice('Bearer '.length).trim();
        const user = await authService.validateAccessToken(accessToken);
        if (!user) {
            return reply.code(401).send({ error: 'invalid or expired token' });
        }
        request.user = { sub: user.id, email: user.email };
    });
    app.register(routes_1.default, { prefix: '/api/v1' });
    return app;
}
