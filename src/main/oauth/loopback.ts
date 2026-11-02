import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { isGoogleIssuer } from './google-issuer.ts';

export const callbackPage =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Aurora</title></head><body><p>You can close this window.</p></body></html>';

const allowedKeys = ['code', 'state', 'error', 'scope', 'authuser', 'prompt', 'iss'] as const;
const unmatchedLimit = 16;

export type LoopbackFailure =
  'denied' | 'rejected' | 'limit' | 'cancelled' | 'timeout' | 'shutdown';

export type LoopbackResult = { kind: 'code'; code: string } | { kind: LoopbackFailure };

export interface AuthorizationRequest {
  method: string;
  url: string;
  host: string | undefined;
  remoteAddress: string | undefined;
  contentLength: string | undefined;
  hasBody: boolean;
  expectedState: string;
  port: number;
}

export type AuthorizationDecision =
  { consume: false; status: number } | { consume: true; status: number; result: LoopbackResult };

export interface LoopbackSession {
  redirectUri: string;
  done: Promise<LoopbackResult>;
  cancel(reason: 'cancelled' | 'timeout' | 'shutdown'): void;
}

function safeEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  return normalized === '127.0.0.1';
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function single(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
}

export function evaluateAuthorizationRequest(request: AuthorizationRequest): AuthorizationDecision {
  if (!isLoopbackAddress(request.remoteAddress)) return { consume: false, status: 400 };
  if (request.method !== 'GET') return { consume: false, status: 405 };
  if (request.url.length < 1 || request.url.length > 2048) return { consume: false, status: 400 };
  if (request.hasBody) return { consume: false, status: 400 };
  if (request.contentLength !== undefined && request.contentLength !== '0') {
    return { consume: false, status: 400 };
  }
  if (request.host !== `127.0.0.1:${request.port}`) return { consume: false, status: 400 };

  let parsed: URL;
  try {
    parsed = new URL(request.url, `http://127.0.0.1:${request.port}`);
  } catch {
    return { consume: false, status: 400 };
  }
  if (parsed.pathname !== '/callback') return { consume: false, status: 404 };
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    return { consume: false, status: 400 };
  }

  const keys = [...parsed.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return { consume: false, status: 400 };
  for (const key of keys) {
    if (!allowedKeys.some((allowed) => allowed === key)) return { consume: false, status: 400 };
  }

  const state = single(parsed.searchParams, 'state');
  if (state === undefined || state === null || !safeEqual(state, request.expectedState)) {
    return { consume: false, status: 400 };
  }

  const code = single(parsed.searchParams, 'code');
  const error = single(parsed.searchParams, 'error');
  const issuer = single(parsed.searchParams, 'iss');
  if (code === undefined || error === undefined || issuer === undefined) {
    return { consume: true, status: 400, result: { kind: 'rejected' } };
  }
  if (issuer !== null && !isGoogleIssuer(issuer)) {
    return { consume: true, status: 400, result: { kind: 'rejected' } };
  }
  if (code !== null && error !== null) {
    return { consume: true, status: 400, result: { kind: 'rejected' } };
  }
  if (error === 'access_denied') return { consume: true, status: 200, result: { kind: 'denied' } };
  if (error !== null) return { consume: true, status: 400, result: { kind: 'rejected' } };
  if (code === null || code.length < 1 || code.length > 2048 || hasControlCharacter(code)) {
    return { consume: true, status: 400, result: { kind: 'rejected' } };
  }
  return { consume: true, status: 200, result: { kind: 'code', code } };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

function writePage(response: ServerResponse, status: number, after?: () => void): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close'
  });
  response.end(callbackPage, () => {
    after?.();
  });
}

export function listenForAuthorizationCallback(expectedState: string): Promise<LoopbackSession> {
  const sockets = new Set<Socket>();
  let unmatched = 0;
  let settled = false;
  let resolveDone: ((result: LoopbackResult) => void) | null = null;
  const done = new Promise<LoopbackResult>((resolve) => {
    resolveDone = resolve;
  });

  const server: Server = createServer();
  server.requestTimeout = 5_000;
  server.headersTimeout = 2_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;

  const finish = (result: LoopbackResult): void => {
    if (settled) return;
    settled = true;
    resolveDone?.(result);
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  };

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('error', () => {
      request.destroy();
    });
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) {
        writePage(response, 404);
        return;
      }
      const address = server.address();
      const port = address !== null && typeof address !== 'string' ? address.port : 0;
      const decision = evaluateAuthorizationRequest({
        method: request.method ?? '',
        url: request.url ?? '',
        host: headerValue(request.headers.host),
        remoteAddress: request.socket.remoteAddress,
        contentLength: headerValue(request.headers['content-length']),
        hasBody: Buffer.concat(chunks).length > 0,
        expectedState,
        port
      });
      writePage(response, decision.status, () => {
        if (settled) return;
        if (!decision.consume) {
          unmatched += 1;
          if (unmatched >= unmatchedLimit) finish({ kind: 'limit' });
          return;
        }
        finish(decision.result);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        finish({ kind: 'shutdown' });
        reject(new Error('loopback'));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        done,
        cancel(reason) {
          finish({ kind: reason });
        }
      });
    });
  });
}
