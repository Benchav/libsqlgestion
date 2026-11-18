"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = snapshotRoutes;
const fs_1 = __importDefault(require("fs"));
const SnapshotService_1 = require("../../../application/snapshots/SnapshotService");
const SnapshotPolicyService_1 = require("../../../application/snapshots/SnapshotPolicyService");
const snapshot_schedule_1 = require("../../../application/snapshots/snapshot-schedule");
const AuditService_1 = require("../../../application/audit/AuditService");
const guards_1 = require("../guards");
const validations_1 = require("../../../types/validations");
const database_presenter_1 = require("../database-presenter");
function presentSnapshot(snapshot) {
    return {
        id: snapshot.id,
        databaseId: snapshot.databaseId,
        status: snapshot.status,
        reason: snapshot.reason,
        fileName: snapshot.fileName,
        sizeBytes: snapshot.sizeBytes,
        checksumSha256: snapshot.checksumSha256,
        milestones: (0, snapshot_schedule_1.getMilestones)(snapshot),
        takenAt: snapshot.takenAt,
        expiresAt: snapshot.expiresAt,
        pinned: snapshot.pinned,
        errorMessage: snapshot.errorMessage,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
    };
}
async function snapshotRoutes(app) {
    const snapshotService = new SnapshotService_1.SnapshotService();
    const policyService = new SnapshotPolicyService_1.SnapshotPolicyService();
    const auditService = new AuditService_1.AuditService();
    app.get('/databases/:id/snapshots', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const query = (0, validations_1.parseAndValidate)(validations_1.snapshotListQuerySchema, request.query || {}, 'query');
            const result = await snapshotService.listSnapshots(id, {
                limit: query.limit,
                before: query.before,
            });
            return reply.send({
                ...result,
                snapshots: result.snapshots.map(presentSnapshot),
            });
        }
        catch (error) {
            if (error instanceof validations_1.ValidationError)
                throw error;
            return reply.status(500).send({ error: 'failed to list snapshots' });
        }
    });
    app.get('/databases/:id/snapshot-policy', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            return reply.send({ policy: await policyService.getPolicy(id) });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to load snapshot policy' });
        }
    });
    app.put('/databases/:id/snapshot-policy', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.snapshotPolicySchema, request.body || {}, 'snapshot policy');
        try {
            const policy = await policyService.upsertPolicy(id, body);
            await auditService.record({
                action: 'database.snapshot.policy',
                resourceType: 'database',
                resourceId: id,
                actorId: request.user?.sub,
                ipAddress: request.ip,
                metadata: { ...policy },
            });
            return reply.send({ policy });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to save snapshot policy' });
        }
    });
    app.post('/databases/:id/snapshots', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const snapshot = await snapshotService.createSnapshot(id, {
                reason: 'manual',
                pinned: true,
                actorId: request.user?.sub,
                ipAddress: request.ip,
            });
            return reply.status(201).send({ snapshot: presentSnapshot(snapshot) });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to create snapshot' });
        }
    });
    app.delete('/databases/:id/snapshots/:snapshotId', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, snapshotId } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            await snapshotService.deleteSnapshot(id, snapshotId, request.user?.sub, request.ip);
            return reply.send({ ok: true });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to delete snapshot' });
        }
    });
    app.post('/databases/:id/snapshots/:snapshotId/restore', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, snapshotId } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.restoreSnapshotSchema, request.body || {}, 'restore snapshot');
        try {
            const result = await snapshotService.restoreSnapshot(id, snapshotId, {
                name: body.name,
                actorId: request.user?.sub,
                ipAddress: request.ip,
            });
            return reply.status(201).send({
                database: (0, database_presenter_1.presentDatabase)(result.database),
                token: result.token,
            });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to restore snapshot' });
        }
    });
    app.get('/databases/:id/snapshots/:snapshotId/download', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id, snapshotId } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const snapshot = await snapshotService.getSnapshot(id, snapshotId);
            if (snapshot.status !== 'ready') {
                return reply.status(409).send({ error: 'snapshot is not ready' });
            }
            if (!fs_1.default.existsSync(snapshot.filePath)) {
                return reply.status(404).send({ error: 'snapshot file not found on disk' });
            }
            const timestamp = new Date(snapshot.takenAt).toISOString().replace(/[:.]/g, '-');
            const safeName = access.name.replace(/["\r\n]/g, '-');
            reply.header('Content-Disposition', `attachment; filename="${safeName}-${timestamp}.db"`);
            reply.header('Content-Type', 'application/x-sqlite3');
            return reply.send(fs_1.default.createReadStream(snapshot.filePath));
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to download snapshot' });
        }
    });
}
