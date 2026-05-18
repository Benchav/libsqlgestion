import { MigrationInterface, QueryRunner } from 'typeorm';

export class PlatformSettings1710000001000 implements MigrationInterface {
  name = 'PlatformSettings1710000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_settings" (
        "id" varchar PRIMARY KEY NOT NULL,
        "key" varchar NOT NULL UNIQUE,
        "value" text,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_platform_settings_key" ON "platform_settings" ("key")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "platform_settings"');
  }
}