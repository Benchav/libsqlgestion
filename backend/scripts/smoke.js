process.env.MASTER_KEY = process.env.MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { buildServer } = require('../dist/server');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');

function parseSetCookies(response) {
  const raw = response.headers.get('set-cookie') || '';
  const values = raw.split(/, (?=[^;]+?=)/).filter(Boolean);
  return values.map((value) => value.split(';')[0]).join('; ');
}

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

    const cookieHeader = parseSetCookies(authResponse);
    const csrfToken = authResponse.headers.get('set-cookie')?.includes('libsqlite.csrfToken') ? null : null;

    const me = await fetch(`${baseUrl}/me`, { headers: { cookie: cookieHeader } });
    if (!me.ok) throw new Error(`me failed: ${me.status}`);

    const projects = await fetch(`${baseUrl}/projects`, { headers: { cookie: cookieHeader } });
    if (!projects.ok) throw new Error(`projects failed: ${projects.status}`);

    const csrf = /libsqlite\.csrfToken=([^;]+)/.exec(authResponse.headers.get('set-cookie') || '')?.[1];
    const createProject = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrf ? decodeURIComponent(csrf) : '' },
      body: JSON.stringify({ name: 'Smoke Project' }),
    });
    if (!createProject.ok) throw new Error(`create project failed: ${createProject.status}`);

    const projectData = await createProject.json();
    const projectId = projectData.project.id;

    const createDb = await fetch(`${baseUrl}/databases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrf ? decodeURIComponent(csrf) : '' },
      body: JSON.stringify({ projectId, name: 'smoke-db', type: 'sqlite' }),
    });
    if (!createDb.ok) throw new Error(`create db failed: ${createDb.status}`);

    const dbData = await createDb.json();
    const dbId = dbData.database.id;

    const dbDetail = await fetch(`${baseUrl}/databases/${dbId}`, { headers: { cookie: cookieHeader } });
    if (!dbDetail.ok) throw new Error(`db detail failed: ${dbDetail.status}`);

    const otherEmail = 'smoke2@example.com';
    const otherPassword = 'SmokePass123!';
    let otherAuth = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password: otherPassword }),
    });
    if (otherAuth.status === 400) {
      otherAuth = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otherEmail, password: otherPassword }),
      });
    }
    if (!otherAuth.ok) throw new Error(`other auth failed: ${otherAuth.status}`);
    const otherCookie = parseSetCookies(otherAuth);
    const forbidden = await fetch(`${baseUrl}/projects/${projectId}`, { headers: { cookie: otherCookie } });
    if (forbidden.status !== 403) throw new Error(`expected 403 for cross-project access, got ${forbidden.status}`);

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
