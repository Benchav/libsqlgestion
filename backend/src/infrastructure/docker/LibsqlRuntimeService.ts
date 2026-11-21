import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { Database } from '../../domain/entities/Database';
import { getPublicDatabaseSettings } from '../../application/settings/PlatformSettingsService';
import { resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';
import { resolvePublicHost } from '../network/public-dns';

type DockerJson = Record<string, any>;

export type RuntimeRouteHealth = {
  checkedAt: string;
  internalOk: boolean;
  backendOk: boolean;
  publicOk: boolean;
  publicChecked: boolean;
  internalError?: string;
  backendError?: string;
  publicError?: string;
};

type RuntimeMetadata = {
  provider: 'docker-libsql';
  image: string;
  containerId: string;
  containerName: string;
  network: string;
  databasePath: string;
  authKeyPem: string;
  internalUrl: string;
  connectionUrl: string;
  backendUrl: string;
  publicHost: string;
  publicPort: string;
  publicUrl: string;
  routeHealth: RuntimeRouteHealth;
};

export type RuntimeBundle = {
  token: string;
  metadata: RuntimeMetadata;
};

export type RotateDatabaseOptions = {
  /**
   * Persists the new credential and runtime metadata before the previous
   * primary is destroyed. If this throws, the rotation is rolled back and the
   * previous token remains valid.
   */
  persist?: (bundle: RuntimeBundle) => Promise<void>;
};

type RotationJournalPhase = 'started' | 'replacement-ready' | 'committed';

type RotationJournal = {
  version: 1;
  phase: RotationJournalPhase;
  startedAt: string;
  oldContainerId: string;
  oldContainerName: string;
  network: string;
  previousAuthPem: string | null;
  newContainerId?: string;
  newContainerName?: string;
  newAuthKeyPem?: string;
};

function parseRotationJournal(content: string): RotationJournal | null {
  try {
    const parsed = JSON.parse(content) as Partial<RotationJournal>;
    if (
      parsed?.version === 1
      && typeof parsed.phase === 'string'
      && typeof parsed.oldContainerId === 'string'
      && typeof parsed.oldContainerName === 'string'
    ) {
      return parsed as RotationJournal;
    }
  } catch {
    // Legacy marker: a raw PEM file from the first implementation.
  }
  return null;
}

type RuntimePaths = {
  databasePath: string;
  containerName: string;
  subdomain: string;
};

export class LibsqlRuntimeService {
  private readonly socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  private readonly image = process.env.LIBSQL_SERVER_IMAGE || 'ghcr.io/tursodatabase/libsql-server:latest';
  private readonly backendContainerId = process.env.LIBSQL_BACKEND_CONTAINER_ID?.trim()
    || process.env.HOSTNAME?.trim()
    || os.hostname();
  private readonly runtimeNetwork = process.env.LIBSQL_RUNTIME_NETWORK?.trim() || '';
  private readonly proxyContainerName = process.env.LIBSQL_PROXY_CONTAINER_NAME?.trim() || 'coolify-proxy';
  private imagePulled = false;
  private imagePullPromise: Promise<void> | null = null;

  isEnabled() {
    return fs.existsSync(this.socketPath);
  }

  async provisionDatabase(database: Database, databasePath: string): Promise<RuntimeBundle> {
    this.assertAvailable();

    const provisionStartedAt = Date.now();
    const paths = this.resolvePaths(database, databasePath);
    const authBundle = this.generateAuthBundle();
    let createdContainerId: string | undefined;

    try {
      await this.ensureImage();
      const networkName = await this.resolveBackendNetworkName();
      createdContainerId = await this.createAndStartContainer(paths, databasePath, authBundle.publicKeyPem, networkName);
      const publicPort = await this.waitForPublishedPort(createdContainerId, 8080);
      const internalUrl = this.buildInternalUrl(paths.containerName, publicPort);
      const backendUrl = this.buildBackendUrl(publicPort);
      const publicUrl = this.buildCanonicalPublicUrl(paths.subdomain, publicPort);
      const readiness = await this.waitForReady(createdContainerId, {
        internalUrl,
        backendUrl,
      }, authBundle.token);

      console.log(
        `[LibsqlRuntimeService] provisioned ${database.id} in ${Date.now() - provisionStartedAt}ms ` +
        `(network=${networkName}, internal=${readiness.routeHealth.internalOk}, ` +
        `backend=${readiness.routeHealth.backendOk}; public check deferred)`,
      );

      return {
        token: authBundle.token,
        metadata: {
          provider: 'docker-libsql',
          image: this.image,
          containerId: createdContainerId,
          containerName: paths.containerName,
          network: networkName,
          databasePath,
          authKeyPem: authBundle.publicKeyPem,
          internalUrl,
          connectionUrl: readiness.connectionUrl,
          backendUrl,
          publicHost: this.getPublicHost(),
          publicPort,
          publicUrl,
          routeHealth: readiness.routeHealth,
        },
      };
    } catch (error) {
      if (createdContainerId) {
        try { await this.removeContainer(createdContainerId); } catch { /* best-effort */ }
      } else {
        try { await this.requestVoid('DELETE', `/containers/${paths.containerName}?force=true&v=true`); } catch { /* best-effort */ }
      }
      throw error;
    }
  }

  async rotateDatabase(
    database: Database,
    options: RotateDatabaseOptions = {},
  ): Promise<RuntimeBundle | null> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return null;

    const rotateStartedAt = Date.now();
    // Resolve the network before touching the current runtime. If Docker
    // inspection fails, the existing primary must stay online.
    const networkName = await this.resolveBackendNetworkName();
    const authBundle = this.generateAuthBundle();
    const paths = this.resolvePaths(database, runtime.databasePath);
    const authPemPath = path.join(this.resolveDatabaseRootDir(runtime.databasePath), 'auth.pem');
    const previousAuthPem = await fs.promises.readFile(authPemPath, 'utf8').catch(() => null);
    const previousContainerName = `${runtime.containerName}-previous-${Date.now()}`;

    // Write the recovery journal before touching Docker. It records which
    // container/key pair the persisted credential belongs to, so startup
    // reconciliation never applies the old key to a committed replacement.
    const journalBase: RotationJournal = {
      version: 1,
      phase: 'started',
      startedAt: new Date().toISOString(),
      oldContainerId: runtime.containerId,
      oldContainerName: runtime.containerName,
      network: networkName,
      previousAuthPem,
    };
    await this.writeRotationJournal(authPemPath, journalBase);

    let createdContainerId: string | undefined;
    let committed = false;

    try {
      // Keep the previous primary recoverable until the replacement accepts
      // authenticated queries and the new credential is persisted.
      await this.renameContainer(runtime.containerId, previousContainerName);
      await this.stopContainer(runtime.containerId);

      // Remove the stopped container from the routing network so Traefik does
      // not keep it as a competing service while the replacement starts.
      try {
        await this.requestJson(
          'POST',
          `/networks/${encodeURIComponent(networkName)}/disconnect`,
          { Container: runtime.containerId, Force: true },
        );
      } catch (error: any) {
        console.warn(
          `[LibsqlRuntimeService] could not disconnect previous runtime from "${networkName}": ` +
          `${error?.message || error}`,
        );
      }

      createdContainerId = await this.createAndStartContainer(paths, runtime.databasePath, authBundle.publicKeyPem, networkName);
      const publicPort = await this.waitForPublishedPort(createdContainerId, 8080);
      const internalUrl = this.buildInternalUrl(paths.containerName, publicPort);
      const backendUrl = this.buildBackendUrl(publicPort);
      const publicUrl = this.buildCanonicalPublicUrl(paths.subdomain, publicPort);
      const readiness = await this.waitForReady(createdContainerId, {
        internalUrl,
        backendUrl,
      }, authBundle.token);

      const bundle: RuntimeBundle = {
        token: authBundle.token,
        metadata: {
          provider: 'docker-libsql',
          image: this.image,
          containerId: createdContainerId,
          containerName: paths.containerName,
          network: networkName,
          databasePath: runtime.databasePath,
          authKeyPem: authBundle.publicKeyPem,
          publicPort,
          connectionUrl: readiness.connectionUrl,
          backendUrl,
          publicHost: this.getPublicHost(),
          publicUrl,
          internalUrl,
          routeHealth: readiness.routeHealth,
        },
      };

      const readyJournal: RotationJournal = {
        ...journalBase,
        phase: 'replacement-ready',
        newContainerId: createdContainerId,
        newContainerName: paths.containerName,
        newAuthKeyPem: authBundle.publicKeyPem,
      };
      await this.writeRotationJournal(authPemPath, readyJournal);

      // Persist the replacement credential before destroying the previous
      // primary. If the write fails, the catch block restores the old runtime
      // and the old token continues to authenticate.
      if (options.persist) {
        await options.persist(bundle);
        // From this point the database row points at the replacement. A later
        // failure must never delete it or revive the previous credential.
        committed = true;
        await this.writeRotationJournal(authPemPath, {
          ...readyJournal,
          phase: 'committed',
        }).catch((error: any) => {
          // The database already points at the replacement. Losing this phase
          // update is safe: startup also treats a persisted replacement id as
          // committed.
          console.warn(
            `[LibsqlRuntimeService] could not mark rotation committed for ${database.id}: ` +
            `${error?.message || error}`,
          );
        });
      }

      await this.removeContainer(runtime.containerId).catch((error: any) => {
        console.warn(
          `[LibsqlRuntimeService] rotated runtime but could not remove the previous container ` +
          `"${previousContainerName}": ${error?.message || error}`,
        );
      });

      await this.clearRotationMarker(authPemPath);

      console.log(
        `[LibsqlRuntimeService] rotated ${database.id} in ${Date.now() - rotateStartedAt}ms ` +
        `(network=${networkName}, internal=${readiness.routeHealth.internalOk}, ` +
        `backend=${readiness.routeHealth.backendOk}; public check deferred)`,
      );
      return bundle;
    } catch (error: any) {
      if (committed) {
        // The new credential is already persisted. Rolling back here would
        // leave the control plane pointing at a deleted runtime.
        console.error(
          `[LibsqlRuntimeService] rotation for ${database.id} was committed but ` +
          `finalization failed: ${error?.message || error}`,
        );
        throw error;
      }

      // Only remove a replacement whose creation was positively confirmed.
      // Deleting by container name here could destroy the original runtime
      // when the initial rename failed.
      if (createdContainerId) {
        await this.removeContainer(createdContainerId).catch((cleanupError: any) => {
          console.warn(
            `[LibsqlRuntimeService] could not remove failed replacement ${createdContainerId}: ` +
            `${cleanupError?.message || cleanupError}`,
          );
        });
      }

      const recovery = await this.recoverPreviousRuntime({
        containerId: runtime.containerId,
        containerName: runtime.containerName,
        networkName,
        authPemPath,
        previousAuthPem,
      });

      if (recovery.ok) {
        await this.clearRotationMarker(authPemPath);
      } else {
        console.error(
          `[LibsqlRuntimeService] rollback failed for ${database.id}; previous container ` +
          `"${previousContainerName}" may need manual recovery: ${recovery.error}`,
        );
      }

      throw new Error(
        `libSQL token rotation failed and the previous runtime ` +
        `${recovery.ok ? 'was restored' : 'could not be restored automatically'}: ` +
        `${error?.message || error}` +
        `${recovery.ok ? '' : ` (recovery error: ${recovery.error})`}`,
      );
    }
  }

  private async inspectContainer(containerId: string): Promise<DockerJson | null> {
    try {
      return await this.requestJson('GET', `/containers/${containerId}/json`);
    } catch (error: any) {
      if (String(error?.message || '').includes('404')) {
        return null;
      }
      throw error;
    }
  }

  private async writeRotationJournal(authPemPath: string, journal: RotationJournal) {
    const journalPath = `${authPemPath}.rotation`;
    const tempPath = `${journalPath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(journal), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, journalPath);
  }

  private async readRotationJournal(
    authPemPath: string,
  ): Promise<RotationJournal | { legacyAuthPem: string } | null> {
    const content = await fs.promises
      .readFile(`${authPemPath}.rotation`, 'utf8')
      .catch(() => null);
    if (content === null) return null;

    const journal = parseRotationJournal(content);
    if (journal) return journal;
    if (content.trim()) return { legacyAuthPem: content };
    return null;
  }

  private async clearRotationMarker(authPemPath: string) {
    await fs.promises.rm(`${authPemPath}.rotation`, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${authPemPath}.rotation.tmp`, { force: true }).catch(() => undefined);
  }

  private async resolveRuntimeNetwork(databaseId: string, runtime: RuntimeMetadata, journal?: RotationJournal) {
    const candidates = [
      journal?.network,
      typeof runtime.network === 'string' ? runtime.network.trim() : '',
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return this.resolveBackendNetworkName();
  }

  /**
   * Brings a specific container to its canonical name, network and running
   * state without assuming which earlier Docker calls completed.
   */
  private async ensureRuntimeState(params: {
    containerId: string;
    containerName: string;
    networkName: string;
  }): Promise<{ ok: boolean; error?: string }> {
    let inspection: DockerJson | null;
    try {
      inspection = await this.inspectContainer(params.containerId);
    } catch (error: any) {
      return { ok: false, error: `could not inspect runtime: ${error?.message || error}` };
    }

    if (!inspection) {
      return { ok: false, error: `container ${params.containerId} no longer exists` };
    }

    try {
      const currentName = String(inspection?.Name || '').replace(/^\/+/, '');
      if (currentName && currentName !== params.containerName) {
        await this.renameContainer(params.containerId, params.containerName);
      }

      const networks = inspection?.NetworkSettings?.Networks;
      const attached = networks && typeof networks === 'object' ? Object.keys(networks) : [];
      if (!attached.includes(params.networkName)) {
        await this.requestJson(
          'POST',
          `/networks/${encodeURIComponent(params.networkName)}/connect`,
          { Container: params.containerId },
        );
      }

      if (inspection?.State?.Running !== true) {
        // Docker returns 304 when the container is already running.
        await this.startContainer(params.containerId);
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  private async validateRuntimeToken(
    containerId: string,
    runtime: RuntimeMetadata,
    token: string | undefined,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!token) {
      // Docker state can still be repaired when MASTER_KEY/decryption is
      // unavailable; authentication validation is the only skipped step.
      console.warn('[LibsqlRuntimeService] no token available; skipping runtime auth validation');
      return { ok: true };
    }

    try {
      await this.waitForReady(containerId, {
        internalUrl: runtime.internalUrl,
        backendUrl: runtime.backendUrl,
      }, token);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  /**
   * Repairs a rotation interrupted by a backend crash or redeploy.
   *
   * The journal records which container/key pair the persisted credential
   * belongs to. A committed rotation is finalized with the NEW verification
   * key; only an uncommitted rotation restores the previous key. This prevents
   * starting a replacement container with the old public key, which would make
   * the persisted token unusable.
   */
  async recoverInterruptedRotation(
    database: Database,
    token?: string,
  ): Promise<'none' | 'restored' | 'finalized' | 'failed'> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return 'none';

    const authPemPath = path.join(this.resolveDatabaseRootDir(runtime.databasePath), 'auth.pem');
    const journalRead = await this.readRotationJournal(authPemPath);
    if (!journalRead) return 'none';

    if ('legacyAuthPem' in journalRead) {
      return this.recoverLegacyRotation(
        database.id,
        runtime,
        authPemPath,
        journalRead.legacyAuthPem,
        token,
      );
    }

    const journal = journalRead;
    const persistedIsReplacement = Boolean(
      journal.newContainerId && runtime.containerId === journal.newContainerId,
    );

    if (persistedIsReplacement) {
      const result = await this.finalizeCommittedRotation(database.id, runtime, authPemPath, journal, token);
      if (!result.ok) {
        console.error(
          `[LibsqlRuntimeService] committed rotation recovery failed for ${database.id}: ${result.error}`,
        );
        return 'failed';
      }
      await this.clearRotationMarker(authPemPath);
      return 'finalized';
    }

    if (journal.phase === 'committed' || runtime.containerId !== journal.oldContainerId) {
      console.error(
        `[LibsqlRuntimeService] rotation journal for ${database.id} does not match the persisted ` +
        `runtime (phase=${journal.phase}, persisted=${runtime.containerId}). Manual review required.`,
      );
      return 'failed';
    }

    const result = await this.rollbackPendingRotation(database.id, runtime, authPemPath, journal, token);
    if (!result.ok) {
      console.error(
        `[LibsqlRuntimeService] interrupted rotation recovery failed for ${database.id}: ${result.error}`,
      );
      return 'failed';
    }

    await this.clearRotationMarker(authPemPath);
    return 'restored';
  }

  private async finalizeCommittedRotation(
    databaseId: string,
    runtime: RuntimeMetadata,
    authPemPath: string,
    journal: RotationJournal,
    token: string | undefined,
  ): Promise<{ ok: boolean; error?: string }> {
    const newContainerId = runtime.containerId || journal.newContainerId || '';
    const newContainerName = journal.newContainerName || runtime.containerName;
    if (!newContainerId || !newContainerName) {
      return { ok: false, error: 'journal is missing the replacement container identity' };
    }

    // The persisted token belongs to the replacement key. Never restore the
    // previous PEM in this path.
    if (journal.newAuthKeyPem) {
      await fs.promises.writeFile(authPemPath, journal.newAuthKeyPem, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    let networkName: string;
    try {
      networkName = await this.resolveRuntimeNetwork(databaseId, runtime, journal);
    } catch (error: any) {
      return { ok: false, error: `could not resolve network: ${error?.message || error}` };
    }

    const state = await this.ensureRuntimeState({
      containerId: newContainerId,
      containerName: newContainerName,
      networkName,
    });
    if (!state.ok) return state;

    const auth = await this.validateRuntimeToken(newContainerId, runtime, token);
    if (!auth.ok) return auth;

    if (journal.oldContainerId && journal.oldContainerId !== newContainerId) {
      await this.removeContainer(journal.oldContainerId).catch((error: any) => {
        console.warn(
          `[LibsqlRuntimeService] could not remove previous container after committed rotation: ` +
          `${error?.message || error}`,
        );
      });
    }

    return { ok: true };
  }

  private async rollbackPendingRotation(
    databaseId: string,
    runtime: RuntimeMetadata,
    authPemPath: string,
    journal: RotationJournal,
    token: string | undefined,
  ): Promise<{ ok: boolean; error?: string }> {
    const oldContainerId = journal.oldContainerId || runtime.containerId;
    const oldContainerName = journal.oldContainerName || runtime.containerName;

    // Remove an unpersisted replacement before renaming the previous runtime
    // back to its canonical name.
    const replacements = new Set<string>();
    if (journal.newContainerId && journal.newContainerId !== oldContainerId) {
      replacements.add(journal.newContainerId);
    }

    try {
      const canonical = await this.inspectContainer(oldContainerName);
      if (canonical?.Id && canonical.Id !== oldContainerId) {
        replacements.add(canonical.Id);
      }
    } catch (error: any) {
      console.warn(
        `[LibsqlRuntimeService] could not inspect canonical runtime for ${databaseId}: ` +
        `${error?.message || error}`,
      );
    }

    for (const containerId of replacements) {
      await this.removeContainer(containerId).catch((error: any) => {
        console.warn(
          `[LibsqlRuntimeService] could not remove unpersisted replacement ${containerId}: ` +
          `${error?.message || error}`,
        );
      });
    }

    let networkName: string;
    try {
      networkName = await this.resolveRuntimeNetwork(databaseId, runtime, journal);
    } catch (error: any) {
      return { ok: false, error: `could not resolve network: ${error?.message || error}` };
    }

    const recovery = await this.recoverPreviousRuntime({
      containerId: oldContainerId,
      containerName: oldContainerName,
      networkName,
      authPemPath,
      previousAuthPem: journal.previousAuthPem,
    });
    if (!recovery.ok) return recovery;

    const auth = await this.validateRuntimeToken(oldContainerId, runtime, token);
    if (!auth.ok) return auth;

    return { ok: true };
  }

  private async recoverLegacyRotation(
    databaseId: string,
    runtime: RuntimeMetadata,
    authPemPath: string,
    previousAuthPem: string,
    token: string | undefined,
  ): Promise<'none' | 'restored' | 'finalized' | 'failed'> {
    // Compatibility with the first marker format (raw PEM). It has no phase
    // information, so decide from the actual containers:
    // - a different container owns the canonical name -> the persisted one is
    //   the old runtime, roll back and remove the uncommitted replacement;
    // - otherwise the persisted container is the only candidate: never
    //   overwrite its key with the legacy one, just start and validate it.
    let persisted: DockerJson | null = null;
    try {
      persisted = await this.inspectContainer(runtime.containerId);
    } catch (error: any) {
      console.warn(
        `[LibsqlRuntimeService] could not inspect ${databaseId} during legacy rotation recovery: ` +
        `${error?.message || error}`,
      );
      return 'failed';
    }

    if (!persisted) {
      console.error(
        `[LibsqlRuntimeService] legacy rotation for ${databaseId} references a missing container ` +
        `${runtime.containerId}; manual review required.`,
      );
      return 'failed';
    }

    let canonical: DockerJson | null = null;
    try {
      canonical = await this.inspectContainer(runtime.containerName);
    } catch {
      canonical = null;
    }

    if (canonical?.Id && canonical.Id !== runtime.containerId) {
      const journal: RotationJournal = {
        version: 1,
        phase: 'started',
        startedAt: new Date().toISOString(),
        oldContainerId: runtime.containerId,
        oldContainerName: runtime.containerName,
        network: runtime.network,
        previousAuthPem,
      };

      const result = await this.rollbackPendingRotation(databaseId, runtime, authPemPath, journal, token);
      if (!result.ok) {
        console.error(
          `[LibsqlRuntimeService] legacy rotation recovery failed for ${databaseId}: ${result.error}`,
        );
        return 'failed';
      }

      await this.clearRotationMarker(authPemPath);
      return 'restored';
    }

    // Only the persisted container exists. Its current auth.pem is the only
    // key that can match the persisted token, so do not replace it blindly.
    let networkName: string;
    try {
      networkName = await this.resolveRuntimeNetwork(databaseId, runtime);
    } catch (error: any) {
      return 'failed';
    }

    const state = await this.ensureRuntimeState({
      containerId: runtime.containerId,
      containerName: runtime.containerName,
      networkName,
    });
    if (!state.ok) {
      console.error(
        `[LibsqlRuntimeService] legacy rotation recovery failed for ${databaseId}: ${state.error}`,
      );
      return 'failed';
    }

    const auth = await this.validateRuntimeToken(runtime.containerId, runtime, token);
    if (!auth.ok) {
      console.error(
        `[LibsqlRuntimeService] legacy rotation for ${databaseId} could not validate the persisted ` +
        `token; the recovery marker was kept for manual review: ${auth.error}`,
      );
      return 'failed';
    }

    await this.clearRotationMarker(authPemPath);
    return 'finalized';
  }

  /**
   * Restores the previous primary from its actual Docker state instead of
   * assuming the earlier stop/rename/disconnect sequence completed. This is
   * what makes a failed rotation safe when a Docker call succeeds server-side
   * but the response is lost.
   */
  private async recoverPreviousRuntime(params: {
    containerId: string;
    containerName: string;
    networkName: string;
    authPemPath: string;
    previousAuthPem: string | null;
  }): Promise<{ ok: boolean; error?: string }> {
    // Restore the JWT verification key before starting the previous container.
    // Otherwise its still-valid token would stop authenticating after a
    // restart because the new public key had already replaced auth.pem.
    try {
      if (params.previousAuthPem !== null) {
        await fs.promises.writeFile(params.authPemPath, params.previousAuthPem, 'utf8');
      } else {
        await fs.promises.rm(params.authPemPath, { force: true });
      }
    } catch (error: any) {
      return { ok: false, error: `could not restore auth key: ${error?.message || error}` };
    }

    let inspect: DockerJson | null;
    try {
      inspect = await this.inspectContainer(params.containerId);
    } catch (error: any) {
      return { ok: false, error: `could not inspect previous runtime: ${error?.message || error}` };
    }

    if (!inspect) {
      return {
        ok: false,
        error: `previous runtime container ${params.containerId} no longer exists`,
      };
    }

    try {
      const currentName = String(inspect?.Name || '').replace(/^\/+/, '');
      if (currentName && currentName !== params.containerName) {
        await this.renameContainer(params.containerId, params.containerName);
      }

      const networks = inspect?.NetworkSettings?.Networks;
      const attached = networks && typeof networks === 'object' ? Object.keys(networks) : [];
      if (!attached.includes(params.networkName)) {
        await this.requestJson(
          'POST',
          `/networks/${encodeURIComponent(params.networkName)}/connect`,
          { Container: params.containerId },
        );
      }

      if (inspect?.State?.Running !== true) {
        // Docker returns 304 when the container is already running.
        await this.startContainer(params.containerId);
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async removeDatabase(database: Database) {
    const runtime = this.readRuntimeMetadata(database);
    if (runtime) {
      await this.removeContainer(runtime.containerId);
    }

    const fileCandidates = new Set<string>();
    if (database.url && resolveEffectiveDatabaseType(database as any) === 'sqlite') {
      fileCandidates.add(database.url);
    }
    if (runtime?.databasePath) {
      fileCandidates.add(runtime.databasePath);
      fileCandidates.add(this.resolveDatabaseRootDir(runtime.databasePath));
    }

    await this.cleanupPaths([...fileCandidates], true);
  }

  private assertAvailable() {
    if (!this.isEnabled()) {
      throw new Error(`Docker socket not found at ${this.socketPath}`);
    }
  }

  private detectPublicHost() {
    return 'host.docker.internal';
  }

  private normalizePublicHost(value?: string) {
    if (!value) {
      return this.detectPublicHost();
    }

    if (value === '127.0.0.1' || value === 'localhost') {
      return this.detectPublicHost();
    }

    return value;
  }

  private getPublicHost() {
    const settings = getPublicDatabaseSettings();
    return this.normalizePublicHost(settings.host || process.env.DATABASE_PUBLIC_HOST?.trim());
  }

  private getPublicProtocol() {
    const settings = getPublicDatabaseSettings();
    return settings.protocol || process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'http';
  }

  private getPublicDomain() {
    const settings = getPublicDatabaseSettings();
    return settings.domain || process.env.DATABASE_PUBLIC_DOMAIN?.trim() || 'localhost';
  }

  private buildPublicUrl(publicPort: string) {
    // The published host port is the raw sqld HTTP listener. TLS is added by
    // the Traefik router for the canonical domain, never on this port.
    return `http://${this.getPublicHost()}:${publicPort}`;
  }

  private buildBackendUrl(publicPort: string) {
    return this.buildPublicUrl(publicPort);
  }

  private buildCanonicalPublicUrl(subdomain: string, publicPort: string) {
    const domain = this.getPublicDomain().replace(/^\.+/, '');
    if (domain && domain !== 'localhost') {
      return `${this.getPublicProtocol()}://${subdomain}.${domain}`;
    }

    return this.buildBackendUrl(publicPort);
  }

  private buildInternalUrl(containerName: string, publicPort: string) {
    if (containerName) {
      return `http://${containerName}:8080`;
    }

    return this.buildPublicUrl(publicPort);
  }

  private resolvePaths(database: Database, databasePath: string): RuntimePaths {
    const containerName = `libsqlite-${database.id}`;

    return {
      databasePath,
      containerName,
      subdomain: database.subdomain || `db-${database.id}`,
    };
  }

  private readRuntimeMetadata(database: Database): RuntimeMetadata | null {
    const runtime = database.metadata?.runtime as Partial<RuntimeMetadata> | undefined;
    if (!runtime || runtime.provider !== 'docker-libsql') {
      return null;
    }

    if (
      typeof runtime.containerId !== 'string' ||
      typeof runtime.containerName !== 'string' ||
      typeof runtime.databasePath !== 'string' ||
      typeof runtime.authKeyPem !== 'string' ||
      typeof runtime.internalUrl !== 'string' ||
      typeof runtime.connectionUrl !== 'string' ||
      typeof runtime.backendUrl !== 'string' ||
      typeof runtime.publicHost !== 'string' ||
      typeof runtime.publicPort !== 'string' ||
      typeof runtime.publicUrl !== 'string'
    ) {
      return null;
    }

    return runtime as RuntimeMetadata;
  }

  private generateAuthBundle() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim() + '\n';
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresInSeconds = Number(process.env.LIBSQL_RUNTIME_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 365);
    const payload = {
      a: 'rw',
      iat: issuedAt - 60,
      nbf: issuedAt - 60,
      exp: issuedAt + Math.max(300, expiresInSeconds),
    };
    const header = this.base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
    const encodedPayload = this.base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${header}.${encodedPayload}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);

    return {
      publicKeyPem,
      token: `${signingInput}.${this.base64UrlEncode(signature)}`,
    };
  }

  private base64UrlEncode(value: Buffer) {
    return value
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private async ensureImage() {
    if (this.imagePulled) return;
    if (this.imagePullPromise) {
      await this.imagePullPromise;
      return;
    }

    this.imagePullPromise = (async () => {
      const imageExists = await this.checkImageExists();
      if (imageExists) {
        this.imagePulled = true;
        return;
      }

      await this.requestJson('POST', `/images/create?fromImage=${encodeURIComponent(this.image)}`);
      this.imagePulled = true;
    })();

    await this.imagePullPromise;
  }

  private async checkImageExists(): Promise<boolean> {
    try {
      const result = await this.requestJson('GET', `/images/${encodeURIComponent(this.image)}/json`);
      return Boolean(result && typeof result.Id === 'string');
    } catch {
      return false;
    }
  }

  private resolveDatabaseRootDir(databasePath: string): string {
    const normalized = path.normalize(databasePath);
    const parts = normalized.split(path.sep);
    const dbsIndex = parts.lastIndexOf('dbs');
    if (dbsIndex !== -1) {
      return parts.slice(0, dbsIndex).join(path.sep);
    }
    return path.dirname(databasePath);
  }

  private async createAndStartContainer(paths: RuntimePaths, databasePath: string, authKeyPem: string, networkName: string) {
    const dbRootDir = this.resolveDatabaseRootDir(databasePath);
    const hostDirName = await this.resolveHostPath(dbRootDir);

    const authPemPath = path.join(dbRootDir, 'auth.pem');
    await fs.promises.writeFile(authPemPath, authKeyPem, 'utf8');

    const routerName = `traefik.http.routers.${paths.containerName}`;
    const certResolver = process.env.TRAEFIK_CERT_RESOLVER?.trim();
    const entrypoint = process.env.TRAEFIK_ENTRYPOINT?.trim();
    const labels: Record<string, string> = {
      'libsqlite.managed': 'true',
      'libsqlite.container-name': paths.containerName,
      'traefik.enable': 'true',
      'traefik.docker.network': networkName,
      [`${routerName}.rule`]: `Host(\`${paths.subdomain}.${this.getPublicDomain()}\`)`,
      // A dedicated runtime must win over the shared sqld HostRegexp router
      // when both are present.
      [`${routerName}.priority`]: '1000',
      [`traefik.http.services.${paths.containerName}.loadbalancer.server.port`]: '8080',
    };

    // Opt-in TLS for dedicated runtimes. The shared sqld namespace uses its
    // own router labels in docker-compose.yml.
    if (certResolver) {
      labels[`${routerName}.tls`] = 'true';
      labels[`${routerName}.tls.certresolver`] = certResolver;
      if (entrypoint) {
        labels[`${routerName}.entrypoints`] = entrypoint;
      }
    } else if (this.getPublicDomain() && this.getPublicDomain() !== 'localhost') {
      console.warn(
        `[LibsqlRuntimeService] Runtime "${paths.subdomain}" has a public domain but ` +
        'TRAEFIK_CERT_RESOLVER is not set. The HTTPS URL may serve the Traefik default ' +
        'certificate; set TRAEFIK_CERT_RESOLVER to your Traefik resolver name.',
      );
    }

    const createResponse = await this.requestJson('POST', `/containers/create?name=${encodeURIComponent(paths.containerName)}`, {
      Image: this.image,
      Env: [
        'SQLD_NODE=primary',
        'SQLD_DB_PATH=/var/lib/sqld',
        'SQLD_AUTH_JWT_KEY_FILE=/var/lib/sqld/auth.pem',
        'SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080',
      ],
      ExposedPorts: {
        '8080/tcp': {},
        '5001/tcp': {},
      },
      HostConfig: {
        AutoRemove: false,
        PublishAllPorts: true,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: Math.max(0, Number(process.env.LIBSQL_RUNTIME_MEMORY_BYTES || 0)),
        NanoCpus: Math.max(0, Number(process.env.LIBSQL_RUNTIME_CPU_NANO || 0)),
        PidsLimit: Math.max(0, Number(process.env.LIBSQL_RUNTIME_PIDS_LIMIT || 0)) || undefined,
        Binds: [
          `${hostDirName}:/var/lib/sqld:rw`,
        ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {},
        },
      },
      Labels: labels,
    });

    const containerId = createResponse.Id as string | undefined;
    if (!containerId) {
      throw new Error('Docker did not return a container id');
    }

    try {
      await this.requestVoid('POST', `/containers/${containerId}/start`);
      await this.assertContainerOnNetwork(containerId, networkName);
      return containerId;
    } catch (error) {
      // The caller does not receive the id when startup fails, so remove the
      // half-created container here by its confirmed identity.
      await this.removeContainer(containerId).catch((cleanupError: any) => {
        console.warn(
          `[LibsqlRuntimeService] could not remove container ${containerId} after startup failure: ` +
          `${cleanupError?.message || cleanupError}`,
        );
      });
      throw error;
    }
  }

  private async assertContainerOnNetwork(containerId: string, networkName: string) {
    const inspect = await this.requestJson('GET', `/containers/${containerId}/json`);
    const networks = inspect?.NetworkSettings?.Networks;
    const attached = networks && typeof networks === 'object' ? Object.keys(networks) : [];

    if (!attached.includes(networkName)) {
      throw new Error(
        `libSQL runtime ${containerId} was created but is not attached to Docker network ` +
        `"${networkName}" (attached: ${attached.length ? attached.join(', ') : 'none'}). ` +
        'Internal container-name DNS and Traefik routing will not work.',
      );
    }
  }

  private async restartContainer(containerId: string) {
    await this.requestVoid('POST', `/containers/${containerId}/restart?t=5`);
  }

  private async removeContainer(containerId: string) {
    try {
      await this.requestVoid('DELETE', `/containers/${containerId}?force=true&v=true`);
    } catch (error: any) {
      if (!String(error?.message || '').includes('404')) {
        throw error;
      }
    }
  }

  private async renameContainer(containerId: string, name: string) {
    await this.requestVoid(
      'POST',
      `/containers/${containerId}/rename?name=${encodeURIComponent(name)}`,
    );
  }

  private async stopContainer(containerId: string, timeoutSeconds = 10) {
    await this.requestVoid('POST', `/containers/${containerId}/stop?t=${timeoutSeconds}`);
  }

  private async startContainer(containerId: string) {
    await this.requestVoid('POST', `/containers/${containerId}/start`);
  }

  private async waitForPublishedPort(containerId: string, containerPort: number) {
    const portKey = `${containerPort}/tcp`;
    const timeoutAt = Date.now() + 30000;
    let delay = 250;

    while (Date.now() < timeoutAt) {
      const inspect = await this.requestJson('GET', `/containers/${containerId}/json`);
      const bindings = inspect?.NetworkSettings?.Ports?.[portKey];
      const hostPort = bindings?.[0]?.HostPort;
      if (typeof hostPort === 'string' && hostPort.trim()) {
        return hostPort;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 3000);
    }

    throw new Error('Timed out waiting for the libSQL server port to become available');
  }

  async checkRouteHealth(
    database: Database,
    token: string,
    options: { publicTimeoutMs?: number } = {},
  ): Promise<RuntimeRouteHealth | null> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return null;

    const internalCheck = await this.checkConnection(runtime.internalUrl, token, false);
    const backendCheck = await this.checkConnection(runtime.backendUrl, token, false);
    // Recompute the canonical public URL from the current settings so a manual
    // health check reflects a wildcard-domain/TLS change without rotating.
    const publicUrl = database.subdomain
      ? this.buildCanonicalPublicUrl(database.subdomain, runtime.publicPort)
      : runtime.publicUrl;
    const publicChecked = Boolean(
      publicUrl
      && publicUrl !== runtime.backendUrl
      && publicUrl !== runtime.internalUrl,
    );

    let publicCheck: { ok: boolean; error?: string } = { ok: true };
    if (publicChecked) {
      const publicHost = (() => {
        try {
          return new URL(publicUrl).hostname;
        } catch {
          return '';
        }
      })();

      let dnsError: string | undefined;
      if (publicHost) {
        const dnsResult = await resolvePublicHost(publicHost);
        if (dnsResult.notFound) {
          dnsError = `DNS does not resolve for ${publicHost}: NXDOMAIN`;
        } else if (dnsResult.addresses.length === 0 && dnsResult.error) {
          dnsError = `DNS lookup failed for ${publicHost}: ${(dnsResult.error as any)?.message || dnsResult.error}`;
        }
      }

      if (dnsError) {
        publicCheck = { ok: false, error: dnsError };
      } else {
        const publicTimeoutMs = Math.max(0, Number(options.publicTimeoutMs || 0));
        publicCheck = publicTimeoutMs > 0
          ? await this.waitForPublicConnection(publicUrl, publicTimeoutMs)
          : await this.checkPublicRoute(publicUrl);
      }
    }

    return {
      checkedAt: new Date().toISOString(),
      internalOk: internalCheck.ok,
      backendOk: backendCheck.ok,
      publicOk: publicCheck.ok,
      publicChecked,
      internalError: internalCheck.ok ? undefined : this.describeRouteError(internalCheck.error, runtime.internalUrl),
      backendError: backendCheck.ok ? undefined : this.describeRouteError(backendCheck.error, runtime.backendUrl),
      publicError: publicCheck.ok ? undefined : this.describeRouteError(publicCheck.error, publicUrl),
    };
  }

  private describeRouteError(error: string | undefined, url?: string) {
    const message = String(error || 'unknown error').trim();
    const lower = message.toLowerCase();
    const host = (() => {
      if (!url) return '';
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();

    if (/enotfound|eai_again|nxdomain|getaddrinfo|dns does not resolve/.test(lower)) {
      return host
        ? `DNS does not resolve for ${host}. Create a wildcard DNS record that covers this host.`
        : 'DNS does not resolve. Create the wildcard DNS record for the database domain.';
    }
    if (/cert|self.signed|unable to verify|tls|ssl/.test(lower)) {
      return 'TLS certificate is not valid. Configure TRAEFIK_CERT_RESOLVER or install a wildcard certificate.';
    }
    if (/503|service unavailable|no available server/.test(lower)) {
      return 'The proxy returned 503. Check that the runtime is on the coolify-proxy network and has valid Traefik labels.';
    }
    if (/econnrefused|econnreset|etimedout|timeout|fetch failed/.test(lower)) {
      return 'Connection refused or timed out. Check DNS, firewall and the proxy route.';
    }

    return message.length > 300 ? `${message.slice(0, 300)}...` : message;
  }

  private async waitForReady(containerId: string, urls: { internalUrl: string; backendUrl: string }, token: string) {
    const timeoutAt = Date.now() + 60000;
    let lastErrorMessage = '';
    let attempt = 0;

    while (Date.now() < timeoutAt) {
      attempt += 1;
      const state = await this.inspectContainerState(containerId);
      if (state && state.running === false) {
        const logs = await this.fetchContainerLogs(containerId);
        throw new Error(`libSQL container stopped unexpectedly with exit code ${state.exitCode ?? 'unknown'}${logs ? `: ${logs}` : ''}`);
      }

      const internalCheck = await this.checkConnection(urls.internalUrl, token);
      const backendCheck = await this.checkConnection(urls.backendUrl, token);

      if (internalCheck.ok || backendCheck.ok) {
        return {
          connectionUrl: internalCheck.ok ? urls.internalUrl : urls.backendUrl,
          routeHealth: {
            checkedAt: new Date().toISOString(),
            internalOk: internalCheck.ok,
            backendOk: backendCheck.ok,
            // The public route is checked after the import response. Waiting
            // for DNS/TLS here added up to 30 seconds to every import.
            publicOk: false,
            publicChecked: false,
          },
        };
      }

      lastErrorMessage = `internal (${urls.internalUrl}): ${internalCheck.error || 'failed'} | backend (${urls.backendUrl}): ${backendCheck.error || 'failed'}`;
      const delay = Math.min(500 * Math.pow(1.5, attempt), 3000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const state = await this.inspectContainerState(containerId);
    const logs = await this.fetchContainerLogs(containerId);
    const suffix = [lastErrorMessage, state ? `running=${state.running} exitCode=${state.exitCode ?? 'unknown'}` : '', logs ? `logs=${logs}` : '']
      .filter(Boolean)
      .join(' | ');

    throw new Error(`Timed out waiting for libSQL to accept connections${suffix ? `: ${suffix}` : ''}`);
  }

  private async waitForPublicConnection(
    publicUrl: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let lastResult: { ok: boolean; error?: string } = { ok: false, error: 'public check not started' };

    while (Date.now() < deadline) {
      lastResult = await this.checkPublicRoute(publicUrl);
      if (lastResult.ok) {
        return lastResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.warn(
      `[LibsqlRuntimeService] Public route did not become ready for ${publicUrl}: ` +
      `${lastResult.error || 'unknown error'}. ` +
      'Check DNS, the Traefik router/TLS certificate and TRAEFIK_CERT_RESOLVER.',
    );
    return lastResult;
  }

  /**
   * Checks DNS, TLS and the public Traefik route without executing SQL. This
   * keeps runtime health independent from Block Reads/Block Writes: a
   * protected database can still have a healthy public route even when
   * `SELECT 1` is rejected by the policy gateway.
   */
  private async checkPublicRoute(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!url) return { ok: false, error: 'Empty URL' };

    const base = url
      .replace(/^libsql:\/\//i, 'https://')
      .replace(/\/+$/, '');
    let lastError = '';

    for (const path of ['/health', '/version']) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${base}${path}`, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) return { ok: true };
        lastError = `HTTP ${response.status} from ${path}`;
      } catch (error: any) {
        lastError = error?.message || String(error);
      } finally {
        clearTimeout(timer);
      }
    }

    return { ok: false, error: lastError || 'public health endpoint did not respond' };
  }

  private async checkConnection(
    url: string,
    authToken: string,
    logFailure = true,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!url) return { ok: false, error: 'Empty URL' };
    try {
      const client = await import('@libsql/client').then(({ createClient }) => createClient({ url, authToken }));
      try {
        await client.execute('SELECT 1');
        return { ok: true };
      } finally {
        client.close();
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (logFailure) {
        console.warn(`[LibsqlRuntimeService] connection check failed for ${url}: ${errMsg}`);
      }
      return { ok: false, error: errMsg };
    }
  }

  getRuntimeErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown libSQL runtime error';
  }

  private async resolveBackendNetworkName(): Promise<string> {
    if (this.runtimeNetwork) {
      const network = await this.getNetworkByName(this.runtimeNetwork);
      if (!network) {
        throw new Error(
          `LIBSQL_RUNTIME_NETWORK="${this.runtimeNetwork}" does not exist in Docker. ` +
          'Create that network or unset LIBSQL_RUNTIME_NETWORK so it can be detected ' +
          'from the backend container.',
        );
      }

      const backendNetworks = await this.getBackendNetworkNames();
      const proxyNetworks = await this.getProxyNetworkNames();
      if (proxyNetworks && proxyNetworks.length > 0 && !proxyNetworks.includes(network.Name)) {
        throw new Error(
          `LIBSQL_RUNTIME_NETWORK="${network.Name}" is not shared with the proxy container ` +
          `"${this.proxyContainerName}" (proxy networks: ${proxyNetworks.join(', ')}). ` +
          'Public routing will not work. Set LIBSQL_RUNTIME_NETWORK to a network shared with the proxy ' +
          '(usually "coolify") or connect the proxy to that network.',
        );
      }

      if (backendNetworks === null) {
        console.warn(
          `[LibsqlRuntimeService] could not inspect backend container ` +
          `"${this.backendContainerId || '(unknown)'}"; assuming it shares Docker network ` +
          `"${network.Name}" because LIBSQL_RUNTIME_NETWORK is set explicitly.`,
        );
      } else if (!backendNetworks.includes(network.Name)) {
        await this.connectBackendToNetwork(network.Name);
      }

      console.log(
        `[LibsqlRuntimeService] using Docker network "${network.Name}" ` +
        '(from LIBSQL_RUNTIME_NETWORK) for libSQL runtimes',
      );
      return network.Name;
    }

    const networkNames = await this.getBackendNetworkNames();
    if (networkNames === null || networkNames.length === 0) {
      throw new Error(
        `Cannot determine a Docker network for the libSQL runtime: backend container ` +
        `"${this.backendContainerId || '(unknown)'}" could not be inspected or has no ` +
        'networks. Set LIBSQL_RUNTIME_NETWORK to the network shared with Traefik and the ' +
        'backend (for example "coolify"), or set LIBSQL_BACKEND_CONTAINER_ID to the ' +
        'backend container id.',
      );
    }

    const proxyNetworks = await this.getProxyNetworkNames();
    if (proxyNetworks && proxyNetworks.length > 0) {
      const sharedNetworks = networkNames.filter((name) => proxyNetworks.includes(name));
      if (sharedNetworks.length === 0) {
        throw new Error(
          `Backend container "${this.backendContainerId}" and proxy container ` +
          `"${this.proxyContainerName}" share no Docker network ` +
          `(backend: ${networkNames.join(', ')}; proxy: ${proxyNetworks.join(', ')}). ` +
          'The libSQL runtime would be unreachable publicly. Set LIBSQL_RUNTIME_NETWORK ' +
          'to a network shared with the proxy (usually "coolify") and restart the proxy.',
        );
      }

      const selected = sharedNetworks.includes('coolify')
        ? 'coolify'
        : sharedNetworks.find((name) => name !== 'bridge') || sharedNetworks[0];

      if (selected === 'bridge') {
        throw new Error(
          'Refusing to create the libSQL runtime on the default "bridge" network: ' +
          'container-name DNS and Traefik routing do not work there. Set ' +
          'LIBSQL_RUNTIME_NETWORK to the shared Docker network (for example "coolify").',
        );
      }

      console.log(
        `[LibsqlRuntimeService] using Docker network "${selected}" shared with proxy ` +
        `"${this.proxyContainerName}" for libSQL runtimes`,
      );
      return selected;
    }

    console.warn(
      `[LibsqlRuntimeService] proxy container "${this.proxyContainerName}" was not found; ` +
      'falling back to the backend network. Public routing may fail if the proxy is not ' +
      'attached to that network.',
    );

    const selected = networkNames.includes('coolify')
      ? 'coolify'
      : networkNames.find((name) => name !== 'bridge') || networkNames[0];

    if (selected === 'bridge') {
      throw new Error(
        'Refusing to create the libSQL runtime on the default "bridge" network: ' +
        'container-name DNS and Traefik routing do not work there, which causes ' +
        '"Internal: Fail" and "Public: Fail". Set LIBSQL_RUNTIME_NETWORK to the shared ' +
        'Docker network (for example "coolify"), or set it to "bridge" explicitly if ' +
        'that is really what you want.',
      );
    }

    console.log(
      `[LibsqlRuntimeService] using Docker network "${selected}" detected from ` +
      `backend container "${this.backendContainerId}" for libSQL runtimes`,
    );
    return selected;
  }

  private async getContainerNetworkNames(containerName: string): Promise<string[] | null> {
    if (!containerName) {
      return null;
    }

    try {
      const inspect = await this.requestJson(
        'GET',
        `/containers/${encodeURIComponent(containerName)}/json`,
      );
      const networks = inspect?.NetworkSettings?.Networks;
      return networks && typeof networks === 'object' ? Object.keys(networks) : [];
    } catch {
      return null;
    }
  }

  private async getBackendNetworkNames(): Promise<string[] | null> {
    return this.getContainerNetworkNames(this.backendContainerId);
  }

  private async getProxyNetworkNames(): Promise<string[] | null> {
    const networkNames = await this.getContainerNetworkNames(this.proxyContainerName);
    return networkNames && networkNames.length > 0 ? networkNames : null;
  }

  private async getNetworkByName(name: string): Promise<{ Name: string } | null> {
    try {
      const network = await this.requestJson('GET', `/networks/${encodeURIComponent(name)}`);
      return typeof network?.Name === 'string' ? { Name: network.Name } : null;
    } catch (error: any) {
      if (String(error?.message || '').includes('(404)')) {
        return null;
      }
      throw error;
    }
  }

  private async connectBackendToNetwork(networkName: string) {
    if (!this.backendContainerId) {
      throw new Error(
        `Cannot attach the backend container to Docker network "${networkName}" because ` +
        'LIBSQL_BACKEND_CONTAINER_ID, HOSTNAME and os.hostname() are all empty.',
      );
    }

    await this.requestJson(
      'POST',
      `/networks/${encodeURIComponent(networkName)}/connect`,
      { Container: this.backendContainerId },
    );
    console.log(
      `[LibsqlRuntimeService] connected backend container "${this.backendContainerId}" ` +
      `to Docker network "${networkName}"`,
    );
  }

  private async resolveHostPath(containerPath: string) {
    if (!this.backendContainerId) {
      return containerPath;
    }

    try {
      const inspect = await this.requestJson('GET', `/containers/${this.backendContainerId}/json`);
      const mounts = inspect?.Mounts || [];

      let bestMatch: any = null;
      for (const mount of mounts) {
        const destinationWithSlash = mount.Destination.endsWith('/') ? mount.Destination : `${mount.Destination}/`;
        if (containerPath === mount.Destination || containerPath.startsWith(destinationWithSlash)) {
          if (!bestMatch || mount.Destination.length > bestMatch.Destination.length) {
            bestMatch = mount;
          }
        }
      }

      if (bestMatch) {
        let relativePath = containerPath.substring(bestMatch.Destination.length);
        if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
          relativePath = relativePath.substring(1);
        }

        if (!relativePath) {
          return bestMatch.Source;
        }

        const separator = bestMatch.Source.includes('\\') ? '\\' : '/';
        const sourceWithSlash = bestMatch.Source.endsWith(separator) ? bestMatch.Source : `${bestMatch.Source}${separator}`;
        return `${sourceWithSlash}${relativePath.replace(/[\\/]/g, separator)}`;
      }
    } catch {
      // Ignored
    }

    return containerPath;
  }

  private async inspectContainerState(containerId: string) {
    try {
      const inspect = await this.requestJson('GET', `/containers/${containerId}/json`);
      return {
        running: Boolean(inspect?.State?.Running),
        exitCode: typeof inspect?.State?.ExitCode === 'number' ? inspect.State.ExitCode : undefined,
      };
    } catch {
      return null;
    }
  }

  async getContainerStats(containerId: string): Promise<{ memoryBytes: number }> {
    try {
      const stats = await this.requestJson('GET', `/containers/${containerId}/stats?stream=false`);
      return {
        memoryBytes: typeof stats?.memory_stats?.usage === 'number' ? stats.memory_stats.usage : 0,
      };
    } catch {
      return { memoryBytes: 0 };
    }
  }

  private async fetchContainerLogs(containerId: string) {
    try {
      const response = await this.request('GET', `/containers/${containerId}/logs?stdout=true&stderr=true&tail=80`);
      return response.body.trim();
    } catch {
      return '';
    }
  }

  private async cleanupPaths(paths: string[], ignoreMissing: boolean) {
    for (const filePath of paths) {
      try {
        await fs.promises.rm(filePath, { recursive: true, force: ignoreMissing });
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private async requestVoid(method: 'POST' | 'DELETE', requestPath: string) {
    await this.request(method, requestPath);
  }

  private async requestJson(method: 'GET' | 'POST' | 'DELETE', requestPath: string, body?: DockerJson) {
    const response = await this.request(method, requestPath, body);
    if (!response.body) {
      return {};
    }

    try {
      return JSON.parse(response.body);
    } catch {
      return { raw: response.body };
    }
  }

  private request(method: 'GET' | 'POST' | 'DELETE', requestPath: string, body?: DockerJson) {
    return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: requestPath,
          method,
          headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode || 0;
            if (statusCode >= 400) {
              reject(new Error(`Docker request failed (${statusCode}): ${bodyText || response.statusMessage || 'unknown error'}`));
              return;
            }

            resolve({ statusCode, body: bodyText });
          });
        },
      );

      request.on('error', reject);

      if (payload) {
        request.write(payload);
      }

      request.end();
    });
  }
}
