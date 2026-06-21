import type { Client as LibsqlCoreClient, ResultSet, InArgs } from '@libsql/client';

export interface LibsqlClient {
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  batch(queries: Array<{ sql: string; args?: InArgs }>, mode?: 'write' | 'read'): Promise<ResultSet[]>;
  close(): void;
}

export function wrapLibsqlClient(core: LibsqlCoreClient): LibsqlClient {
  return {
    execute(sql, args) {
      return core.execute(sql, args ?? []);
    },
    batch(queries, mode) {
      return core.batch(queries as any, mode as any) as any;
    },
    close() {
      core.close();
    },
  };
}
