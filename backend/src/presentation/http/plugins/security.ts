import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export async function securityPlugin(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return payload;
  });

  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }

    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
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
