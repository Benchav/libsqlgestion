import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { AppDataSource } from './infrastructure/db/data-source';
import { buildServer } from './server';
import { bootstrapSecurityCatalog } from './application/auth/auth.bootstrap';
import { DiscoveryService } from './application/databases/DiscoveryService';
import { bootstrapPlatformSettings } from './application/settings/PlatformSettingsService';
import { ConnectionPool } from './infrastructure/db/ConnectionPool';

const start = async () => {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await bootstrapSecurityCatalog();
  await bootstrapPlatformSettings();

  const discoveryProjectId = process.env.SQLITE_DISCOVERY_PROJECT_ID;
  const discoveryPath = process.env.SQLITE_DISCOVERY_PATH;
  if (discoveryProjectId && discoveryPath) {
    const discoveryService = new DiscoveryService();
    const adoptDiscovered = String(process.env.SQLITE_DISCOVERY_ADOPT || 'false').toLowerCase() === 'true';
    await discoveryService.scanMountedDirectory(discoveryProjectId, discoveryPath, adoptDiscovered);
  }

  const app = buildServer();
  try {
    await app.listen({ port: Number(process.env.PORT || 5000), host: '0.0.0.0' });
    console.log('Server started on port', process.env.PORT || 5000);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown: close all pooled database connections before exiting
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully...`);
    try {
      const pool = ConnectionPool.getInstance();
      console.log(`Closing ${pool.size} pooled database connection(s)...`);
      await pool.shutdown();
      await app.close();
      await AppDataSource.destroy();
      console.log('Shutdown complete.');
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

start();

