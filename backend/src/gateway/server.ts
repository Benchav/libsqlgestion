import http, { IncomingMessage, Server, ServerResponse } from 'http';
import https from 'https';
import { URL } from 'url';
import {
  assertDatabaseSqlAllowed,
  DatabaseProtectionError,
} from '../application/databases/database-protection';
import type { GatewayQueryMetric, GatewayTrafficMetric } from './analytics';

export type GatewayPolicy = {
  databaseId: string;
  subdomain: string;
  provider: string;
  upstreamBaseUrl: string;
  blockReads: boolean;
  blockWrites: boolean;
};

export type GatewayConfig = {
  policyUrl: string;
  internalToken: string;
  bodyLimitBytes: number;
  policyTtlMs: number;
  policyMaxStaleMs: number;
  upstreamTimeoutMs: number;
  pathPrefix: string;
  allowRoot: boolean;
};

type PolicyCacheEntry = {
  policy: GatewayPolicy;
  fetchedAt: number;
};

type StoredSqlState = {
  sql: Map<number, string>;
  expiresAt: number;
};

type GatewayDependencies = {
  resolvePolicy?: (host: string) => Promise<GatewayPolicy | null>;
  recordQuery?: (metric: GatewayQueryMetric) => void;
  recordTraffic?: (metric: GatewayTrafficMetric) => void;
};

type ProxyResult = {
  statusCode: number;
  durationMs: number;
  responseBytes: number;
  body?: any;
};

const DEFAULT_PATH_PREFIX = '/gateway';

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getGatewayConfig(): GatewayConfig {
  return {
    policyUrl: process.env.GATEWAY_POLICY_URL || 'http://backend:5000/api/v1/internal/gateway/policy',
    internalToken: process.env.GATEWAY_INTERNAL_TOKEN?.trim() || '',
    bodyLimitBytes: positiveInt(process.env.GATEWAY_BODY_LIMIT_BYTES, 32 * 1024 * 1024),
    policyTtlMs: positiveInt(process.env.GATEWAY_POLICY_TTL_MS, 1_000),
    policyMaxStaleMs: positiveInt(process.env.GATEWAY_POLICY_MAX_STALE_MS, 5_000),
    upstreamTimeoutMs: positiveInt(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS, 120_000),
    pathPrefix: normalizePrefix(process.env.GATEWAY_PATH_PREFIX || DEFAULT_PATH_PREFIX),
    allowRoot: ['true', '1', 'yes', 'on'].includes(
      String(process.env.GATEWAY_ALLOW_ROOT || '').trim().toLowerCase(),
    ),
  };
}

function normalizePrefix(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_PATH_PREFIX;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeHost(value: string | undefined) {
  return String(value || '')
    .split(',')[0]
    .trim()
    .split(':')[0]
    .replace(/\.$/, '')
    .toLowerCase();
}

function requestJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('policy response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`policy request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function fetchPolicyFromBackend(
  config: GatewayConfig,
  host: string,
): Promise<GatewayPolicy | null> {
  if (!config.internalToken) {
    throw new Error('GATEWAY_INTERNAL_TOKEN is not configured');
  }
  const url = new URL(config.policyUrl);
  url.searchParams.set('host', host);
  const response = await requestJson(url.href, {
    'x-gateway-token': config.internalToken,
    accept: 'application/json',
  }, 5_000);

  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`policy backend returned ${response.status}: ${response.body.slice(0, 300)}`);
  }

  const parsed = JSON.parse(response.body) as Partial<GatewayPolicy>;
  if (
    typeof parsed.databaseId !== 'string'
    || typeof parsed.subdomain !== 'string'
    || typeof parsed.provider !== 'string'
    || typeof parsed.upstreamBaseUrl !== 'string'
    || typeof parsed.blockReads !== 'boolean'
    || typeof parsed.blockWrites !== 'boolean'
  ) {
    throw new Error('policy backend returned an invalid policy document');
  }
  return parsed as GatewayPolicy;
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        const error: any = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function proxyHeaders(req: IncomingMessage, body: Buffer | null) {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['transfer-encoding'];
  delete headers['content-length'];
  delete headers['accept-encoding'];
  headers['accept-encoding'] = 'identity';
  if (body) headers['content-length'] = String(body.length);
  return headers;
}

function responseHeaders(headers: http.IncomingHttpHeaders, bodyLength?: number) {
  const copy: http.OutgoingHttpHeaders = { ...headers };
  delete copy.connection;
  delete copy['keep-alive'];
  delete copy['transfer-encoding'];
  delete copy['content-encoding'];
  if (bodyLength !== undefined) copy['content-length'] = String(bodyLength);
  return copy;
}

function buildUpstreamUrl(policy: GatewayPolicy, pathWithQuery: string) {
  const base = new URL(policy.upstreamBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const targetPath = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  return new URL(`${base.origin}${basePath}${targetPath}`);
}

function resolveSql(
  stmt: any,
  sqlMap: Map<number, string>,
): string | null {
  if (typeof stmt?.sql === 'string' && stmt.sql.trim()) return stmt.sql;
  if (stmt?.sql_id != null) return sqlMap.get(Number(stmt.sql_id)) || null;
  return null;
}

function enforcePolicy(policy: GatewayPolicy, sql: string) {
  assertDatabaseSqlAllowed(
    { blockReads: policy.blockReads, blockWrites: policy.blockWrites },
    sql,
  );
}

class GatewayRequestError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayRequestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function protectionErrorResponse(error: any) {
  if (error instanceof DatabaseProtectionError || error instanceof GatewayRequestError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      blocked: error instanceof DatabaseProtectionError,
    };
  }
  return null;
}

function enforcePipeline(
  policy: GatewayPolicy,
  requests: any[],
  storedSql: Map<number, string>,
) {
  const stateLost = () => new GatewayRequestError(
    409,
    'GATEWAY_STREAM_STATE_LOST',
    'The gateway lost this stream state (for example after a restart). Retry the transaction from the beginning.',
  );

  for (const item of requests) {
    if (item?.type === 'store_sql') {
      const sql = typeof item.sql === 'string' ? item.sql : '';
      if (sql && (policy.blockReads || policy.blockWrites)) enforcePolicy(policy, sql);
      if (item.sql_id != null) storedSql.set(Number(item.sql_id), sql);
      continue;
    }

    if (item?.type === 'close_sql') {
      if (item.sql_id != null) storedSql.delete(Number(item.sql_id));
      continue;
    }

    if (item?.type === 'execute') {
      const sql = resolveSql(item.stmt, storedSql);
      if (!sql) {
        if (policy.blockReads || policy.blockWrites) throw stateLost();
        continue;
      }
      enforcePolicy(policy, sql);
      continue;
    }

    if (item?.type === 'batch') {
      for (const step of item.batch?.steps || []) {
        const sql = resolveSql(step?.stmt, storedSql);
        if (!sql) {
          if (policy.blockReads || policy.blockWrites) throw stateLost();
          continue;
        }
        enforcePolicy(policy, sql);
      }
      continue;
    }

    if (item?.type === 'sequence') {
      const sql = resolveSql(item, storedSql);
      if (!sql) {
        if (policy.blockReads || policy.blockWrites) throw stateLost();
        continue;
      }
      enforcePolicy(policy, sql);
      continue;
    }

    // `describe` only prepares metadata and never executes the statement.
    if (item?.type === 'describe') continue;

    // Fail closed for any future SQL-bearing request type. Unknown requests
    // without SQL are forwarded unchanged (for example get_autocommit/close).
    const fallbackSql = resolveSql(item?.stmt, storedSql)
      || (typeof item?.sql === 'string' && item.sql.trim() ? item.sql : null);
    if (fallbackSql) {
      enforcePolicy(policy, fallbackSql);
      continue;
    }
    const fallbackSteps = Array.isArray(item?.batch?.steps) ? item.batch.steps : [];
    for (const step of fallbackSteps) {
      const sql = resolveSql(step?.stmt, storedSql);
      if (!sql) {
        if (policy.blockReads || policy.blockWrites) throw stateLost();
        continue;
      }
      enforcePolicy(policy, sql);
    }
  }
}

function enforceLegacyStatements(policy: GatewayPolicy, body: any) {
  if (!Array.isArray(body?.statements)) return;
  for (const statement of body.statements) {
    const sql = typeof statement === 'string' ? statement : statement?.q;
    if (typeof sql === 'string' && sql.trim()) enforcePolicy(policy, sql);
  }
}

type StatementUsage = {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
  success: boolean;
  errorCode?: string;
};

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageFromResult(sql: string, result: any): StatementUsage | null {
  if (!result) return null;
  if (result.type === 'error') {
    return {
      sql,
      rowsRead: 0,
      rowsWritten: 0,
      success: false,
      errorCode: String(result?.error?.code || 'GATEWAY_UPSTREAM_ERROR'),
    };
  }
  if (result.type !== 'ok') return null;

  const payload = result?.response?.result;
  if (!payload) return null;

  return {
    sql,
    rowsRead: Array.isArray(payload.rows) ? payload.rows.length : 0,
    rowsWritten: numericValue(payload.affected_row_count),
    success: true,
  };
}

/**
 * Converts a Hrana pipeline response into per-statement usage metrics. The
 * gateway already buffers pipeline responses to strip `base_url`, so this is
 * the only place where external libSQL traffic can be measured accurately.
 */
export function collectUsageMetrics(
  requests: any[],
  results: any[],
  storedSql: Map<number, string>,
): StatementUsage[] {
  const metrics: StatementUsage[] = [];

  requests.forEach((item, index) => {
    if (item?.type === 'execute') {
      const sql = resolveSql(item.stmt, storedSql);
      if (!sql) return;
      const metric = usageFromResult(sql, results[index]);
      if (metric) metrics.push(metric);
      return;
    }

    if (item?.type === 'batch') {
      const result = results[index];
      const stepResults = result?.response?.result?.step_results;
      const stepErrors = result?.response?.result?.step_errors;
      const steps = Array.isArray(item.batch?.steps) ? item.batch.steps : [];

      steps.forEach((step: any, stepIndex: number) => {
        const sql = resolveSql(step?.stmt, storedSql);
        if (!sql) return;

        const stepError = Array.isArray(stepErrors) ? stepErrors[stepIndex] : null;
        if (stepError) {
          metrics.push({
            sql,
            rowsRead: 0,
            rowsWritten: 0,
            success: false,
            errorCode: String(stepError?.code || 'GATEWAY_UPSTREAM_ERROR'),
          });
          return;
        }

        const stepResult = Array.isArray(stepResults) ? stepResults[stepIndex] : null;
        const metric = usageFromResult(sql, stepResult
          ? { type: 'ok', response: { result: stepResult } }
          : null);
        if (metric) metrics.push(metric);
      });
      return;
    }

    if (item?.type === 'sequence') {
      const sql = resolveSql(item, storedSql);
      if (!sql) return;
      const result = results[index];
      metrics.push({
        sql,
        rowsRead: 0,
        rowsWritten: 0,
        success: result?.type !== 'error',
        errorCode: result?.type === 'error'
          ? String(result?.error?.code || 'GATEWAY_UPSTREAM_ERROR')
          : undefined,
      });
    }
  });

  return metrics;
}

export function createGatewayServer(
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Server {
  const policyCache = new Map<string, PolicyCacheEntry>();
  const streams = new Map<string, StoredSqlState>();
  const pathPrefix = config.pathPrefix;
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });
  const verboseLogging = process.env.GATEWAY_LOG_REQUESTS === 'true';

  const resolvePolicy = dependencies.resolvePolicy
    || ((host: string) => fetchPolicyFromBackend(config, host));

  async function getPolicy(host: string): Promise<GatewayPolicy | null> {
    const cached = policyCache.get(host);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < config.policyTtlMs) {
      return cached.policy;
    }

    try {
      const policy = await resolvePolicy(host);
      if (!policy) {
        policyCache.delete(host);
        return null;
      }
      policyCache.set(host, { policy, fetchedAt: now });
      return policy;
    } catch (error: any) {
      if (cached && now - cached.fetchedAt <= config.policyMaxStaleMs) {
        console.warn(`[gateway] policy refresh failed for ${host}; using cached policy: ${error?.message || error}`);
        return cached.policy;
      }
      throw error;
    }
  }

  function getStream(baton: string | null) {
    if (!baton) return null;
    const state = streams.get(baton);
    if (!state) return null;
    if (state.expiresAt <= Date.now()) {
      streams.delete(baton);
      return null;
    }
    return state;
  }

  function saveStream(baton: unknown, sql: Map<number, string>) {
    if (typeof baton !== 'string' || !baton) return;
    streams.set(baton, {
      sql: new Map(sql),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
  }

  function deleteStream(baton: string | null) {
    if (baton) streams.delete(baton);
  }

  function sweepStreams() {
    const now = Date.now();
    for (const [baton, state] of streams.entries()) {
      if (state.expiresAt <= now) streams.delete(baton);
    }
    if (streams.size > 2_000) {
      const oldest = [...streams.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [baton] of oldest.slice(0, streams.size - 2_000)) streams.delete(baton);
    }
  }

  function isAllowedPath(pathname: string) {
    return pathname === '/v2/pipeline'
      || pathname === '/v1/pipeline'
      || pathname === '/pipeline'
      || pathname === '/'
      || pathname === '/v2'
      || pathname === '/v1'
      || pathname === '/v2/cursor'
      || pathname === '/v1/cursor'
      || pathname === '/version'
      || pathname === '/health';
  }

  function isPipelinePath(pathname: string) {
    return pathname === '/v2/pipeline'
      || pathname === '/v1/pipeline'
      || pathname === '/pipeline'
      || pathname === '/';
  }

  function isCursorPath(pathname: string) {
    return pathname === '/v2/cursor' || pathname === '/v1/cursor';
  }

  function isMetadataPath(pathname: string) {
    return pathname === '/'
      || pathname === '/version'
      || pathname === '/health'
      || pathname === '/v2'
      || pathname === '/v1';
  }

  function enforceCursor(
    policy: GatewayPolicy,
    body: any,
    storedSql: Map<number, string>,
  ) {
    const steps = Array.isArray(body?.batch?.steps) ? body.batch.steps : [];
    if (!steps.length) {
      if (policy.blockReads || policy.blockWrites) {
        throw new GatewayRequestError(
          400,
          'GATEWAY_INVALID_CURSOR',
          'The cursor request does not contain a batch of statements.',
        );
      }
      return;
    }

    for (const step of steps) {
      const sql = resolveSql(step?.stmt, storedSql);
      if (!sql) {
        if (policy.blockReads || policy.blockWrites) {
          throw new GatewayRequestError(
            409,
            'GATEWAY_STREAM_STATE_LOST',
            'The gateway lost this stream state (for example after a restart). Retry the transaction from the beginning.',
          );
        }
        continue;
      }
      enforcePolicy(policy, sql);
    }
  }

  async function proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    policy: GatewayPolicy,
    pathWithQuery: string,
    body: Buffer | null,
    rewritePipelineResponse: boolean,
  ): Promise<ProxyResult> {
    const target = buildUpstreamUrl(policy, pathWithQuery);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = proxyHeaders(req, body);
    const startedAt = Date.now();

    return new Promise<ProxyResult>((resolve) => {
      const upstream = transport.request(target, {
        method: req.method,
        headers,
        timeout: config.upstreamTimeoutMs,
        agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      }, (upstreamRes) => {
        const upstreamEncoding = String(upstreamRes.headers['content-encoding'] || 'identity').toLowerCase();
        if (upstreamEncoding !== 'identity') {
          sendJson(res, 502, {
            error: 'the upstream returned an unsupported content encoding',
            code: 'GATEWAY_UNSUPPORTED_ENCODING',
          });
          upstreamRes.resume();
          resolve({
            statusCode: 502,
            durationMs: Date.now() - startedAt,
            responseBytes: 0,
          });
          return;
        }

        if (!rewritePipelineResponse) {
          const declaredLength = Number(upstreamRes.headers['content-length'] || 0);
          const statusCode = upstreamRes.statusCode || 502;
          res.writeHead(statusCode, responseHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          upstreamRes.on('end', () => {
            resolve({
              statusCode,
              durationMs: Date.now() - startedAt,
              responseBytes: Number.isFinite(declaredLength) ? declaredLength : 0,
            });
          });
          upstreamRes.on('error', (error) => {
            if (!res.headersSent) sendJson(res, 502, { error: 'upstream response error', code: 'GATEWAY_UPSTREAM_ERROR' });
            else res.destroy(error);
            resolve({
              statusCode: 502,
              durationMs: Date.now() - startedAt,
              responseBytes: 0,
            });
          });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        upstreamRes.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > config.bodyLimitBytes) {
            upstream.destroy(new Error('upstream response too large'));
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          const statusCode = upstreamRes.statusCode || 502;
          const responseBody = Buffer.concat(chunks);
          let rewritten = responseBody;
          let parsed: any = null;
          try {
            parsed = JSON.parse(responseBody.toString('utf8'));
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed === 'object' && parsed.base_url) {
            parsed.base_url = null;
            rewritten = Buffer.from(JSON.stringify(parsed));
          }
          res.writeHead(
            statusCode,
            responseHeaders(upstreamRes.headers, rewritten.length),
          );
          res.end(rewritten);
          if (parsed && typeof parsed === 'object') {
            const requestedBaton = typeof (req as any).__gatewayBaton === 'string'
              ? (req as any).__gatewayBaton
              : null;
            if (typeof parsed.baton === 'string' && parsed.baton) {
              if (requestedBaton && requestedBaton !== parsed.baton) deleteStream(requestedBaton);
              saveStream(parsed.baton, (req as any).__gatewayStoredSql || new Map());
            } else {
              deleteStream(requestedBaton);
            }
          }
          resolve({
            statusCode,
            durationMs: Date.now() - startedAt,
            responseBytes: rewritten.length,
            body: parsed,
          });
        });
        upstreamRes.on('error', (error) => {
          if (!res.headersSent) sendJson(res, 502, { error: 'upstream response error', code: 'GATEWAY_UPSTREAM_ERROR' });
          else res.destroy(error);
          resolve({
            statusCode: 502,
            durationMs: Date.now() - startedAt,
            responseBytes: 0,
          });
        });
      });

      upstream.on('timeout', () => upstream.destroy(new Error('upstream request timed out')));
      upstream.on('error', (error: any) => {
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: `gateway upstream error: ${error?.message || error}`,
            code: 'GATEWAY_UPSTREAM_ERROR',
          });
        } else {
          res.destroy(error);
        }
        resolve({
          statusCode: 502,
          durationMs: Date.now() - startedAt,
          responseBytes: 0,
        });
      });

      if (body) upstream.end(body);
      else req.pipe(upstream);
    });
  }

  function recordQueryUsage(
    policy: GatewayPolicy,
    requests: any[],
    storedSql: Map<number, string>,
    proxyResult: ProxyResult,
  ) {
    if (!dependencies.recordQuery) return;
    const results = proxyResult.body?.results;
    if (!Array.isArray(results)) return;

    const metrics = collectUsageMetrics(requests, results, storedSql);
    if (metrics.length === 0) return;

    // Hrana reports one response for the whole pipeline; distribute the
    // observed latency so aggregate averages stay representative.
    const perStatementMs = Math.max(1, Math.round(proxyResult.durationMs / metrics.length));
    for (const metric of metrics) {
      dependencies.recordQuery({
        databaseId: policy.databaseId,
        sql: metric.sql,
        durationMs: perStatementMs,
        rowsRead: metric.rowsRead,
        rowsWritten: metric.rowsWritten,
        success: metric.success,
        errorCode: metric.errorCode,
      });
    }
  }

  function recordTrafficUsage(
    policy: GatewayPolicy,
    req: IncomingMessage,
    path: string,
    requestBytes: number,
    proxyResult: ProxyResult,
  ) {
    dependencies.recordTraffic?.({
      databaseId: policy.databaseId,
      method: req.method || 'POST',
      path,
      requestBytes,
      responseBytes: proxyResult.responseBytes,
      statusCode: proxyResult.statusCode,
      durationMs: proxyResult.durationMs,
    });
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestUrl = new URL(req.url || '/', 'http://gateway');
    let host = normalizeHost(req.headers.host);
    let status = 500;
    let blocked = false;

    try {
      if (requestUrl.pathname === '/__health' || requestUrl.pathname === `${pathPrefix}/__health`) {
        status = 200;
        sendJson(res, 200, { ok: true, uptime: process.uptime() });
        return;
      }

      const hasExplicitPrefix = requestUrl.pathname === pathPrefix
        || requestUrl.pathname.startsWith(`${pathPrefix}/`);
      if (!hasExplicitPrefix && !config.allowRoot) {
        status = 404;
        sendJson(res, 404, { error: 'not found', code: 'GATEWAY_NOT_FOUND' });
        return;
      }

      if (!host) {
        status = 400;
        sendJson(res, 400, { error: 'missing host header', code: 'GATEWAY_MISSING_HOST' });
        return;
      }

      if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
        status = 501;
        blocked = true;
        sendJson(res, 501, {
          error: 'WebSocket upgrades are not supported by the enforcement gateway. Use the HTTP libSQL URL.',
          code: 'GATEWAY_WEBSOCKET_UNSUPPORTED',
        });
        return;
      }

      let policy: GatewayPolicy | null;
      try {
        policy = await getPolicy(host);
      } catch (error: any) {
        status = 503;
        sendJson(res, 503, {
          error: 'gateway policy is unavailable',
          code: 'GATEWAY_POLICY_UNAVAILABLE',
        });
        console.warn(`[gateway] policy unavailable for ${host}: ${error?.message || error}`);
        return;
      }

      if (!policy) {
        status = 404;
        sendJson(res, 404, { error: 'database not found for host', code: 'GATEWAY_DATABASE_NOT_FOUND' });
        return;
      }

      const strippedPath = hasExplicitPrefix
        ? (requestUrl.pathname === pathPrefix
          ? '/'
          : requestUrl.pathname.slice(pathPrefix.length) || '/')
        : requestUrl.pathname;
      if (!isAllowedPath(strippedPath)) {
        status = 404;
        sendJson(res, 404, { error: 'not found', code: 'GATEWAY_NOT_FOUND' });
        return;
      }

      const pathWithQuery = `${strippedPath}${requestUrl.search}`;
      const method = String(req.method || '').toUpperCase();
      const pipelineRequest = method === 'POST' && isPipelinePath(strippedPath);
      const cursorRequest = method === 'POST' && isCursorPath(strippedPath);
      const metadataRequest = (method === 'GET' || method === 'HEAD')
        && isMetadataPath(strippedPath);

      if (!pipelineRequest && !cursorRequest && !metadataRequest) {
        status = 405;
        sendJson(res, 405, {
          error: 'method not allowed for this gateway endpoint',
          code: 'GATEWAY_METHOD_NOT_ALLOWED',
        });
        return;
      }

      if (metadataRequest) {
        const declaredLength = Number(req.headers['content-length'] || 0);
        const proxyResult = await proxyRequest(req, res, policy, pathWithQuery, null, false);
        recordTrafficUsage(
          policy,
          req,
          requestUrl.pathname,
          Number.isFinite(declaredLength) ? declaredLength : 0,
          proxyResult,
        );
        status = proxyResult.statusCode;
        return;
      }

      const requestEncoding = String(req.headers['content-encoding'] || 'identity').toLowerCase();
      if (requestEncoding !== 'identity') {
        status = 415;
        sendJson(res, 415, {
          error: 'compressed request bodies are not supported',
          code: 'GATEWAY_UNSUPPORTED_ENCODING',
        });
        return;
      }

      const rawBody = await readBody(req, config.bodyLimitBytes);
      let parsedBody: any;
      try {
        parsedBody = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
      } catch {
        status = 400;
        sendJson(res, 400, { error: 'invalid JSON body', code: 'GATEWAY_INVALID_JSON' });
        return;
      }

      const baton = typeof parsedBody?.baton === 'string' ? parsedBody.baton : null;
      const existing = getStream(baton);
      const requests = Array.isArray(parsedBody?.requests) ? parsedBody.requests : [];
      const cursorSteps = Array.isArray(parsedBody?.batch?.steps) ? parsedBody.batch.steps : [];
      if (baton && !existing && (policy.blockReads || policy.blockWrites)) {
        const referencesStoredSql = requests.some((item: any) => (
          item?.type === 'execute' && item?.stmt?.sql_id != null
          || item?.type === 'sequence' && item?.sql_id != null
          || item?.type === 'batch' && (item?.batch?.steps || []).some((step: any) => step?.stmt?.sql_id != null)
        )) || cursorSteps.some((step: any) => step?.stmt?.sql_id != null);
        if (referencesStoredSql) {
          status = 409;
          sendJson(res, 409, {
            error: 'The gateway lost this stream state. Retry the transaction from the beginning.',
            code: 'GATEWAY_STREAM_STATE_LOST',
          });
          return;
        }
      }

      const storedSql = new Map<number, string>(existing?.sql || []);
      try {
        if (cursorRequest) {
          enforceCursor(policy, parsedBody, storedSql);
          const proxyResult = await proxyRequest(req, res, policy, pathWithQuery, rawBody, false);
          recordTrafficUsage(policy, req, requestUrl.pathname, rawBody.length, proxyResult);
          status = proxyResult.statusCode;
          return;
        }

        if (strippedPath === '/' && Array.isArray(parsedBody?.statements)) {
          enforceLegacyStatements(policy, parsedBody);
        } else if (strippedPath === '/' && Array.isArray(parsedBody)) {
          for (const statement of parsedBody) {
            const sql = typeof statement === 'string' ? statement : statement?.q;
            if (typeof sql === 'string' && sql.trim()) enforcePolicy(policy, sql);
          }
        } else if (strippedPath === '/' && typeof parsedBody?.q === 'string') {
          enforcePolicy(policy, parsedBody.q);
        } else if (strippedPath === '/' && typeof parsedBody?.sql === 'string') {
          enforcePolicy(policy, parsedBody.sql);
        } else if (strippedPath === '/' && (policy.blockReads || policy.blockWrites)) {
          throw new GatewayRequestError(
            400,
            'GATEWAY_UNSUPPORTED_REQUEST',
            'The gateway does not recognize this legacy request shape.',
          );
        } else {
          enforcePipeline(policy, requests, storedSql);
        }
      } catch (error: any) {
        const mapped = protectionErrorResponse(error);
        if (mapped) {
          status = mapped.status;
          blocked = mapped.blocked;
          sendJson(res, mapped.status, { error: mapped.message, code: mapped.code });
          return;
        }
        throw error;
      }

      (req as any).__gatewayBaton = baton;
      (req as any).__gatewayStoredSql = storedSql;
      const proxyResult = await proxyRequest(req, res, policy, pathWithQuery, rawBody, true);
      recordQueryUsage(policy, requests, storedSql, proxyResult);
      recordTrafficUsage(policy, req, requestUrl.pathname, rawBody.length, proxyResult);
      status = proxyResult.statusCode;
    } catch (error: any) {
      status = error?.statusCode || 500;
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status === 413 ? 'request body too large' : (error?.message || 'gateway error'),
          code: status === 413 ? 'GATEWAY_BODY_TOO_LARGE' : 'GATEWAY_ERROR',
        });
      } else {
        res.destroy(error);
      }
    } finally {
      sweepStreams();
      if (verboseLogging || blocked || status >= 400) {
        console.log(
          `[gateway] ${host || '-'} ${req.method || '-'} ${requestUrl.pathname} ` +
          `status=${status} blocked=${blocked} duration=${Date.now() - startedAt}ms`,
        );
      }
    }
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('close', () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  });

  return server;
}
