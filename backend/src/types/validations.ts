import { z } from 'zod';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nonEmptyString = z.string().trim().min(1).max(512);
const optionalString = z.string().max(512).optional();

export const createDatabaseSchema = z.object({
  projectId: z.string().uuid(),
  name: nonEmptyString,
  type: z.enum(['sqlite', 'libsql', 'remote']),
  url: optionalString,
  token: optionalString,
  subdomain: optionalString,
  metadata: z.record(z.unknown()).optional(),
});

export const importSqliteSchema = z.object({
  projectId: z.string().uuid(),
  name: optionalString,
  sourceName: optionalString,
  sourcePath: z.string().min(1),
  subdomain: optionalString,
  token: optionalString,
  metadata: z.record(z.unknown()).optional(),
});

export const updateDatabaseSchema = z.object({
  name: optionalString,
  status: z.enum(['active', 'inactive', 'error']).optional(),
});

export const executeQuerySchema = z.object({
  sql: z.string().min(1).max(65536),
  params: z.array(z.unknown()).default([]),
});

export const createProjectSchema = z.object({
  name: nonEmptyString,
});

export const backupDatabaseSchema = z.object({
  name: nonEmptyString,
});

export const renameTableSchema = z.object({
  name: identifier,
});

export const addColumnSchema = z.object({
  name: identifier,
  type: z.string().min(1).max(256).regex(/^[A-Z0-9_\s(),]+$/i),
  notnull: z.boolean().optional(),
  defaultValue: optionalString,
  unique: z.boolean().optional(),
});

export const renameColumnSchema = z.object({
  name: identifier,
});

export const changeColumnTypeSchema = z.object({
  type: z.string().min(1).max(256).regex(/^[A-Z0-9_\s(),]+$/i),
});

export const registerUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export const assignRoleSchema = z.object({
  roleName: z.string().min(1).max(128),
});

export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: optionalString,
});

export const scanDirectorySchema = z.object({
  projectId: z.string().uuid(),
  path: z.string().min(1),
  adopt: z.boolean().optional(),
});

export const adoptDatabaseSchema = z.object({
  projectId: z.string().uuid(),
  sourcePath: z.string().min(1),
  name: optionalString,
  subdomain: optionalString,
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const publicDatabaseSettingsSchema = z.object({
  domain: optionalString,
  template: optionalString,
  baseUrl: optionalString,
  host: optionalString,
  protocol: z.enum(['http', 'https']).optional(),
});

export function parseAndValidate<T>(schema: z.ZodSchema<T>, data: unknown, errorLabel: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ValidationError(`Invalid ${errorLabel}: ${details}`, result.error.issues);
  }
  return result.data;
}

export class ValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
