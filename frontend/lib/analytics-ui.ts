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
