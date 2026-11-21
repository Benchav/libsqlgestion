import { createGatewayServer, getGatewayConfig } from './server';

const config = getGatewayConfig();
const port = Number(process.env.GATEWAY_PORT || 8081);
const server = createGatewayServer(config);

server.listen(port, '0.0.0.0', () => {
  console.log(
    `[gateway] listening on 0.0.0.0:${port} `
    + `(prefix ${config.pathPrefix}${config.allowRoot ? ', root enabled' : ''})`,
  );
  if (!config.internalToken) {
    console.warn('[gateway] GATEWAY_INTERNAL_TOKEN is empty; policy requests will fail closed');
  }
});

const shutdown = (signal: string) => {
  console.log(`[gateway] ${signal} received, closing...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
