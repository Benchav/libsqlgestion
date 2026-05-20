"use client";

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { AppShell } from '../../../../components/AppShell';
import { TableSidebar } from '../../../../components/studio/TableSidebar';
import { DataGrid } from '../../../../components/studio/DataGrid';
import { ContextMenu, type ContextMenuItem } from '../../../../components/studio/ContextMenu';
import { SqlRunner } from '../../../../components/studio/SqlRunner';
import { ChevronRight, X, AlertTriangle, Pencil, Plus, Trash2, Edit3, Settings2 } from 'lucide-react';

type ColumnMeta = { cid: number; name: string; type: string; notnull: number; pk: number };
type TableSchema = { table: string; kind: 'table' | 'view'; rowCount: number; columns: ColumnMeta[]; foreignKeys: unknown[] };
type DatabaseInfo = { id: string; name: string; type: string; status: string };
type RowMode = 'insert' | 'edit';
type MenuTarget =
  | { type: 'table'; table: string }
  | { type: 'column'; column: string }
  | { type: 'row'; rowIndex: number };

type MenuState = {
  open: boolean;
  x: number;
  y: number;
  target: MenuTarget | null;
};

function getColumnInputKind(column: ColumnMeta): 'text' | 'number' | 'date' | 'datetime-local' | 'checkbox' {
  const type = (column.type || '').toUpperCase();
  if (type.includes('BOOL')) return 'checkbox';
  if (type.includes('DATE') && !type.includes('TIME')) return 'date';
  if (type.includes('TIME') || type.includes('TIMESTAMP')) return 'datetime-local';
  if (type.includes('INT') || type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE') || type.includes('NUMERIC') || type.includes('DECIMAL')) {
    return 'number';
  }
  return 'text';
}

function isTruthyValue(value: string) {
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value.toLowerCase() === 'on';
}

const PAGE_SIZE = 50;

export default function StudioPage() {
  const params = useParams();
  const router = useRouter();
  const dbId = params?.id as string;

  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [activeKind, setActiveKind] = useState<'table' | 'view'>('table');
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'data' | 'sql'>('data');

  // Data grid state
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [page, setPage] = useState(0);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [gridLoading, setGridLoading] = useState(false);

  // Manual insert state
  const [isInsertOpen, setIsInsertOpen] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [insertSaving, setInsertSaving] = useState(false);
  const [insertError, setInsertError] = useState('');

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editRowIndex, setEditRowIndex] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // SQL runner state
  const [sqlResult, setSqlResult] = useState<{ ok: boolean; rows?: unknown[]; error?: string; changes?: number; statementsExecuted?: number; statementResults?: Array<{ index: number; sql: string; kind: 'read' | 'write'; rows?: unknown[]; rowsAffected?: number; lastInsertRowid?: unknown }> } | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);

  const [error, setError] = useState('');
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingTable, setRenamingTable] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [columnDialog, setColumnDialog] = useState<{ mode: 'add' | 'rename'; table: string; column?: string } | null>(null);
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('TEXT');
  const [columnNotNull, setColumnNotNull] = useState(false);
  const [columnDefaultValue, setColumnDefaultValue] = useState('');
  const [columnError, setColumnError] = useState('');
  const [columnSaving, setColumnSaving] = useState(false);
  const [columnRiskMode, setColumnRiskMode] = useState<'delete' | 'type' | null>(null);
  const [columnRiskTarget, setColumnRiskTarget] = useState('');
  const [columnRiskType, setColumnRiskType] = useState('TEXT');
  const [selectedColumn, setSelectedColumn] = useState('');
  const [contextMenu, setContextMenu] = useState<MenuState>({ open: false, x: 0, y: 0, target: null });

  const visibleSchemas = tables.filter((schema) => schema.kind === activeKind);
  const currentTableSchema = tables.find((schema) => schema.table === activeTable);

  // Load database info
  useEffect(() => {
    if (!dbId) return;
    apiRequest<{ database: DatabaseInfo }>(`/databases/${dbId}`)
      .then((r) => setDatabase(r.database))
      .catch((err: any) => setError(err.message));
  }, [dbId]);

  // Load schema
  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    try {
      const result = await apiRequest<{ tables: TableSchema[]; views: TableSchema[] }>(`/databases/${dbId}/schema`);
      const combined = [...(result.tables || []), ...(result.views || [])];
      setTables(combined);
      const initialGroup = combined.filter((schema) => schema.kind === activeKind);
      if (!activeTable && initialGroup.length > 0) {
        setActiveTable(initialGroup[0].table);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSchemaLoading(false);
    }
  }, [dbId, activeTable]);

  useEffect(() => {
    if (dbId) loadSchema();
  }, [dbId]);

  // Load table data
  const loadTableData = useCallback(async () => {
    if (!activeTable || !dbId) return;
    setGridLoading(true);
    try {
      const countResult = await apiRequest<{ ok: boolean; rows: Array<{ cnt: number }> }>(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: `SELECT COUNT(*) as cnt FROM "${activeTable}"` }),
      });
      const count = countResult.rows?.[0]?.cnt ?? 0;
      setTotalRows(count);

      const orderClause = sortColumn ? ` ORDER BY "${sortColumn}" ${sortDir}` : '';
      const dataResult = await apiRequest<{ ok: boolean; rows: Record<string, unknown>[] }>(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `SELECT * FROM "${activeTable}"${orderClause} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
        }),
      });
      setRows(dataResult.rows || []);
    } catch (err: any) {
      setError(err.message);
      setRows([]);
    } finally {
      setGridLoading(false);
    }
  }, [dbId, activeTable, page, sortColumn, sortDir]);

  useEffect(() => {
    loadTableData();
  }, [loadTableData]);

  function handleSelectTable(table: string) {
    setActiveTable(table);
    setPage(0);
    setSortColumn(null);
    setSortDir('ASC');
    setIsInsertOpen(false);
    setIsEditOpen(false);
  }

  function handleSelectKind(kind: 'table' | 'view') {
    setActiveKind(kind);
    const nextSchema = tables.find((schema) => schema.kind === kind);
    if (nextSchema) {
      setActiveTable(nextSchema.table);
    } else {
      setActiveTable(null);
    }
    setPage(0);
    setSortColumn(null);
    setSortDir('ASC');
    setIsInsertOpen(false);
    setIsEditOpen(false);
  }

  function handleSort(column: string, dir: 'ASC' | 'DESC') {
    setSortColumn(column);
    setSortDir(dir);
    setPage(0);
  }

  async function handleCellEdit(rowIndex: number, column: string, value: unknown) {
    if (!activeTable) return;
    const row = rows[rowIndex];
    const activeTableSchema = tables.find((t) => t.table === activeTable);
    const pkCol = activeTableSchema?.columns.find((c) => c.pk === 1);

    if (!pkCol) {
      setError('Cannot edit: table has no primary key');
      return;
    }

    const pkValue = row[pkCol.name];
    const sqlValue = value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
    const pkSqlValue = typeof pkValue === 'number' ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;

    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `UPDATE "${activeTable}" SET "${column}" = ${sqlValue} WHERE "${pkCol.name}" = ${pkSqlValue}`,
        }),
      });
      await loadTableData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteRow(rowIndex: number) {
    if (!activeTable) return;
    const row = rows[rowIndex];
    const activeTableSchema = tables.find((t) => t.table === activeTable);
    const pkCol = activeTableSchema?.columns.find((c) => c.pk === 1);

    if (!pkCol) {
      setError('Cannot delete: table has no primary key');
      return;
    }

    const pkValue = row[pkCol.name];
    if (!confirm(`Delete row with ${pkCol.name} = ${pkValue}?`)) return;

    const pkSqlValue = typeof pkValue === 'number' ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;

    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `DELETE FROM "${activeTable}" WHERE "${pkCol.name}" = ${pkSqlValue}`,
        }),
      });
      await loadTableData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddRow() {
    if (!activeTable || currentTableSchema?.kind !== 'table') return;
    const activeTableSchema = tables.find((t) => t.table === activeTable);
    if (!activeTableSchema) return;

    const cols = activeTableSchema.columns.filter((c) => c.pk !== 1);
    if (cols.length === 0) {
      try {
        await apiRequest(`/databases/${dbId}/query`, {
          method: 'POST',
          body: JSON.stringify({ sql: `INSERT INTO "${activeTable}" DEFAULT VALUES` }),
        });
        await loadTableData();
      } catch (err: any) {
        setError(err.message);
      }
      return;
    }

    const colNames = cols.map((c) => `"${c.name}"`).join(', ');
    const colValues = cols.map((c) => (c.notnull ? "''" : 'NULL')).join(', ');
    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `INSERT INTO "${activeTable}" (${colNames}) VALUES (${colValues})`,
        }),
      });
      const newCount = totalRows + 1;
      const lastPage = Math.max(0, Math.ceil(newCount / PAGE_SIZE) - 1);
      setPage(lastPage);
      await loadTableData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleOpenInsertRow() {
    if (!currentTableSchema || currentTableSchema.kind !== 'table') return;
    const initialValues: Record<string, string> = {};
    currentTableSchema.columns.forEach((column) => {
      initialValues[column.name] = '';
    });
    setInsertValues(initialValues);
    setInsertError('');
    setIsInsertOpen(true);
  }

  function handleOpenEditRow(rowIndex: number) {
    if (!currentTableSchema || currentTableSchema.kind !== 'table') return;
    const row = rows[rowIndex];
    const initialValues: Record<string, string> = {};
    currentTableSchema.columns.forEach((column) => {
      const value = row[column.name];
      initialValues[column.name] = value === null || value === undefined ? '' : String(value);
    });
    setEditRowIndex(rowIndex);
    setEditValues(initialValues);
    setEditError('');
    setIsEditOpen(true);
  }

  async function handleInsertRow() {
    if (!activeTable || !currentTableSchema || currentTableSchema.kind !== 'table') return;

    const insertColumns = currentTableSchema.columns;
    const missingRequired = insertColumns
      .filter((column) => column.notnull === 1 && column.pk !== 1)
      .find((column) => insertValues[column.name] === undefined || insertValues[column.name].trim() === '');

    if (missingRequired) {
      setInsertError(`Column "${missingRequired.name}" is required.`);
      return;
    }

    const columnsSql = insertColumns.map((column) => `"${column.name}"`).join(', ');
    const placeholders = insertColumns.map(() => '?').join(', ');
    const params = insertColumns.map((column) => {
      const rawValue = insertValues[column.name];
      if (rawValue === undefined || rawValue.trim() === '') return null;
      return rawValue;
    });

    setInsertSaving(true);
    setInsertError('');
    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `INSERT INTO "${activeTable}" (${columnsSql}) VALUES (${placeholders})`,
          params,
        }),
      });
      setIsInsertOpen(false);
      await loadTableData();
      loadSchema();
    } catch (err: any) {
      setInsertError(err.message);
    } finally {
      setInsertSaving(false);
    }
  }

  async function handleSaveEditRow() {
    if (editRowIndex === null || !activeTable || !currentTableSchema || currentTableSchema.kind !== 'table') return;

    const row = rows[editRowIndex];
    const pkColumns = currentTableSchema.columns.filter((column) => column.pk === 1);
    const pkCol = pkColumns[0];

    if (!pkCol) {
      setEditError('Cannot edit: table has no primary key.');
      return;
    }

    const missingRequired = currentTableSchema.columns
      .filter((column) => column.notnull === 1 && column.pk !== 1)
      .find((column) => editValues[column.name] === undefined || editValues[column.name].trim() === '');

    if (missingRequired) {
      setEditError(`Column "${missingRequired.name}" is required.`);
      return;
    }

    const pkValue = row[pkCol.name];

    const editableColumns = currentTableSchema.columns.filter((column) => column.pk !== 1);
    const setClauses = editableColumns.map((column) => `"${column.name}" = ?`).join(', ');
    const params = editableColumns.map((column) => {
      const rawValue = editValues[column.name];
      if (rawValue === undefined || rawValue.trim() === '') return null;
      return rawValue;
    });
    params.push(pkValue === null || pkValue === undefined ? null : String(pkValue));

    setEditSaving(true);
    setEditError('');
    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `UPDATE "${activeTable}" SET ${setClauses} WHERE "${pkCol.name}" = ?`,
          params,
        }),
      });
      setIsEditOpen(false);
      setEditRowIndex(null);
      await loadTableData();
      loadSchema();
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  async function handleSqlExecute(sql: string) {
    setSqlLoading(true);
    setSqlResult(null);
    try {
      const result = await apiRequest<{ ok: boolean; rows?: unknown[]; result?: { changes: number }; statementsExecuted?: number; statementResults?: Array<{ index: number; sql: string; kind: 'read' | 'write'; rows?: unknown[]; rowsAffected?: number; lastInsertRowid?: unknown }> }>(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql }),
      });
      setSqlResult({
        ok: result.ok !== false,
        rows: result.rows,
        changes: result.result?.changes,
        statementsExecuted: result.statementsExecuted,
        statementResults: result.statementResults,
      });
      loadSchema();
      if (activeTable) loadTableData();
    } catch (err: any) {
      setSqlResult({ ok: false, error: err.message });
    } finally {
      setSqlLoading(false);
    }
  }

  async function handleDeleteTable(tableName: string) {
    setDeleteTarget(tableName);
    setDeleteError('');
  }

  function handleOpenRenameTable(tableName: string) {
    setRenameTarget(tableName);
    setRenameValue(tableName);
    setRenameError('');
  }

  function handleOpenAddColumn() {
    if (!activeTable) return;
    setColumnDialog({ mode: 'add', table: activeTable });
    setColumnName('');
    setColumnType('TEXT');
    setColumnNotNull(false);
    setColumnDefaultValue('');
    setColumnError('');
  }

  function handleOpenRenameColumn(column: string) {
    if (!activeTable) return;
    setColumnDialog({ mode: 'rename', table: activeTable, column });
    setColumnName(column);
    setColumnType('TEXT');
    setColumnNotNull(false);
    setColumnDefaultValue('');
    setColumnError('');
  }

  function handleOpenDeleteColumn(column: string) {
    if (!activeTable) return;
    setColumnRiskMode('delete');
    setColumnRiskTarget(column);
    setColumnError('');
  }

  function handleOpenChangeColumnType(column: string) {
    if (!activeTable) return;
    setColumnRiskMode('type');
    setColumnRiskTarget(column);
    setColumnRiskType('TEXT');
    setColumnError('');
  }

  const closeContextMenu = useCallback(() => {
    setContextMenu((current) => ({ ...current, open: false, target: null }));
  }, []);

  const openContextMenu = useCallback((x: number, y: number, target: MenuTarget) => {
    setContextMenu({ open: true, x, y, target });
  }, []);

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu.target) return [];
    const target = contextMenu.target;

    if (target.type === 'table') {
      return [
        { label: 'Rename table', icon: <Edit3 size={14} />, onClick: () => handleOpenRenameTable(target.table) },
        { label: 'Delete table', icon: <Trash2 size={14} />, danger: true, onClick: () => handleDeleteTable(target.table) },
      ];
    }

    if (target.type === 'column') {
      if (!currentTableSchema || currentTableSchema.kind !== 'table') return [];
      return [
        { label: 'Rename column', icon: <Edit3 size={14} />, onClick: () => handleOpenRenameColumn(target.column) },
        { label: 'Change type', icon: <Settings2 size={14} />, onClick: () => handleOpenChangeColumnType(target.column) },
        { label: 'Delete column', icon: <Trash2 size={14} />, danger: true, onClick: () => handleOpenDeleteColumn(target.column) },
      ];
    }

    if (!currentTableSchema || currentTableSchema.kind !== 'table') return [];

    return [
      { label: 'Edit row', icon: <Pencil size={14} />, onClick: () => handleOpenEditRow(target.rowIndex) },
      { label: 'Delete row', icon: <Trash2 size={14} />, danger: true, onClick: () => handleDeleteRow(target.rowIndex) },
    ];
  }, [contextMenu.target, currentTableSchema]);

  async function confirmDeleteTable() {
    if (!deleteTarget || !activeTable) return;

    setDeletingTable(true);
    setDeleteError('');
    try {
      await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(deleteTarget)}`, {
        method: 'DELETE',
      });

      setDeleteTarget(null);
      await loadSchema();
      setActiveTable((current) => (current === deleteTarget ? null : current));
      setPage(0);
      setRows([]);
      setTotalRows(0);
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeletingTable(false);
    }
  }

  async function confirmRenameTable() {
    if (!renameTarget || !renameValue.trim()) return;

    setRenamingTable(true);
    setRenameError('');
    try {
      await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(renameTarget)}/rename`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameValue.trim() }),
      });

      const nextName = renameValue.trim();
      setRenameTarget(null);
      setRenameValue('');
      await loadSchema();
      setActiveTable((current) => (current === renameTarget ? nextName : current));
    } catch (err: any) {
      setRenameError(err.message);
    } finally {
      setRenamingTable(false);
    }
  }

  async function confirmColumnAction() {
    if (!columnDialog || !activeTable) return;
    if (!columnName.trim()) return;

    setColumnSaving(true);
    setColumnError('');
    try {
      if (columnDialog.mode === 'add') {
        const defaultValue = columnDefaultValue.trim();
        await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(columnDialog.table)}/columns`, {
          method: 'POST',
          body: JSON.stringify({
            name: columnName.trim(),
            type: columnType.trim(),
            notnull: columnNotNull,
            defaultValue: defaultValue || undefined,
          }),
        });
      } else if (columnDialog.column) {
        await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(columnDialog.table)}/columns/${encodeURIComponent(columnDialog.column)}/rename`, {
          method: 'PATCH',
          body: JSON.stringify({ name: columnName.trim() }),
        });
      }

      setColumnDialog(null);
      await loadSchema();
    } catch (err: any) {
      setColumnError(err.message);
    } finally {
      setColumnSaving(false);
    }
  }

  async function confirmColumnRiskAction() {
    if (!activeTable || !columnRiskMode || !columnRiskTarget) return;

    setColumnSaving(true);
    setColumnError('');
    try {
      if (columnRiskMode === 'delete') {
        await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(activeTable)}/columns/${encodeURIComponent(columnRiskTarget)}`, {
          method: 'DELETE',
        });
      } else {
        await apiRequest(`/databases/${dbId}/schema/tables/${encodeURIComponent(activeTable)}/columns/${encodeURIComponent(columnRiskTarget)}/type`, {
          method: 'PATCH',
          body: JSON.stringify({ type: columnRiskType.trim() }),
        });
      }

      setColumnRiskMode(null);
      setColumnRiskTarget('');
      await loadSchema();
    } catch (err: any) {
      setColumnError(err.message);
    } finally {
      setColumnSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="flex flex-col h-full bg-[#0a0a0a] text-zinc-300">
        {/* Topbar for Studio */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-[#09090b] text-sm flex-shrink-0 z-20">
          <div className="flex items-center text-zinc-400">
            <span className="cursor-pointer hover:text-zinc-200 transition-colors" onClick={() => router.push('/databases')}>Databases</span>
            <ChevronRight size={14} className="mx-2 text-zinc-600" />
            <span className="cursor-pointer hover:text-zinc-200 transition-colors" onClick={() => router.push(`/databases/${dbId}`)}>{database?.name || 'Database'}</span>
            <ChevronRight size={14} className="mx-2 text-zinc-600" />
            <span className="text-zinc-100 font-medium">Studio</span>
          </div>

          <div className="flex items-center gap-3">
            {database?.type && <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider">{database.type}</span>}
            {database?.status && <span className={`px-2 py-0.5 rounded text-[11px] font-medium border uppercase tracking-wider ${database.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>{database.status}</span>}
          </div>
        </div>

        {error && (
          <div className="m-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm flex-shrink-0 error-banner flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-400/60 hover:text-red-300 transition-colors shrink-0"><X size={14} /></button>
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <TableSidebar
            tables={visibleSchemas.map((t) => ({ table: t.table, kind: t.kind, rowCount: t.rowCount, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) }))}
            activeTable={activeTable}
            activeKind={activeKind}
            activeTab={activeTab}
            onSelectTable={handleSelectTable}
            onSelectKind={handleSelectKind}
            onSelectTab={setActiveTab}
            onRefresh={loadSchema}
            onTableMenu={(table, event) => openContextMenu(event.clientX, event.clientY, { type: 'table', table })}
            loading={schemaLoading}
          />

          <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a]">
            {activeTable && currentTableSchema && (
              <div className="flex items-center justify-between border-b border-zinc-800/80 bg-[#09090b] px-4 py-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-zinc-500">Selected table</div>
                  <div className="text-sm font-medium text-zinc-100">{activeTable}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenAddColumn}
                    className="inline-flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
                  >
                    <Plus size={14} /> Add column
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenRenameTable(activeTable)}
                    className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-[#0f0f0f] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    <Pencil size={14} /> Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteTable(activeTable)}
                    className="inline-flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20"
                  >
                    <AlertTriangle size={14} /> Delete
                  </button>
                </div>
              </div>
            )}

            {activeTable && currentTableSchema && (
              <div className="border-b border-zinc-800/80 bg-[#0b0b0d] px-4 py-3">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-zinc-500">Columns</div>
                    <div className="text-sm text-zinc-400">Select a column to edit safely.</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentTableSchema.columns.map((column) => (
                    <button
                      key={column.name}
                      type="button"
                      onClick={() => setSelectedColumn(column.name)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openContextMenu(event.clientX, event.clientY, { type: 'column', column: column.name });
                      }}
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${selectedColumn === column.name ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-zinc-800 bg-[#0f0f0f] text-zinc-300 hover:bg-zinc-800'}`}
                    >
                      <div className="font-medium">{column.name}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">{column.type || 'ANY'}</div>
                    </button>
                  ))}
                </div>
                {selectedColumn && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                    <button type="button" onClick={() => handleOpenRenameColumn(selectedColumn)} className="rounded-md border border-zinc-800 bg-[#0f0f0f] px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800">Rename column</button>
                    <button type="button" onClick={() => handleOpenChangeColumnType(selectedColumn)} className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/20">Change type</button>
                    <button type="button" onClick={() => handleOpenDeleteColumn(selectedColumn)} className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20">Delete column</button>
                  </div>
                )}
              </div>
            )}

            {/* Main Area */}
            {activeTab === 'data' && activeTable && currentTableSchema ? (
              <DataGrid
                tableName={activeTable}
                columns={currentTableSchema.columns}
                rows={rows}
                totalRows={totalRows}
                readOnly={currentTableSchema.kind === 'view'}
                page={page}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
                onSort={handleSort}
                sortColumn={sortColumn}
                sortDir={sortDir}
                onCellEdit={handleCellEdit}
                onEditRow={handleOpenEditRow}
                onDeleteRow={handleDeleteRow}
                onAddRow={handleAddRow}
                onInsertRow={handleOpenInsertRow}
                loading={gridLoading}
                onColumnMenu={(column, event) => openContextMenu(event.clientX, event.clientY, { type: 'column', column })}
                onRowMenu={(rowIndex, event) => openContextMenu(event.clientX, event.clientY, { type: 'row', rowIndex })}
              />
            ) : activeTab === 'data' && !activeTable ? (
              <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
                Select a table from the sidebar to view data.
              </div>
            ) : activeTab === 'sql' ? (
              <SqlRunner
                onExecute={handleSqlExecute}
                loading={sqlLoading}
                result={sqlResult}
              />
            ) : null}
          </div>
        </div>
      </div>

      {isInsertOpen && activeTable && currentTableSchema && (
        <InsertRowModal
          tableName={activeTable}
          columns={currentTableSchema.columns}
          values={insertValues}
          saving={insertSaving}
          error={insertError}
          onClose={() => setIsInsertOpen(false)}
          onChange={(column, value) => setInsertValues((current) => ({ ...current, [column]: value }))}
          onSave={handleInsertRow}
          mode="insert"
        />
      )}

      {isEditOpen && activeTable && currentTableSchema && editRowIndex !== null && (
        <InsertRowModal
          tableName={activeTable}
          columns={currentTableSchema.columns}
          values={editValues}
          saving={editSaving}
          error={editError}
          onClose={() => setIsEditOpen(false)}
          onChange={(column, value) => setEditValues((current) => ({ ...current, [column]: value }))}
          onSave={handleSaveEditRow}
          title="Edit Row"
          description={`Update the record in ${activeTable}.`}
          saveLabel="Save changes"
          mode="edit"
        />
      )}

      {activeTab === 'data' && currentTableSchema?.kind === 'view' && (
        <div className="fixed bottom-4 right-4 rounded-lg border border-zinc-800 bg-[#0f0f0f] px-4 py-3 text-sm text-zinc-300 shadow-2xl">
          Views are read-only. Use SQL if you need to modify underlying tables.
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-[#120f10] shadow-2xl">
            <div className="flex items-start gap-3 border-b border-red-500/20 px-6 py-5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500/10 text-red-400">
                <AlertTriangle size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-zinc-100">Delete table</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  This will permanently remove <span className="font-mono text-zinc-200">{deleteTarget}</span> and all of its data.
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="mx-6 mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {deleteError}
              </div>
            )}

            <div className="px-6 py-5">
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Warning: this action cannot be undone. Confirm only if you are sure.
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-red-500/20 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (!deletingTable) {
                    setDeleteTarget(null);
                    setDeleteError('');
                  }
                }}
                className="rounded-lg border border-zinc-800 bg-[#0f0f0f] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteTable}
                disabled={deletingTable}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-400 disabled:opacity-60"
              >
                {deletingTable ? 'Deleting...' : 'Delete table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-amber-500/30 bg-[#101114] shadow-2xl">
            <div className="flex items-start gap-3 border-b border-amber-500/20 px-6 py-5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500/10 text-amber-400">
                <Pencil size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-zinc-100">Rename table</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Rename <span className="font-mono text-zinc-200">{renameTarget}</span> to a new table name.
                </p>
              </div>
            </div>

            {renameError && (
              <div className="mx-6 mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {renameError}
              </div>
            )}

            <div className="px-6 py-5 space-y-3">
              <label className="block text-sm font-medium text-zinc-300">New name</label>
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                placeholder="new_table_name"
              />
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                This is safe for SQLite, but references in your app code may need to be updated.
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-amber-500/20 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (!renamingTable) {
                    setRenameTarget(null);
                    setRenameValue('');
                    setRenameError('');
                  }
                }}
                className="rounded-lg border border-zinc-800 bg-[#0f0f0f] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRenameTable}
                disabled={renamingTable || !renameValue.trim() || renameValue.trim() === renameTarget}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-amber-400 disabled:opacity-60"
              >
                {renamingTable ? 'Renaming...' : 'Rename table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {columnDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl border border-emerald-500/30 bg-[#101114] shadow-2xl">
            <div className="flex items-start gap-3 border-b border-emerald-500/20 px-6 py-5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                <Plus size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-zinc-100">{columnDialog.mode === 'add' ? 'Add column' : 'Rename column'}</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  {columnDialog.mode === 'add'
                    ? `Add a new column to ${columnDialog.table}.`
                    : `Rename the selected column in ${columnDialog.table}.`}
                </p>
              </div>
            </div>

            {columnError && (
              <div className="mx-6 mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {columnError}
              </div>
            )}

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">Column name</label>
                <input
                  value={columnName}
                  onChange={(event) => setColumnName(event.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                  placeholder="column_name"
                />
              </div>

              {columnDialog.mode === 'add' && (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-300">Type</label>
                    <input
                      value={columnType}
                      onChange={(event) => setColumnType(event.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                      placeholder="TEXT"
                    />
                  </div>
                  <label className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-3 text-sm text-zinc-300">
                    <input type="checkbox" checked={columnNotNull} onChange={(event) => setColumnNotNull(event.target.checked)} />
                    NOT NULL
                  </label>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-300">Default value</label>
                    <input
                      value={columnDefaultValue}
                      onChange={(event) => setColumnDefaultValue(event.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                      placeholder="Optional"
                    />
                  </div>
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                    Only safe ADD COLUMN forms are supported. Unique and complex constraints are intentionally blocked.
                  </div>
                </>
              )}

              {columnDialog.mode === 'rename' && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  Renaming a column is safe in modern SQLite, but app code and queries may need updates.
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-emerald-500/20 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (!columnSaving) {
                    setColumnDialog(null);
                    setColumnError('');
                  }
                }}
                className="rounded-lg border border-zinc-800 bg-[#0f0f0f] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmColumnAction}
                disabled={columnSaving || !columnName.trim()}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-60"
              >
                {columnSaving ? 'Saving...' : columnDialog.mode === 'add' ? 'Add column' : 'Rename column'}
              </button>
            </div>
          </div>
        </div>
      )}

      {columnRiskMode && columnRiskTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-[#120f10] shadow-2xl">
            <div className="flex items-start gap-3 border-b border-red-500/20 px-6 py-5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500/10 text-red-400">
                <AlertTriangle size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-zinc-100">
                  {columnRiskMode === 'delete' ? 'Delete column' : 'Change column type'}
                </h3>
                <p className="mt-1 text-sm text-zinc-400">
                  <span className="font-mono text-zinc-200">{columnRiskTarget}</span> in <span className="font-mono text-zinc-200">{activeTable}</span>
                </p>
              </div>
            </div>

            {columnError && (
              <div className="mx-6 mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {columnError}
              </div>
            )}

            <div className="px-6 py-5 space-y-4">
              {columnRiskMode === 'delete' ? (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  This may rebuild the table if SQLite cannot drop the column directly. It is blocked when the column is part of a constraint.
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-zinc-300">New type</label>
                    <input
                      value={columnRiskType}
                      onChange={(event) => setColumnRiskType(event.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                      placeholder="TEXT"
                    />
                  </div>
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                    Changing type rebuilds the table and may be blocked if the current schema is unsafe.
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-red-500/20 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (!columnSaving) {
                    setColumnRiskMode(null);
                    setColumnRiskTarget('');
                    setColumnError('');
                  }
                }}
                className="rounded-lg border border-zinc-800 bg-[#0f0f0f] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmColumnRiskAction}
                disabled={columnSaving}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-400 disabled:opacity-60"
              >
                {columnSaving ? 'Working...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ContextMenu
        open={contextMenu.open}
        x={contextMenu.x}
        y={contextMenu.y}
        items={contextMenuItems}
        onClose={closeContextMenu}
      />
    </AppShell>
  );
}

function InsertRowModal({
  tableName,
  columns,
  values,
  saving,
  error,
  onClose,
  onChange,
  onSave,
  title = 'Insert Row',
  description,
  saveLabel = 'Insert row',
  mode = 'insert',
}: {
  tableName: string;
  columns: ColumnMeta[];
  values: Record<string, string>;
  saving: boolean;
  error: string;
  onClose: () => void;
  onChange: (column: string, value: string) => void;
  onSave: () => Promise<void>;
  title?: string;
  description?: string;
  saveLabel?: string;
  mode?: RowMode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] modal-backdrop">
      <div className="w-full max-w-3xl rounded-xl border border-zinc-800/80 bg-[#0f0f0f] shadow-2xl modal-content">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800/80 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">{title}</h2>
            <p className="mt-1 text-sm text-zinc-400">{description || `Fill the fields for ${tableName} and save a new record.`}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-auto px-6 py-5 custom-scrollbar">
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {columns.map((column) => (
              <div key={column.name} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium text-zinc-300">
                    {column.name}
                    {column.pk ? <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-500">pk</span> : null}
                  </label>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    {column.type || 'ANY'} {mode === 'edit' && column.pk ? '· locked' : ''}
                  </span>
                </div>
                {getColumnInputKind(column) === 'checkbox' ? (
                  <label className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={isTruthyValue(values[column.name] || '')}
                      disabled={Boolean(mode === 'edit' && column.pk)}
                      onChange={(event) => onChange(column.name, event.target.checked ? '1' : '0')}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500"
                    />
                    <span>{column.notnull ? 'Required' : 'Optional / NULL'}</span>
                  </label>
                ) : (
                  <input
                    type={getColumnInputKind(column)}
                    step={getColumnInputKind(column) === 'number' ? 'any' : undefined}
                    value={values[column.name] || ''}
                    onChange={(event) => onChange(column.name, event.target.value)}
                    readOnly={Boolean(mode === 'edit' && column.pk)}
                    placeholder={
                      mode === 'insert' && column.pk && getColumnInputKind(column) === 'number'
                        ? 'Leave blank for auto increment'
                        : column.notnull
                          ? 'Required'
                          : 'Optional / NULL'
                    }
                    className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none read-only:cursor-not-allowed read-only:bg-zinc-900/40"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-zinc-800/80 px-6 py-4">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
          >
              {saving ? 'Saving...' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
