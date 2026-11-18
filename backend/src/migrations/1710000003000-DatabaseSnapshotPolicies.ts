import { MigrationInterface, QueryRunner } from 'typeorm';

export class DatabaseSnapshotPolicies1710000003000 implements MigrationInterface {
  name = 'DatabaseSnapshotPolicies1710000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = ON');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "database_snapshot_policies" (
        "databaseId" varchar PRIMARY KEY NOT NULL,
        "restorePointIntervalMinutes" integer NOT NULL DEFAULT (60),
        "dailyEnabled" boolean NOT NULL DEFAULT (1),
        "dailyAtHour" integer NOT NULL DEFAULT (2),
        "dailyRetention" integer NOT NULL DEFAULT (14),
        "weeklyEnabled" boolean NOT NULL DEFAULT (0),
        "weeklyDayOfWeek" integer NOT NULL DEFAULT (0),
        "weeklyAtHour" integer NOT NULL DEFAULT (2),
        "weeklyRetention" integer NOT NULL DEFAULT (8),
        "monthlyEnabled" boolean NOT NULL DEFAULT (0),
        "monthlyDayOfMonth" integer NOT NULL DEFAULT (1),
        "monthlyAtHour" integer NOT NULL DEFAULT (2),
        "monthlyRetention" integer NOT NULL DEFAULT (12),
        "timezone" varchar NOT NULL DEFAULT ('UTC'),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_database_snapshot_policies_database" FOREIGN KEY ("databaseId") REFERENCES "databases" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "database_snapshot_policies"');
  }
}
