import { NextRequest } from 'next/server';

const BACKEND_URL = (
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://127.0.0.1:3000/api/v1'
).replace(/\/+$/, '');

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

async function proxy(request: NextRequest, params: { path: string[] }) {
  if (params.path.some((segment) => segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    return errorResponse('invalid proxy path', 400);
  }

  const targetUrl = `${BACKEND_URL}/${params.path.join('/')}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);

  // Do not forward hop-by-hop or host headers to the backend.
  headers.delete('host');
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('proxy-authenticate');
  headers.delete('proxy-authorization');
  headers.delete('te');
  headers.delete('trailer');
  headers.delete('transfer-encoding');
  headers.delete('upgrade');

  const contentLength = request.headers.get('content-length');
  const hasBody =
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body !== null &&
    contentLength !== '0';

  if (!hasBody) {
    headers.delete('content-length');
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (hasBody) {
    // Stream the body directly so large uploads do not get buffered in the
    // frontend process. `duplex` is required by fetch for streaming bodies.
    init.body = request.body as any;
    init.duplex = 'half';
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, init);
  } catch (error: any) {
    console.error('[api-proxy] upstream request failed', {
      method: request.method,
      path: request.nextUrl.pathname,
      error: error?.message || String(error),
    });
    return errorResponse(`backend request failed: ${error?.message || 'unknown error'}`, 502);
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('transfer-encoding');
  responseHeaders.delete('content-length');

  const setCookie = (response.headers as any).getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    responseHeaders.delete('set-cookie');
    for (const cookie of setCookie) {
      responseHeaders.append('set-cookie', cookie);
    }
  }

  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}

export async function OPTIONS(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, await context.params);
}
