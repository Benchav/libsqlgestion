import { createClient as createLibsqlCoreClient } from '@libsql/client';
import type { LibsqlClient } from '../../types/libsql-client';
import { wrapLibsqlClient } from '../../types/libsql-client';

export function createLibsqlClient(url: string, authToken?: string): LibsqlClient {
  return wrapLibsqlClient(createLibsqlCoreClient({ url, authToken }));
}

export type { LibsqlClient };
