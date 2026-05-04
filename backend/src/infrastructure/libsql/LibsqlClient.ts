import { createClient, LibsqlError } from '@libsql/client';

export function createLibsqlClient(url: string, authToken?: string) {
  return createClient({
    url,
    authToken,
  });
}
