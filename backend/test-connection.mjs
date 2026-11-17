import { createClient } from '@libsql/client';

const url = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error('Set DATABASE_URL/TURSO_DATABASE_URL and DATABASE_AUTH_TOKEN/TURSO_AUTH_TOKEN.');
  process.exit(1);
}

const client = createClient({ url, authToken });

async function test() {
  console.log('Connecting to the configured libSQL database...');
  try {
    const rs = await client.execute("SELECT 'connection ok' AS message");
    console.log('Result:', rs.rows);
  } catch (error) {
    console.error('Connection failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

test();
