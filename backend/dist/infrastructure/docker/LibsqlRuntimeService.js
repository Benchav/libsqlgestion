"use strict";
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
        this.publicHost = process.env.DATABASE_PUBLIC_HOST?.trim() || '127.0.0.1';
        this.publicProtocol = process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'http';
    }
    isEnabled() {
        return fs_1.default.existsSync(this.socketPath);
    }
    async provisionDatabase(database, databasePath) {
        this.assertAvailable();
        const paths = this.resolvePaths(database, databasePath);
        const authBundle = this.generateAuthBundle();
        await fs_1.default.promises.mkdir(path_1.default.dirname(paths.authKeyPath), { recursive: true });
        await fs_1.default.promises.writeFile(paths.authKeyPath, authBundle.publicKeyPem, 'utf8');
        try {
            await this.ensureImage();
            const containerId = await this.createAndStartContainer(paths, databasePath);
            const publicPort = await this.waitForPublishedPort(containerId, 8080);
            return {
                token: authBundle.token,
                metadata: {
                    provider: 'docker-libsql',
                    image: this.image,
                    containerId,
                    containerName: paths.containerName,
                    databasePath,
                    authKeyPath: paths.authKeyPath,
                    publicHost: this.publicHost,
                    publicPort,
                    publicUrl: `${this.publicProtocol}://${this.publicHost}:${publicPort}`,
                },
            };
        }
        catch (error) {
            await this.cleanupPaths([paths.authKeyPath], true);
            throw error;
        }
    }
    async rotateDatabase(database) {
        const runtime = this.readRuntimeMetadata(database);
        if (!runtime)
            return null;
        const authBundle = this.generateAuthBundle();
        await fs_1.default.promises.mkdir(path_1.default.dirname(runtime.authKeyPath), { recursive: true });
        await fs_1.default.promises.writeFile(runtime.authKeyPath, authBundle.publicKeyPem, 'utf8');
        await this.restartContainer(runtime.containerId);
        const publicPort = await this.waitForPublishedPort(runtime.containerId, 8080);
        return {
            token: authBundle.token,
            metadata: {
                ...runtime,
                publicPort,
                publicUrl: `${this.publicProtocol}://${runtime.publicHost}:${publicPort}`,
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
        if (runtime?.authKeyPath) {
            fileCandidates.add(runtime.authKeyPath);
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
    resolvePaths(database, databasePath) {
        const directory = path_1.default.dirname(databasePath);
        const containerName = `libsqlite-${database.id}`;
        return {
            databasePath,
            authKeyPath: path_1.default.join(directory, `${database.id}.auth.pem`),
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
            typeof runtime.authKeyPath !== 'string' ||
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
    async createAndStartContainer(paths, databasePath) {
        const dbFileName = path_1.default.basename(databasePath);
        const authFileName = path_1.default.basename(paths.authKeyPath);
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
