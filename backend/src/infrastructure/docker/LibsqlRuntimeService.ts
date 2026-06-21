import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Database } from '../../domain/entities/Database';
import { getPublicDatabaseSettings } from '../../application/settings/PlatformSettingsService';
import { resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';

type DockerJson = Record<string, any>;

type RuntimeMetadata = {
  provider: 'docker-libsql';
  image: string;
  containerId: string;
  containerName: string;
  databasePath: string;
  authKeyPem: string;
  internalUrl: string;
  connectionUrl: string;
  backendUrl: string;
  publicHost: string;
  publicPort: string;
  publicUrl: string;
  routeHealth: {
    checkedAt: string;
    internalOk: boolean;
    backendOk: boolean;
    publicOk: boolean;
    publicChecked: boolean;
  };
};

type RuntimeBundle = {
  token: string;
  metadata: RuntimeMetadata;
};

type RuntimePaths = {
  databasePath: string;
  containerName: string;
  subdomain: string;
};

export class LibsqlRuntimeService {
  private readonly socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  private readonly image = process.env.LIBSQL_SERVER_IMAGE || 'ghcr.io/tursodatabase/libsql-server:latest';
  private readonly backendContainerId = process.env.HOSTNAME?.trim() || '';
  private imagePulled = false;
  private imagePullPromise: Promise<void> | null = null;

  isEnabled() {
    return fs.existsSync(this.socketPath);
  }

  async provisionDatabase(database: Database, databasePath: string): Promise<RuntimeBundle> {
    this.assertAvailable();

    const paths = this.resolvePaths(database, databasePath);
    const authBundle = this.generateAuthBundle();
    let createdContainerId: string | undefined;

    try {
      await this.ensureImage();
      const networkName = await this.resolveBackendNetworkName();
      createdContainerId = await this.createAndStartContainer(paths, databasePath, authBundle.publicKeyPem, networkName);
      const publicPort = await this.waitForPublishedPort(createdContainerId, 8080);
      const internalUrl = this.buildInternalUrl(paths.subdomain, publicPort);
      const backendUrl = this.buildBackendUrl(publicPort);
      const publicUrl = this.buildCanonicalPublicUrl(paths.subdomain, publicPort);
      const readiness = await this.waitForReady(createdContainerId, {
        internalUrl,
        backendUrl,
        publicUrl,
      }, authBundle.token);

      return {
        token: authBundle.token,
        metadata: {
          provider: 'docker-libsql',
          image: this.image,
          containerId: createdContainerId,
          containerName: paths.containerName,
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

  async rotateDatabase(database: Database): Promise<RuntimeBundle | null> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return null;

    const authBundle = this.generateAuthBundle();
    await this.removeContainer(runtime.containerId);

    const paths = this.resolvePaths(database, runtime.databasePath);
    const networkName = await this.resolveBackendNetworkName();
    let createdContainerId: string | undefined;

    try {
      createdContainerId = await this.createAndStartContainer(paths, runtime.databasePath, authBundle.publicKeyPem, networkName);
      const publicPort = await this.waitForPublishedPort(createdContainerId, 8080);
      const internalUrl = this.buildInternalUrl(paths.subdomain, publicPort);
      const backendUrl = this.buildBackendUrl(publicPort);
      const publicUrl = this.buildCanonicalPublicUrl(paths.subdomain, publicPort);
      const readiness = await this.waitForReady(createdContainerId, {
        internalUrl,
        backendUrl,
        publicUrl,
      }, authBundle.token);
      return {
        token: authBundle.token,
        metadata: {
          provider: 'docker-libsql',
          image: this.image,
          containerId: createdContainerId,
          containerName: paths.containerName,
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
    } catch (error) {
      if (createdContainerId) {
        try { await this.removeContainer(createdContainerId); } catch { /* best-effort */ }
      } else {
        try { await this.requestVoid('DELETE', `/containers/${paths.containerName}?force=true&v=true`); } catch { /* best-effort */ }
      }
      throw error;
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
    return `${this.getPublicProtocol()}://${this.getPublicHost()}:${publicPort}`;
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

  private buildInternalUrl(subdomain: string, publicPort: string) {
    const stableHost = this.buildStableInternalHost(subdomain);
    if (stableHost) {
      return `http://${stableHost}:8080`;
    }

    return this.buildPublicUrl(publicPort);
  }

  private buildStableInternalHost(subdomain: string) {
    const normalized = String(subdomain || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');

    return normalized ? `libsqlite-${normalized}` : '';
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
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresInSeconds = Number(process.env.LIBSQL_RUNTIME_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30);
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

  private async createAndStartContainer(paths: RuntimePaths, databasePath: string, authKeyPem: string, networkName?: string) {
    const dbDirName = path.dirname(databasePath);
    const databaseDir = path.basename(dbDirName) || 'data';
    const hostDirName = await this.resolveHostPath(dbDirName);

    const authPemPath = path.join(dbDirName, 'auth.pem');
    await fs.promises.writeFile(authPemPath, authKeyPem, 'utf8');

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
      NetworkingConfig: networkName
        ? {
            EndpointsConfig: {
              [networkName]: {
                Aliases: [paths.containerName, this.buildStableInternalHost(paths.subdomain)].filter(Boolean),
              },
            },
          }
        : undefined,
      Labels: {
        'libsqlite.managed': 'true',
        'libsqlite.container-name': paths.containerName,
        'traefik.enable': 'true',
        [`traefik.http.routers.${paths.containerName}.rule`]: `Host(\`${paths.subdomain}.${this.getPublicDomain()}\`)`,
        [`traefik.http.services.${paths.containerName}.loadbalancer.server.port`]: '8080',
      },
    });

    const containerId = createResponse.Id as string | undefined;
    if (!containerId) {
      throw new Error('Docker did not return a container id');
    }

    await this.requestVoid('POST', `/containers/${containerId}/start`);
    return containerId;
  }

  private async restartContainer(containerId: string) {
    await this.requestVoid('POST', `/containers/${containerId}/restart?t=5`);
  }

  private async removeContainer(containerId: string) {
    try {
      await this.requestVoid('DELETE', `/containers/${containerId}?force=true&v=true`);
    } catch (error: any) {
      if (!this.isIgnorableContainerRemovalError(error)) {
        throw error;
      }
    }
  }

  private isIgnorableContainerRemovalError(error: unknown) {
    const message = String((error as any)?.message || '');
    return message.includes('404') || message.includes('already in progress');
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

  private async waitForReady(containerId: string, urls: { internalUrl: string; backendUrl: string; publicUrl: string }, token: string) {
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

      const internalOk = await this.canConnect(urls.internalUrl, token);
      if (internalOk) {
        const backendOk = await this.canConnect(urls.backendUrl, token);
        const publicChecked = urls.publicUrl !== urls.backendUrl && urls.publicUrl !== urls.internalUrl;
        const publicOk = publicChecked ? await this.canConnect(urls.publicUrl, token) : backendOk || internalOk;

        return {
          connectionUrl: urls.internalUrl,
          routeHealth: {
            checkedAt: new Date().toISOString(),
            internalOk,
            backendOk,
            publicOk,
            publicChecked,
          },
        };
      }

      lastErrorMessage = `internal=${internalOk}`;
      const delay = Math.min(500 * Math.pow(1.5, attempt), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const state = await this.inspectContainerState(containerId);
    const logs = await this.fetchContainerLogs(containerId);
    const suffix = [lastErrorMessage, state ? `running=${state.running} exitCode=${state.exitCode ?? 'unknown'}` : '', logs ? `logs=${logs}` : '']
      .filter(Boolean)
      .join(' | ');

    throw new Error(`Timed out waiting for libSQL to accept connections${suffix ? `: ${suffix}` : ''}`);
  }

  private async canConnect(url: string, authToken: string) {
    try {
      const client = await import('@libsql/client').then(({ createClient }) => createClient({ url, authToken }));
      try {
        await client.execute('SELECT 1');
        return true;
      } finally {
        client.close();
      }
    } catch (err: any) {
      console.warn(`[LibsqlRuntimeService] connection check failed for ${url}: ${err?.message || err}`);
      return false;
    }
  }

  getRuntimeErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown libSQL runtime error';
  }

  private async resolveBackendNetworkName() {
    if (!this.backendContainerId) {
      return undefined;
    }

    try {
      const inspect = await this.requestJson('GET', `/containers/${this.backendContainerId}/json`);
      const networks = inspect?.NetworkSettings?.Networks;
      const networkNames = networks ? Object.keys(networks) : [];
      
      if (networkNames.includes('coolify')) {
        return 'coolify';
      }
      
      return networkNames[0];
    } catch {
      return undefined;
    }
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
        await fs.promises.rm(filePath, { force: ignoreMissing });
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
