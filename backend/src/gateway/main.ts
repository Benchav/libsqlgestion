import { GatewayAnalyticsClient } from './analytics';
import { createGatewayServer, getGatewayConfig } from './server';

const config = getGatewayConfig();
const port = Number(process.env.GATEWAY_PORT || 8081);
const analytics = new GatewayAnalyticsClient();
const server = createGatewayServer(config, {
  recordQuery: (metric) => analytics.recordQuery(metric),
  recordTraffic: (metric) => analytics.recordTraffic(metric),
});

analytics.start();

server.listen(port, '0.0.0.0', () => {
  console.log(
    `[gateway] listening on 0.0.0.0:${port} `
    + `(prefix ${config.pathPrefix}${config.allowRoot ? ', root enabled' : ''})`,
  );
  if (!config.internalToken) {
    console.warn('[gateway] GATEWAY_INTERNAL_TOKEN is empty; policy requests will fail closed');
  } else if (!analytics.enabled) {
    console.warn('[gateway] usage analytics are disabled');
  }
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gateway] ${signal} received, closing...`);
  await analytics.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
