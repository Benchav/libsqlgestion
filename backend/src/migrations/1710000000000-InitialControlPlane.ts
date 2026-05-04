import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialControlPlane1710000000000 implements MigrationInterface {
  name = 'InitialControlPlane1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = ON');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" varchar PRIMARY KEY NOT NULL,
        "email" varchar NOT NULL UNIQUE,
        "passwordHash" varchar NOT NULL,
        "active" boolean NOT NULL DEFAULT (1),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "roles" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL UNIQUE,
        "isSystem" boolean NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "permissions" (
        "id" varchar PRIMARY KEY NOT NULL,
        "code" varchar NOT NULL UNIQUE,
        "description" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "ownerId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_projects_owner" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "databases" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "type" varchar NOT NULL,
        "url" varchar,
        "encryptedToken" varchar,
        "subdomain" varchar,
        "status" varchar NOT NULL DEFAULT ('inactive'),
        "metadata" text,
        "projectId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_databases_project" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_roles" (
        "id" varchar PRIMARY KEY NOT NULL,
        "userId" varchar NOT NULL,
        "roleId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_user_roles_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_user_roles_role" FOREIGN KEY ("roleId") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_roles_user_role" ON "user_roles" ("userId", "roleId")');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "role_permissions" (
        "rolesId" varchar NOT NULL,
        "permissionsId" varchar NOT NULL,
        PRIMARY KEY ("rolesId", "permissionsId"),
        CONSTRAINT "FK_role_permissions_role" FOREIGN KEY ("rolesId") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_role_permissions_permission" FOREIGN KEY ("permissionsId") REFERENCES "permissions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_members" (
        "id" varchar PRIMARY KEY NOT NULL,
        "projectId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_project_members_project" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_members_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_project_members_project_user" ON "project_members" ("projectId", "userId")');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "id" varchar PRIMARY KEY NOT NULL,
        "accessTokenHash" varchar NOT NULL UNIQUE,
        "refreshTokenHash" varchar NOT NULL UNIQUE,
        "revokedAt" datetime,
        "expiresAt" datetime,
        "userId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_sessions_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "action" varchar NOT NULL,
        "resourceType" varchar,
        "resourceId" varchar,
        "metadata" text,
        "actorId" varchar,
        "ipAddress" varchar,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_audit_logs_actor" FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "database_migrations" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "checksum" varchar NOT NULL UNIQUE,
        "statements" text,
        "source" varchar,
        "status" varchar NOT NULL DEFAULT ('pending'),
        "errorMessage" varchar,
        "databaseId" varchar NOT NULL,
        "actorId" varchar,
        "appliedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "FK_database_migrations_database" FOREIGN KEY ("databaseId") REFERENCES "databases" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_database_migrations_actor" FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_database_migrations_name" ON "database_migrations" ("name")');

    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_databases_type" ON "databases" ("type")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_databases_status" ON "databases" ("status")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "database_migrations"');
    await queryRunner.query('DROP TABLE IF EXISTS "audit_logs"');
    await queryRunner.query('DROP TABLE IF EXISTS "sessions"');
    await queryRunner.query('DROP TABLE IF EXISTS "project_members"');
    await queryRunner.query('DROP TABLE IF EXISTS "role_permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "user_roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "databases"');
    await queryRunner.query('DROP TABLE IF EXISTS "projects"');
    await queryRunner.query('DROP TABLE IF EXISTS "permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "users"');
  }
}
