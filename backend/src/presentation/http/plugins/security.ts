import { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

export async function securityPlugin(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
      },
    },
  });

  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];

  await app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  app.addHook('onRequest', async (request) => {
    (request as any).startedAt = Date.now();
  });

  app.addHook('onResponse', async (request) => {
    const startedAt = (request as any).startedAt ?? Date.now();
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
