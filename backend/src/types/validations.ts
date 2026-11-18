import { z } from 'zod';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nonEmptyString = z.string().trim().min(1).max(512);
const optionalString = z.string().max(512).optional();

export const primaryModeSchema = z.enum(['auto', 'namespace', 'runtime']);
export const storageModeSchema = z.enum(['auto', 'local', 'namespace', 'runtime']);

export const createDatabaseSchema = z.object({
  projectId: z.string().uuid(),
  name: nonEmptyString,
  type: z.enum(['sqlite', 'libsql', 'remote']),
  url: optionalString,
  token: optionalString,
  subdomain: optionalString,
  primaryMode: primaryModeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const importSqliteSchema = z.object({
  projectId: z.string().uuid(),
  name: optionalString,
  sourceName: optionalString,
  sourcePath: z.string().min(1),
  subdomain: optionalString,
  token: optionalString,
  storageMode: storageModeSchema.optional().default('auto'),
  metadata: z.record(z.unknown()).optional(),
});

export const updateDatabaseSchema = z.object({
  name: optionalString,
  status: z.enum(['active', 'inactive', 'error']).optional(),
});

export const convertToRuntimeSchema = z.object({
  subdomain: optionalString,
});

export const executeQuerySchema = z.object({
  sql: z.string().min(1).max(65536),
  params: z.array(z.unknown()).default([]),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  countTotal: z.boolean().optional(),
  source: z.enum(['studio', 'api']).optional(),
});

export const createProjectSchema = z.object({
  name: nonEmptyString,
});

export const backupDatabaseSchema = z.object({
  name: nonEmptyString,
});

export const restoreSnapshotSchema = z.object({
  name: optionalString,
});

export const snapshotListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.coerce.date().optional(),
});

export const snapshotPolicySchema = z.object({
  restorePointIntervalMinutes: z.coerce.number().int().min(5).max(1440).optional(),
  dailyEnabled: z.boolean().optional(),
  dailyAtHour: z.coerce.number().int().min(0).max(23).optional(),
  dailyRetention: z.coerce.number().int().min(1).max(365).optional(),
  weeklyEnabled: z.boolean().optional(),
  weeklyDayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
  weeklyAtHour: z.coerce.number().int().min(0).max(23).optional(),
  weeklyRetention: z.coerce.number().int().min(1).max(365).optional(),
  monthlyEnabled: z.boolean().optional(),
  monthlyDayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
  monthlyAtHour: z.coerce.number().int().min(0).max(23).optional(),
  monthlyRetention: z.coerce.number().int().min(1).max(365).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
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

export const changeEmailSchema = z.object({
  email: z.string().email().max(254),
  currentPassword: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export const createUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  roleName: z.string().trim().min(1).max(128).optional(),
});

export const updateUserSchema = z.object({
  email: z.string().email().max(254).optional(),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean().optional(),
});

export const assignRoleSchema = z.object({
  roleName: z.string().min(1).max(128),
});

export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: optionalString,
});

export const analyticsQuerySchema = z.object({
  range: z.enum(['today', '7d', '30d', 'month']).optional(),
  from: optionalString,
  to: optionalString,
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
