import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { Database } from '../../domain/entities/Database';
import { getPublicDatabaseSettings } from '../../application/settings/PlatformSettingsService';
import { resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';

type DockerJson = Record<string, any>;

export type RuntimeRouteHealth = {
  checkedAt: string;
  internalOk: boolean;
  backendOk: boolean;
  publicOk: boolean;
  publicChecked: boolean;
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
  private readonly backendContainerId = process.env.LIBSQL_BACKEND_CONTAINER_ID?.trim()
    || process.env.HOSTNAME?.trim()
    || os.hostname();
  private readonly runtimeNetwork = process.env.LIBSQL_RUNTIME_NETWORK?.trim() || '';
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

  async rotateDatabase(database: Database): Promise<RuntimeBundle | null> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return null;

    const rotateStartedAt = Date.now();
    // Resolve the network before removing the current runtime. If Docker
    // inspection fails, the existing primary must stay online.
    const networkName = await this.resolveBackendNetworkName();
    const authBundle = this.generateAuthBundle();
    await this.removeContainer(runtime.containerId);

    const paths = this.resolvePaths(database, runtime.databasePath);
    let createdContainerId: string | undefined;

    try {
      createdContainerId = await this.createAndStartContainer(paths, runtime.databasePath, authBundle.publicKeyPem, networkName);
      const publicPort = await this.waitForPublishedPort(createdContainerId, 8080);
      const internalUrl = this.buildInternalUrl(paths.containerName, publicPort);
      const backendUrl = this.buildBackendUrl(publicPort);
      const publicUrl = this.buildCanonicalPublicUrl(paths.subdomain, publicPort);
      const readiness = await this.waitForReady(createdContainerId, {
        internalUrl,
        backendUrl,
      }, authBundle.token);
      console.log(
        `[LibsqlRuntimeService] rotated ${database.id} in ${Date.now() - rotateStartedAt}ms ` +
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

    await this.requestVoid('POST', `/containers/${containerId}/start`);
    await this.assertContainerOnNetwork(containerId, networkName);
    return containerId;
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
      const publicTimeoutMs = Math.max(0, Number(options.publicTimeoutMs || 0));
      publicCheck = publicTimeoutMs > 0
        ? await this.waitForPublicConnection(publicUrl, token, publicTimeoutMs)
        : await this.checkConnection(publicUrl, token, false);
    }

    return {
      checkedAt: new Date().toISOString(),
      internalOk: internalCheck.ok,
      backendOk: backendCheck.ok,
      publicOk: publicCheck.ok,
      publicChecked,
    };
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
    authToken: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let lastResult: { ok: boolean; error?: string } = { ok: false, error: 'public check not started' };

    while (Date.now() < deadline) {
      lastResult = await this.checkConnection(publicUrl, authToken, false);
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

  private async getBackendNetworkNames(): Promise<string[] | null> {
    if (!this.backendContainerId) {
      return null;
    }

    try {
      const inspect = await this.requestJson(
        'GET',
        `/containers/${encodeURIComponent(this.backendContainerId)}/json`,
      );
      const networks = inspect?.NetworkSettings?.Networks;
      return networks && typeof networks === 'object' ? Object.keys(networks) : [];
    } catch {
      return null;
    }
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
