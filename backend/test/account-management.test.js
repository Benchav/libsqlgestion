const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-account-test-'));
process.env.DATABASE_FILE = path.join(tempDir, 'control.db');
process.env.SQLITE_STORAGE_ROOT = path.join(tempDir, 'storage');
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ALLOW_PUBLIC_REGISTRATION = 'false';
process.env.LIBSQL_ADMIN_URL = '';
process.env.LIBSQL_ENABLE_NAMESPACES = 'false';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { buildServer } = require('../dist/server');

function parseCookies(response) {
  const result = {};
  const setCookies = response.headers['set-cookie'];
  for (const item of Array.isArray(setCookies) ? setCookies : [setCookies]) {
    const [pair] = item.split(';');
    const [key, value] = pair.split('=');
    if (key && value) result[key.trim()] = value.trim();
  }
  return result;
}

function authHeaders(cookies) {
  const csrf = cookies['libsqlite.csrfToken.v2'] || cookies['libsqlite.csrfToken'];
  return {
    cookie: `libsqlite.accessToken=${cookies['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrf}`,
    'x-csrf-token-v2': csrf,
  };
}

test.describe('Account management', () => {
  let app;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();
    app = buildServer();
  });

  test.after(async () => {
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('changes email and password securely, revokes other sessions, and manages users', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'owner@test.test', password: 'OwnerPass123!' },
    });
    assert.equal(register.statusCode, 200, register.payload);
    const sessionA = parseCookies(register);

    const meA = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeaders(sessionA),
    });
    assert.equal(meA.statusCode, 200);
    const meBody = JSON.parse(meA.payload).user;
    assert.equal(meBody.email, 'owner@test.test');
    assert.equal(meBody.passwordHash, undefined);
    assert.equal(meBody.sessions, undefined);
    assert.ok(meBody.permissions.includes('users.write'));

    const loginB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@test.test', password: 'OwnerPass123!' },
    });
    assert.equal(loginB.statusCode, 200);
    const sessionB = parseCookies(loginB);

    const wrongEmail = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/email',
      headers: authHeaders(sessionB),
      payload: { email: 'owner-new@test.test', currentPassword: 'wrong-password' },
    });
    assert.equal(wrongEmail.statusCode, 401);

    const changeEmail = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/email',
      headers: authHeaders(sessionB),
      payload: { email: 'owner-new@test.test', currentPassword: 'OwnerPass123!' },
    });
    assert.equal(changeEmail.statusCode, 200, changeEmail.payload);
    assert.equal(JSON.parse(changeEmail.payload).user.email, 'owner-new@test.test');
    assert.equal(JSON.parse(changeEmail.payload).user.passwordHash, undefined);

    const changePassword = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/password',
      headers: authHeaders(sessionB),
      payload: { currentPassword: 'OwnerPass123!', newPassword: 'OwnerPass456!' },
    });
    assert.equal(changePassword.statusCode, 200, changePassword.payload);

    const oldPasswordLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner-new@test.test', password: 'OwnerPass123!' },
    });
    assert.equal(oldPasswordLogin.statusCode, 401);

    const newPasswordLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner-new@test.test', password: 'OwnerPass456!' },
    });
    assert.equal(newPasswordLogin.statusCode, 200);
    const sessionC = parseCookies(newPasswordLogin);

    const revokedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeaders(sessionA),
    });
    assert.equal(revokedSession.statusCode, 401);

    const currentSession = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeaders(sessionB),
    });
    assert.equal(currentSession.statusCode, 200);

    const createUser = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeaders(sessionC),
      payload: { email: 'teammate@test.test', password: 'Teammate123!', roleName: 'readonly' },
    });
    assert.equal(createUser.statusCode, 201, createUser.payload);
    const createdUser = JSON.parse(createUser.payload).user;
    assert.equal(createdUser.email, 'teammate@test.test');
    assert.equal(createdUser.passwordHash, undefined);
    assert.ok(createdUser.roles.includes('readonly'));

    const duplicateUser = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeaders(sessionC),
      payload: { email: 'teammate@test.test', password: 'Teammate123!' },
    });
    assert.equal(duplicateUser.statusCode, 409);

    const forbiddenRole = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeaders(sessionC),
      payload: { email: 'super-2@test.test', password: 'SuperPass123!', roleName: 'superadmin' },
    });
    assert.equal(forbiddenRole.statusCode, 403);

    const teammateLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'teammate@test.test', password: 'Teammate123!' },
    });
    assert.equal(teammateLogin.statusCode, 200);
    const teammateSession = parseCookies(teammateLogin);

    const teammateUsers = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeaders(teammateSession),
    });
    assert.equal(teammateUsers.statusCode, 403);

    const adminUsers = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeaders(sessionC),
    });
    assert.equal(adminUsers.statusCode, 200);
    const users = JSON.parse(adminUsers.payload).users;
    assert.ok(users.length >= 2);
    for (const user of users) {
      assert.equal(user.passwordHash, undefined);
      assert.equal(user.sessions, undefined);
      assert.ok(Array.isArray(user.roles));
    }

    const resetPassword = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${createdUser.id}`,
      headers: authHeaders(sessionC),
      payload: { password: 'Teammate456!' },
    });
    assert.equal(resetPassword.statusCode, 200, resetPassword.payload);
    assert.equal(JSON.parse(resetPassword.payload).user.passwordHash, undefined);

    const revokedTeammate = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeaders(teammateSession),
    });
    assert.equal(revokedTeammate.statusCode, 401);

    const resetLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'teammate@test.test', password: 'Teammate456!' },
    });
    assert.equal(resetLogin.statusCode, 200);
    const resetSession = parseCookies(resetLogin);

    const deactivateUser = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${createdUser.id}`,
      headers: authHeaders(sessionC),
      payload: { active: false },
    });
    assert.equal(deactivateUser.statusCode, 200, deactivateUser.payload);

    const deactivatedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeaders(resetSession),
    });
    assert.equal(deactivatedSession.statusCode, 401);

    const inactiveLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'teammate@test.test', password: 'Teammate456!' },
    });
    assert.equal(inactiveLogin.statusCode, 401);

    const meId = meBody.id;
    const deactivateSelf = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${meId}`,
      headers: authHeaders(sessionC),
      payload: { active: false },
    });
    assert.equal(deactivateSelf.statusCode, 409);
  });
});
