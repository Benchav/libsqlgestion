import { MigrationInterface, QueryRunner } from 'typeorm';

export class DatabaseSnapshots1710000002000 implements MigrationInterface {
  name = 'DatabaseSnapshots1710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = ON');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "database_snapshots" (
        "id" varchar PRIMARY KEY NOT NULL,
        "databaseId" varchar NOT NULL,
        "projectId" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT ('pending'),
        "reason" varchar NOT NULL,
        "filePath" varchar NOT NULL,
        "fileName" varchar NOT NULL,
        "sizeBytes" integer NOT NULL DEFAULT (0),
        "checksumSha256" varchar,
        "takenAt" datetime NOT NULL,
        "expiresAt" datetime,
        "pinned" boolean NOT NULL DEFAULT (0),
        "errorMessage" varchar,
        "metadata" text,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_database_snapshots_database" FOREIGN KEY ("databaseId") REFERENCES "databases" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_database_snapshots_db_status_taken" ON "database_snapshots" ("databaseId", "status", "takenAt")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_database_snapshots_status" ON "database_snapshots" ("status")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_database_snapshots_one_pending" ON "database_snapshots" ("databaseId") WHERE "status" = \'pending\'',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_database_snapshots_one_pending"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_database_snapshots_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_database_snapshots_db_status_taken"');
    await queryRunner.query('DROP TABLE IF EXISTS "database_snapshots"');
  }
}
