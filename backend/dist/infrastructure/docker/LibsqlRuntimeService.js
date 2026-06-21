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
const PlatformSettingsService_1 = require("../../application/settings/PlatformSettingsService");
const database_runtime_1 = require("../../application/databases/database-runtime");
class LibsqlRuntimeService {
    constructor() {
        this.socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
        this.image = process.env.LIBSQL_SERVER_IMAGE || 'ghcr.io/tursodatabase/libsql-server:latest';
        this.backendContainerId = process.env.HOSTNAME?.trim() || '';
        this.imagePulled = false;
        this.imagePullPromise = null;
    }
    isEnabled() {
        return fs_1.default.existsSync(this.socketPath);
    }
    async provisionDatabase(database, databasePath) {
        this.assertAvailable();
        const paths = this.resolvePaths(database, databasePath);
        const authBundle = this.generateAuthBundle();
        let createdContainerId;
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
        }
        catch (error) {
            if (createdContainerId) {
                try {
                    await this.removeContainer(createdContainerId);
                }
                catch { /* best-effort */ }
            }
            else {
                try {
                    await this.requestVoid('DELETE', `/containers/${paths.containerName}?force=true&v=true`);
                }
                catch { /* best-effort */ }
            }
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
        let createdContainerId;
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
        }
        catch (error) {
            if (createdContainerId) {
                try {
                    await this.removeContainer(createdContainerId);
                }
                catch { /* best-effort */ }
            }
            else {
                try {
                    await this.requestVoid('DELETE', `/containers/${paths.containerName}?force=true&v=true`);
                }
                catch { /* best-effort */ }
            }
            throw error;
        }
    }
    async removeDatabase(database) {
        const runtime = this.readRuntimeMetadata(database);
        if (runtime) {
            await this.removeContainer(runtime.containerId);
        }
        const fileCandidates = new Set();
        if (database.url && (0, database_runtime_1.resolveEffectiveDatabaseType)(database) === 'sqlite') {
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
    getPublicHost() {
        const settings = (0, PlatformSettingsService_1.getPublicDatabaseSettings)();
        return this.normalizePublicHost(settings.host || process.env.DATABASE_PUBLIC_HOST?.trim());
    }
    getPublicProtocol() {
        const settings = (0, PlatformSettingsService_1.getPublicDatabaseSettings)();
        return settings.protocol || process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'http';
    }
    getPublicDomain() {
        const settings = (0, PlatformSettingsService_1.getPublicDatabaseSettings)();
        return settings.domain || process.env.DATABASE_PUBLIC_DOMAIN?.trim() || 'localhost';
    }
    buildPublicUrl(publicPort) {
        return `${this.getPublicProtocol()}://${this.getPublicHost()}:${publicPort}`;
    }
    buildBackendUrl(publicPort) {
        return this.buildPublicUrl(publicPort);
    }
    buildCanonicalPublicUrl(subdomain, publicPort) {
        const domain = this.getPublicDomain().replace(/^\.+/, '');
        if (domain && domain !== 'localhost') {
            return `${this.getPublicProtocol()}://${subdomain}.${domain}`;
        }
        return this.buildBackendUrl(publicPort);
    }
    buildInternalUrl(subdomain, publicPort) {
        const stableHost = this.buildStableInternalHost(subdomain);
        if (stableHost) {
            return `http://${stableHost}:8080`;
        }
        return this.buildPublicUrl(publicPort);
    }
    buildStableInternalHost(subdomain) {
        const normalized = String(subdomain || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+|-+$/g, '')
            .replace(/-{2,}/g, '-');
        return normalized ? `libsqlite-${normalized}` : '';
    }
    resolvePaths(database, databasePath) {
        const containerName = `libsqlite-${database.id}`;
        return {
            databasePath,
            containerName,
            subdomain: database.subdomain || `db-${database.id}`,
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
            typeof runtime.backendUrl !== 'string' ||
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
        if (this.imagePulled)
            return;
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
    async checkImageExists() {
        try {
            const result = await this.requestJson('GET', `/images/${encodeURIComponent(this.image)}/json`);
            return Boolean(result && typeof result.Id === 'string');
        }
        catch {
            return false;
        }
    }
    async createAndStartContainer(paths, databasePath, authKeyPem, networkName) {
        const dbDirName = path_1.default.dirname(databasePath);
        const databaseDir = path_1.default.basename(dbDirName) || 'data';
        const hostDirName = await this.resolveHostPath(dbDirName);
        const authPemPath = path_1.default.join(dbDirName, 'auth.pem');
        await fs_1.default.promises.writeFile(authPemPath, authKeyPem, 'utf8');
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
            if (!this.isIgnorableContainerRemovalError(error)) {
                throw error;
            }
        }
    }
    isIgnorableContainerRemovalError(error) {
        const message = String(error?.message || '');
        return message.includes('404') || message.includes('already in progress');
    }
    async waitForPublishedPort(containerId, containerPort) {
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
    async waitForReady(containerId, urls, token) {
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
    async canConnect(url, authToken) {
        try {
            const client = await Promise.resolve().then(() => __importStar(require('@libsql/client'))).then(({ createClient }) => createClient({ url, authToken }));
            try {
                await client.execute('SELECT 1');
                return true;
            }
            finally {
                client.close();
            }
        }
        catch (err) {
            console.warn(`[LibsqlRuntimeService] connection check failed for ${url}: ${err?.message || err}`);
            return false;
        }
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
            if (networkNames.includes('coolify')) {
                return 'coolify';
            }
            return networkNames[0];
        }
        catch {
            return undefined;
        }
    }
    async resolveHostPath(containerPath) {
        if (!this.backendContainerId) {
            return containerPath;
        }
        try {
            const inspect = await this.requestJson('GET', `/containers/${this.backendContainerId}/json`);
            const mounts = inspect?.Mounts || [];
            let bestMatch = null;
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
        }
        catch {
            // Ignored
        }
        return containerPath;
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
    async getContainerStats(containerId) {
        try {
            const stats = await this.requestJson('GET', `/containers/${containerId}/stats?stream=false`);
            return {
                memoryBytes: typeof stats?.memory_stats?.usage === 'number' ? stats.memory_stats.usage : 0,
            };
        }
        catch {
            return { memoryBytes: 0 };
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
