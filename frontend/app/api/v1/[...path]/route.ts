import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.INTERNAL_API_URL || 'http://backend:3000/api/v1';

async function proxy(request: NextRequest, params: { path: string[] }) {
  const targetUrl = `${BACKEND_URL}/${params.path.join('/')}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    redirect: 'manual',
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('transfer-encoding');

  const setCookie = (response.headers as any).getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    responseHeaders.delete('set-cookie');
    for (const cookie of setCookie) {
      responseHeaders.append('set-cookie', cookie);
    }
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
