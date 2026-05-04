"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityPlugin = securityPlugin;
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
async function securityPlugin(app) {
    await app.register(helmet_1.default, {
        contentSecurityPolicy: false,
    });
    await app.register(cors_1.default, {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
        credentials: true,
    });
    await app.register(rate_limit_1.default, {
        max: 120,
        timeWindow: '1 minute',
    });
    app.addHook('onRequest', async (request) => {
        request.startedAt = Date.now();
    });
    app.addHook('onResponse', async (request) => {
        const startedAt = request.startedAt ?? Date.now();
        const durationMs = Date.now() - startedAt;
        request.log.info({
            requestId: request.id,
            method: request.method,
            url: request.url,
            statusCode: request.raw.statusCode,
            durationMs,
        }, 'request completed');
    });
}
