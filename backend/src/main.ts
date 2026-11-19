import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { AppDataSource } from './infrastructure/db/data-source';
import { buildServer } from './server';
import { bootstrapSecurityCatalog } from './application/auth/auth.bootstrap';
import { DiscoveryService } from './application/databases/DiscoveryService';
import { DatabaseService } from './application/databases/DatabaseService';
import { bootstrapPlatformSettings } from './application/settings/PlatformSettingsService';
import { bootstrapOffsiteBackupSettings } from './application/settings/OffsiteBackupSettingsService';
import { getOffsiteBackupService } from './application/offsite/OffsiteBackupService';
import { ConnectionPool } from './infrastructure/db/ConnectionPool';
import { LibsqlNamespaceService } from './infrastructure/libsql/LibsqlNamespaceService';
import { SnapshotScheduler } from './application/snapshots/SnapshotScheduler';
import { RuntimeHealthMonitor } from './application/databases/RuntimeHealthMonitor';
import { analyticsCollector } from './application/analytics/AnalyticsCollector';
import { StorageSampler } from './application/analytics/StorageSampler';

const start = async () => {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await bootstrapSecurityCatalog();
  await bootstrapPlatformSettings();
  await bootstrapOffsiteBackupSettings();

  const namespaceService = new LibsqlNamespaceService();
  if (namespaceService.isEnabled()) {
    try {
      namespaceService.ensureAuthKeys();
    } catch (error: any) {
      console.warn('[main] Could not prepare sqld auth keys:', error?.message || error);
    }
  }

  const databaseService = new DatabaseService();
  const reconciliation = await databaseService.reconcileLegacyDatabases();
  if (reconciliation.reconciled > 0) {
    console.log(`Reconciled ${reconciliation.reconciled} legacy database record(s).`);
  }

  try {
    const rotationRecovery = await databaseService.recoverInterruptedRotations();
    if (rotationRecovery.restored || rotationRecovery.finalized || rotationRecovery.failed) {
      console.log(
        `[main] Rotation recovery: ${rotationRecovery.restored} restored, ` +
        `${rotationRecovery.finalized} finalized, ${rotationRecovery.failed} failed.`,
      );
    }
  } catch (error: any) {
    console.warn('[main] Could not reconcile interrupted token rotations:', error?.message || error);
  }

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

  const snapshotScheduler = new SnapshotScheduler();
  try {
    await snapshotScheduler.start();
  } catch (error: any) {
    console.warn('[main] Could not start snapshot scheduler:', error?.message || error);
  }

  const offsiteBackupService = getOffsiteBackupService();
  try {
    await offsiteBackupService.start();
  } catch (error: any) {
    console.warn('[main] Could not start offsite backup service:', error?.message || error);
  }

  const runtimeHealthMonitor = new RuntimeHealthMonitor();
  try {
    await runtimeHealthMonitor.start();
  } catch (error: any) {
    console.warn('[main] Could not start runtime health monitor:', error?.message || error);
  }

  analyticsCollector.start();
  const storageSampler = new StorageSampler();
  storageSampler.start();

  // Graceful shutdown: close all pooled database connections before exiting
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully...`);
    try {
      storageSampler.stop();
      await analyticsCollector.stop();
      await offsiteBackupService.stop();
      await snapshotScheduler.stop();
      await runtimeHealthMonitor.stop();
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

