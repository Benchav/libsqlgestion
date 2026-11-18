const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PUBLIC_HOST = 'data.example.com';
process.env.DATABASE_PUBLIC_PROTOCOL = 'https';
process.env.DATABASE_PUBLIC_DOMAIN = 'data.example.com';
process.env.HOSTNAME = 'backend-container';

const { LibsqlRuntimeService } = require('../dist/infrastructure/docker/LibsqlRuntimeService');

function mockRequests(service, handler) {
  const calls = [];
  service.requestJson = async (method, requestPath, body) => {
    calls.push({ method, requestPath, body });
    return handler(method, requestPath, body);
  };
  service.requestVoid = async (method, requestPath) => {
    calls.push({ method, requestPath });
    return handler(method, requestPath);
  };
  return calls;
}

function backendInspect(networks) {
  return { NetworkSettings: { Networks: Object.fromEntries(networks.map((name) => [name, {}])) } };
}

test.describe('LibSQL runtime Docker network selection', () => {
  test.afterEach(() => {
    delete process.env.LIBSQL_RUNTIME_NETWORK;
  });

  test('uses the explicit LIBSQL_RUNTIME_NETWORK when the backend is attached', async () => {
    process.env.LIBSQL_RUNTIME_NETWORK = 'coolify';
    const service = new LibsqlRuntimeService();
    const calls = mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/coolify') {
        return { Name: 'coolify' };
      }
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        return backendInspect(['coolify']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    assert.equal(await service['resolveBackendNetworkName'](), 'coolify');
    assert.equal(
      calls.some((call) => call.requestPath.endsWith('/connect')),
      false,
      'the backend is already attached, so it must not be reconnected',
    );
  });

  test('connects the backend when LIBSQL_RUNTIME_NETWORK is not attached yet', async () => {
    process.env.LIBSQL_RUNTIME_NETWORK = 'coolify';
    const service = new LibsqlRuntimeService();
    const calls = mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/coolify') {
        return { Name: 'coolify' };
      }
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        if (requestPath.includes('coolify-proxy')) {
          return backendInspect(['coolify']);
        }
        return backendInspect(['app_default']);
      }
      if (method === 'POST' && requestPath === '/networks/coolify/connect') {
        return {};
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    assert.equal(await service['resolveBackendNetworkName'](), 'coolify');
    const connect = calls.find((call) => call.requestPath === '/networks/coolify/connect');
    assert.ok(connect, 'the backend must be connected to the explicit network');
    assert.deepEqual(connect.body, { Container: 'backend-container' });
  });

  test('detects the backend network and prefers coolify', async () => {
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        return backendInspect(['app_default', 'coolify']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    assert.equal(await service['resolveBackendNetworkName'](), 'coolify');
  });

  test('fails when backend and proxy share no Docker network', async () => {
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath.includes('coolify-proxy')) {
        return backendInspect(['coolify']);
      }
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        return backendInspect(['app_default']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    await assert.rejects(
      () => service['resolveBackendNetworkName'](),
      /share no Docker network/,
    );
  });

  test('fails when LIBSQL_RUNTIME_NETWORK is not shared with the proxy', async () => {
    process.env.LIBSQL_RUNTIME_NETWORK = 'app_default';
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/app_default') {
        return { Name: 'app_default' };
      }
      if (method === 'GET' && requestPath.includes('coolify-proxy')) {
        return backendInspect(['coolify']);
      }
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        return backendInspect(['app_default']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    await assert.rejects(
      () => service['resolveBackendNetworkName'](),
      /not shared with the proxy container/,
    );
  });

  test('refuses to create runtimes on the default bridge network', async () => {
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        return backendInspect(['bridge']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    await assert.rejects(
      () => service['resolveBackendNetworkName'](),
      /Refusing to create the libSQL runtime on the default "bridge" network/,
    );
  });

  test('fails with a clear error when the explicit network does not exist', async () => {
    process.env.LIBSQL_RUNTIME_NETWORK = 'missing-network';
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/missing-network') {
        throw new Error('Docker request failed (404): network not found');
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    await assert.rejects(
      () => service['resolveBackendNetworkName'](),
      /LIBSQL_RUNTIME_NETWORK="missing-network" does not exist/,
    );
  });

  test('keeps the current runtime when rotation cannot resolve the network', async () => {
    process.env.LIBSQL_RUNTIME_NETWORK = 'missing-network';
    const service = new LibsqlRuntimeService();
    const calls = mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/missing-network') {
        throw new Error('Docker request failed (404): network not found');
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    const database = {
      id: 'database-1',
      metadata: {
        runtime: {
          provider: 'docker-libsql',
          image: 'libsql-server',
          containerId: 'old-container',
          containerName: 'libsqlite-database-1',
          databasePath: '/tmp/database-1/dbs/default/data',
          authKeyPem: 'pem',
          internalUrl: 'http://libsqlite-database-1:8080',
          connectionUrl: 'http://libsqlite-database-1:8080',
          backendUrl: 'http://host.docker.internal:32769',
          publicHost: 'host.docker.internal',
          publicPort: '32769',
          publicUrl: 'https://erp-db.data.example.com',
        },
      },
    };

    await assert.rejects(
      () => service['rotateDatabase'](database),
      /LIBSQL_RUNTIME_NETWORK="missing-network" does not exist/,
    );
    assert.equal(
      calls.some((call) => call.method === 'DELETE'),
      false,
      'the old primary must stay online when network resolution fails',
    );
  });

  test('classifies DNS, TLS and proxy errors for the public route', () => {
    const service = new LibsqlRuntimeService();
    assert.match(
      service['describeRouteError']('getaddrinfo ENOTFOUND insumosv1.data.example.com', 'https://insumosv1.data.example.com'),
      /DNS does not resolve/,
    );
    assert.match(
      service['describeRouteError']('unable to verify the first certificate', 'https://insumosv1.data.example.com'),
      /TLS certificate is not valid/,
    );
    assert.match(
      service['describeRouteError']('503 Service Unavailable', 'https://insumosv1.data.example.com'),
      /proxy returned 503/,
    );
  });

  test('always attaches a new runtime to the selected network with Traefik labels', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-runtime-network-'));
    try {
      process.env.LIBSQL_RUNTIME_NETWORK = 'coolify';
      const databasePath = path.join(tempDir, 'dbs', 'default', 'data');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });

      const service = new LibsqlRuntimeService();
      service['resolveHostPath'] = async (containerPath) => containerPath;
      const calls = mockRequests(service, (method, requestPath) => {
        if (method === 'POST' && requestPath.startsWith('/containers/create')) {
          return { Id: 'runtime-1' };
        }
        if (method === 'POST' && requestPath === '/containers/runtime-1/start') {
          return {};
        }
        if (method === 'GET' && requestPath === '/containers/runtime-1/json') {
          return backendInspect(['coolify']);
        }
        throw new Error(`unexpected ${method} ${requestPath}`);
      });

      await service['createAndStartContainer'](
        { containerName: 'libsqlite-db', subdomain: 'erp-db' },
        databasePath,
        'PUBLIC-KEY',
        'coolify',
      );

      const create = calls.find((call) => call.requestPath.startsWith('/containers/create'));
      assert.deepEqual(create.body.NetworkingConfig, {
        EndpointsConfig: { coolify: {} },
      });
      assert.equal(create.body.Labels['traefik.docker.network'], 'coolify');
      assert.equal(create.body.Labels['traefik.enable'], 'true');
      assert.equal(
        create.body.Labels['traefik.http.routers.libsqlite-db.rule'],
        'Host(`erp-db.data.example.com`)',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('fails if Docker does not attach the runtime to the selected network', async () => {
    const service = new LibsqlRuntimeService();
    mockRequests(service, (method, requestPath) => {
      if (method === 'GET' && requestPath === '/containers/runtime-1/json') {
        return backendInspect(['bridge']);
      }
      throw new Error(`unexpected ${method} ${requestPath}`);
    });

    await assert.rejects(
      () => service['assertContainerOnNetwork']('runtime-1', 'coolify'),
      /not attached to Docker network "coolify"/,
    );
  });
});
