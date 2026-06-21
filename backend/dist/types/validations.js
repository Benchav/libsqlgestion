"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = exports.publicDatabaseSettingsSchema = exports.pageQuerySchema = exports.adoptDatabaseSchema = exports.scanDirectorySchema = exports.auditListQuerySchema = exports.assignRoleSchema = exports.loginSchema = exports.registerUserSchema = exports.changeColumnTypeSchema = exports.renameColumnSchema = exports.addColumnSchema = exports.renameTableSchema = exports.backupDatabaseSchema = exports.createProjectSchema = exports.executeQuerySchema = exports.updateDatabaseSchema = exports.importSqliteSchema = exports.createDatabaseSchema = void 0;
exports.parseAndValidate = parseAndValidate;
const zod_1 = require("zod");
const identifier = zod_1.z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nonEmptyString = zod_1.z.string().trim().min(1).max(512);
const optionalString = zod_1.z.string().max(512).optional();
exports.createDatabaseSchema = zod_1.z.object({
    projectId: zod_1.z.string().uuid(),
    name: nonEmptyString,
    type: zod_1.z.enum(['sqlite', 'libsql', 'remote']),
    url: optionalString,
    token: optionalString,
    subdomain: optionalString,
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
exports.importSqliteSchema = zod_1.z.object({
    projectId: zod_1.z.string().uuid(),
    name: optionalString,
    sourceName: optionalString,
    sourcePath: zod_1.z.string().min(1),
    subdomain: optionalString,
    token: optionalString,
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
exports.updateDatabaseSchema = zod_1.z.object({
    name: optionalString,
    status: zod_1.z.enum(['active', 'inactive', 'error']).optional(),
});
exports.executeQuerySchema = zod_1.z.object({
    sql: zod_1.z.string().min(1).max(65536),
    params: zod_1.z.array(zod_1.z.unknown()).default([]),
});
exports.createProjectSchema = zod_1.z.object({
    name: nonEmptyString,
});
exports.backupDatabaseSchema = zod_1.z.object({
    name: nonEmptyString,
});
exports.renameTableSchema = zod_1.z.object({
    name: identifier,
});
exports.addColumnSchema = zod_1.z.object({
    name: identifier,
    type: zod_1.z.string().min(1).max(256).regex(/^[A-Z0-9_\s(),]+$/i),
    notnull: zod_1.z.boolean().optional(),
    defaultValue: optionalString,
    unique: zod_1.z.boolean().optional(),
});
exports.renameColumnSchema = zod_1.z.object({
    name: identifier,
});
exports.changeColumnTypeSchema = zod_1.z.object({
    type: zod_1.z.string().min(1).max(256).regex(/^[A-Z0-9_\s(),]+$/i),
});
exports.registerUserSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(254),
    password: zod_1.z.string().min(8).max(128),
});
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(254),
    password: zod_1.z.string().min(1).max(128),
});
exports.assignRoleSchema = zod_1.z.object({
    roleName: zod_1.z.string().min(1).max(128),
});
exports.auditListQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    search: optionalString,
});
exports.scanDirectorySchema = zod_1.z.object({
    projectId: zod_1.z.string().uuid(),
    path: zod_1.z.string().min(1),
    adopt: zod_1.z.boolean().optional(),
});
exports.adoptDatabaseSchema = zod_1.z.object({
    projectId: zod_1.z.string().uuid(),
    sourcePath: zod_1.z.string().min(1),
    name: optionalString,
    subdomain: optionalString,
});
exports.pageQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
exports.publicDatabaseSettingsSchema = zod_1.z.object({
    domain: optionalString,
    template: optionalString,
    baseUrl: optionalString,
    host: optionalString,
    protocol: zod_1.z.enum(['http', 'https']).optional(),
});
function parseAndValidate(schema, data, errorLabel) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new ValidationError(`Invalid ${errorLabel}: ${details}`, result.error.issues);
    }
    return result.data;
}
class ValidationError extends Error {
    constructor(message, issues) {
        super(message);
        this.name = 'ValidationError';
        this.issues = issues;
    }
}
exports.ValidationError = ValidationError;
