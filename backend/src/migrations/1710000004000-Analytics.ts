import { MigrationInterface, QueryRunner } from 'typeorm';

export class Analytics1710000004000 implements MigrationInterface {
  name = 'Analytics1710000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "query_metrics" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "databaseId" varchar NOT NULL,
        "projectId" varchar,
        "source" varchar NOT NULL,
        "operation" varchar NOT NULL,
        "sqlFingerprint" varchar NOT NULL,
        "sqlPreview" text NOT NULL,
        "durationMs" integer NOT NULL DEFAULT (0),
        "rowsRead" integer NOT NULL DEFAULT (0),
        "rowsWritten" integer NOT NULL DEFAULT (0),
        "success" boolean NOT NULL DEFAULT (1),
        "errorCode" varchar,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_query_metrics_created" ON "query_metrics" ("createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_query_metrics_db_created" ON "query_metrics" ("databaseId", "createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_query_metrics_fingerprint_created" ON "query_metrics" ("sqlFingerprint", "createdAt")');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "traffic_metrics" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "databaseId" varchar,
        "method" varchar NOT NULL,
        "path" varchar NOT NULL,
        "requestBytes" integer NOT NULL DEFAULT (0),
        "responseBytes" integer NOT NULL DEFAULT (0),
        "statusCode" integer NOT NULL DEFAULT (0),
        "durationMs" integer NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_traffic_metrics_created" ON "traffic_metrics" ("createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_traffic_metrics_db_created" ON "traffic_metrics" ("databaseId", "createdAt")');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "storage_samples" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "databaseId" varchar NOT NULL,
        "projectId" varchar,
        "sizeBytes" integer NOT NULL DEFAULT (0),
        "sampledAt" datetime NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_storage_samples_db_sampled" ON "storage_samples" ("databaseId", "sampledAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_storage_samples_sampled" ON "storage_samples" ("sampledAt")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "storage_samples"');
    await queryRunner.query('DROP TABLE IF EXISTS "traffic_metrics"');
    await queryRunner.query('DROP TABLE IF EXISTS "query_metrics"');
  }
}
