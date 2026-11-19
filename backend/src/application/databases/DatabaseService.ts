import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';
import { encrypt, decrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { AuditService } from '../audit/AuditService';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { assertValidSubdomainLabel, ensureSubdomain } from '../../infrastructure/security/slug';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';
import { LibsqlRuntimeService, RuntimeRouteHealth } from '../../infrastructure/docker/LibsqlRuntimeService';
import { LibsqlNamespaceService } from '../../infrastructure/libsql/LibsqlNamespaceService';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import { getPublicDatabaseSettings } from '../settings/PlatformSettingsService';
import { getMaxUploadBytes } from '../../config/uploads';
import { getRuntimeConnectionUrl, isRemoteDatabaseUrl, normalizeLegacyLocalDatabase, resolveEffectiveDatabaseType, shouldReconcileLegacyLocalDatabase } from './database-runtime';
import { runtimeIdentityMatches } from './runtime-health-guard';

type PrimaryMode = 'namespace' | 'runtime';
type RequestedPrimaryMode = PrimaryMode | 'auto';
type StorageMode = PrimaryMode | 'local';

// DatabaseService is instantiated in several places (HTTP controllers,
// background monitors, scripts). A module-level guard prevents two concurrent
// rotations from racing on the same primary regardless of instance.
const rotatingDatabaseIds = new Set<string>();

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export class NamespaceUnavailableError extends Error {
  statusCode = 503;
  code = 'SQLD_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'NamespaceUnavailableError';
  }
}

export class DatabaseService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();
  private storageService = new SqliteStorageService();
  private runtimeService = new LibsqlRuntimeService();
  private namespaceService = new LibsqlNamespaceService();

  async createDatabase(projectId: string, input: { name: string; type: 'sqlite' | 'libsql' | 'remote'; url?: string; token?: string; subdomain?: string; primaryMode?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    if (input.type === 'remote' && !input.url) {
      const error: any = new Error('Remote database registration requires a URL.');
      error.statusCode = 422;
      throw error;
    }
    const subdomain = input.subdomain ? assertValidSubdomainLabel(input.subdomain) : ensureSubdomain(input.name, randomToken());
    const isExternalPrimary = input.type === 'remote' || (input.type === 'libsql' && Boolean(input.url));
    let storageMode: StorageMode | null = null;

    if (!isExternalPrimary) {
      if (input.type === 'sqlite') {
        if (!this.isLocalFileAllowed()) {
          const error: any = new Error(
            'LOCAL-FILE creation is disabled by policy. Create a libSQL namespace or runtime instead.',
          );
          error.statusCode = 403;
          throw error;
        }
        storageMode = 'local';
      } else {
        storageMode = await this.resolvePrimaryMode(input.primaryMode);
        if (storageMode === 'local') {
          const error: any = new Error(
            'No libSQL primary is available. Configure the shared sqld namespace or enable the Docker runtime.',
          );
          error.statusCode = 503;
          throw error;
        }
      }
    }

    if (storageMode === 'namespace') {
      this.assertNamespaceHost(subdomain);
      const namespace = await this.namespaceService.createNamespace(subdomain);
      if (!namespace.ok) {
        throw new NamespaceUnavailableError(
          `No se pudo crear el namespace "${subdomain}" en sqld: ${namespace.error || 'error desconocido'}`,
        );
      }

      const token = input.token ?? this.namespaceService.generateToken(subdomain);
      const urls = this.namespaceService.buildNamespaceUrls(subdomain);
      await this.verifyNamespaceConnection(subdomain, token);

      const database = await this.databaseRepo.save(this.databaseRepo.create({
        name: input.name,
        type: 'libsql',
        status: 'active',
        subdomain,
        url: urls.connectionUrl,
        encryptedToken: encrypt(token),
        metadata: {
          ...(input.metadata ?? {}),
          runtime: {
            provider: 'sqld-namespace',
            namespace: subdomain,
            connectionUrl: urls.connectionUrl,
            internalUrl: urls.internalUrl,
            backendUrl: urls.backendUrl,
            publicUrl: urls.publicUrl,
            publicHost: urls.publicHost,
          },
        },
        project,
      }));

      await this.auditService.record({
        action: 'database.create',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { projectId, type: 'libsql', subdomain, runtime: 'sqld-namespace', primaryMode: 'namespace' },
      });

      return { database, token };
    }

    const willProvisionRuntime = storageMode === 'runtime';

    if (input.type === 'libsql' && !input.url && !willProvisionRuntime) {
      throw new NamespaceUnavailableError(
        'No se puede crear una base libSQL sin runtime ni URL. Configura los namespaces de sqld, habilita el socket Docker o proporciona una URL remota.',
      );
    }

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: input.type,
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: input.metadata,
      project,
    }));

    let managedPath: string | undefined;

    try {
      const token = input.token ?? randomToken();

      if (input.type === 'sqlite' || willProvisionRuntime) {
        const storageType = willProvisionRuntime ? 'libsql' : input.type;
        managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id, storageType);

        if (input.type === 'sqlite' && !willProvisionRuntime) {
          const initClient = new SqliteClient(managedPath);
          try {
            await initClient.run('PRAGMA journal_mode = WAL;');
          } finally {
            await initClient.close();
          }
        }
      }

      database.url = managedPath || input.url || undefined;
      database.status = database.type === 'remote' && !managedPath ? (input.url ? 'active' : 'inactive') : willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      const initialProvider = isExternalPrimary ? 'remote' : 'local-file';
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: initialProvider,
        databasePath: managedPath || null,
        connectionUrl: managedPath || null,
        internalUrl: managedPath || null,
        publicUrl: managedPath || null,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.create',
        resourceType: 'database',
        resourceId: database.id,
        metadata: {
          projectId,
          type: input.type,
          subdomain: input.subdomain,
          runtime: isExternalPrimary ? 'remote' : willProvisionRuntime ? 'docker-libsql' : 'local-file',
          storageMode: storageMode ?? (isExternalPrimary ? 'remote' : 'local'),
        },
      });

      if (willProvisionRuntime && managedPath) {
        const asyncProvisioning = this.isRuntimeProvisioningAsync()
          && !input.primaryMode
          && !this.isPrimaryRequired();

        if (asyncProvisioning) {
          this.attemptRuntimeProvisioning(database.id, managedPath, 'database.create', {
            projectId, type: input.type, subdomain: input.subdomain, primaryMode: 'runtime',
          }).catch((error) => {
            console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
          });
        } else {
          const provisioned = await this.attemptRuntimeProvisioning(database.id, managedPath, 'database.create', {
            projectId, type: input.type, subdomain: input.subdomain, primaryMode: 'runtime',
          }, false);
          if (!provisioned) {
            throw await this.buildProvisioningFailure(database.id);
          }
          return { database: provisioned.database, token: provisioned.token };
        }
      }

      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : []);
      throw error;
    }
  }

  async importExistingSqlite(projectId: string, input: { name?: string; sourceName?: string; sourcePath: string; subdomain?: string; token?: string; storageMode?: string; sourceIsUpload?: boolean; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    if (!fs.existsSync(input.sourcePath)) {
      throw new Error('sourcePath does not exist');
    }
    const databaseName = deriveDatabaseName(input.name, input.sourceName, input.sourcePath);
    const subdomain = input.subdomain ? assertValidSubdomainLabel(input.subdomain) : ensureSubdomain(databaseName, randomToken());
    const storageMode = await this.resolveImportStorageMode(input.storageMode);
    const importStartedAt = Date.now();
    const sourceSize = (() => {
      try {
        return fs.statSync(input.sourcePath).size;
      } catch {
        return 0;
      }
    })();

    if (storageMode === 'namespace') {
      this.assertNamespaceHost(subdomain);
      const copyStartedAt = Date.now();
      try {
        await this.storageService.importToNamespace(input.sourcePath, subdomain, {
          consistentSnapshot: !input.sourceIsUpload,
          moveSource: Boolean(input.sourceIsUpload),
        });
      } catch (error: any) {
        throw new Error(`No se pudo copiar la base al namespace "${subdomain}": ${error?.message || error}`);
      }
      const namespaceCopyMs = Date.now() - copyStartedAt;

      const namespace = await this.namespaceService.createNamespace(subdomain);
      if (!namespace.ok) {
        throw new NamespaceUnavailableError(
          `No se pudo crear el namespace "${subdomain}" en sqld: ${namespace.error || 'error desconocido'}`,
        );
      }

      const token = input.token ?? this.namespaceService.generateToken(subdomain);
      const urls = this.namespaceService.buildNamespaceUrls(subdomain);
      await this.verifyNamespaceConnection(subdomain, token);

      const database = await this.databaseRepo.save(this.databaseRepo.create({
        name: databaseName,
        type: 'libsql',
        status: 'active',
        subdomain,
        url: urls.connectionUrl,
        encryptedToken: encrypt(token),
        metadata: {
          ...(input.metadata ?? {}),
          imported: true,
          sourceName: input.sourceName,
          sourcePath: input.sourceIsUpload ? null : input.sourcePath,
          runtime: {
            provider: 'sqld-namespace',
            namespace: subdomain,
            connectionUrl: urls.connectionUrl,
            internalUrl: urls.internalUrl,
            backendUrl: urls.backendUrl,
            publicUrl: urls.publicUrl,
            publicHost: urls.publicHost,
          },
        },
        project,
      }));

      await this.auditService.record({
        action: 'database.import',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { projectId, sourcePath: input.sourceIsUpload ? input.sourceName : input.sourcePath, subdomain, runtime: 'sqld-namespace', storageMode: 'namespace' },
      });

      console.log(
        `[DatabaseService] imported ${database.id} (${sourceSize} bytes) as namespace in ` +
        `${Date.now() - importStartedAt}ms (copy ${namespaceCopyMs}ms)`,
      );
      return { database, token };
    }

    const willProvisionRuntime = storageMode === 'runtime';
    const storageType = willProvisionRuntime ? 'libsql' : 'sqlite';

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: databaseName,
      type: 'sqlite',
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: { ...(input.metadata ?? {}), imported: true, sourceName: input.sourceName, sourcePath: input.sourceIsUpload ? null : input.sourcePath },
      project,
    }));

    let managedPath = '';
    let copyMs = 0;

    try {
      const copyStartedAt = Date.now();
      managedPath = await this.storageService.importDatabaseFile(
        input.sourcePath,
        project.id,
        database.id,
        storageType,
        {
          consistentSnapshot: !input.sourceIsUpload,
          moveSource: Boolean(input.sourceIsUpload),
        },
      );
      copyMs = Date.now() - copyStartedAt;

      const token = input.token ?? randomToken();

      database.url = managedPath;
      database.status = willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: managedPath,
        connectionUrl: managedPath,
        internalUrl: managedPath,
        publicUrl: managedPath,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.import',
        resourceType: 'database',
        resourceId: database.id,
        metadata: {
          projectId,
          sourcePath: input.sourceIsUpload ? input.sourceName : input.sourcePath,
          subdomain: input.subdomain,
          runtime: willProvisionRuntime ? 'docker-libsql' : 'local-file',
          storageMode,
        },
      });

      if (willProvisionRuntime) {
        // Import requests must return the real runtime JWT. Provisioning in the
        // background would return a token that is immediately invalid.
        const provisionStartedAt = Date.now();
        const provisioned = await this.attemptRuntimeProvisioning(database.id, managedPath, 'database.import', {
          projectId,
          sourcePath: input.sourceIsUpload ? input.sourceName : input.sourcePath,
          subdomain: input.subdomain,
          primaryMode: 'runtime',
        }, false);
        if (!provisioned) {
          throw await this.buildProvisioningFailure(database.id);
        }
        console.log(
          `[DatabaseService] imported ${database.id} (${sourceSize} bytes) as runtime in ` +
          `${Date.now() - importStartedAt}ms (copy ${copyMs}ms, primary ${Date.now() - provisionStartedAt}ms)`,
        );
        return { database: provisioned.database, token: provisioned.token };
      }

      console.log(
        `[DatabaseService] imported ${database.id} (${sourceSize} bytes) as ${storageMode} in ` +
        `${Date.now() - importStartedAt}ms (copy ${copyMs}ms)`,
      );
      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : []);
      throw error;
    }
  }

  async listDatabases(projectId?: string) {
    if (!projectId) return this.databaseRepo.find({ relations: ['project', 'project.owner'] });
    return this.databaseRepo.find({ where: { project: { id: projectId } }, relations: ['project', 'project.owner'] });
  }

  async getDatabase(id: string) {
    return this.databaseRepo.findOne({ where: { id }, relations: ['project', 'project.owner'] });
  }

  async revealToken(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) {
      const error: any = new Error('database not found');
      error.statusCode = 404;
      throw error;
    }

    if (!database.encryptedToken) {
      const error: any = new Error('database has no token');
      error.statusCode = 409;
      throw error;
    }

    let token: string;
    try {
      token = decrypt(database.encryptedToken);
    } catch (error: any) {
      const wrapped: any = new Error(`Failed to decrypt database token: ${error?.message || error}. Check MASTER_KEY.`);
      wrapped.statusCode = 500;
      throw wrapped;
    }

    await this.auditService.record({
      action: 'database.reveal_token',
      resourceType: 'database',
      resourceId: database.id,
      metadata: { projectId: database.project?.id },
    });

    return { database, token };
  }

  async convertNamespaceDatabaseToLocal(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) {
      const error: any = new Error('database not found');
      error.statusCode = 404;
      throw error;
    }

    const runtime = database.metadata?.runtime as { provider?: unknown } | undefined;
    if (runtime?.provider !== 'sqld-namespace' || !database.subdomain) {
      const error: any = new Error('database is not a sqld namespace database');
      error.statusCode = 409;
      throw error;
    }

    const sourcePath = this.storageService.namespaceDatabasePath(database.subdomain);
    if (!fs.existsSync(sourcePath)) {
      const error: any = new Error(`namespace database file not found at ${sourcePath}`);
      error.statusCode = 404;
      throw error;
    }

    const targetPath = await this.storageService.importDatabaseFile(sourcePath, database.project.id, database.id, 'sqlite');

    database.type = 'sqlite';
    database.status = 'active';
    database.url = targetPath;
    database.metadata = {
      ...mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: targetPath,
        connectionUrl: targetPath,
        internalUrl: targetPath,
        publicUrl: targetPath,
      }),
      convertedFromNamespace: database.subdomain,
    };
    await this.databaseRepo.save(database);
    ConnectionPool.getInstance().evict(database.id);

    await this.auditService.record({
      action: 'database.convert_to_local',
      resourceType: 'database',
      resourceId: database.id,
      metadata: { projectId: database.project.id, namespace: database.subdomain, targetPath },
    });

    return database;
  }

  async convertLocalDatabaseToRuntime(id: string, input: { subdomain?: string } = {}) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) {
      const error: any = new Error('database not found');
      error.statusCode = 404;
      throw error;
    }

    if (!this.runtimeService.isEnabled()) {
      const error: any = new Error('Docker socket is not available; cannot provision a libSQL runtime');
      error.statusCode = 503;
      throw error;
    }

    this.assertPrimaryPublicDomain();

    if (resolveEffectiveDatabaseType(database) !== 'sqlite') {
      const error: any = new Error('Only LOCAL-FILE SQLite databases can be converted to a libSQL runtime');
      error.statusCode = 409;
      throw error;
    }

    const sourcePath = (database.url && fs.existsSync(database.url))
      ? database.url
      : this.storageService.managedDatabasePath(database.project.id, database.id, 'sqlite');

    if (!fs.existsSync(sourcePath)) {
      const error: any = new Error(`local SQLite file not found at ${sourcePath}`);
      error.statusCode = 404;
      throw error;
    }

    const subdomain = input.subdomain
      ? assertValidSubdomainLabel(input.subdomain)
      : database.subdomain || ensureSubdomain(database.name, randomToken());

    const existing = await this.databaseRepo.findOne({ where: { subdomain } });
    if (existing && existing.id !== database.id) {
      const error: any = new Error(`subdomain "${subdomain}" is already in use`);
      error.statusCode = 409;
      throw error;
    }

    const targetPath = await this.storageService.importDatabaseFile(sourcePath, database.project.id, database.id, 'libsql');

    database.subdomain = subdomain;

    try {
      const runtime = await this.runtimeService.provisionDatabase(database, targetPath);

      database.type = 'libsql';
      database.status = 'active';
      database.url = targetPath;
      database.encryptedToken = encrypt(runtime.token);
      database.metadata = {
        ...mergeRuntimeMetadata(database.metadata, runtime.metadata),
        convertedFromLocal: true,
        convertedAt: new Date().toISOString(),
        previousLocalPath: sourcePath,
      };
      await this.databaseRepo.save(database);
      ConnectionPool.getInstance().evict(database.id);

      await this.auditService.record({
        action: 'database.convert_to_runtime',
        resourceType: 'database',
        resourceId: database.id,
        metadata: {
          projectId: database.project.id,
          subdomain,
          sourcePath,
          targetPath,
          runtime: 'docker-libsql',
        },
      });

      return { database, token: runtime.token };
    } catch (error) {
      // The original local database record and file are left untouched.
      throw error;
    }
  }
  /**
   * Publica una base LOCAL-FILE en el sqld compartido usando un namespace.
   *
   * Es el equivalente a `convertLocalDatabaseToRuntime`, pero sin Docker:
   * copia el archivo con VACUUM INTO al path del namespace, registra el
   * namespace en el admin de sqld y entrega un JWT con scope `ns`.
   *
   * La base local original NO se borra. La ruta original queda en
   * `previousLocalPath` para rollback/auditoría.
   */
  async convertLocalDatabaseToNamespace(id: string, input: { subdomain?: string } = {}) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) {
      const error: any = new Error('database not found');
      error.statusCode = 404;
      throw error;
    }

    if (!this.namespaceService.isEnabled()) {
      const error: any = new Error(
        'sqld namespaces are not configured. Set LIBSQL_ADMIN_URL or LIBSQL_ENABLE_NAMESPACES=true.',
      );
      error.statusCode = 503;
      throw error;
    }

    if (!(await this.namespaceService.isAvailable())) {
      throw new NamespaceUnavailableError(
        'sqld is not available. Verify that the sqld container is running and reachable through LIBSQL_ADMIN_URL.',
      );
    }

    if (!this.namespaceService.isPublicEnabled()) {
      throw new NamespaceUnavailableError(
        'Shared namespace public routing is not enabled. Configure wildcard TLS and set ' +
        'LIBSQL_NAMESPACE_PUBLIC_ENABLED=true (or LIBSQL_NAMESPACE_HOST for a single host).',
      );
    }

    this.assertPrimaryPublicDomain();

    if (resolveEffectiveDatabaseType(database) !== 'sqlite' || database.type === 'remote' || isRemoteDatabaseUrl(database.url)) {
      const error: any = new Error('Only LOCAL-FILE SQLite databases can be converted to a sqld namespace');
      error.statusCode = 409;
      throw error;
    }

    const sourcePath = (database.url && fs.existsSync(database.url))
      ? database.url
      : this.storageService.managedDatabasePath(database.project.id, database.id, 'sqlite');

    if (!fs.existsSync(sourcePath)) {
      const error: any = new Error(`local SQLite file not found at ${sourcePath}`);
      error.statusCode = 404;
      throw error;
    }

    const subdomain = input.subdomain
      ? assertValidSubdomainLabel(input.subdomain)
      : database.subdomain || ensureSubdomain(database.name, randomToken());

    const existing = await this.databaseRepo.findOne({ where: { subdomain } });
    if (existing && existing.id !== database.id) {
      const error: any = new Error(`subdomain "${subdomain}" is already in use`);
      error.statusCode = 409;
      throw error;
    }

    // Never overwrite an existing namespace file. If a previous attempt left
    // an orphan, the operator must choose another subdomain or clean it up
    // manually; silently replacing it could destroy data.
    const namespacePath = this.storageService.namespaceDatabasePath(subdomain);
    if (fs.existsSync(namespacePath)) {
      const error: any = new Error(
        `a sqld namespace file already exists for "${subdomain}" at ${namespacePath}. ` +
        'Choose another subdomain or remove the orphan before converting.',
      );
      error.statusCode = 409;
      throw error;
    }

    // importToNamespace uses VACUUM INTO, so committed WAL contents are
    // included even while the old local client is still open.
    await this.storageService.importToNamespace(sourcePath, subdomain);

    const namespace = await this.namespaceService.createNamespace(subdomain);
    if (!namespace.ok) {
      // The local source is untouched. The imported copy is intentionally left
      // for inspection; deleting it here could race with an existing namespace.
      console.error(
        `[DatabaseService] Namespace "${subdomain}" was imported but could not be registered in sqld. ` +
        `Source remains at ${sourcePath}; imported path: ${namespacePath}.`,
        namespace.error,
      );
      throw new NamespaceUnavailableError(
        `No se pudo crear el namespace "${subdomain}" en sqld: ${namespace.error || 'error desconocido'}`,
      );
    }

    const token = this.namespaceService.generateToken(subdomain);
    const urls = this.namespaceService.buildNamespaceUrls(subdomain);

    try {
      await this.verifyNamespaceConnection(subdomain, token);
    } catch (error) {
      console.error(
        `[DatabaseService] Namespace "${subdomain}" was created but failed verification. ` +
        `Source remains at ${sourcePath}; imported path: ${namespacePath}.`,
        error,
      );
      throw error;
    }

    database.subdomain = subdomain;
    database.type = 'libsql';
    database.status = 'active';
    database.url = urls.connectionUrl;
    database.encryptedToken = encrypt(token);
    database.metadata = {
      ...mergeRuntimeMetadata(database.metadata, {
        provider: 'sqld-namespace',
        namespace: subdomain,
        connectionUrl: urls.connectionUrl,
        internalUrl: urls.internalUrl,
        backendUrl: urls.backendUrl,
        publicUrl: urls.publicUrl,
        publicHost: urls.publicHost,
      }),
      convertedFromLocal: true,
      convertedAt: new Date().toISOString(),
      previousLocalPath: sourcePath,
    };
    await this.databaseRepo.save(database);
    ConnectionPool.getInstance().evict(database.id);

    await this.auditService.record({
      action: 'database.convert_to_namespace',
      resourceType: 'database',
      resourceId: database.id,
      metadata: {
        projectId: database.project.id,
        subdomain,
        sourcePath,
        namespacePath,
        runtime: 'sqld-namespace',
      },
    });

    return { database, token };
  }

  /**
   * Publica una base LOCAL-FILE en el primario libSQL configurado.
   *
   * LIBSQL_CONVERSION_MODE=namespace usa sqld compartido; runtime usa un
   * contenedor dedicado; auto prefiere namespace cuando está disponible.
   * El valor por defecto es runtime para no cambiar instalaciones existentes.
   */
  async convertLocalDatabaseToPublic(id: string, input: { subdomain?: string } = {}) {
    const mode = String(
      process.env.LIBSQL_CONVERSION_MODE || process.env.LIBSQL_PRIMARY_MODE || 'auto',
    ).trim().toLowerCase();

    if (mode === 'namespace' || mode === 'sqld' || mode === 'path') {
      return this.convertLocalDatabaseToNamespace(id, input);
    }

    if (mode === 'auto') {
      if (
        this.namespaceService.isEnabled()
        && this.namespaceService.isPublicEnabled()
        && await this.namespaceService.isAvailable()
      ) {
        return this.convertLocalDatabaseToNamespace(id, input);
      }
      return this.convertLocalDatabaseToRuntime(id, input);
    }

    if (mode === 'runtime' || mode === 'docker') {
      return this.convertLocalDatabaseToRuntime(id, input);
    }

    const error: any = new Error(
      `Invalid LIBSQL_CONVERSION_MODE "${mode}". Use namespace, runtime or auto.`,
    );
    error.statusCode = 500;
    throw error;
  }

  async reconcileLegacyDatabases() {
    const databases = await this.databaseRepo.find();
    let reconciled = 0;

    for (const database of databases) {
      if (!shouldReconcileLegacyLocalDatabase(database)) {
        continue;
      }

      const normalized = normalizeLegacyLocalDatabase(database);
      database.type = normalized.type;
      database.status = normalized.status as any;
      database.metadata = normalized.metadata;
      await this.databaseRepo.save(database);
      reconciled += 1;
    }

    return { reconciled };
  }

  async rotateToken(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    if (database.status === 'provisioning') {
      throw new Error('Cannot rotate token while database is provisioning');
    }

    ConnectionPool.getInstance().evict(id);

    if (this.isManagedRuntimeEntry(database)) {
      const runtime = database.metadata?.runtime as any;
      if (runtime?.provider === 'sqld-namespace' && database.subdomain) {
        const newToken = this.namespaceService.generateToken(database.subdomain);
        database.encryptedToken = encrypt(newToken);
        await this.databaseRepo.save(database);
        await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
        return { database, token: newToken };
      }

      if (rotatingDatabaseIds.has(id)) {
        const error: any = new Error('A token rotation is already in progress for this database.');
        error.statusCode = 409;
        throw error;
      }

      rotatingDatabaseIds.add(id);
      try {
        let persisted = false;
        let persistedDatabase: Database | null = null;
        const runtimeBundle = await this.runtimeService.rotateDatabase(database, {
          persist: async (bundle) => {
            // Re-read before saving so a concurrent rename/subdomain change is
            // preserved. Only the credential and runtime metadata belong to
            // this rotation.
            const fresh = await this.databaseRepo.findOne({ where: { id } });
            if (!fresh) {
              throw new Error('database record disappeared during token rotation');
            }
            fresh.encryptedToken = encrypt(bundle.token);
            fresh.metadata = mergeRuntimeMetadata(fresh.metadata, bundle.metadata);
            try {
              await this.databaseRepo.save(fresh);
            } catch (error) {
              // A local write can succeed while the driver still reports an
              // error. Never delete the replacement if the row already points
              // at it: that would leave the panel with an unusable runtime.
              const check = await this.databaseRepo.findOne({ where: { id } }).catch(() => null);
              const persistedRuntime = check?.metadata?.runtime as
                | { containerId?: unknown }
                | undefined;
              if (check && persistedRuntime?.containerId === bundle.metadata.containerId) {
                persistedDatabase = check;
                persisted = true;
                return;
              }
              throw error;
            }
            persistedDatabase = fresh;
            persisted = true;
          },
        });

        if (!runtimeBundle) {
          throw new Error('database runtime is missing');
        }

        if (!persisted) {
          // Defensive path for callers that rotate without the persist hook.
          // The runtime has already been replaced, so the credential must be
          // saved before reporting success.
          const fresh = await this.databaseRepo.findOne({ where: { id } });
          const target = fresh ?? database;
          target.encryptedToken = encrypt(runtimeBundle.token);
          target.metadata = mergeRuntimeMetadata(target.metadata, runtimeBundle.metadata);
          await this.databaseRepo.save(target);
          persistedDatabase = target;
        }

        // A successful rotation must not be reported as failed only because
        // the audit insert failed: the new credential is already active.
        try {
          await this.auditService.record({
            action: 'database.rotate-token',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { runtime: 'docker-libsql' },
          });
        } catch (auditError: any) {
          console.warn(
            `[DatabaseService] token rotated for ${database.id} but audit logging failed: ` +
            `${auditError?.message || auditError}`,
          );
        }

        if (runtimeBundle.metadata.routeHealth?.publicChecked === false) {
          this.scheduleRuntimeHealthRefresh(database.id);
        }
        return { database: persistedDatabase ?? database, token: runtimeBundle.token };
      } finally {
        rotatingDatabaseIds.delete(id);
      }
    }

    const newToken = randomToken();
    database.encryptedToken = encrypt(newToken);
    await this.databaseRepo.save(database);
    await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
    return { database, token: newToken };
  }

  /**
   * Repairs rotations interrupted by a backend crash or redeploy. Runs before
   * the HTTP listener starts so a stopped primary is brought back before it is
   * reported unhealthy or receives traffic.
   */
  async recoverInterruptedRotations() {
    if (!this.runtimeService.isEnabled()) {
      return { restored: 0, finalized: 0, failed: 0 };
    }

    const databases = await this.databaseRepo.find();
    let restored = 0;
    let finalized = 0;
    let failed = 0;

    for (const database of databases) {
      const runtime = database.metadata?.runtime as Record<string, unknown> | undefined;
      if (runtime?.provider !== 'docker-libsql') continue;

      let token: string | undefined;
      if (database.encryptedToken) {
        try {
          token = decrypt(database.encryptedToken);
        } catch (error: any) {
          console.warn(
            `[DatabaseService] cannot decrypt token for ${database.id}; ` +
            `rotation recovery will not validate authentication: ${error?.message || error}`,
          );
        }
      }

      try {
        const result = await this.runtimeService.recoverInterruptedRotation(database, token);
        if (result === 'restored') {
          restored += 1;
          console.warn(
            `[DatabaseService] recovered interrupted token rotation for ${database.name} (${database.id})`,
          );
        } else if (result === 'finalized') {
          finalized += 1;
        } else if (result === 'failed') {
          failed += 1;
        }
      } catch (error: any) {
        failed += 1;
        console.warn(
          `[DatabaseService] rotation recovery failed for ${database.name} (${database.id}): ` +
          `${error?.message || error}`,
        );
      }
    }

    return { restored, finalized, failed };
  }

  async testConnection(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    if (database.status === 'provisioning') {
      return { ok: false, details: 'Database is still provisioning. Please wait a moment and try again.' };
    }

    if (database.status === 'error') {
      const errorMsg = (database.metadata as any)?.runtimeError || 'Database runtime is in an error state.';
      return { ok: false, details: `Database runtime error: ${errorMsg}` };
    }

    const runtimeUrl = getManagedRuntimeUrl(database);

    if (runtimeUrl && database.encryptedToken) {
      const token = decrypt(database.encryptedToken);
      const libClient = createLibsqlClient(runtimeUrl, token);
      try {
        await libClient.execute('SELECT 1');
        return { ok: true, details: 'connection ok' };
      } catch (error: any) {
        return { ok: false, details: error.message };
      } finally {
        libClient.close();
      }
    }

    if (resolveEffectiveDatabaseType(database) === 'sqlite') {
      const managedPath = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
      const url = (database.url && fs.existsSync(database.url)) ? database.url : managedPath;
      if (!fs.existsSync(url)) {
        return { ok: false, details: 'sqlite file missing', code: 'SQLITE_CANTOPEN' };
      }

      let client: SqliteClient;
      try {
        client = new SqliteClient(url);
      } catch (error: any) {
        return { ok: false, details: error.message || 'failed to open database', code: error.code || 'SQLITE_CANTOPEN' };
      }

      try {
        const integrity = await client.checkIntegrity();
        if (!integrity.ok) {
          return { ok: false, details: `Integrity check failed: ${integrity.details}`, code: 'SQLITE_CORRUPT' };
        }
        return { ok: true, details: 'sqlite connection ok - integrity check passed' };
      } catch (error: any) {
        return { ok: false, details: error.message || 'failed to verify database', code: error.code || 'SQLITE_ERROR' };
      } finally {
        client.close();
      }
    }

    if (!database.url || !database.encryptedToken) return { ok: false, details: 'missing url or token' };
    const token = decrypt(database.encryptedToken);
    const libClient = createLibsqlClient(database.url, token);
    try {
      await libClient.execute('SELECT 1');
      return { ok: true, details: 'connection ok' };
    } catch (error: any) {
      return { ok: false, details: error.message };
    } finally {
      libClient.close();
    }
  }

  async deleteDatabase(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    ConnectionPool.getInstance().evict(id);

    const runtime = database.metadata?.runtime as any;
    if (runtime?.provider === 'sqld-namespace' && database.subdomain) {
      await this.namespaceService.deleteNamespace(database.subdomain);
      const nsPath = this.storageService.namespaceDatabasePath(database.subdomain);
      await fs.promises.rm(path.dirname(nsPath), { recursive: true, force: true }).catch(() => undefined);
    } else {
      await this.runtimeService.removeDatabase(database);
    }

    if (database.project?.id) {
      await fs.promises.rm(
        this.storageService.snapshotDirectory(database.project.id, database.id),
        { recursive: true, force: true },
      ).catch(() => undefined);
    }

    // Explicit physical file cleanup for SQLite files, WAL and SHM
    if (resolveEffectiveDatabaseType(database) === 'sqlite') {
      const candidates = new Set<string>();
      if (database.url) {
        candidates.add(database.url);
        candidates.add(`${database.url}-wal`);
        candidates.add(`${database.url}-shm`);
      }
      if (database.project?.id) {
        const managed = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
        candidates.add(managed);
        candidates.add(`${managed}-wal`);
        candidates.add(`${managed}-shm`);
      }
      for (const filePath of candidates) {
        await fs.promises.rm(filePath, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    await this.databaseRepo.remove(database);

    await this.auditService.record({
      action: 'database.delete',
      resourceType: 'database',
      resourceId: id,
      metadata: { name: database.name, type: database.type },
    });

    return { ok: true };
  }

  async updateDatabase(id: string, input: { name?: string; status?: string }) {
    const database = await this.databaseRepo.findOneByOrFail({ id });
    if (input.name) database.name = input.name;
    if (input.status) database.status = input.status as any;
    await this.databaseRepo.save(database);
    await this.auditService.record({
      action: 'database.update',
      resourceType: 'database',
      resourceId: id,
      metadata: input,
    });
    return database;
  }

  async backupDatabase(sourceId: string, input: { name: string }) {
    const sourceDatabase = await this.databaseRepo.findOne({ where: { id: sourceId }, relations: ['project'] });
    if (!sourceDatabase) throw new Error('source database not found');

    const project = sourceDatabase.project;

    // Namespace databases keep their SQLite file at the sqld data path, not
    // at database.url (which is an HTTP endpoint).
    const sourcePath = await this.getDatabaseFilePath(sourceId);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('source database file not found on disk');
    }

    const subdomain = ensureSubdomain(input.name, randomToken());
    const willProvisionRuntime = this.runtimeService.isEnabled();
    const storageType = willProvisionRuntime ? 'libsql' : sourceDatabase.type as 'sqlite' | 'libsql' | 'remote';

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: sourceDatabase.type as 'sqlite' | 'libsql' | 'remote',
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: {
        backup: true,
        sourceId: sourceDatabase.id,
        sourceName: sourceDatabase.name,
        backupTimestamp: new Date().toISOString(),
      },
      project,
    }));

    const managedPath = await this.storageService.importDatabaseFile(sourcePath, project.id, database.id, storageType);

    try {
      const token = randomToken();
      database.url = managedPath;
      database.status = willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: managedPath,
        connectionUrl: managedPath,
        internalUrl: managedPath,
        publicUrl: managedPath,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.backup',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id, runtime: 'local-file' },
      });

      if (willProvisionRuntime) {
        this.attemptRuntimeProvisioning(database.id, managedPath, 'database.backup', {
          sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id,
        }).catch((error) => {
          console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
        });
      }

      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, [managedPath]);
      throw error;
    }
  }

  async getDatabaseFilePath(id: string): Promise<string> {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    const runtime = database.metadata?.runtime as { provider?: unknown } | undefined;
    if (runtime?.provider === 'sqld-namespace' && database.subdomain) {
      const namespacePath = this.storageService.namespaceDatabasePath(database.subdomain);
      if (fs.existsSync(namespacePath)) {
        return namespacePath;
      }
    }

    const managedPath = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
    return (database.url && fs.existsSync(database.url)) ? database.url : managedPath;
  }

  private isPrimaryRequired(): boolean {
    return parseEnvBoolean(process.env.LIBSQL_REQUIRE_PRIMARY, false);
  }

  private isLocalFileAllowed(): boolean {
    return parseEnvBoolean(process.env.LIBSQL_ALLOW_LOCAL_FILE, !this.isPrimaryRequired());
  }

  private getRequestedPrimaryMode(requested?: string): RequestedPrimaryMode {
    const raw = String(requested || process.env.LIBSQL_PRIMARY_MODE || 'auto').trim().toLowerCase();
    if (raw === 'namespace' || raw === 'runtime' || raw === 'auto') {
      return raw;
    }

    const error: any = new Error(
      `Invalid primary mode "${raw}". Use auto, namespace or runtime.`,
    );
    error.statusCode = 500;
    throw error;
  }

  private hasPrimaryPublicDomain(): boolean {
    const settings = getPublicDatabaseSettings();
    return Boolean(settings.domain && settings.domain !== 'localhost');
  }

  private assertPrimaryPublicDomain() {
    if (!this.isPrimaryRequired() || this.hasPrimaryPublicDomain()) {
      return;
    }

    const error: any = new Error(
      'Public wildcard domain is not configured. Set the Wildcard domain in Settings ' +
      'or DATABASE_PUBLIC_DOMAIN before creating a public libSQL primary.',
    );
    error.statusCode = 503;
    throw error;
  }

  private assertRuntimePrimaryReady() {
    if (!this.runtimeService.isEnabled()) {
      const error: any = new Error(
        'Dedicated libSQL runtime is not available: Docker socket not found. ' +
        'Enable the Docker socket or configure the shared sqld namespace.',
      );
      error.statusCode = 503;
      throw error;
    }

    this.assertPrimaryPublicDomain();
  }

  private async assertNamespacePrimaryReady() {
    if (!this.namespaceService.isEnabled()) {
      throw new NamespaceUnavailableError(
        'Shared sqld namespaces are not configured. Set LIBSQL_ADMIN_URL or LIBSQL_ENABLE_NAMESPACES=true.',
      );
    }

    if (!(await this.namespaceService.isAvailable())) {
      throw new NamespaceUnavailableError(
        'sqld is not available. Verify that the sqld container is running and reachable through LIBSQL_ADMIN_URL.',
      );
    }

    if (!this.namespaceService.isPublicEnabled()) {
      throw new NamespaceUnavailableError(
        'Shared namespace public routing is not enabled. Configure wildcard TLS and set ' +
        'LIBSQL_NAMESPACE_PUBLIC_ENABLED=true (or LIBSQL_NAMESPACE_HOST for a single host).',
      );
    }

    this.assertPrimaryPublicDomain();
  }

  private assertNamespaceHost(subdomain: string) {
    if (this.namespaceService.isWildcardPublicEnabled()) {
      return;
    }

    const exactHost = this.namespaceService.getExactPublicHost();
    const expectedLabel = exactHost?.split('.')[0]?.trim().toLowerCase();
    if (!exactHost || !expectedLabel || subdomain.toLowerCase() === expectedLabel) {
      return;
    }

    const error: any = new Error(
      `Only the configured namespace host "${exactHost}" is publicly routed. ` +
      `Use subdomain "${expectedLabel}" or enable wildcard namespace routing.`,
    );
    error.statusCode = 422;
    throw error;
  }

  private async resolvePrimaryMode(requested?: string): Promise<StorageMode> {
    const mode = this.getRequestedPrimaryMode(requested);

    if (mode === 'namespace') {
      await this.assertNamespacePrimaryReady();
      return 'namespace';
    }

    if (mode === 'runtime') {
      this.assertRuntimePrimaryReady();
      return 'runtime';
    }

    if (
      this.namespaceService.isEnabled()
      && this.namespaceService.isPublicEnabled()
      && await this.namespaceService.isAvailable()
    ) {
      await this.assertNamespacePrimaryReady();
      return 'namespace';
    }

    if (this.runtimeService.isEnabled()) {
      this.assertRuntimePrimaryReady();
      return 'runtime';
    }

    if (this.isLocalFileAllowed()) {
      return 'local';
    }

    const error: any = new Error(
      'No libSQL primary is available. Configure the shared sqld namespace or enable the Docker runtime. ' +
      'LOCAL-FILE creation is disabled by policy.',
    );
    error.statusCode = 503;
    throw error;
  }

  private async resolveImportStorageMode(requested?: string): Promise<StorageMode> {
    const raw = String(requested || 'auto').trim().toLowerCase();

    if (raw === 'local') {
      if (!this.isLocalFileAllowed()) {
        const error: any = new Error(
          'LOCAL-FILE imports are disabled by policy. Choose a libSQL namespace or runtime.',
        );
        error.statusCode = 403;
        throw error;
      }
      return 'local';
    }

    if (raw === 'namespace') {
      await this.assertNamespacePrimaryReady();
      return 'namespace';
    }

    if (raw === 'runtime') {
      this.assertRuntimePrimaryReady();
      return 'runtime';
    }

    if (raw !== 'auto') {
      const error: any = new Error(`Invalid storage mode "${raw}". Use auto, namespace, runtime or local.`);
      error.statusCode = 422;
      throw error;
    }

    if (this.isPrimaryRequired()) {
      return this.resolvePrimaryMode('auto');
    }

    // Legacy auto behavior, preserved for installations that have not enabled
    // the libSQL-first policy yet.
    if (await this.shouldUseNamespaceForImport()) {
      return 'namespace';
    }
    if (this.shouldProvisionRuntimeForImport()) {
      return 'runtime';
    }
    if (this.isLocalFileAllowed()) {
      return 'local';
    }

    const error: any = new Error(
      'No import target is available. Configure sqld namespaces or the Docker runtime.',
    );
    error.statusCode = 503;
    throw error;
  }

  async getStorageCapabilities() {
    const namespaceEnabled = this.namespaceService.isEnabled();
    const namespacePublicEnabled = this.namespaceService.isPublicEnabled();
    const namespaceAvailable = namespaceEnabled && await this.namespaceService.isAvailable();
    const namespaceUsable = namespaceAvailable && namespacePublicEnabled;
    const runtimeAvailable = this.runtimeService.isEnabled();
    const localAllowed = this.isLocalFileAllowed();
    const requirePrimary = this.isPrimaryRequired();
    const preferredMode = this.getRequestedPrimaryMode();
    const maxUploadBytes = getMaxUploadBytes();

    let defaultMode: StorageMode | null = null;
    if (preferredMode === 'namespace') {
      defaultMode = namespaceUsable ? 'namespace' : null;
    } else if (preferredMode === 'runtime') {
      defaultMode = runtimeAvailable ? 'runtime' : null;
    } else {
      defaultMode = namespaceUsable ? 'namespace' : runtimeAvailable ? 'runtime' : localAllowed ? 'local' : null;
    }

    const settings = getPublicDatabaseSettings();

    const namespaceReason = !namespaceEnabled
      ? 'Shared sqld namespaces are not configured.'
      : !namespacePublicEnabled
        ? 'Namespace public routing is not enabled (wildcard TLS/LIBSQL_NAMESPACE_PUBLIC_ENABLED).'
        : !namespaceAvailable
          ? 'sqld admin is not reachable.'
          : null;

    return {
      namespace: {
        enabled: namespaceEnabled,
        publicEnabled: namespacePublicEnabled,
        available: namespaceAvailable,
        usable: namespaceUsable,
        reason: namespaceReason,
      },
      runtime: {
        enabled: runtimeAvailable,
        available: runtimeAvailable,
        reason: runtimeAvailable ? null : 'Docker socket is not available.',
      },
      local: {
        allowed: localAllowed,
      },
      requirePrimary,
      preferredMode,
      defaultMode,
      publicDomain: settings.domain || '',
      publicProtocol: settings.protocol || 'https',
      runtimeTlsConfigured: Boolean(process.env.TRAEFIK_CERT_RESOLVER?.trim()),
      maxUploadBytes,
      supportsUploadCompression: true,
    };
  }

  private async verifyNamespaceConnection(subdomain: string, token: string) {
    const urls = this.namespaceService.buildNamespaceUrls(subdomain);
    const client = createLibsqlClient(urls.connectionUrl, token);
    try {
      await client.execute('SELECT 1');
    } catch (error: any) {
      throw new NamespaceUnavailableError(
        `El namespace "${subdomain}" se creó pero no responde en ${urls.connectionUrl}: ${error?.message || error}`,
      );
    } finally {
      client.close();
    }
  }

  private async shouldUseNamespaceForImport(): Promise<boolean> {
    const mode = String(process.env.LIBSQL_NAMESPACE_IMPORTS || 'auto').trim().toLowerCase();
    const strict = mode === 'true' || mode === 'namespace' || mode === 'required';

    if (mode === 'false' || mode === 'local' || mode === 'off') {
      return false;
    }

    if (!this.namespaceService.isEnabled()) {
      if (strict) {
        throw new NamespaceUnavailableError(
          'La importación por namespace está habilitada, pero los namespaces no están configurados. Define LIBSQL_ADMIN_URL o LIBSQL_ENABLE_NAMESPACES=true.',
        );
      }
      return false;
    }

    if (!(await this.namespaceService.isAvailable())) {
      if (strict) {
        throw new NamespaceUnavailableError(
          'sqld no está disponible para crear el namespace. Verifica que el contenedor sqld esté corriendo, que LIBSQL_ADMIN_URL sea accesible desde el backend y que ambos compartan la misma red Docker.',
        );
      }

      console.warn('[DatabaseService] sqld no está disponible; se usará importación local para esta base.');
      return false;
    }

    if (!this.namespaceService.isPublicEnabled()) {
      if (strict) {
        throw new NamespaceUnavailableError(
          'La importación por namespace requiere routing público. Configura wildcard TLS y define ' +
          'LIBSQL_NAMESPACE_PUBLIC_ENABLED=true (o LIBSQL_NAMESPACE_HOST para un solo host).',
        );
      }
      return false;
    }

    return true;
  }

  private shouldProvisionRuntimeForImport(): boolean {
    const mode = String(process.env.LIBSQL_IMPORT_RUNTIME || 'false').trim().toLowerCase();
    if (mode !== 'true' && mode !== '1' && mode !== 'yes') {
      return false;
    }
    return this.runtimeService.isEnabled();
  }

  private isManagedRuntimeEntry(database: { metadata?: Record<string, unknown>; type: string; url?: string | null }) {
    return getManagedRuntimeUrl(database) !== null;
  }

  private async attemptRuntimeProvisioning(
    databaseId: string,
    managedPath: string,
    auditAction: string,
    auditMetadata: Record<string, unknown>,
    asyncProvisioned = true,
  ): Promise<{ token: string; database: Database } | null> {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) return null;

    try {
      const managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
      database.type = 'libsql';
      database.url = managedPath;
      database.status = 'active';
      database.encryptedToken = encrypt(managedRuntime.token);
      database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
      await this.databaseRepo.save(database);
      await this.auditService.record({
        action: auditAction,
        resourceType: 'database',
        resourceId: database.id,
        metadata: { ...auditMetadata, runtime: managedRuntime.metadata.provider, asyncProvisioned },
      });
      if (managedRuntime.metadata.routeHealth?.publicChecked === false) {
        // The public route is not part of the critical provisioning path. Check
        // it shortly after the primary is ready and persist the result.
        this.scheduleRuntimeHealthRefresh(database.id);
      }
      return { token: managedRuntime.token, database };
    } catch (error) {
      const errorMessage = this.runtimeService.getRuntimeErrorMessage(error);
      database.status = 'error';
      database.metadata = {
        ...(database.metadata ?? {}),
        runtimeError: errorMessage,
        lastProvisioningAttemptAt: new Date().toISOString(),
      };
      await this.databaseRepo.save(database);
      await this.auditService.record({
        action: 'database.provision_failed',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { ...auditMetadata, error: errorMessage },
      });
      return null;
    }
  }

  private async buildProvisioningFailure(databaseId: string) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId } });
    const rawError = database?.metadata?.runtimeError;
    const detail = typeof rawError === 'string' && rawError.trim() ? rawError.trim() : '';
    const error: any = new Error(
      detail
        ? `No se pudo aprovisionar el runtime libSQL. Causa: ${detail}`
        : 'No se pudo aprovisionar el runtime libSQL. Revisa los logs del backend y el estado del socket Docker.',
    );
    error.statusCode = 502;
    return error;
  }

  async refreshRuntimeHealth(id: string, options: { publicTimeoutMs?: number; recordAudit?: boolean } = {}) {
    const database = await this.databaseRepo.findOne({
      where: { id },
      relations: ['project', 'project.owner'],
    });

    if (!database) {
      const error: any = new Error('database not found');
      error.statusCode = 404;
      throw error;
    }

    const runtime = database.metadata?.runtime as Record<string, unknown> | undefined;
    if (runtime?.provider !== 'docker-libsql') {
      const error: any = new Error('Health checks are only available for dedicated libSQL runtimes.');
      error.statusCode = 409;
      throw error;
    }

    if (!database.encryptedToken) {
      const error: any = new Error('database has no token');
      error.statusCode = 409;
      throw error;
    }

    let token: string;
    try {
      token = decrypt(database.encryptedToken);
    } catch (error: any) {
      const wrapped: any = new Error(`Failed to decrypt database token: ${error?.message || error}. Check MASTER_KEY.`);
      wrapped.statusCode = 500;
      throw wrapped;
    }

    const checkedIdentity = {
      containerId: typeof runtime.containerId === 'string' ? runtime.containerId : '',
      authKeyPem: typeof runtime.authKeyPem === 'string' ? runtime.authKeyPem : '',
    };
    if (!checkedIdentity.containerId) {
      const error: any = new Error('Runtime metadata is missing the container id.');
      error.statusCode = 409;
      throw error;
    }

    const health = await this.runtimeService.checkRouteHealth(database, token, options);
    if (!health) {
      const error: any = new Error('Runtime metadata is missing or incomplete.');
      error.statusCode = 409;
      throw error;
    }

    // Compare-and-swap health into metadata. A plain read/modify/save could
    // overwrite a rotation that finishes between those steps; the conditional
    // UPDATE only applies while the runtime identity is still the one checked.
    const fresh = await this.databaseRepo.findOne({ where: { id } });
    const freshRuntime = fresh?.metadata?.runtime as Record<string, unknown> | undefined;
    if (!fresh || !runtimeIdentityMatches(freshRuntime, checkedIdentity)) {
      return fresh ?? database;
    }

    const previousHealth = freshRuntime?.routeHealth as Record<string, unknown> | undefined;
    const healthChanged = !previousHealth
      || previousHealth.internalOk !== health.internalOk
      || previousHealth.backendOk !== health.backendOk
      || previousHealth.publicOk !== health.publicOk
      || previousHealth.publicChecked !== health.publicChecked;

    const applied = await this.updateRuntimeHealthIfCurrent(
      database.id,
      checkedIdentity,
      health,
    );
    const current = await this.databaseRepo.findOne({ where: { id } });
    if (!applied || !current) {
      // A rotation won the race. Keep the new credential and skip stale audit.
      return current ?? database;
    }

    // The periodic monitor records only transitions, avoiding an audit row
    // every few minutes for a healthy primary.
    if (options.recordAudit !== false || healthChanged) {
      await this.auditService.record({
        action: 'database.health_check',
        resourceType: 'database',
        resourceId: current.id,
        metadata: {
          internalOk: health.internalOk,
          backendOk: health.backendOk,
          publicOk: health.publicOk,
          publicChecked: health.publicChecked,
          background: options.recordAudit === false,
        },
      });
    }

    return current;
  }

  private async updateRuntimeHealthIfCurrent(
    databaseId: string,
    expected: { containerId: string; authKeyPem: string },
    health: RuntimeRouteHealth,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rawRow = await this.databaseRepo
        .createQueryBuilder('database')
        .select('database.metadata', 'metadata')
        .where('database.id = :id', { id: databaseId })
        .getRawOne<{ metadata: string | null }>();

      const raw = rawRow?.metadata;
      if (raw === null || raw === undefined) return false;

      let metadata: Record<string, unknown>;
      try {
        metadata = typeof raw === 'string'
          ? JSON.parse(raw) as Record<string, unknown>
          : raw as Record<string, unknown>;
      } catch {
        return false;
      }

      const runtime = metadata.runtime as Record<string, unknown> | undefined;
      if (!runtimeIdentityMatches(runtime, expected)) return false;

      const nextMetadata = {
        ...metadata,
        runtime: {
          ...runtime,
          routeHealth: health,
        },
      };

      const result = await AppDataSource.createQueryBuilder()
        .update(Database)
        .set({ metadata: nextMetadata })
        .where('id = :id', { id: databaseId })
        .andWhere('metadata = :raw', { raw })
        .execute();

      if (Number(result.affected ?? 0) > 0) {
        return true;
      }
      // Another writer changed the row; re-read and retry with fresh identity.
    }

    return false;
  }

  private scheduleRuntimeHealthRefresh(databaseId: string, delayMs = 3000, attempt = 1) {
    const timer = setTimeout(async () => {
      try {
        const database = await this.refreshRuntimeHealth(databaseId);
        const health = database.metadata?.runtime as
          | { routeHealth?: { publicChecked?: boolean; publicOk?: boolean } }
          | undefined;
        const routeHealth = health?.routeHealth;
        if (routeHealth?.publicChecked && !routeHealth.publicOk && attempt < 3) {
          this.scheduleRuntimeHealthRefresh(databaseId, 5000 * attempt, attempt + 1);
        }
      } catch (error: any) {
        console.warn(
          `[DatabaseService] Background health check failed for ${databaseId}: ` +
          `${error?.message || error}`,
        );
      }
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  private isRuntimeProvisioningAsync(): boolean {
    const value = String(process.env.LIBSQL_PROVISION_ASYNC || 'false').trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'yes';
  }

  private async cleanupCreatedDatabase(databaseId: string, extraPaths: string[] = [], runtimeMetadata?: Record<string, unknown>) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (database) {
      try {
        await this.runtimeService.removeDatabase({
          ...database,
          metadata: runtimeMetadata ? { ...(database.metadata ?? {}), runtime: runtimeMetadata } : database.metadata,
        });
      } catch {
      }

      await this.databaseRepo.remove(database);
    }

    for (const filePath of extraPaths) {
      try {
        await fs.promises.rm(filePath, { force: true });
      } catch {
      }
    }
  }
}

function deriveDatabaseName(name?: string, sourceName?: string, sourcePath?: string) {
  const explicitName = name?.trim();
  if (explicitName) return explicitName;

  const candidate = sourceName || (sourcePath ? path.basename(sourcePath) : '');
  return candidate.replace(/\.[^.]+$/, '').trim() || 'imported-database';
}

function mergeRuntimeMetadata(existing: Record<string, unknown> | undefined, runtime: Record<string, unknown>) {
  return {
    ...(existing ?? {}),
    runtimeError: undefined,
    lastHealthyAt: new Date().toISOString(),
    runtime,
  };
}

function getManagedRuntimeUrl(database: { metadata?: Record<string, unknown>; type: string; url?: string | null }) {
  const runtimeUrl = getRuntimeConnectionUrl(database);
  if (resolveEffectiveDatabaseType(database) !== 'libsql') {
    return null;
  }

  return runtimeUrl || null;
}
