const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { buildServer } = require('../dist/server');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');

async function main() {
  const port = Number(process.env.SMOKE_PORT || 3456);
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await bootstrapSecurityCatalog();

  const app = buildServer();
  await app.listen({ port, host: '127.0.0.1' });

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    if (!health.ok) throw new Error(`health failed: ${health.status}`);

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    if (!ready.ok) throw new Error(`ready failed: ${ready.status}`);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke@example.com', password: 'SmokePass123!' }),
    });
    if (!(login.status === 200 || login.status === 400)) {
      throw new Error(`login failed: ${login.status}`);
    }

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
