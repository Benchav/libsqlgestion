export const OPERATION_COLORS: Record<string, string> = {
  select: '#34d399',
  insert: '#a78bfa',
  update: '#f59e0b',
  delete: '#f87171',
  replace: '#f472b6',
  pragma: '#38bdf8',
  other: '#71717a',
};

export function operationLabel(operation: string | undefined) {
  const value = (operation || 'other').toLowerCase();
  if (value === 'select') return 'SELECT';
  return value.toUpperCase();
}

export function sourceLabel(source: string | null | undefined) {
  if (!source) return 'No traffic';
  if (source === 'gateway') return 'Gateway (ERP)';
  if (source === 'api') return 'API';
  if (source === 'pipeline') return 'Pipeline';
  if (source === 'studio') return 'Studio';
  if (source === 'migration') return 'Migration';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export type TrafficPathKind = 'panel' | 'gateway' | 'health' | 'other';

export type TrafficOriginSummary = {
  panel: { requests: number; bytes: number };
  gateway: { requests: number; bytes: number };
  health: { requests: number; bytes: number };
  other: { requests: number; bytes: number };
};

export const TRAFFIC_KIND_COLORS: Record<TrafficPathKind, string> = {
  panel: '#a78bfa',
  gateway: '#22d3ee',
  health: '#71717a',
  other: '#f59e0b',
};

export function trafficPathKind(path: string | null | undefined): TrafficPathKind {
  const value = String(path || '').toLowerCase();
  if (value.startsWith('/api/v1/')) return 'panel';
  if (value.includes('/v2/pipeline') || value.includes('/pipeline')) return 'gateway';
  if (value.endsWith('/health') || value.endsWith('/version') || value === '/' || value === '') return 'health';
  return 'other';
}

export function trafficKindLabel(kind: TrafficPathKind) {
  if (kind === 'panel') return 'Panel';
  if (kind === 'gateway') return 'Gateway';
  if (kind === 'health') return 'Health';
  return 'Other';
}

export function trafficPathLabel(path: string | null | undefined) {
  const value = String(path || '');
  const lower = value.toLowerCase();

  if (lower.startsWith('/api/v1/databases/')) {
    if (lower.includes('/snapshots')) return 'Panel · snapshots';
    if (lower.includes('/schema')) return 'Panel · schema';
    if (lower.includes('/query')) return 'Panel · query';
    if (lower.includes('/migrations')) return 'Panel · migrations';
    if (lower.includes('/health-check')) return 'Panel · health check';
    if (lower.includes('/metrics')) return 'Panel · metrics';
    if (lower.includes('/backup')) return 'Panel · backup';
    if (lower.includes('/v2/pipeline')) return 'Panel · pipeline';
    return 'Panel · database API';
  }

  if (lower.startsWith('/api/v1/')) {
    if (lower.includes('/analytics')) return 'Panel · analytics';
    if (lower.includes('/snapshots')) return 'Panel · snapshots';
    return 'Panel · API';
  }

  if (lower.includes('/v2/pipeline') || lower.includes('/pipeline')) return 'libSQL pipeline';
  if (lower.endsWith('/health') || lower === '/') return 'Health check';
  if (lower.endsWith('/version')) return 'Version probe';
  return value || 'Unknown path';
}

export function summarizeTrafficPaths(paths: Array<{ path: string; requests: number; bytes: number }>) {
  const summary: TrafficOriginSummary = {
    panel: { requests: 0, bytes: 0 },
    gateway: { requests: 0, bytes: 0 },
    health: { requests: 0, bytes: 0 },
    other: { requests: 0, bytes: 0 },
  };

  for (const item of paths) {
    const kind = trafficPathKind(item.path);
    summary[kind].requests += item.requests;
    summary[kind].bytes += item.bytes;
  }

  return summary;
}
