"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = databaseRoutes;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const promises_1 = require("stream/promises");
const DatabaseService_1 = require("../../../application/databases/DatabaseService");
const connection_url_1 = require("../../../application/databases/connection-url");
const guards_1 = require("../guards");
const validations_1 = require("../../../types/validations");
const validations_2 = require("../../../types/validations");
function withConnectionUrl(database) {
    const urls = (0, connection_url_1.buildDatabaseConnectionUrls)(database);
    const runtime = database.metadata?.runtime;
    const runtimeStatus = typeof database.status === 'string' ? database.status : 'inactive';
    return {
        ...database,
        connectionUrl: urls.publicHttpsUrl || urls.publicLibsqlUrl || urls.backendUrl,
        publicConnectionUrl: urls.publicHttpsUrl,
        publicHttpsUrl: urls.publicHttpsUrl,
        publicLibsqlUrl: urls.publicLibsqlUrl,
        internalConnectionUrl: urls.internalUrl,
        internalLibsqlUrl: urls.internalUrl,
        backendConnectionUrl: urls.backendUrl,
        backendReachableUrl: urls.backendUrl,
        runtimeStatus,
        exposureMode: runtime?.provider === 'docker-libsql' ? 'public-runtime' : runtime?.provider === 'local-file' ? 'local-file' : database.type,
        runtimeHealth: database.metadata?.runtime?.routeHealth,
    };
}
async function databaseRoutes(app) {
    const databaseService = new DatabaseService_1.DatabaseService();
    app.get('/databases', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        try {
            const query = (0, validations_1.parseAndValidate)(validations_1.pageQuerySchema, request.query || {}, 'query');
            const databases = await databaseService.listDatabases(request.query?.projectId);
            const enriched = databases.map((db) => withConnectionUrl(db));
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
            return reply.status(201).send({ database: withConnectionUrl(result.database), token: result.token });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to create database' });
        }
    });
    app.post('/databases/import-sqlite', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.importSqliteSchema, request.body, 'import sqlite');
        try {
            const result = await databaseService.importExistingSqlite(body.projectId, body);
            return reply.status(201).send({ ...result, database: withConnectionUrl(result.database) });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to import database' });
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
            return reply.status(201).send({ ...result, database: withConnectionUrl(result.database) });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to import uploaded database' });
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
        return reply.send({ database: withConnectionUrl(database) });
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
            return reply.send({ database: withConnectionUrl(database) });
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
        return reply.send({ database: withConnectionUrl(result.database), token: result.token });
    });
    app.post('/databases/:id/test-connection', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const result = await databaseService.testConnection(id);
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
            return reply.status(201).send({ database: withConnectionUrl(result.database), token: result.token });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message || 'failed to create backup' });
        }
    });
}
