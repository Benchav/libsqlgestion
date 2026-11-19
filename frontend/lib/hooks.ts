'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

// ----- Types -----

export type ProjectInfo = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
};

export type DatabaseInfo = {
  id: string;
  name: string;
  type: string;
  effectiveType?: string;
  runtimeProvider?: string;
  status: string;
  subdomain?: string;
  createdAt: string;
  project?: { id: string; name: string };
};

export type DatabaseDetail = {
  id: string;
  name: string;
  type: string;
  effectiveType?: string;
  runtimeProvider?: string;
  status: string;
  subdomain?: string;
  url?: string;
  connectionUrl?: string;
  publicConnectionUrl?: string;
  publicHttpsUrl?: string;
  publicLibsqlUrl?: string;
  internalConnectionUrl?: string;
  internalLibsqlUrl?: string;
  backendConnectionUrl?: string;
  backendReachableUrl?: string;
  runtimeStatus?: string;
  exposureMode?: string;
  runtimeHealth?: {
    checkedAt?: string;
    internalOk?: boolean;
    backendOk?: boolean;
    publicOk?: boolean;
    publicChecked?: boolean;
    internalError?: string;
    backendError?: string;
    publicError?: string;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  project?: { id: string; name: string };
};

export type StorageCapabilities = {
  namespace: {
    enabled: boolean;
    publicEnabled: boolean;
    available: boolean;
    usable: boolean;
    reason?: string | null;
  };
  runtime: {
    enabled: boolean;
    available: boolean;
    reason?: string | null;
  };
  local: {
    allowed: boolean;
  };
  requirePrimary: boolean;
  preferredMode: 'auto' | 'namespace' | 'runtime';
  defaultMode: 'namespace' | 'runtime' | 'local' | null;
  publicDomain: string;
  publicProtocol: string;
  runtimeTlsConfigured: boolean;
  maxUploadBytes: number;
  supportsUploadCompression?: boolean;
};

export type DatabaseSnapshot = {
  id: string;
  databaseId: string;
  status: 'pending' | 'ready' | 'failed' | 'deleted';
  reason: 'scheduled' | 'manual' | 'pre_restore';
  fileName: string;
  format?: 'sqlite' | 'libsql-sql-dump' | 'libsql-sqlite-export';
  verified?: boolean;
  sizeBytes: number;
  totalSizeBytes?: number;
  downloadFormats?: Array<'db' | 'sql'>;
  warning?: string;
  checksumSha256?: string;
  milestones?: Partial<Record<'daily' | 'weekly' | 'monthly', string>>;
  takenAt: string;
  expiresAt?: string | null;
  pinned: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotEnginePolicy = {
  intervalMinutes: number;
  fullWindowHours: number;
  sixHourlyWindowHours: number;
  retentionDays: number;
  maxConcurrent: number;
};

export type SnapshotListResponse = {
  snapshots: DatabaseSnapshot[];
  totalSizeBytes: number;
  hasMore: boolean;
  policy: SnapshotEnginePolicy;
};

export type DatabaseSnapshotPolicy = {
  databaseId: string;
  restorePointIntervalMinutes: number;
  dailyEnabled: boolean;
  dailyAtHour: number;
  dailyRetention: number;
  weeklyEnabled: boolean;
  weeklyDayOfWeek: number;
  weeklyAtHour: number;
  weeklyRetention: number;
  monthlyEnabled: boolean;
  monthlyDayOfMonth: number;
  monthlyAtHour: number;
  monthlyRetention: number;
  timezone: string;
  isDefault: boolean;
};

export type AuditLogEntry = {
  id: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  actor?: { id: string; email: string };
};

export type MetricInfo = {
  totalDiskBytes?: number;
  totalRamBytes?: number;
  maxRamBytes?: number;
  cpuUsagePercent?: number;
  sampledAt?: string;
  cacheTtlMs?: number;
  databases: Array<Record<string, unknown>>;
  system?: Record<string, unknown>;
};

// ----- Project Hooks -----

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const result = await apiRequest<{ projects: ProjectInfo[] }>('/projects');
      return result.projects;
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string }) => {
      const result = await apiRequest<{ project: ProjectInfo }>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return result.project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ----- Database Hooks -----

export function useDatabases() {
  return useQuery({
    queryKey: ['databases'],
    queryFn: async () => {
      const result = await apiRequest<{ databases: DatabaseInfo[] }>('/databases');
      return result.databases;
    },
    refetchInterval: (query) => {
      const list = query.state.data;
      if (Array.isArray(list) && list.some((d) => d.status === 'provisioning')) {
        return 2500;
      }
      return false;
    },
  });
}

export function useStorageCapabilities() {
  return useQuery({
    queryKey: ['storage-capabilities'],
    queryFn: async () => apiRequest<StorageCapabilities>('/databases/storage-capabilities'),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useDatabase(id: string | undefined) {
  return useQuery({
    queryKey: ['database', id],
    queryFn: async () => {
      const result = await apiRequest<{ database: DatabaseDetail }>(`/databases/${id}`);
      return result.database;
    },
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const db = query.state.data;
      if (db?.status === 'provisioning') {
        return 2500;
      }
      return false;
    },
  });
}

export function useCreateDatabase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { projectId: string; name: string; type: string; subdomain?: string; primaryMode?: 'auto' | 'namespace' | 'runtime' }) => {
      const result = await apiRequest<{ database: DatabaseDetail; token: string }>('/databases', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
    },
  });
}

export function useCreateBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId, name }: { sourceId: string; name: string }) => {
      const result = await apiRequest<{ database: DatabaseDetail; token: string }>(`/databases/${sourceId}/backup`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
    },
  });
}

export function useSnapshots(databaseId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['snapshots', databaseId],
    queryFn: async () => {
      return apiRequest<SnapshotListResponse>(`/databases/${databaseId}/snapshots?limit=100`);
    },
    enabled: Boolean(databaseId) && enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.snapshots?.some((snapshot) => snapshot.status === 'pending')) {
        return 2000;
      }
      return 60_000;
    },
  });
}

export function useSnapshotPolicy(databaseId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['snapshot-policy', databaseId],
    queryFn: async () => {
      return apiRequest<{ policy: DatabaseSnapshotPolicy }>(`/databases/${databaseId}/snapshot-policy`);
    },
    enabled: Boolean(databaseId) && enabled,
  });
}

export function useUpdateSnapshotPolicy(databaseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Omit<DatabaseSnapshotPolicy, 'databaseId' | 'isDefault'>>) => {
      return apiRequest<{ policy: DatabaseSnapshotPolicy }>(`/databases/${databaseId}/snapshot-policy`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snapshot-policy', databaseId] });
      queryClient.invalidateQueries({ queryKey: ['snapshots', databaseId] });
    },
  });
}

export function useCreateSnapshot(databaseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return apiRequest<{ snapshot: DatabaseSnapshot }>(`/databases/${databaseId}/snapshots`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snapshots', databaseId] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export function useDeleteSnapshot(databaseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotId: string) => {
      await apiRequest(`/databases/${databaseId}/snapshots/${snapshotId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snapshots', databaseId] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export function useRestoreSnapshot(databaseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      snapshotId,
      name,
      artifactFormat,
    }: { snapshotId: string; name?: string; artifactFormat?: 'db' | 'sql' }) => {
      return apiRequest<{ database: DatabaseDetail; token: string }>(
        `/databases/${databaseId}/snapshots/${snapshotId}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ name: name || undefined, artifactFormat }),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export function useDeleteDatabase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/databases/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
    },
  });
}

export function useRotateToken(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await apiRequest<{ database: DatabaseDetail; token: string }>(`/databases/${id}/rotate-token`, { method: 'PATCH' });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['database', id] });
    },
  });
}

export function useTestConnection(id: string) {
  return useMutation({
    mutationFn: async () => {
      return apiRequest<{ ok: boolean; details: string }>(`/databases/${id}/test-connection`, { method: 'POST' });
    },
  });
}

export function useExecuteQuery(id: string) {
  return useMutation({
    mutationFn: async (sql: string) => {
      return apiRequest<{
        ok: boolean;
        rows?: unknown[];
        result?: { changes: number };
        rowsAffected?: number;
        statementsExecuted?: number;
        statementResults?: unknown[];
        error?: string;
      }>(`/databases/${id}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql, params: [] }),
      });
    },
  });
}

// ----- Audit Hooks -----

export function useAuditLogs(page: number = 1, limit: number = 50, search: string = '') {
  return useQuery({
    queryKey: ['audit', page, limit, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(limit));
      if (search) params.set('search', search);
      return apiRequest<{ logs: AuditLogEntry[]; total: number; page: number; limit: number; hasMore: boolean }>(`/audit?${params.toString()}`);
    },
  });
}

// ----- Metrics Hooks -----

export function useMetrics() {
  return useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      return apiRequest<MetricInfo>('/metrics');
    },
    refetchInterval: 15_000,
  });
}

// ----- Schema Hooks -----

export function useSchema(id: string | undefined) {
  return useQuery({
    queryKey: ['schema', id],
    queryFn: async () => {
      return apiRequest<{ tables: unknown[]; views: unknown[] }>(`/databases/${id}/schema`);
    },
    enabled: Boolean(id),
  });
}
