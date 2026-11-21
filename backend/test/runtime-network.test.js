const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

function runtimeDatabase() {
  return {
    id: 'database-1',
    metadata: {
      runtime: {
        provider: 'docker-libsql',
        image: 'libsql-server',
        containerId: 'old-container',
        containerName: 'libsqlite-database-1',
        network: 'coolify',
        databasePath: '/tmp/database-1/dbs/default/data',
        authKeyPem: 'OLD-PUBLIC-KEY',
        internalUrl: 'http://libsqlite-database-1:8080',
        connectionUrl: 'http://libsqlite-database-1:8080',
        backendUrl: 'http://host.docker.internal:32769',
        publicHost: 'host.docker.internal',
        publicPort: '32769',
        publicUrl: 'https://erp-db.data.example.com',
      },
    },
  };
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

  test('never deletes the original runtime when the initial rename fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-rotation-rename-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'auth.pem'), 'OLD-KEY', 'utf8');

      const service = new LibsqlRuntimeService();
      service['resolveBackendNetworkName'] = async () => 'coolify';
      service['resolvePaths'] = () => ({
        databasePath: path.join(tempDir, 'dbs', 'default', 'data'),
        containerName: 'libsqlite-database-1',
      });
      service['resolveDatabaseRootDir'] = () => tempDir;
      service['renameContainer'] = async () => {
        throw new Error('simulated rename failure');
      };

      const deletes = [];
      service['removeContainer'] = async (containerId) => {
        deletes.push(containerId);
      };
      service['requestJson'] = async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/containers/old-container/json') {
          return {
            Id: 'old-container',
            Name: '/libsqlite-database-1',
            State: { Running: true },
            NetworkSettings: { Networks: { coolify: {} } },
          };
        }
        if (method === 'POST' && requestPath.startsWith('/networks/')) {
          return {};
        }
        throw new Error(`unexpected ${method} ${requestPath}`);
      };
      service['requestVoid'] = async (method, requestPath) => {
        throw new Error(`unexpected ${method} ${requestPath}`);
      };

      await assert.rejects(
        () => service['rotateDatabase'](runtimeDatabase()),
        /was restored/,
      );
      assert.deepEqual(deletes, [], 'the original runtime must never be deleted by a failed rotation');
      assert.equal(fs.readFileSync(path.join(tempDir, 'auth.pem'), 'utf8'), 'OLD-KEY');
      assert.equal(
        fs.existsSync(path.join(tempDir, 'auth.pem.rotation')),
        false,
        'rollback must clear the recovery marker',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps the previous runtime until the new credential is persisted', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-rotation-persist-'));
    try {
      const databasePath = path.join(tempDir, 'dbs', 'default', 'data');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const authPemPath = path.join(tempDir, 'auth.pem');
      fs.writeFileSync(authPemPath, 'OLD-KEY', 'utf8');

      const service = new LibsqlRuntimeService();
      const renames = [];
      const deletes = [];
      const starts = [];
      let connectCalls = 0;

      service['resolveBackendNetworkName'] = async () => 'coolify';
      service['resolvePaths'] = () => ({
        databasePath,
        containerName: 'libsqlite-database-1',
        subdomain: 'erp-db',
      });
      // The fixture metadata uses a placeholder path; point auth.pem at the
      // temp directory that the test controls.
      service['resolveDatabaseRootDir'] = () => tempDir;
      service['generateAuthBundle'] = () => ({ publicKeyPem: 'NEW-KEY', token: 'NEW-TOKEN' });
      service['renameContainer'] = async (containerId, name) => {
        renames.push({ containerId, name });
      };
      service['stopContainer'] = async () => undefined;
      service['createAndStartContainer'] = async () => {
        fs.writeFileSync(authPemPath, 'NEW-KEY', 'utf8');
        return 'new-container';
      };
      service['waitForPublishedPort'] = async () => '32770';
      service['waitForReady'] = async () => ({
        connectionUrl: 'http://libsqlite-database-1:8080',
        routeHealth: {
          checkedAt: new Date().toISOString(),
          internalOk: true,
          backendOk: true,
          publicOk: true,
          publicChecked: false,
        },
      });
      service['removeContainer'] = async (containerId) => {
        deletes.push(containerId);
      };
      service['startContainer'] = async (containerId) => {
        starts.push(containerId);
      };
      service['requestJson'] = async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/containers/old-container/json') {
          return {
            Name: '/libsqlite-database-1-previous-1',
            State: { Running: false },
            NetworkSettings: { Networks: {} },
          };
        }
        if (method === 'POST' && requestPath === '/networks/coolify/disconnect') {
          return {};
        }
        if (method === 'POST' && requestPath === '/networks/coolify/connect') {
          connectCalls += 1;
          return {};
        }
        throw new Error(`unexpected ${method} ${requestPath}`);
      };

      await assert.rejects(
        () => service['rotateDatabase'](runtimeDatabase(), {
          persist: async () => {
            throw new Error('database write failed');
          },
        }),
        /was restored/,
      );

      assert.deepEqual(deletes, ['new-container'], 'only the failed replacement may be removed');
      assert.equal(renames[0].name.startsWith('libsqlite-database-1-previous-'), true);
      assert.deepEqual(renames[1], {
        containerId: 'old-container',
        name: 'libsqlite-database-1',
      });
      assert.equal(connectCalls, 1);
      assert.deepEqual(starts, ['old-container']);
      assert.equal(fs.readFileSync(authPemPath, 'utf8'), 'OLD-KEY');
      assert.equal(fs.existsSync(`${authPemPath}.rotation`), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('recovers a rotation interrupted after creating the replacement', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-rotation-recovery-'));
    try {
      const authPemPath = path.join(tempDir, 'auth.pem');
      fs.writeFileSync(authPemPath, 'NEW-KEY', 'utf8');
      fs.writeFileSync(`${authPemPath}.rotation`, 'OLD-KEY', 'utf8');

      const service = new LibsqlRuntimeService();
      const deletes = [];
      const renames = [];
      const starts = [];

      service['resolveDatabaseRootDir'] = () => tempDir;
      service['removeContainer'] = async (containerId) => {
        deletes.push(containerId);
      };
      service['renameContainer'] = async (containerId, name) => {
        renames.push({ containerId, name });
      };
      service['startContainer'] = async (containerId) => {
        starts.push(containerId);
      };
      service['requestJson'] = async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/containers/old-container/json') {
          return {
            Id: 'old-container',
            Name: '/libsqlite-database-1-previous-1',
            State: { Running: false },
            NetworkSettings: { Networks: {} },
          };
        }
        if (method === 'GET' && requestPath === '/containers/libsqlite-database-1/json') {
          return {
            Id: 'new-container',
            Name: '/libsqlite-database-1',
            State: { Running: true },
            NetworkSettings: { Networks: { coolify: {} } },
          };
        }
        if (method === 'POST' && requestPath === '/networks/coolify/connect') {
          return {};
        }
        throw new Error(`unexpected ${method} ${requestPath}`);
      };

      const result = await service.recoverInterruptedRotation(runtimeDatabase());

      assert.equal(result, 'restored');
      assert.equal(fs.readFileSync(authPemPath, 'utf8'), 'OLD-KEY');
      assert.equal(fs.existsSync(`${authPemPath}.rotation`), false);
      assert.deepEqual(deletes, ['new-container']);
      assert.deepEqual(renames, [{
        containerId: 'old-container',
        name: 'libsqlite-database-1',
      }]);
      assert.deepEqual(starts, ['old-container']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('finalizes a persisted replacement with its new key, never the old one', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-rotation-committed-'));
    try {
      const authPemPath = path.join(tempDir, 'auth.pem');
      fs.writeFileSync(authPemPath, 'OLD-KEY', 'utf8');
      fs.writeFileSync(`${authPemPath}.rotation`, JSON.stringify({
        version: 1,
        phase: 'replacement-ready',
        startedAt: new Date().toISOString(),
        oldContainerId: 'old-container',
        oldContainerName: 'libsqlite-database-1',
        network: 'coolify',
        previousAuthPem: 'OLD-KEY',
        newContainerId: 'new-container',
        newContainerName: 'libsqlite-database-1',
        newAuthKeyPem: 'NEW-KEY',
      }), 'utf8');

      const database = runtimeDatabase();
      database.metadata = {
        runtime: {
          ...database.metadata.runtime,
          containerId: 'new-container',
          authKeyPem: 'NEW-PUBLIC-KEY',
        },
      };

      const service = new LibsqlRuntimeService();
      const deletes = [];
      const starts = [];

      service['resolveDatabaseRootDir'] = () => tempDir;
      service['removeContainer'] = async (containerId) => {
        deletes.push(containerId);
      };
      service['startContainer'] = async (containerId) => {
        starts.push(containerId);
      };
      service['requestJson'] = async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/containers/new-container/json') {
          return {
            Id: 'new-container',
            Name: '/libsqlite-database-1',
            State: { Running: false },
            NetworkSettings: { Networks: {} },
          };
        }
        if (method === 'POST' && requestPath === '/networks/coolify/connect') {
          return {};
        }
        throw new Error(`unexpected ${method} ${requestPath}`);
      };

      const result = await service.recoverInterruptedRotation(database);

      assert.equal(result, 'finalized');
      assert.equal(
        fs.readFileSync(authPemPath, 'utf8'),
        'NEW-KEY',
        'a persisted replacement must be started with its own verification key',
      );
      assert.equal(fs.existsSync(`${authPemPath}.rotation`), false);
      assert.deepEqual(deletes, ['old-container']);
      assert.deepEqual(starts, ['new-container']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('public route health uses HTTP metadata instead of executing SQL', async () => {
  const server = http.createServer((req, res) => {
    // Some runtimes do not expose /health; /version is the fallback.
    if (req.url === '/version') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('libsql-server 0.0.0');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const service = new LibsqlRuntimeService();
    const result = await service.checkPublicRoute(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true, result.error);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
