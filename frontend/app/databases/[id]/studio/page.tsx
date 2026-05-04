"use client";

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { AppShell } from '../../../../components/AppShell';
import { TableSidebar } from '../../../../components/studio/TableSidebar';
import { DataGrid } from '../../../../components/studio/DataGrid';
import { SqlRunner } from '../../../../components/studio/SqlRunner';
import { ChevronRight } from 'lucide-react';

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
                onDeleteRow={handleDeleteRow}
                onAddRow={handleAddRow}
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
    </AppShell>
  );
}
