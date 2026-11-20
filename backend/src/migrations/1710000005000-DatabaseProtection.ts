import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds data-plane protection flags to existing databases.
 *
 * These columns are additive and default to false. A rolling deploy can run
 * this migration before the new application code starts serving traffic
 * without changing the behaviour of any existing database.
 */
export class DatabaseProtection1710000005000 implements MigrationInterface {
  name = 'DatabaseProtection1710000005000';

  private async columnNames(queryRunner: QueryRunner) {
    const rows = await queryRunner.query('PRAGMA table_info("databases")') as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Keep the migration idempotent. A deploy interrupted after the first
    // ALTER must be able to retry without failing on an existing column.
    const columns = await this.columnNames(queryRunner);
    if (!columns.has('blockReads')) {
      await queryRunner.query(
        'ALTER TABLE "databases" ADD COLUMN "blockReads" boolean NOT NULL DEFAULT (0)',
      );
    }
    if (!columns.has('blockWrites')) {
      await queryRunner.query(
        'ALTER TABLE "databases" ADD COLUMN "blockWrites" boolean NOT NULL DEFAULT (0)',
      );
    }
    if (!columns.has('deleteProtection')) {
      await queryRunner.query(
        'ALTER TABLE "databases" ADD COLUMN "deleteProtection" boolean NOT NULL DEFAULT (0)',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const columns = await this.columnNames(queryRunner);
    if (columns.has('deleteProtection')) {
      await queryRunner.query('ALTER TABLE "databases" DROP COLUMN "deleteProtection"');
    }
    if (columns.has('blockWrites')) {
      await queryRunner.query('ALTER TABLE "databases" DROP COLUMN "blockWrites"');
    }
    if (columns.has('blockReads')) {
      await queryRunner.query('ALTER TABLE "databases" DROP COLUMN "blockReads"');
    }
  }
}
