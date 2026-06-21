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
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  project?: { id: string; name: string };
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
  });
}

export function useCreateDatabase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { projectId: string; name: string; type: string }) => {
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
