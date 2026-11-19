import fs from 'fs';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getSnapshotArtifacts,
  getSnapshotFormat,
  SnapshotService,
} from '../../../application/snapshots/SnapshotService';
import { SnapshotPolicyService } from '../../../application/snapshots/SnapshotPolicyService';
import { getMilestones } from '../../../application/snapshots/snapshot-schedule';
import { DatabaseSnapshot } from '../../../domain/entities/DatabaseSnapshot';
import { AuditService } from '../../../application/audit/AuditService';
import { ensureDatabaseAccess, ensurePermission } from '../guards';
import {
  parseAndValidate,
  restoreSnapshotSchema,
  snapshotDownloadQuerySchema,
  snapshotListQuerySchema,
  snapshotPolicySchema,
  ValidationError,
} from '../../../types/validations';
import { presentDatabase } from '../database-presenter';
import { resolveEffectiveDatabaseType } from '../../../application/databases/database-runtime';

function presentSnapshot(snapshot: DatabaseSnapshot) {
  const artifacts = getSnapshotArtifacts(snapshot);
  return {
    id: snapshot.id,
    databaseId: snapshot.databaseId,
    status: snapshot.status,
    reason: snapshot.reason,
    fileName: snapshot.fileName,
    format: getSnapshotFormat(snapshot),
    verified: snapshot.metadata?.verified === true,
    sizeBytes: snapshot.sizeBytes,
    totalSizeBytes: artifacts.totalBytes,
    downloadFormats: artifacts.downloadFormats,
    warning: artifacts.warning,
    checksumSha256: snapshot.checksumSha256,
    milestones: getMilestones(snapshot),
    takenAt: snapshot.takenAt,
    expiresAt: snapshot.expiresAt,
    pinned: snapshot.pinned,
    errorMessage: snapshot.errorMessage,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

export default async function snapshotRoutes(app: FastifyInstance) {
  const snapshotService = new SnapshotService();
  const policyService = new SnapshotPolicyService();
  const auditService = new AuditService();

  app.get('/databases/:id/snapshots', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const query = parseAndValidate(snapshotListQuerySchema, request.query || {}, 'query');
      const result = await snapshotService.listSnapshots(id, {
        limit: query.limit,
        before: query.before,
      });
      return reply.send({
        ...result,
        snapshots: result.snapshots.map(presentSnapshot),
      });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return reply.status(500).send({ error: 'failed to list snapshots' });
    }
  });

  app.get('/databases/:id/snapshot-policy', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      return reply.send({ policy: await policyService.getPolicy(id) });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to load snapshot policy' });
    }
  });

  app.put('/databases/:id/snapshot-policy', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    const body = parseAndValidate(snapshotPolicySchema, request.body || {}, 'snapshot policy');
    try {
      const policy = await policyService.upsertPolicy(id, body);
      await auditService.record({
        action: 'database.snapshot.policy',
        resourceType: 'database',
        resourceId: id,
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
        metadata: { ...policy },
      });
      return reply.send({ policy });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to save snapshot policy' });
    }
  });

  app.post('/databases/:id/snapshots', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      // libSQL snapshots are logical dumps and can take longer than a proxy
      // request timeout. Return the pending job and let the UI poll it.
      const background = resolveEffectiveDatabaseType(access) === 'libsql';
      const snapshot = await snapshotService.createSnapshot(id, {
        reason: 'manual',
        pinned: true,
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
        background,
      });
      return reply.status(background ? 202 : 201).send({ snapshot: presentSnapshot(snapshot) });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to create snapshot' });
    }
  });

  app.delete('/databases/:id/snapshots/:snapshotId', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id, snapshotId } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      await snapshotService.deleteSnapshot(id, snapshotId, (request as any).user?.sub, request.ip);
      return reply.send({ ok: true });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to delete snapshot' });
    }
  });

  app.post('/databases/:id/snapshots/:snapshotId/restore', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id, snapshotId } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    const body = parseAndValidate(restoreSnapshotSchema, request.body || {}, 'restore snapshot');
    try {
      const result = await snapshotService.restoreSnapshot(id, snapshotId, {
        name: body.name,
        artifactFormat: body.artifactFormat,
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
      });
      return reply.status(201).send({
        database: presentDatabase(result.database),
        token: result.token,
      });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to restore snapshot' });
    }
  });

  app.get('/databases/:id/snapshots/:snapshotId/download', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id, snapshotId } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const query = parseAndValidate(snapshotDownloadQuerySchema, request.query || {}, 'query');

      // Take the lease before resolving the artifact. Otherwise retention could
      // unlink the file between the stat and the stream creation.
      const releaseLease = snapshotService.acquireSnapshotLease(snapshotId);
      let snapshot;
      let artifact;
      try {
        ({ snapshot, artifact } = await snapshotService.resolveSnapshotDownload(
          id,
          snapshotId,
          query.format,
        ));
      } catch (error) {
        releaseLease();
        throw error;
      }

      const timestamp = new Date(snapshot.takenAt).toISOString().replace(/[:.]/g, '-');
      const safeName = access.name.replace(/[\\/:*?"<>|\r\n]/g, '-');
      const extension = artifact.kind;
      reply.header('Content-Disposition', `attachment; filename="${safeName}-${timestamp}.${extension}"`);
      reply.header(
        'Content-Type',
        extension === 'sql' ? 'application/sql; charset=utf-8' : 'application/vnd.sqlite3',
      );
      if (typeof artifact.sizeBytes === 'number' && Number.isFinite(artifact.sizeBytes)) {
        reply.header('Content-Length', String(artifact.sizeBytes));
      }
      reply.header('Cache-Control', 'private, no-store, max-age=0');
      reply.header('X-Backup-Artifact', extension);

      // Retention and explicit deletes must not unlink a file while it is
      // streaming to the operator.
      const stream = fs.createReadStream(artifact.path);
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        releaseLease();
      };
      stream.once('close', releaseOnce);
      stream.once('error', releaseOnce);

      try {
        return await reply.send(stream);
      } catch (error) {
        releaseOnce();
        stream.destroy();
        throw error;
      }
    } catch (error: any) {
      if (reply.sent) return;
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to download snapshot' });
    }
  });
}
