"use client";

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { AppShell } from '../../../../components/AppShell';
import { TableSidebar } from '../../../../components/studio/TableSidebar';
import { DataGrid } from '../../../../components/studio/DataGrid';
import { SqlRunner } from '../../../../components/studio/SqlRunner';
import { ChevronRight, X } from 'lucide-react';

type ColumnMeta = { cid: number; name: string; type: string; notnull: number; pk: number };
type TableSchema = { table: string; columns: ColumnMeta[]; foreignKeys: unknown[] };
type DatabaseInfo = { id: string; name: string; type: string; status: string };

const PAGE_SIZE = 50;

export default function StudioPage() {
  const params = useParams();
  const router = useRouter();
  const dbId = params?.id as string;

  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [tables, setTables] = useState<TableSchema[]>([]);
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
  const [sqlResult, setSqlResult] = useState<{ ok: boolean; rows?: unknown[]; error?: string; changes?: number } | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);

  const [error, setError] = useState('');

  // Load database info
  useEffect(() => {
    if (!dbId) return;
    apiRequest<{ database: DatabaseInfo }>(`/databases/${dbId}`)
      .then((r) => setDatabase(r.database))
      .catch((err: any) => setError(err.message));
  }, [dbId]);

  // Load schema
  const loadSchema = useCallback(async () => {
    try {
      const result = await apiRequest<{ tables: TableSchema[] }>(`/databases/${dbId}/schema`);
      setTables(result.tables || []);
      // Select first table if none selected
      if (!activeTable && result.tables?.length > 0) {
        setActiveTable(result.tables[0].table);
      }
    } catch (err: any) {
      setError(err.message);
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
    if (!activeTable) return;
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
    if (!currentTableSchema) return;
    const initialValues: Record<string, string> = {};
    currentTableSchema.columns.forEach((column) => {
      initialValues[column.name] = '';
    });
    setInsertValues(initialValues);
    setInsertError('');
    setIsInsertOpen(true);
  }

  function handleOpenEditRow(rowIndex: number) {
    if (!currentTableSchema) return;
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
    if (!activeTable || !currentTableSchema) return;

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
    if (editRowIndex === null || !activeTable || !currentTableSchema) return;

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

    const setClauses = currentTableSchema.columns.map((column) => `"${column.name}" = ?`).join(', ');
    const params = currentTableSchema.columns.map((column) => {
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
      const result = await apiRequest<{ ok: boolean; rows?: unknown[]; result?: { changes: number } }>(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql }),
      });
      setSqlResult({
        ok: result.ok !== false,
        rows: result.rows,
        changes: result.result?.changes,
      });
      loadSchema();
      if (activeTable) loadTableData();
    } catch (err: any) {
      setSqlResult({ ok: false, error: err.message });
    } finally {
      setSqlLoading(false);
    }
  }

  const currentTableSchema = tables.find((t) => t.table === activeTable);

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
          <div className="m-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm flex-shrink-0">
            {error}
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <TableSidebar
            tables={tables.map((t) => ({ table: t.table, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) }))}
            activeTable={activeTable}
            activeTab={activeTab}
            onSelectTable={handleSelectTable}
            onSelectTab={setActiveTab}
            onRefresh={loadSchema}
          />

          <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a]">
            {/* Main Area */}
            {activeTab === 'data' && activeTable && currentTableSchema ? (
              <DataGrid
                tableName={activeTable}
                columns={currentTableSchema.columns}
                rows={rows}
                totalRows={totalRows}
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
        />
      )}
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
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-3xl rounded-xl border border-zinc-800/80 bg-[#0f0f0f] shadow-2xl">
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
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">{column.type || 'ANY'}</span>
                </div>
                <input
                  type="text"
                  value={values[column.name] || ''}
                  onChange={(event) => onChange(column.name, event.target.value)}
                  placeholder={column.notnull ? 'Required' : 'Optional / NULL'}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                />
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
