process.env.MASTER_KEY = process.env.MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { buildServer } = require('../dist/server');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');

async function main() {
  const port = Number(process.env.SMOKE_PORT || 3456);
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  const email = process.env.SMOKE_EMAIL || 'smoke@example.com';
  const password = process.env.SMOKE_PASSWORD || 'SmokePass123!';

  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await bootstrapSecurityCatalog();

  const app = buildServer();
  await app.listen({ port, host: '127.0.0.1' });

  try {
    const health = await fetch(`${baseUrl}/health`);
    if (!health.ok) throw new Error(`health failed: ${health.status}`);

    const ready = await fetch(`${baseUrl}/ready`);
    if (!ready.ok) throw new Error(`ready failed: ${ready.status}`);

    let authResponse = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (authResponse.status === 400) {
      authResponse = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    }

    if (!authResponse.ok) throw new Error(`auth failed: ${authResponse.status}`);

    const setCookieHeader = authResponse.headers.get('set-cookie') || '';
    const cookieHeader = setCookieHeader
      .split(/, (?=[^;]+?=)/)
      .map((value) => value.split(';')[0])
      .join('; ');

    const me = await fetch(`${baseUrl}/me`, { headers: { cookie: cookieHeader } });
    if (!me.ok) throw new Error(`me failed: ${me.status}`);

    const projects = await fetch(`${baseUrl}/projects`, { headers: { cookie: cookieHeader } });
    if (!projects.ok) throw new Error(`projects failed: ${projects.status}`);

    console.log('smoke ok');
  } finally {
    await app.close();
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
