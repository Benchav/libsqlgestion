"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = databaseRoutes;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const promises_1 = require("stream/promises");
const DatabaseService_1 = require("../../../application/databases/DatabaseService");
const guards_1 = require("../guards");
const validations_1 = require("../../../types/validations");
const validations_2 = require("../../../types/validations");
const data_source_1 = require("../../../infrastructure/db/data-source");
const Database_1 = require("../../../domain/entities/Database");
const crypto_2 = require("../../../infrastructure/crypto");
const ConnectionPool_1 = require("../../../infrastructure/db/ConnectionPool");
const SqliteClient_1 = require("../../../infrastructure/sqlite/SqliteClient");
const LibsqlNamespaceService_1 = require("../../../infrastructure/libsql/LibsqlNamespaceService");
const database_presenter_1 = require("../database-presenter");
function formatHranaValue(val) {
    if (val === null || val === undefined)
        return { type: 'null' };
    if (typeof val === 'number') {
        if (Number.isInteger(val))
            return { type: 'integer', value: String(val) };
        return { type: 'float', value: val };
    }
    if (typeof val === 'bigint') {
        return { type: 'integer', value: String(val) };
    }
    if (Buffer.isBuffer(val)) {
        return { type: 'blob', base64: val.toString('base64') };
    }
    return { type: 'text', value: String(val) };
}
async function databaseRoutes(app) {
    const databaseService = new DatabaseService_1.DatabaseService();
    app.get('/databases', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        try {
            const query = (0, validations_1.parseAndValidate)(validations_1.pageQuerySchema, request.query || {}, 'query');
            const databases = await databaseService.listDatabases(request.query?.projectId);
            const enriched = databases.map((db) => (0, database_presenter_1.presentDatabase)(db));
            if (query.page && query.limit) {
                const start = (query.page - 1) * query.limit;
                const page = enriched.slice(start, start + query.limit);
                return reply.send({
                    databases: page,
                    total: enriched.length,
                    page: query.page,
                    limit: query.limit,
                    hasMore: start + query.limit < enriched.length,
                });
            }
            return reply.send({ databases: enriched });
        }
        catch (error) {
            if (error instanceof validations_2.ValidationError)
                throw error;
            return reply.status(500).send({ error: 'failed to list databases' });
        }
    });
    app.post('/databases', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.createDatabaseSchema, request.body, 'create database');
        try {
            const result = await databaseService.createDatabase(body.projectId, body);
            return reply.status(201).send({ database: (0, database_presenter_1.presentDatabase)(result.database), token: result.token });
        }
        catch (err) {
            return reply.status(err?.statusCode || 500).send({ error: err?.message || 'failed to create database' });
        }
    });
    app.post('/databases/import-sqlite', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.importSqliteSchema, request.body, 'import sqlite');
        try {
            const result = await databaseService.importExistingSqlite(body.projectId, body);
            return reply.status(201).send({ ...result, database: (0, database_presenter_1.presentDatabase)(result.database) });
        }
        catch (err) {
            return reply.status(err?.statusCode || 500).send({ error: err?.message || 'failed to import database' });
        }
    });
    app.post('/databases/import-upload', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const fields = {};
        let uploadedPath = '';
        let uploadedFileName = '';
        for await (const part of request.parts()) {
            if (part.type === 'file') {
                if (part.fieldname !== 'file') {
                    part.file.resume();
                    continue;
                }
                const tempRoot = await fs_1.default.promises.mkdtemp(path_1.default.join(os_1.default.tmpdir(), 'libsqlite-upload-'));
                uploadedFileName = part.filename || 'database.db';
                uploadedPath = path_1.default.join(tempRoot, uploadedFileName);
                await (0, promises_1.pipeline)(part.file, fs_1.default.createWriteStream(uploadedPath));
                continue;
            }
            if (typeof part.value === 'string') {
                fields[part.fieldname] = part.value;
            }
        }
        if (!fields.projectId || !uploadedPath) {
            return reply.status(400).send({ error: 'projectId and file required' });
        }
        const access = await (0, guards_1.ensureProjectAccess)(request, reply, fields.projectId);
        if (!access)
            return;
        try {
            const result = await databaseService.importExistingSqlite(fields.projectId, {
                name: fields.name,
                sourceName: uploadedFileName,
                sourcePath: uploadedPath,
                subdomain: fields.subdomain || undefined,
            });
            return reply.status(201).send({ ...result, database: (0, database_presenter_1.presentDatabase)(result.database) });
        }
        catch (err) {
            return reply.status(err?.statusCode || 500).send({ error: err?.message || 'failed to import uploaded database' });
        }
        finally {
            if (uploadedPath) {
                const tempDir = path_1.default.dirname(uploadedPath);
                await fs_1.default.promises.rm(tempDir, { recursive: true, force: true });
            }
        }
    });
    app.get('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const database = await databaseService.getDatabase(id);
        if (!database)
            return reply.status(404).send({ error: 'database not found' });
        return reply.send({ database: (0, database_presenter_1.presentDatabase)(database) });
    });
    app.patch('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = (0, validations_1.parseAndValidate)(validations_1.updateDatabaseSchema, request.body, 'update database');
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const database = await databaseService.updateDatabase(id, body);
            return reply.send({ database: (0, database_presenter_1.presentDatabase)(database) });
        }
        catch (err) {
            return reply.status(404).send({ error: err.message });
        }
    });
    app.delete('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await databaseService.deleteDatabase(id);
            return reply.send(result);
        }
        catch (err) {
            return reply.status(404).send({ error: err.message });
        }
    });
    app.patch('/databases/:id/rotate-token', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const result = await databaseService.rotateToken(id);
        return reply.send({ database: (0, database_presenter_1.presentDatabase)(result.database), token: result.token });
    });
    app.post('/databases/:id/test-connection', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const result = await databaseService.testConnection(id);
        if (!result.ok) {
            request.log.warn({ databaseId: id, details: result.details }, '[DatabaseController] test-connection failed');
            return reply.status(503).send({ ...result, error: result.details });
        }
        return reply.send(result);
    });
    app.get('/databases/:id/download', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const database = await databaseService.getDatabase(id);
            if (!database)
                return reply.status(404).send({ error: 'database not found' });
            const filePath = await databaseService.getDatabaseFilePath(id);
            if (!fs_1.default.existsSync(filePath)) {
                return reply.status(404).send({ error: 'database file not found on disk' });
            }
            const filename = `${database.name}.db`;
            reply.header('Content-Disposition', `attachment; filename="${filename}"`);
            reply.header('Content-Type', 'application/x-sqlite3');
            const stream = fs_1.default.createReadStream(filePath);
            return reply.send(stream);
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to download database file' });
        }
    });
    app.post('/databases/:id/convert-to-local', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const database = await databaseService.convertNamespaceDatabaseToLocal(id);
            return reply.send({ database: (0, database_presenter_1.presentDatabase)(database) });
        }
        catch (err) {
            return reply.status(err?.statusCode || 500).send({ error: err?.message || 'failed to convert database to local file' });
        }
    });
    app.post('/databases/:id/convert-to-runtime', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.convertToRuntimeSchema, request.body || {}, 'convert to runtime');
        try {
            const result = await databaseService.convertLocalDatabaseToRuntime(id, body);
            return reply.send({ database: (0, database_presenter_1.presentDatabase)(result.database), token: result.token });
        }
        catch (err) {
            return reply.status(err?.statusCode || 500).send({ error: err?.message || 'failed to convert database to libSQL runtime' });
        }
    });
    app.post('/databases/:id/backup', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = (0, validations_1.parseAndValidate)(validations_1.backupDatabaseSchema, request.body, 'backup database');
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await databaseService.backupDatabase(id, { name: body.name });
            return reply.status(201).send({ database: (0, database_presenter_1.presentDatabase)(result.database), token: result.token });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to create backup' });
        }
    });
    // ---------------------------------------------------------------------------
    // Turso-compatible LibSQL Hrana Pipeline Endpoint (/v2/pipeline, /v1/pipeline)
    // Allows any external @libsql/client to connect via URL and Auth Token
    // ---------------------------------------------------------------------------
    function parseHranaValue(a) {
        if (a === null || a === undefined)
            return null;
        if (typeof a !== 'object')
            return a;
        if (a.type === 'null')
            return null;
        if (a.type === 'integer') {
            const num = Number(a.value);
            return Number.isSafeInteger(num) ? num : a.value;
        }
        if (a.type === 'float')
            return Number(a.value);
        if (a.type === 'text')
            return String(a.value);
        if (a.type === 'blob')
            return Buffer.from(a.base64 || '', 'base64');
        if ('value' in a)
            return parseHranaValue(a.value);
        return a;
    }
    function evalBatchCond(cond, stepResults, stepErrors) {
        if (!cond)
            return true;
        if (cond.type === 'ok') {
            const stepIdx = cond.step;
            return stepResults[stepIdx] !== null && stepResults[stepIdx] !== undefined;
        }
        if (cond.type === 'error') {
            const stepIdx = cond.step;
            return stepErrors[stepIdx] !== null && stepErrors[stepIdx] !== undefined;
        }
        if (cond.type === 'not') {
            return !evalBatchCond(cond.cond, stepResults, stepErrors);
        }
        if (cond.type === 'and') {
            return (cond.conds || []).every((c) => evalBatchCond(c, stepResults, stepErrors));
        }
        if (cond.type === 'or') {
            return (cond.conds || []).some((c) => evalBatchCond(c, stepResults, stepErrors));
        }
        if (cond.type === 'is_autocommit') {
            return true;
        }
        return true;
    }
    async function executeHranaStmt(client, stmt, sqlMap) {
        const sql = stmt?.sql || (stmt?.sql_id != null && sqlMap ? sqlMap.get(stmt.sql_id) : undefined);
        if (!sql)
            throw new Error('missing sql statement');
        let args = [];
        if (Array.isArray(stmt.named_args) && stmt.named_args.length > 0) {
            const named = {};
            const sqlNamedParams = new Set();
            for (const match of sql.matchAll(/([:@$])([A-Za-z_][A-Za-z0-9_]*)/g)) {
                sqlNamedParams.add(`${match[1]}${match[2]}`);
            }
            for (const na of stmt.named_args) {
                if (!na || !na.name)
                    continue;
                const value = parseHranaValue(na.value);
                const name = String(na.name);
                const baseName = name.replace(/^[:@$]/, '');
                const candidates = [name, `:${baseName}`, `@${baseName}`, `$${baseName}`];
                const bindingName = candidates.find((candidate) => sqlNamedParams.has(candidate)) || name;
                named[bindingName] = value;
            }
            args = named;
        }
        else if (Array.isArray(stmt.args)) {
            args = stmt.args.map(parseHranaValue);
        }
        if (client instanceof SqliteClient_1.SqliteClient) {
            const isSelect = /^\s*(WITH\b[\s\S]*?\bSELECT|SELECT|PRAGMA|EXPLAIN)\b/i.test(sql);
            const isReturning = /\bRETURNING\b/i.test(sql);
            if (isSelect || isReturning) {
                const rows = await client.all(sql, args);
                const cols = rows.length > 0 ? Object.keys(rows[0]).map((k) => ({ name: k })) : [];
                const hranaRows = rows.map((row) => Object.values(row).map(formatHranaValue));
                return {
                    cols,
                    rows: hranaRows,
                    affected_row_count: isReturning ? rows.length : 0,
                    last_insert_rowid: null,
                };
            }
            else {
                const runRes = await client.run(sql, args);
                return {
                    cols: [],
                    rows: [],
                    affected_row_count: runRes.changes || 0,
                    last_insert_rowid: runRes.lastID != null ? String(runRes.lastID) : null,
                };
            }
        }
        else {
            const res = await client.execute({ sql, args });
            const cols = (res.columns || []).map((col) => ({ name: col }));
            const hranaRows = (res.rows || []).map((row) => Object.values(row).map(formatHranaValue));
            return {
                cols,
                rows: hranaRows,
                affected_row_count: res.rowsAffected || 0,
                last_insert_rowid: res.lastInsertRowid != null ? String(res.lastInsertRowid) : null,
            };
        }
    }
    const pipelineBatons = new Map();
    function getRequestSql(reqItem, sqlMap) {
        const sqls = [];
        const add = (stmt) => {
            const sql = stmt?.sql || (stmt?.sql_id != null ? sqlMap.get(stmt.sql_id) : undefined);
            if (typeof sql === 'string' && sql.trim())
                sqls.push(sql);
        };
        if (reqItem?.type === 'execute')
            add(reqItem.stmt);
        if (reqItem?.type === 'sequence') {
            const sql = reqItem.sql || (reqItem.sql_id != null ? sqlMap.get(reqItem.sql_id) : undefined);
            if (typeof sql === 'string' && sql.trim())
                sqls.push(sql);
        }
        if (reqItem?.type === 'batch') {
            for (const step of reqItem.batch?.steps || [])
                add(step?.stmt);
        }
        return sqls;
    }
    function pipelineStartsTransaction(requests, sqlMap) {
        return requests.some((item) => getRequestSql(item, sqlMap).some((sql) => /^\s*BEGIN(?:\s+TRANSACTION)?\b/i.test(sql)));
    }
    function pipelineEndsTransaction(requests, sqlMap) {
        return requests.some((item) => getRequestSql(item, sqlMap).some((sql) => /^\s*(?:COMMIT|END|ROLLBACK)\b/i.test(sql)));
    }
    async function closeBatonState(state) {
        try {
            if (state.transactionOpen) {
                await state.client.exec('ROLLBACK;');
            }
        }
        catch { }
        try {
            await state.client.close();
        }
        catch { }
    }
    function sweepPipelineBatons() {
        const now = Date.now();
        for (const [id, state] of pipelineBatons) {
            if (now - state.lastUsed <= 5 * 60000)
                continue;
            pipelineBatons.delete(id);
            void closeBatonState(state);
        }
    }
    const handlePipeline = async (request, reply) => {
        const params = (request.params || {});
        const query = (request.query || {});
        const targetIdentifier = params.id || query.databaseId || request.headers['x-database-id'];
        const authHeader = request.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!token) {
            return reply.code(401).send({ error: 'unauthorized: missing database authorization token' });
        }
        let database = null;
        if (targetIdentifier) {
            database = await data_source_1.AppDataSource.getRepository(Database_1.Database).findOne({
                where: [{ id: targetIdentifier }, { subdomain: targetIdentifier }],
                relations: ['project'],
            });
        }
        // If identifier was not provided or not found, identify database by token
        if (!database) {
            try {
                const namespaceService = new LibsqlNamespaceService_1.LibsqlNamespaceService();
                const payload = namespaceService.verifyToken(token);
                if (payload && payload.ns) {
                    database = await data_source_1.AppDataSource.getRepository(Database_1.Database).findOne({
                        where: { subdomain: payload.ns },
                        relations: ['project'],
                    });
                }
            }
            catch { }
            if (!database) {
                const allDbs = await data_source_1.AppDataSource.getRepository(Database_1.Database).find({ relations: ['project'] });
                for (const db of allDbs) {
                    if (db.encryptedToken) {
                        try {
                            if ((0, crypto_2.decrypt)(db.encryptedToken) === token) {
                                database = db;
                                break;
                            }
                        }
                        catch { }
                    }
                }
            }
        }
        if (!database) {
            return reply.code(404).send({ error: 'database not found' });
        }
        // Authenticate database token
        let tokenValid = false;
        if (database.encryptedToken) {
            try {
                const expectedToken = (0, crypto_2.decrypt)(database.encryptedToken);
                if (token === expectedToken) {
                    tokenValid = true;
                }
            }
            catch { }
        }
        if (!tokenValid && database.subdomain) {
            try {
                const namespaceService = new LibsqlNamespaceService_1.LibsqlNamespaceService();
                const payload = namespaceService.verifyToken(token);
                if (payload && payload.ns === database.subdomain) {
                    tokenValid = true;
                }
            }
            catch { }
        }
        if (!tokenValid) {
            return reply.code(401).send({ error: 'unauthorized: invalid database token' });
        }
        const body = (request.body || {});
        const requests = Array.isArray(body.requests) ? body.requests : [];
        const results = [];
        const requestedBaton = typeof body.baton === 'string' ? body.baton : undefined;
        sweepPipelineBatons();
        let batonState = requestedBaton ? pipelineBatons.get(requestedBaton) : undefined;
        if (requestedBaton && (!batonState || batonState.databaseId !== database.id)) {
            return reply.code(400).send({ error: 'invalid baton' });
        }
        const requestSqlMap = new Map();
        for (const reqItem of requests) {
            if (reqItem.type === 'store_sql' && reqItem.sql_id != null && reqItem.sql) {
                requestSqlMap.set(reqItem.sql_id, reqItem.sql);
            }
        }
        let client = ConnectionPool_1.ConnectionPool.getInstance().getClient(database);
        let responseBaton = requestedBaton ?? null;
        if (client instanceof SqliteClient_1.SqliteClient) {
            if (batonState) {
                client = batonState.client;
                for (const [sqlId, sql] of requestSqlMap) {
                    batonState.sqlMap.set(sqlId, sql);
                }
                batonState.lastUsed = Date.now();
            }
            else if (pipelineStartsTransaction(requests, requestSqlMap)) {
                const dedicatedClient = ConnectionPool_1.ConnectionPool.getInstance().createDedicatedSqliteClient(database);
                const batonId = crypto_1.default.randomUUID();
                batonState = {
                    client: dedicatedClient,
                    databaseId: database.id,
                    lastUsed: Date.now(),
                    transactionOpen: true,
                    sqlMap: requestSqlMap,
                };
                pipelineBatons.set(batonId, batonState);
                client = dedicatedClient;
                responseBaton = batonId;
            }
        }
        else if (requestedBaton) {
            return reply.code(400).send({ error: 'baton transactions are only supported for local SQLite databases' });
        }
        const activeSqlMap = batonState ? batonState.sqlMap : requestSqlMap;
        for (const reqItem of requests) {
            if (reqItem.type === 'store_sql') {
                if (reqItem.sql_id != null && reqItem.sql) {
                    activeSqlMap.set(reqItem.sql_id, reqItem.sql);
                }
                results.push({ type: 'ok', response: { type: 'store_sql' } });
            }
            else if (reqItem.type === 'close_sql') {
                if (reqItem.sql_id != null) {
                    activeSqlMap.delete(reqItem.sql_id);
                }
                results.push({ type: 'ok', response: { type: 'close_sql' } });
            }
            else if (reqItem.type === 'execute') {
                try {
                    const stmtResult = await executeHranaStmt(client, reqItem.stmt, activeSqlMap);
                    results.push({
                        type: 'ok',
                        response: {
                            type: 'execute',
                            result: stmtResult,
                        },
                    });
                }
                catch (err) {
                    results.push({
                        type: 'error',
                        error: {
                            message: err?.message || 'execution error',
                            code: 'SQLITE_ERROR',
                        },
                    });
                }
            }
            else if (reqItem.type === 'batch') {
                const stepResults = [];
                const stepErrors = [];
                const steps = reqItem.batch?.steps || [];
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    const shouldRun = evalBatchCond(step.condition, stepResults, stepErrors);
                    if (!shouldRun) {
                        stepResults.push(null);
                        stepErrors.push(null);
                        continue;
                    }
                    try {
                        const stmtResult = await executeHranaStmt(client, step.stmt, activeSqlMap);
                        stepResults.push(stmtResult);
                        stepErrors.push(null);
                    }
                    catch (err) {
                        stepResults.push(null);
                        stepErrors.push({
                            message: err?.message || 'batch step error',
                            code: 'SQLITE_ERROR',
                        });
                    }
                }
                results.push({
                    type: 'ok',
                    response: {
                        type: 'batch',
                        result: {
                            step_results: stepResults,
                            step_errors: stepErrors,
                        },
                    },
                });
            }
            else if (reqItem.type === 'sequence') {
                const sequenceSql = reqItem.sql || (reqItem.sql_id != null ? activeSqlMap.get(reqItem.sql_id) : undefined);
                try {
                    if (sequenceSql) {
                        if (client instanceof SqliteClient_1.SqliteClient) {
                            await client.exec(sequenceSql);
                        }
                        else {
                            await client.execute(sequenceSql);
                        }
                    }
                    results.push({ type: 'ok', response: { type: 'sequence' } });
                }
                catch (err) {
                    results.push({
                        type: 'error',
                        error: {
                            message: err?.message || 'sequence error',
                            code: 'SQLITE_ERROR',
                        },
                    });
                }
            }
            else if (reqItem.type === 'close') {
                results.push({ type: 'ok', response: { type: 'close' } });
            }
            else {
                results.push({ type: 'ok', response: { type: reqItem.type } });
            }
        }
        if (batonState) {
            batonState.lastUsed = Date.now();
            if (pipelineEndsTransaction(requests, activeSqlMap)) {
                batonState.transactionOpen = false;
            }
            if (requests.some((item) => item.type === 'close')) {
                if (responseBaton) {
                    pipelineBatons.delete(responseBaton);
                }
                await closeBatonState(batonState);
                responseBaton = null;
            }
        }
        return reply.send({
            baton: responseBaton,
            base_url: null,
            results,
        });
    };
    const handleVersion = async (_request, reply) => {
        return reply.code(200).send({ version: 2 });
    };
    app.post('/databases/:id/v2/pipeline', handlePipeline);
    app.post('/databases/:id/v1/pipeline', handlePipeline);
    app.post('/databases/:id/pipeline', handlePipeline);
    app.post('/databases/v2/pipeline', handlePipeline);
    app.post('/databases/v1/pipeline', handlePipeline);
    app.post('/databases/pipeline', handlePipeline);
    app.get('/databases/:id/v2', handleVersion);
    app.get('/databases/:id/v1', handleVersion);
    app.get('/databases/v2', handleVersion);
    app.get('/databases/v1', handleVersion);
}
