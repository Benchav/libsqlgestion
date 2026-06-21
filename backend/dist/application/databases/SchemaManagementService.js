"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaManagementService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const AuditService_1 = require("../audit/AuditService");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
function validateTableName(name) {
    if (!name || typeof name !== 'string') {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Table name is required.', false);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Invalid table name.', false);
    }
    return name;
}
function validateColumnName(name) {
    if (!name || typeof name !== 'string') {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Column name is required.', false);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Invalid column name.', false);
    }
    return name;
}
function validateColumnType(type) {
    const normalized = String(type || '').trim().toUpperCase();
    if (!normalized) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Column type is required.', false);
    }
    if (!/^[A-Z0-9_\s(),]+$/.test(normalized)) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Invalid column type.', false);
    }
    return normalized;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function splitTopLevelCommaList(sql) {
    const parts = [];
    let current = '';
    let state = 'normal';
    let depth = 0;
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        const next = sql[index + 1];
        if (state === 'line-comment') {
            current += char;
            if (char === '\n')
                state = 'normal';
            continue;
        }
        if (state === 'block-comment') {
            current += char;
            if (char === '*' && next === '/') {
                current += next;
                index += 1;
                state = 'normal';
            }
            continue;
        }
        if (state === 'single') {
            current += char;
            if (char === "'" && next === "'") {
                current += next;
                index += 1;
                continue;
            }
            if (char === "'")
                state = 'normal';
            continue;
        }
        if (state === 'double') {
            current += char;
            if (char === '"' && next === '"') {
                current += next;
                index += 1;
                continue;
            }
            if (char === '"')
                state = 'normal';
            continue;
        }
        if (state === 'backtick') {
            current += char;
            if (char === '`')
                state = 'normal';
            continue;
        }
        if (char === '-' && next === '-') {
            current += char + next;
            index += 1;
            state = 'line-comment';
            continue;
        }
        if (char === '/' && next === '*') {
            current += char + next;
            index += 1;
            state = 'block-comment';
            continue;
        }
        if (char === '"' || char === '`' || char === "'") {
            current += char;
            state = char === '"' ? 'double' : char === '`' ? 'backtick' : 'single';
            continue;
        }
        if (char === '(')
            depth += 1;
        if (char === ')')
            depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) {
            if (current.trim())
                parts.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim())
        parts.push(current.trim());
    return parts;
}
function extractTableColumnName(segment) {
    const trimmed = segment.trim();
    if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(trimmed)) {
        return null;
    }
    const match = trimmed.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\b/i);
    return match?.[1] || match?.[2] || match?.[3] || match?.[4] || match?.[5] || null;
}
function replaceColumnType(segment, nextType) {
    const trimmed = segment.trim();
    const match = trimmed.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s+(.*)$/s);
    if (!match) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', `Unable to parse column definition: ${segment}`, false);
    }
    const columnName = match[1] || match[2] || match[3] || match[4] || match[5];
    const remainder = match[6].trim();
    const constraintKeywords = new Set(['NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'CHECK', 'COLLATE', 'REFERENCES', 'CONSTRAINT', 'GENERATED', 'AS']);
    const tokens = remainder.split(/\s+/);
    const typeTokens = [];
    const constraintTokens = [];
    let depth = 0;
    let inConstraints = false;
    for (const token of tokens) {
        const upper = token.toUpperCase();
        depth += (token.match(/\(/g) || []).length;
        depth -= (token.match(/\)/g) || []).length;
        if (!inConstraints && depth === 0 && constraintKeywords.has(upper)) {
            inConstraints = true;
        }
        if (inConstraints) {
            constraintTokens.push(token);
        }
        else {
            typeTokens.push(token);
        }
    }
    const suffix = constraintTokens.join(' ');
    return `${quoteIdentifier(columnName)} ${nextType}${suffix ? ` ${suffix}` : ''}`;
}
function buildCreateTableSql(originalSql, tableName, tempTableName, defs) {
    const firstParen = originalSql.indexOf('(');
    const lastParen = originalSql.lastIndexOf(')');
    const suffix = lastParen >= 0 ? originalSql.slice(lastParen + 1).trim() : '';
    const suffixPart = suffix ? ` ${suffix}` : '';
    return `CREATE TABLE ${quoteIdentifier(tempTableName)} (${defs.join(', ')})${suffixPart}`;
}
function isTableConstraintSegment(segment) {
    return /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(segment.trim());
}
class SchemaManagementService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.auditService = new AuditService_1.AuditService();
    }
    async deleteTable(databaseId, tableName, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                await client.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)};`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
        }
        else {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            try {
                await client.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)}`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to drop table', true);
            }
        }
        await this.auditService.record({
            action: 'schema.table.delete',
            resourceType: 'table',
            resourceId: safeTableName,
            actorId,
            metadata: { databaseId, tableName: safeTableName },
        });
        return { ok: true, table: safeTableName };
    }
    async renameTable(databaseId, tableName, nextTableName, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const safeNextTableName = validateTableName(nextTableName);
        if (safeTableName === safeNextTableName) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'The new table name must be different.', false);
        }
        const sql = `ALTER TABLE ${quoteIdentifier(safeTableName)} RENAME TO ${quoteIdentifier(safeNextTableName)}`;
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                await client.exec(`${sql};`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
        }
        else {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            try {
                await client.execute(sql);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to rename table', true);
            }
        }
        await this.auditService.record({
            action: 'schema.table.rename',
            resourceType: 'table',
            resourceId: safeTableName,
            actorId,
            metadata: { databaseId, from: safeTableName, to: safeNextTableName },
        });
        return { ok: true, table: safeNextTableName };
    }
    async addColumn(databaseId, tableName, input, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const safeColumnName = validateColumnName(input.name);
        const safeColumnType = validateColumnType(input.type);
        const parts = [`ALTER TABLE ${quoteIdentifier(safeTableName)} ADD COLUMN ${quoteIdentifier(safeColumnName)} ${safeColumnType}`];
        if (input.notnull)
            parts.push('NOT NULL');
        if (input.defaultValue !== undefined && input.defaultValue !== '') {
            parts.push(`DEFAULT ${input.defaultValue}`);
        }
        if (input.unique) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'SQLite does not allow UNIQUE on ADD COLUMN directly. Use a migration instead.', false);
        }
        const sql = parts.join(' ');
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                await client.exec(`${sql};`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
        }
        else {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            try {
                await client.execute(sql);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to add column', true);
            }
        }
        await this.auditService.record({
            action: 'schema.column.add',
            resourceType: 'column',
            resourceId: safeColumnName,
            actorId,
            metadata: { databaseId, tableName: safeTableName, columnName: safeColumnName, columnType: safeColumnType, notnull: Boolean(input.notnull), defaultValue: input.defaultValue ?? null },
        });
        return { ok: true, table: safeTableName, column: safeColumnName };
    }
    async renameColumn(databaseId, tableName, columnName, nextColumnName, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const safeColumnName = validateColumnName(columnName);
        const safeNextColumnName = validateColumnName(nextColumnName);
        if (safeColumnName === safeNextColumnName) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'The new column name must be different.', false);
        }
        const sql = `ALTER TABLE ${quoteIdentifier(safeTableName)} RENAME COLUMN ${quoteIdentifier(safeColumnName)} TO ${quoteIdentifier(safeNextColumnName)}`;
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                await client.exec(`${sql};`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
        }
        else {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            try {
                await client.execute(sql);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to rename column', true);
            }
        }
        await this.auditService.record({
            action: 'schema.column.rename',
            resourceType: 'column',
            resourceId: safeColumnName,
            actorId,
            metadata: { databaseId, tableName: safeTableName, from: safeColumnName, to: safeNextColumnName },
        });
        return { ok: true, table: safeTableName, column: safeNextColumnName };
    }
    async deleteColumn(databaseId, tableName, columnName, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const safeColumnName = validateColumnName(columnName);
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                await client.exec(`ALTER TABLE ${quoteIdentifier(safeTableName)} DROP COLUMN ${quoteIdentifier(safeColumnName)};`);
            }
            catch (error) {
                const fallback = await this.rebuildWithoutColumn(client, safeTableName, safeColumnName);
                if (!fallback.ok) {
                    pool.evictOnError(database.id, error);
                    throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
                }
            }
        }
        else {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            try {
                await client.execute(`ALTER TABLE ${quoteIdentifier(safeTableName)} DROP COLUMN ${quoteIdentifier(safeColumnName)}`);
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to delete column', true);
            }
        }
        await this.auditService.record({
            action: 'schema.column.delete',
            resourceType: 'column',
            resourceId: safeColumnName,
            actorId,
            metadata: { databaseId, tableName: safeTableName, columnName: safeColumnName },
        });
        return { ok: true, table: safeTableName, column: safeColumnName };
    }
    async changeColumnType(databaseId, tableName, columnName, nextType, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        const safeColumnName = validateColumnName(columnName);
        const safeNextType = validateColumnType(nextType);
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        try {
            await this.rebuildTableWithClient(client instanceof SqliteClient_1.SqliteClient ? client : client, safeTableName, (parts) => this.transformColumnType(parts, safeColumnName, safeNextType));
        }
        catch (error) {
            pool.evictOnError(database.id, error);
            if (client instanceof SqliteClient_1.SqliteClient) {
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
            throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to change column type', true);
        }
        await this.auditService.record({
            action: 'schema.column.type.change',
            resourceType: 'column',
            resourceId: safeColumnName,
            actorId,
            metadata: { databaseId, tableName: safeTableName, columnName: safeColumnName, nextType: safeNextType },
        });
        return { ok: true, table: safeTableName, column: safeColumnName, nextType: safeNextType };
    }
    async rebuildWithoutColumn(client, tableName, columnName) {
        return this.rebuildTableWithClient(client, tableName, (parts) => this.transformWithoutColumn(parts, columnName));
    }
    async rebuildTableWithClient(client, tableName, transform) {
        const execute = async (sql) => {
            if ('exec' in client) {
                await client.exec(sql);
                return;
            }
            await client.execute(sql);
        };
        const fetchRows = async (sql) => {
            if ('all' in client && typeof client.all === 'function') {
                return await client.all(sql);
            }
            const result = await client.execute(sql);
            return result.rows;
        };
        const tableRows = await fetchRows(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
        const createSql = String(tableRows[0]?.sql || '');
        if (!createSql) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Table definition not found.', false);
        }
        const triggerRows = await fetchRows(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${tableName}'`);
        if ((triggerRows || []).length > 0) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_UNSUPPORTED', 'This table has triggers. Schema reconstruction is blocked for safety.', false);
        }
        const indexRows = await fetchRows(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${tableName}' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_autoindex_%'`);
        const parsed = this.parseCreateTableSql(createSql);
        const next = transform({
            createSql,
            columnDefs: parsed.columnDefs,
            tableConstraints: parsed.tableConstraints,
            indexes: indexRows,
        });
        const tempTableName = `__libsqlite_tmp_${tableName}_${Date.now()}`;
        const nextCreateSql = buildCreateTableSql(createSql, tableName, tempTableName, [...next.columnDefs, ...next.tableConstraints]);
        const nextColumnNames = next.columnDefs
            .map((segment) => extractTableColumnName(segment))
            .filter((name) => Boolean(name));
        const commonColumns = nextColumnNames.map((name) => quoteIdentifier(name)).join(', ');
        const copyColumns = nextColumnNames.map((name) => quoteIdentifier(name)).join(', ');
        const statements = [
            'PRAGMA foreign_keys=OFF;',
            'BEGIN IMMEDIATE;',
            nextCreateSql.endsWith(';') ? nextCreateSql : `${nextCreateSql};`,
            `INSERT INTO ${quoteIdentifier(tempTableName)} (${copyColumns}) SELECT ${commonColumns} FROM ${quoteIdentifier(tableName)};`,
            `DROP TABLE ${quoteIdentifier(tableName)};`,
            `ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(tableName)};`,
            ...next.indexSqls,
            'COMMIT;',
            'PRAGMA foreign_keys=ON;',
        ];
        try {
            await execute(statements.join('\n'));
            return { ok: true };
        }
        catch (error) {
            try {
                await execute('ROLLBACK;');
            }
            catch {
                // Best-effort rollback.
            }
            throw error;
        }
    }
    transformWithoutColumn(parts, columnName) {
        const nextColumnDefs = parts.columnDefs.filter((segment) => extractTableColumnName(segment) !== columnName);
        if (nextColumnDefs.length === parts.columnDefs.length) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', `Column "${columnName}" not found.`, false);
        }
        const affectedConstraint = parts.tableConstraints.find((segment) => new RegExp(`\\b${escapeRegExp(columnName)}\\b`, 'i').test(segment));
        if (affectedConstraint) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_UNSUPPORTED', `Column "${columnName}" is referenced by a table constraint and cannot be dropped safely.`, false);
        }
        const nextIndexes = parts.indexes.filter((index) => !new RegExp(`\\b${escapeRegExp(columnName)}\\b`, 'i').test(index.sql));
        return {
            columnDefs: nextColumnDefs,
            tableConstraints: parts.tableConstraints,
            indexSqls: nextIndexes.map((index) => index.sql),
        };
    }
    transformColumnType(parts, columnName, nextType) {
        let updated = false;
        const nextColumnDefs = parts.columnDefs.map((segment) => {
            const currentName = extractTableColumnName(segment);
            if (currentName !== columnName)
                return segment;
            updated = true;
            return replaceColumnType(segment, nextType);
        });
        if (!updated) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', `Column "${columnName}" not found.`, false);
        }
        return {
            columnDefs: nextColumnDefs,
            tableConstraints: parts.tableConstraints,
            indexSqls: parts.indexes.map((index) => index.sql),
        };
    }
    parseCreateTableSql(createSql) {
        const firstParen = createSql.indexOf('(');
        const lastParen = createSql.lastIndexOf(')');
        if (firstParen < 0 || lastParen < firstParen) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Unable to parse table definition.', false);
        }
        const inner = createSql.slice(firstParen + 1, lastParen);
        const definitions = splitTopLevelCommaList(inner);
        return {
            columnDefs: definitions.filter((segment) => !isTableConstraintSegment(segment)),
            tableConstraints: definitions.filter((segment) => isTableConstraintSegment(segment)),
        };
    }
}
exports.SchemaManagementService = SchemaManagementService;
