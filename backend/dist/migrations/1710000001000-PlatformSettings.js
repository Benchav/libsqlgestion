"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformSettings1710000001000 = void 0;
class PlatformSettings1710000001000 {
    constructor() {
        this.name = 'PlatformSettings1710000001000';
    }
    async up(queryRunner) {
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
    async down(queryRunner) {
        await queryRunner.query('DROP TABLE IF EXISTS "platform_settings"');
    }
}
exports.PlatformSettings1710000001000 = PlatformSettings1710000001000;
