import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Database } from '../../domain/entities/Database';

type DockerJson = Record<string, any>;

type RuntimeMetadata = {
  provider: 'docker-libsql';
  image: string;
  containerId: string;
  containerName: string;
  databasePath: string;
  authKeyPath: string;
  internalUrl: string;
  connectionUrl: string;
  publicHost: string;
  publicPort: string;
  publicUrl: string;
};

type RuntimeBundle = {
  token: string;
  metadata: RuntimeMetadata;
};

type RuntimePaths = {
  databasePath: string;
  authKeyPath: string;
  containerName: string;
};

export class LibsqlRuntimeService {
  private readonly socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  private readonly image = process.env.LIBSQL_SERVER_IMAGE || 'ghcr.io/tursodatabase/libsql-server:latest';
  private readonly publicHost = process.env.DATABASE_PUBLIC_HOST?.trim() || this.detectPublicHost();
  private readonly publicProtocol = process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'http';
  private readonly backendContainerId = process.env.HOSTNAME?.trim() || '';

  isEnabled() {
    return fs.existsSync(this.socketPath);
  }

  async provisionDatabase(database: Database, databasePath: string): Promise<RuntimeBundle> {
    this.assertAvailable();

    const paths = this.resolvePaths(database, databasePath);
    const authBundle = this.generateAuthBundle();
    await fs.promises.mkdir(path.dirname(paths.authKeyPath), { recursive: true });
    await fs.promises.writeFile(paths.authKeyPath, authBundle.publicKeyPem, 'utf8');

    try {
      await this.ensureImage();
      const networkName = await this.resolveBackendNetworkName();
      const containerId = await this.createAndStartContainer(paths, databasePath, networkName);
      const publicPort = await this.waitForPublishedPort(containerId, 8080);
      const internalUrl = `http://${paths.containerName}:8080`;
      const publicUrl = `${this.publicProtocol}://${this.publicHost}:${publicPort}`;
      const connectionUrl = (await this.waitForReady(containerId, [publicUrl, internalUrl], authBundle.token)) || publicUrl;

      return {
        token: authBundle.token,
        metadata: {
          provider: 'docker-libsql',
          image: this.image,
          containerId,
          containerName: paths.containerName,
          databasePath,
          authKeyPath: paths.authKeyPath,
          internalUrl,
          connectionUrl,
          publicHost: this.publicHost,
          publicPort,
          publicUrl,
        },
      };
    } catch (error) {
      await this.cleanupPaths([paths.authKeyPath], true);
      throw error;
    }
  }

  async rotateDatabase(database: Database): Promise<RuntimeBundle | null> {
    const runtime = this.readRuntimeMetadata(database);
    if (!runtime) return null;

    const authBundle = this.generateAuthBundle();
    await fs.promises.mkdir(path.dirname(runtime.authKeyPath), { recursive: true });
    await fs.promises.writeFile(runtime.authKeyPath, authBundle.publicKeyPem, 'utf8');

    await this.restartContainer(runtime.containerId);

    const publicPort = await this.waitForPublishedPort(runtime.containerId, 8080);
    const connectionUrl = (await this.waitForReady(runtime.containerId, [runtime.publicUrl, runtime.internalUrl], authBundle.token)) || runtime.publicUrl;
    return {
      token: authBundle.token,
      metadata: {
        ...runtime,
        publicPort,
        connectionUrl,
        publicUrl: `${this.publicProtocol}://${runtime.publicHost}:${publicPort}`,
      },
    };
  }

  async removeDatabase(database: Database) {
    const runtime = this.readRuntimeMetadata(database);
    if (runtime) {
      await this.removeContainer(runtime.containerId);
    }

    const fileCandidates = new Set<string>();
    if (database.url && database.type === 'sqlite') {
      fileCandidates.add(database.url);
    }
    if (runtime?.authKeyPath) {
      fileCandidates.add(runtime.authKeyPath);
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
    if (process.platform === 'linux') {
      return 'host.docker.internal';
    }

    return '127.0.0.1';
  }

  private resolvePaths(database: Database, databasePath: string): RuntimePaths {
    const directory = path.dirname(databasePath);
    const containerName = `libsqlite-${database.id}`;

    return {
      databasePath,
      authKeyPath: path.join(directory, `${database.id}.auth.pem`),
      containerName,
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
      typeof runtime.authKeyPath !== 'string' ||
      typeof runtime.internalUrl !== 'string' ||
      typeof runtime.connectionUrl !== 'string' ||
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
    const header = this.base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
    const payload = this.base64UrlEncode(Buffer.from(JSON.stringify({})));
    const signingInput = `${header}.${payload}`;
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
    await this.requestJson('POST', `/images/create?fromImage=${encodeURIComponent(this.image)}`);
  }

  private async createAndStartContainer(paths: RuntimePaths, databasePath: string, networkName?: string) {
    const dbFileName = path.basename(databasePath);
    const authFileName = path.basename(paths.authKeyPath);

    const createResponse = await this.requestJson('POST', `/containers/create?name=${encodeURIComponent(paths.containerName)}`, {
      Image: this.image,
      Env: [
        'SQLD_NODE=primary',
        `SQLD_DB_PATH=/var/lib/sqld/${dbFileName}`,
        `SQLD_AUTH_JWT_KEY_FILE=/var/lib/sqld/${authFileName}`,
      ],
      ExposedPorts: {
        '8080/tcp': {},
        '5001/tcp': {},
      },
      HostConfig: {
        AutoRemove: false,
        PublishAllPorts: true,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: [
          `${databasePath}:/var/lib/sqld/${dbFileName}:rw`,
          `${paths.authKeyPath}:/var/lib/sqld/${authFileName}:ro`,
        ],
      },
      NetworkingConfig: networkName
        ? {
            EndpointsConfig: {
              [networkName]: {},
            },
          }
        : undefined,
      Labels: {
        'libsqlite.managed': 'true',
        'libsqlite.container-name': paths.containerName,
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
      if (!String(error?.message || '').includes('404')) {
        throw error;
      }
    }
  }

  private async waitForPublishedPort(containerId: string, containerPort: number) {
    const portKey = `${containerPort}/tcp`;
    const timeoutAt = Date.now() + 15000;

    while (Date.now() < timeoutAt) {
      const inspect = await this.requestJson('GET', `/containers/${containerId}/json`);
      const bindings = inspect?.NetworkSettings?.Ports?.[portKey];
      const hostPort = bindings?.[0]?.HostPort;
      if (typeof hostPort === 'string' && hostPort.trim()) {
        return hostPort;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error('Timed out waiting for the libSQL server port to become available');
  }

  private async waitForReady(containerId: string, urls: string[], token: string) {
    const timeoutAt = Date.now() + 20000;

    while (Date.now() < timeoutAt) {
      const state = await this.inspectContainerState(containerId);
      if (state && state.running === false) {
        const logs = await this.fetchContainerLogs(containerId);
        throw new Error(`libSQL container stopped unexpectedly with exit code ${state.exitCode ?? 'unknown'}${logs ? `: ${logs}` : ''}`);
      }

      for (const url of urls) {
        try {
          const client = await import('@libsql/client').then(({ createClient }) =>
            createClient({ url, authToken: token }),
          );
          try {
            await client.execute('SELECT 1');
            return url;
          } finally {
            client.close();
          }
        } catch {
          continue;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error('Timed out waiting for libSQL to accept connections');
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
      return networkNames[0];
    } catch {
      return undefined;
    }
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