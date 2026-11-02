import { createPublicKey, verify, timingSafeEqual, type JsonWebKey } from 'node:crypto';
import { OAuthFlowError } from './errors.ts';
import { isGoogleIssuer } from './google-issuer.ts';

const certsUrl = 'https://www.googleapis.com/oauth2/v3/certs';
const clockSkewSeconds = 60;
const maxCacheSeconds = 3_600;

export interface JwksClient {
  getKey(kid: string): Promise<JsonWebKey | null>;
}

export interface GoogleIdentity {
  subject: string;
  email: string | null;
  displayName: string | null;
}

interface JsonWebTokenHeader {
  alg: string;
  kid: string;
}

function reject(): never {
  throw new OAuthFlowError('provider-rejected');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) reject();
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.length < 1) reject();
  return decoded;
}

function readHeader(segment: string): JsonWebTokenHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(segment).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error;
    reject();
  }
  if (!isRecord(parsed) || parsed.alg !== 'RS256' || typeof parsed.kid !== 'string') reject();
  if (parsed.kid.length < 1 || parsed.kid.length > 256) reject();
  return { alg: 'RS256', kid: parsed.kid };
}

function readPayload(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(segment).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error;
    reject();
  }
  if (!isRecord(parsed)) reject();
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireClaimString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) reject();
  if (hasControlCharacter(value)) reject();
  return value;
}

function optionalDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return null;
  if (hasControlCharacter(value)) return null;
  return value;
}

function verifiedEmail(payload: Record<string, unknown>): string | null {
  if (payload.email_verified !== true) return null;
  return requireClaimString(payload.email, 320);
}

function safeEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function cacheSeconds(header: string | null): number {
  if (header === null) return maxCacheSeconds;
  const match = /max-age=(\d+)/.exec(header);
  if (match?.[1] === undefined) return maxCacheSeconds;
  return Math.min(Number(match[1]), maxCacheSeconds);
}

function isRsaJwk(value: unknown): value is JsonWebKey {
  if (!isRecord(value) || value.kty !== 'RSA' || typeof value.n !== 'string') return false;
  return typeof value.e === 'string' && value.n.length > 0 && value.e.length > 0;
}

export function createGoogleJwksClient(
  fetchImpl: typeof fetch,
  now: () => number = () => Date.now()
): JwksClient {
  let cached: { keys: JsonWebKey[]; expiresAt: number } | null = null;

  async function load(): Promise<JsonWebKey[]> {
    if (cached !== null && cached.expiresAt > now()) return cached.keys;
    let response: Response;
    try {
      response = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new OAuthFlowError('network');
    }
    if (!response.ok) throw new OAuthFlowError('provider-rejected');
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new OAuthFlowError('provider-rejected');
    }
    if (!isRecord(payload) || !Array.isArray(payload.keys)) {
      throw new OAuthFlowError('provider-rejected');
    }
    const keys = payload.keys.filter(isRsaJwk);
    cached = {
      keys,
      expiresAt: now() + cacheSeconds(response.headers.get('cache-control')) * 1000
    };
    return keys;
  }

  return {
    async getKey(kid: string): Promise<JsonWebKey | null> {
      const first = await load();
      const match = first.find((key) => key.kid === kid);
      if (match !== undefined) return match;
      cached = null;
      const second = await load();
      return second.find((key) => key.kid === kid) ?? null;
    }
  };
}

export async function verifyGoogleIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string;
  jwks: JwksClient;
  now?: () => Date;
}): Promise<GoogleIdentity> {
  const parts = input.idToken.split('.');
  if (parts.length !== 3) reject();
  const encodedHeader = parts[0] ?? '';
  const encodedPayload = parts[1] ?? '';
  const encodedSignature = parts[2] ?? '';
  const header = readHeader(encodedHeader);
  const signature = decodeSegment(encodedSignature);
  const key = await input.jwks.getKey(header.kid);
  if (key === null) reject();
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  let valid = false;
  try {
    valid = verify('RSA-SHA256', signed, createPublicKey({ key, format: 'jwk' }), signature);
  } catch {
    reject();
  }
  if (!valid) reject();

  const payload = readPayload(encodedPayload);
  if (typeof payload.iss !== 'string' || !isGoogleIssuer(payload.iss)) reject();
  if (payload.aud !== input.clientId) reject();
  const nowSeconds = Math.floor((input.now ?? (() => new Date()))().getTime() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSeconds < nowSeconds) reject();
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > nowSeconds) reject();
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, input.nonce)) reject();
  return {
    subject: requireClaimString(payload.sub, 256),
    email: verifiedEmail(payload),
    displayName: optionalDisplayName(payload.name)
  };
}
