"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionPool = void 0;
const SqliteClient_1 = require("../sqlite/SqliteClient");
const LibsqlClient_1 = require("../libsql/LibsqlClient");
const crypto_1 = require("../crypto");
class ConnectionPool {
    constructor() {
        this.pool = new Map();
        this.maxSize = Math.max(1, Number(process.env.DB_CONNECTION_POOL_MAX_SIZE || 256));
        this.idleTtlMs = Math.max(1000, Number(process.env.DB_CONNECTION_POOL_IDLE_TTL_MS || 30 * 60 * 1000));
        this.lastSweepAt = 0;
    }
    static getInstance() {
        if (!ConnectionPool.instance) {
            ConnectionPool.instance = new ConnectionPool();
        }
        return ConnectionPool.instance;
    }
    getClient(database) {
        this.sweepIdleConnections();
        const existing = this.pool.get(database.id);
        if (existing) {
            existing.lastUsed = Date.now();
            return existing.client;
        }
        this.ensureCapacity();
        const entry = this.createClient(database);
        this.pool.set(database.id, entry);
        return entry.client;
    }
    getSqliteClient(database) {
        const client = this.getClient(database);
        if (!(client instanceof SqliteClient_1.SqliteClient)) {
            throw new Error(`Database ${database.id} is not a local SQLite database`);
        }
        return client;
    }
    evict(databaseId) {
        const entry = this.pool.get(databaseId);
        if (!entry)
            return;
        this.pool.delete(databaseId);
        void this.closeClient(entry);
    }
    evictOnError(databaseId, error) {
        if (!this.isFatalError(error))
            return;
        this.evict(databaseId);
    }
    async shutdown() {
        const entries = Array.from(this.pool.entries());
        this.pool.clear();
        for (const [, entry] of entries) {
            await this.closeClient(entry);
        }
    }
    get size() {
        return this.pool.size;
    }
    get stats() {
        return {
            size: this.pool.size,
            maxSize: this.maxSize,
            idleTtlMs: this.idleTtlMs,
        };
    }
    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------
    createClient(database) {
        if (database.type === 'sqlite') {
            const filePath = database.url || '';
            if (!filePath) {
                throw new Error(`Database ${database.id} has no file path configured`);
            }
            const client = new SqliteClient_1.SqliteClient(filePath);
            return { client, type: 'sqlite', lastUsed: Date.now() };
        }
        // libsql / remote
        if (!database.url || !database.encryptedToken) {
            throw new Error(`Database ${database.id} is missing url or token for libsql connection`);
        }
        const token = (0, crypto_1.decrypt)(database.encryptedToken);
        const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, token);
        return { client, type: 'libsql', lastUsed: Date.now() };
    }
    async closeClient(entry) {
        try {
            if (entry.type === 'sqlite') {
                await entry.client.close();
            }
            else {
                entry.client.close();
            }
        }
        catch {
            // Best-effort close — connection may already be broken.
        }
    }
    isFatalError(error) {
        if (!(error instanceof Error))
            return false;
        const msg = error.message.toLowerCase();
        return (msg.includes('sqlite_notadb') ||
            msg.includes('sqlite_corrupt') ||
            msg.includes('sqlite_cantopen') ||
            msg.includes('not a database') ||
            msg.includes('database disk image is malformed'));
    }
    sweepIdleConnections() {
        const now = Date.now();
        if (now - this.lastSweepAt < 30000) {
            return;
        }
        this.lastSweepAt = now;
        for (const [databaseId, entry] of this.pool.entries()) {
            if (now - entry.lastUsed <= this.idleTtlMs) {
                continue;
            }
            this.pool.delete(databaseId);
            void this.closeClient(entry);
        }
    }
    ensureCapacity() {
        if (this.pool.size < this.maxSize) {
            return;
        }
        const oldest = Array.from(this.pool.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) {
            return;
        }
        this.pool.delete(oldest[0]);
        void this.closeClient(oldest[1]);
    }
}
exports.ConnectionPool = ConnectionPool;
