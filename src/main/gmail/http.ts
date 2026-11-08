import { GmailError } from './errors.ts';

export const gmailBodyLimit = 8_388_608;

const reasonPattern = /^[A-Za-z0-9_]{1,64}$/;
const quotaReasons = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded'
]);
const permissionReasons = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'forbidden'
]);

export interface LimitedResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

function contentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export async function readLimitedBody(response: LimitedResponse): Promise<Uint8Array> {
  const declared = contentLength(response.headers.get('content-length'));
  if (declared !== null && declared > gmailBodyLimit)
    throw new GmailError('too-large', response.status);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > gmailBodyLimit) {
        await reader.cancel();
        throw new GmailError('too-large', response.status);
      }
      chunks.push(step.value);
    }
  } catch (error) {
    if (error instanceof GmailError) throw error;
    throw new GmailError('network', response.status);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function safeReason(value: unknown): string | null {
  if (typeof value !== 'string' || !reasonPattern.test(value)) return null;
  return value;
}

export function classifyGmailFailure(
  status: number,
  payload: unknown
): { code: GmailError['code']; reason: string | null } {
  const reasons = reasonsOf(payload);
  const quota = reasons.some((reason) => quotaReasons.has(reason));
  const permission = reasons.some((reason) => permissionReasons.has(reason));
  const statusName = statusOf(payload);
  if (status === 429 || quota || statusName === 'RESOURCE_EXHAUSTED') {
    return {
      code: 'rate-limited',
      reason: reasons.find((reason) => quotaReasons.has(reason)) ?? statusName
    };
  }
  if (status === 401) return { code: 'gmail-rejected', reason: reasons[0] ?? statusName };
  if (status === 404) return { code: 'not-found', reason: reasons[0] ?? statusName };
  if (status === 403 && (permission || statusName === 'PERMISSION_DENIED')) {
    return {
      code: 'permission-denied',
      reason: reasons.find((reason) => permissionReasons.has(reason)) ?? statusName
    };
  }
  if (status === 403) return { code: 'unavailable', reason: reasons[0] ?? statusName };
  return { code: 'unavailable', reason: reasons[0] ?? statusName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonsOf(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const error = payload.error;
  if (!isRecord(error)) return [];
  const errors = error.errors;
  if (!Array.isArray(errors)) return [];
  const reasons: string[] = [];
  for (const item of errors) {
    if (!isRecord(item)) continue;
    const reason = safeReason(item.reason);
    if (reason !== null) reasons.push(reason);
  }
  return reasons;
}

function statusOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (!isRecord(error)) return null;
  if (reasonsOf(payload).length > 0) return null;
  return safeReason(error.status);
}

export function retryDelay(header: string | null): number {
  if (header === '1' || header === '2') return Number(header) * 1000;
  return 1000;
}

export function recordGmailFailure(status: number, reason: string | null): void {
  if (process.env.NODE_ENV !== 'development') return;
  const identifier = reason !== null && reasonPattern.test(reason) ? reason : 'none';
  console.error(`aurora gmail status=${status} reason=${identifier}`);
}
