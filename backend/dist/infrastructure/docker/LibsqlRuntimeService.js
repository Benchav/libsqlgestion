"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LibsqlRuntimeService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
class LibsqlRuntimeService {
    constructor() {
        this.socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
        this.image = process.env.LIBSQL_SERVER_IMAGE || 'ghcr.io/tursodatabase/libsql-server:latest';
        this.publicHost = this.normalizePublicHost(process.env.DATABASE_PUBLIC_HOST?.trim());
        this.publicProtocol = process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'http';
        this.backendContainerId = process.env.HOSTNAME?.trim() || '';
    }
    isEnabled() {
        return fs_1.default.existsSync(this.socketPath);
    }
    async provisionDatabase(database, databasePath) {
        this.assertAvailable();
        const paths = this.resolvePaths(database, databasePath);
        const authBundle = this.generateAuthBundle();
        try {
            await this.ensureImage();
            const networkName = await this.resolveBackendNetworkName();
            const containerId = await this.createAndStartContainer(paths, databasePath, authBundle.publicKeyPem, networkName);
            const publicPort = await this.waitForPublishedPort(containerId, 8080);
            const internalUrl = this.buildInternalUrl(paths.containerName, publicPort);
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
                    authKeyPem: authBundle.publicKeyPem,
                    internalUrl,
                    connectionUrl,
                    publicHost: this.publicHost,
                    publicPort,
                    publicUrl,
                },
            };
        }
        catch (error) {
            throw error;
        }
    }
    async rotateDatabase(database) {
        const runtime = this.readRuntimeMetadata(database);
        if (!runtime)
            return null;
        const authBundle = this.generateAuthBundle();
        await this.removeContainer(runtime.containerId);
        const paths = this.resolvePaths(database, runtime.databasePath);
        const networkName = await this.resolveBackendNetworkName();
        const containerId = await this.createAndStartContainer(paths, runtime.databasePath, authBundle.publicKeyPem, networkName);
        const publicPort = await this.waitForPublishedPort(containerId, 8080);
        const internalUrl = this.buildInternalUrl(paths.containerName, publicPort);
        const publicUrl = `${this.publicProtocol}://${this.publicHost}:${publicPort}`;
        const connectionUrl = (await this.waitForReady(containerId, [publicUrl, internalUrl], authBundle.token)) || publicUrl;
        return {
            token: authBundle.token,
            metadata: {
                provider: 'docker-libsql',
                image: this.image,
                containerId,
                containerName: paths.containerName,
                databasePath: runtime.databasePath,
                authKeyPem: authBundle.publicKeyPem,
                publicPort,
                connectionUrl,
                publicHost: this.publicHost,
                publicUrl,
                internalUrl,
            },
        };
    }
    async removeDatabase(database) {
        const runtime = this.readRuntimeMetadata(database);
        if (runtime) {
            await this.removeContainer(runtime.containerId);
        }
        const fileCandidates = new Set();
        if (database.url && database.type === 'sqlite') {
            fileCandidates.add(database.url);
        }
        if (runtime?.databasePath) {
            fileCandidates.add(runtime.databasePath);
        }
        await this.cleanupPaths([...fileCandidates], true);
    }
    assertAvailable() {
        if (!this.isEnabled()) {
            throw new Error(`Docker socket not found at ${this.socketPath}`);
        }
    }
    detectPublicHost() {
        return 'host.docker.internal';
    }
    normalizePublicHost(value) {
        if (!value) {
            return this.detectPublicHost();
        }
        if (value === '127.0.0.1' || value === 'localhost') {
            return this.detectPublicHost();
        }
        return value;
    }
    buildInternalUrl(containerName, publicPort) {
        if (containerName) {
            return `http://${containerName}:8080`;
        }
        return `${this.publicProtocol}://${this.publicHost}:${publicPort}`;
    }
    resolvePaths(database, databasePath) {
        const directory = path_1.default.dirname(databasePath);
        const containerName = `libsqlite-${database.id}`;
        return {
            databasePath,
            containerName,
        };
    }
    readRuntimeMetadata(database) {
        const runtime = database.metadata?.runtime;
        if (!runtime || runtime.provider !== 'docker-libsql') {
            return null;
        }
        if (typeof runtime.containerId !== 'string' ||
            typeof runtime.containerName !== 'string' ||
            typeof runtime.databasePath !== 'string' ||
            typeof runtime.authKeyPem !== 'string' ||
            typeof runtime.internalUrl !== 'string' ||
            typeof runtime.connectionUrl !== 'string' ||
            typeof runtime.publicHost !== 'string' ||
            typeof runtime.publicPort !== 'string' ||
            typeof runtime.publicUrl !== 'string') {
            return null;
        }
        return runtime;
    }
    generateAuthBundle() {
        const { publicKey, privateKey } = crypto_1.default.generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
        const header = this.base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
        const payload = this.base64UrlEncode(Buffer.from(JSON.stringify({})));
        const signingInput = `${header}.${payload}`;
        const signature = crypto_1.default.sign(null, Buffer.from(signingInput), privateKey);
        return {
            publicKeyPem,
            token: `${signingInput}.${this.base64UrlEncode(signature)}`,
        };
    }
    base64UrlEncode(value) {
        return value
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }
    async ensureImage() {
        await this.requestJson('POST', `/images/create?fromImage=${encodeURIComponent(this.image)}`);
    }
    async createAndStartContainer(paths, databasePath, authKeyPem, networkName) {
        const dbFileName = path_1.default.basename(databasePath);
        const createResponse = await this.requestJson('POST', `/containers/create?name=${encodeURIComponent(paths.containerName)}`, {
            Image: this.image,
            Env: [
                'SQLD_NODE=primary',
                `SQLD_DB_PATH=/var/lib/sqld/${dbFileName}`,
                `SQLD_AUTH_JWT_KEY=${authKeyPem}`,
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
                    `${path_1.default.dirname(databasePath)}:/var/lib/sqld:rw`,
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
        const containerId = createResponse.Id;
        if (!containerId) {
            throw new Error('Docker did not return a container id');
        }
        await this.requestVoid('POST', `/containers/${containerId}/start`);
        return containerId;
    }
    async restartContainer(containerId) {
        await this.requestVoid('POST', `/containers/${containerId}/restart?t=5`);
    }
    async removeContainer(containerId) {
        try {
            await this.requestVoid('DELETE', `/containers/${containerId}?force=true&v=true`);
        }
        catch (error) {
            if (!String(error?.message || '').includes('404')) {
                throw error;
            }
        }
    }
    async waitForPublishedPort(containerId, containerPort) {
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
    async waitForReady(containerId, urls, token) {
        const timeoutAt = Date.now() + 30000;
        let lastErrorMessage = '';
        while (Date.now() < timeoutAt) {
            const state = await this.inspectContainerState(containerId);
            if (state && state.running === false) {
                const logs = await this.fetchContainerLogs(containerId);
                throw new Error(`libSQL container stopped unexpectedly with exit code ${state.exitCode ?? 'unknown'}${logs ? `: ${logs}` : ''}`);
            }
            for (const url of [...urls].sort((a, b) => (a.includes('host.docker.internal') ? 1 : 0) - (b.includes('host.docker.internal') ? 1 : 0))) {
                try {
                    const client = await Promise.resolve().then(() => __importStar(require('@libsql/client'))).then(({ createClient }) => createClient({ url, authToken: token }));
                    try {
                        await client.execute('SELECT 1');
                        return url;
                    }
                    finally {
                        client.close();
                    }
                }
                catch (error) {
                    lastErrorMessage = error?.message || String(error);
                    continue;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const state = await this.inspectContainerState(containerId);
        const logs = await this.fetchContainerLogs(containerId);
        const suffix = [lastErrorMessage, state ? `running=${state.running} exitCode=${state.exitCode ?? 'unknown'}` : '', logs ? `logs=${logs}` : '']
            .filter(Boolean)
            .join(' | ');
        throw new Error(`Timed out waiting for libSQL to accept connections${suffix ? `: ${suffix}` : ''}`);
    }
    getRuntimeErrorMessage(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown libSQL runtime error';
    }
    async resolveBackendNetworkName() {
        if (!this.backendContainerId) {
            return undefined;
        }
        try {
            const inspect = await this.requestJson('GET', `/containers/${this.backendContainerId}/json`);
            const networks = inspect?.NetworkSettings?.Networks;
            const networkNames = networks ? Object.keys(networks) : [];
            return networkNames[0];
        }
        catch {
            return undefined;
        }
    }
    async inspectContainerState(containerId) {
        try {
            const inspect = await this.requestJson('GET', `/containers/${containerId}/json`);
            return {
                running: Boolean(inspect?.State?.Running),
                exitCode: typeof inspect?.State?.ExitCode === 'number' ? inspect.State.ExitCode : undefined,
            };
        }
        catch {
            return null;
        }
    }
    async fetchContainerLogs(containerId) {
        try {
            const response = await this.request('GET', `/containers/${containerId}/logs?stdout=true&stderr=true&tail=80`);
            return response.body.trim();
        }
        catch {
            return '';
        }
    }
    async cleanupPaths(paths, ignoreMissing) {
        for (const filePath of paths) {
            try {
                await fs_1.default.promises.rm(filePath, { force: ignoreMissing });
            }
            catch {
                // Best effort cleanup.
            }
        }
    }
    async requestVoid(method, requestPath) {
        await this.request(method, requestPath);
    }
    async requestJson(method, requestPath, body) {
        const response = await this.request(method, requestPath, body);
        if (!response.body) {
            return {};
        }
        try {
            return JSON.parse(response.body);
        }
        catch {
            return { raw: response.body };
        }
    }
    request(method, requestPath, body) {
        return new Promise((resolve, reject) => {
            const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
            const request = http_1.default.request({
                socketPath: this.socketPath,
                path: requestPath,
                method,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
                },
            }, (response) => {
                const chunks = [];
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
            });
            request.on('error', reject);
            if (payload) {
                request.write(payload);
            }
            request.end();
        });
    }
}
exports.LibsqlRuntimeService = LibsqlRuntimeService;
