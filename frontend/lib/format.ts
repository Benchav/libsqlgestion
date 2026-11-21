export function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function formatPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  const percent = value * 100;
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

export function formatRatio(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 100) return `${Math.round(value)}:1`;
  if (value >= 10) return `${value.toFixed(0)}:1`;
  return `${value.toFixed(1)}:1`;
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';

  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatDayLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
