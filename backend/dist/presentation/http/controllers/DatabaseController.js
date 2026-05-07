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
function withConnectionUrl(database) {
    const urls = (0, connection_url_1.buildDatabaseConnectionUrls)(database);
    return {
        ...database,
        connectionUrl: urls.publicUrl,
        publicConnectionUrl: urls.publicUrl,
        internalConnectionUrl: urls.internalUrl,
    };
}
async function databaseRoutes(app) {
    const databaseService = new DatabaseService_1.DatabaseService();
    app.get('/databases', { preHandler: [app.authenticate] }, async (_request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(_request, reply, 'databases.read')))
            return;
        const query = _request.query || {};
        const databases = await databaseService.listDatabases(query.projectId);
        return reply.send({ databases: databases.map((database) => withConnectionUrl(database)) });
    });
    app.post('/databases', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.name || !body.type)
            return reply.status(400).send({ error: 'projectId, name and type required' });
        if (typeof body.projectId !== 'string' || typeof body.name !== 'string' || typeof body.type !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
        if (!['sqlite', 'libsql', 'remote'].includes(body.type))
            return reply.status(400).send({ error: 'invalid database type' });
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
        const body = request.body;
        if (!body.projectId || !body.sourcePath)
            return reply.status(400).send({ error: 'projectId and sourcePath required' });
        if (typeof body.projectId !== 'string' || typeof body.sourcePath !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
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
        const body = request.body;
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
}
