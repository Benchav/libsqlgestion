#!/usr/bin/env node
import 'reflect-metadata';
import dotenv from 'dotenv';
import path from 'node:path';
import { createRequire } from 'node:module';

dotenv.config({ path: process.env.ENV_FILE || path.resolve(process.cwd(), '.env') });

const require = createRequire(import.meta.url);
const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { DatabaseService } = require('../dist/application/databases/DatabaseService');
const { resolveEffectiveDatabaseType } = require('../dist/application/databases/database-runtime');
const { bootstrapPlatformSettings, getPublicDatabaseSettings } = require('../dist/application/settings/PlatformSettingsService');
const { presentDatabase } = require('../dist/presentation/http/database-presenter');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { Database } = require('../dist/domain/entities/Database');

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const mode = readArg('mode', 'runtime').toLowerCase();
const idFilter = readArg('id', '').trim();
const apply = process.argv.slice(2).includes('--apply');

if (process.argv.slice(2).includes('--help')) {
  console.log(`
Usage:
  npm run migrate:local-to-primary -- --mode=runtime [--id=<databaseId>] [--apply]
  npm run migrate:local-to-primary -- --mode=namespace [--id=<databaseId>] [--apply]

Default: dry-run with --mode=runtime.
--mode=namespace requires wildcard/public namespace routing and LIBSQL_NAMESPACE_PUBLIC_ENABLED=true.
Original LOCAL-FILE files are never deleted.
`);
  process.exit(0);
}

if (mode !== 'namespace' && mode !== 'runtime') {
  console.error(`Invalid --mode="${mode}". Use --mode=namespace or --mode=runtime.`);
  process.exit(2);
}

async function main() {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await bootstrapPlatformSettings();

  const settings = getPublicDatabaseSettings();
  if (!settings.domain || settings.domain === 'localhost') {
    console.warn('WARNING: Wildcard domain is not configured. The resulting public URLs will use localhost.');
  }
  if (mode === 'runtime' && !process.env.TRAEFIK_CERT_RESOLVER?.trim()) {
    console.warn('WARNING: TRAEFIK_CERT_RESOLVER is not set. Runtime HTTPS URLs may serve the Traefik default certificate.');
  }
  if (mode === 'namespace') {
    const publicEnabled = ['true', '1', 'yes', 'on'].includes(String(process.env.LIBSQL_NAMESPACE_PUBLIC_ENABLED || '').toLowerCase());
    if (!publicEnabled) {
      if (process.env.LIBSQL_NAMESPACE_HOST?.trim()) {
        console.warn(
          'WARNING: Only the exact LIBSQL_NAMESPACE_HOST is routed. ' +
          'Use the wildcard override and LIBSQL_NAMESPACE_PUBLIC_ENABLED=true for multiple namespaces.',
        );
      } else {
        console.warn('WARNING: LIBSQL_NAMESPACE_PUBLIC_ENABLED is not true. Namespace conversion will fail.');
      }
    }
  }

  const repo = AppDataSource.getRepository(Database);
  const databases = await repo.find({ relations: ['project'] });
  const targets = databases.filter((database) => {
    if (idFilter && database.id !== idFilter) return false;
    return resolveEffectiveDatabaseType(database) === 'sqlite';
  });

  if (targets.length === 0) {
    console.log('No LOCAL-FILE databases found. Nothing to migrate.');
    return;
  }

  console.log(`Target mode: ${mode}`);
  console.log(`LOCAL-FILE databases found: ${targets.length}`);
  console.log(apply ? 'APPLY mode: records will be updated.' : 'DRY-RUN: no changes will be made. Pass --apply to execute.');
  console.log('');

  const service = new DatabaseService();
  let migrated = 0;
  let failed = 0;

  for (const database of targets) {
    const label = `${database.name} (${database.id})`;
    console.log(`- ${label}`);

    if (!apply) {
      console.log(`  would convert to ${mode}; source: ${database.url || '(managed path)'}`);
      continue;
    }

    try {
      const result = mode === 'namespace'
        ? await service.convertLocalDatabaseToNamespace(database.id, {})
        : await service.convertLocalDatabaseToRuntime(database.id, {});

      const presented = presentDatabase(result.database);
      console.log(`  OK -> ${presented.runtimeProvider || 'unknown'}`);
      console.log(`  sync URL: ${presented.syncUrl || '(not available)'}`);
      console.log(`  token: ${result.token}`);
      console.log(`  source preserved at: ${result.database.metadata?.previousLocalPath || '(see audit log)'}`);
      migrated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  FAILED: ${error?.message || error}`);
    }

    console.log('');
  }

  console.log(`Summary: migrated=${migrated} failed=${failed} dryRun=${!apply}`);
  if (apply && failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await ConnectionPool.getInstance().shutdown();
    } catch {}
    try {
      if (AppDataSource.isInitialized) {
        await AppDataSource.destroy();
      }
    } catch {}
  });
