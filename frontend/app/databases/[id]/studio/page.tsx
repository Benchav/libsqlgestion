"use client";

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiRequest } from '../../../../lib/api';
import { AppShell } from '../../../../components/AppShell';
import { TableSidebar } from '../../../../components/studio/TableSidebar';
import { DataGrid } from '../../../../components/studio/DataGrid';
import { SqlRunner } from '../../../../components/studio/SqlRunner';
import '../../../../components/studio/studio.css';

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
  }, [dbId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load table data
  const loadTableData = useCallback(async () => {
    if (!activeTable || !dbId) return;
    setGridLoading(true);
    try {
      // Get count
      const countResult = await apiRequest<{ ok: boolean; rows: Array<{ cnt: number }> }>(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: `SELECT COUNT(*) as cnt FROM "${activeTable}"` }),
      });
      const count = countResult.rows?.[0]?.cnt ?? 0;
      setTotalRows(count);

      // Get rows
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

  // Handle table selection
  function handleSelectTable(table: string) {
    setActiveTable(table);
    setPage(0);
    setSortColumn(null);
    setSortDir('ASC');
    setActiveTab('data');
  }

  // Handle sort
  function handleSort(column: string, dir: 'ASC' | 'DESC') {
    setSortColumn(column);
    setSortDir(dir);
    setPage(0);
  }

  // Handle cell edit
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

  // Handle delete row
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

  // Handle add row
  async function handleAddRow() {
    if (!activeTable) return;
    const activeTableSchema = tables.find((t) => t.table === activeTable);
    if (!activeTableSchema) return;

    // Insert with defaults
    const cols = activeTableSchema.columns.filter((c) => c.pk !== 1); // skip auto-increment PK
    if (cols.length === 0) {
      // Table only has PK, try inserting with defaults
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

    // Insert a row with NULL values for all columns
    const colNames = cols.map((c) => `"${c.name}"`).join(', ');
    const colValues = cols.map((c) => (c.notnull ? "''" : 'NULL')).join(', ');
    try {
      await apiRequest(`/databases/${dbId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          sql: `INSERT INTO "${activeTable}" (${colNames}) VALUES (${colValues})`,
        }),
      });
      // Go to last page to see the new row
      const newCount = totalRows + 1;
      const lastPage = Math.max(0, Math.ceil(newCount / PAGE_SIZE) - 1);
      setPage(lastPage);
      await loadTableData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  // Handle SQL execute
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
      // Refresh schema in case tables were created/dropped
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
      <div className="studio-shell">
        <div className="studio-topbar">
          <div className="studio-breadcrumbs">
            <button type="button" className="studio-chip" onClick={() => router.push(`/databases/${dbId}`)}>Database</button>
            <span className="studio-divider">/</span>
            <span className="studio-current">Studio</span>
          </div>

          <div className="studio-meta-row">
            {database?.type && <span className="badge">{database.type}</span>}
            {database?.status && <span className={`badge ${database.status === 'active' ? 'success' : 'warning'}`}>{database.status}</span>}
          </div>
        </div>

        {error ? <div className="studio-callout danger">{error}</div> : null}

        <div className="studio-layout">
          <TableSidebar
            tables={tables.map((t) => ({ table: t.table, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) }))}
            activeTable={activeTable}
            onSelect={handleSelectTable}
            onRefresh={loadSchema}
          />

          <div className="studio-main">
            <div className="studio-tab-bar">
              <button type="button" className={`studio-tab ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}>
                Data{activeTable ? ` · ${activeTable}` : ''}
              </button>
              <button type="button" className={`studio-tab ${activeTab === 'sql' ? 'active' : ''}`} onClick={() => setActiveTab('sql')}>
                SQL
              </button>
            </div>

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
              <div className="studio-empty-state">Select a table from the sidebar to browse data.</div>
            ) : null}

            {activeTab === 'sql' && (
              <SqlRunner
                onExecute={handleSqlExecute}
                loading={sqlLoading}
                result={sqlResult}
              />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
