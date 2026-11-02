import { OAuthFlowError } from './errors.ts';
import { pkceChallengeS256 } from './pkce.ts';

export const googleAuthorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
export const googleTokenUrl = 'https://oauth2.googleapis.com/token';
export const googleRevokeUrl = 'https://oauth2.googleapis.com/revoke';

export const googleScopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly'
] as const;

const requestTimeoutMs = 10_000;

export interface AuthorizationCodeTokens {
  idToken: string;
  refreshToken: string | null;
}

export interface RefreshedTokens {
  refreshToken: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signalFor(timeoutMs: number, cancel: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (cancel === undefined) return timeout;
  return AbortSignal.any([timeout, cancel]);
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  timeoutMs: number,
  cancel: AbortSignal | undefined
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: signalFor(timeoutMs, cancel)
    });
  } catch (error) {
    if (cancel?.aborted) throw new OAuthFlowError('oauth-cancelled');
    void error;
    throw new OAuthFlowError('network');
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new OAuthFlowError('provider-rejected');
  }
}

function optionalRefreshToken(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) {
    throw new OAuthFlowError('provider-rejected');
  }
  return value;
}

const oauthErrorIdentifierPattern = /^[a-z0-9_]{1,32}$/;

function oauthErrorIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || !oauthErrorIdentifierPattern.test(value)) return null;
  return value;
}

function recordTokenExchangeFailure(status: number, providerError: unknown): void {
  if (process.env.NODE_ENV !== 'development') return;
  const identifier = oauthErrorIdentifier(providerError);
  console.error(`aurora oauth stage=token-exchange status=${status} error=${identifier ?? 'none'}`);
}

function withClientSecret(
  body: URLSearchParams,
  clientSecret: string | null | undefined
): URLSearchParams {
  if (clientSecret !== undefined && clientSecret !== null) body.set('client_secret', clientSecret);
  return body;
}

function readError(payload: Record<string, unknown>): void {
  if (payload.error === undefined) return;
  if (payload.error === 'invalid_grant') throw new OAuthFlowError('needs-reauth');
  throw new OAuthFlowError('provider-rejected');
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
}): string {
  const url = new URL(googleAuthorizationUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', googleScopes.join(' '));
  url.searchParams.set('code_challenge', pkceChallengeS256(input.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  return url.href;
}

export async function exchangeAuthorizationCode(input: {
  fetchImpl: typeof fetch;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  clientSecret?: string | null;
  cancel?: AbortSignal;
  timeoutMs?: number;
}): Promise<AuthorizationCodeTokens> {
  const body = withClientSecret(
    new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code'
    }),
    input.clientSecret
  );
  const response = await postForm(
    input.fetchImpl,
    googleTokenUrl,
    body,
    input.timeoutMs ?? requestTimeoutMs,
    input.cancel
  );
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    recordTokenExchangeFailure(response.status, undefined);
    throw new OAuthFlowError('provider-rejected');
  }
  if (!isRecord(payload)) {
    recordTokenExchangeFailure(response.status, undefined);
    throw new OAuthFlowError('provider-rejected');
  }
  if (payload.error !== undefined) {
    recordTokenExchangeFailure(response.status, payload.error);
    if (payload.error === 'invalid_grant') throw new OAuthFlowError('needs-reauth');
    throw new OAuthFlowError('provider-rejected');
  }
  if (!response.ok || typeof payload.id_token !== 'string' || payload.id_token.length < 1) {
    recordTokenExchangeFailure(response.status, undefined);
    throw new OAuthFlowError('provider-rejected');
  }
  try {
    return {
      idToken: payload.id_token,
      refreshToken: optionalRefreshToken(payload.refresh_token)
    };
  } catch (error) {
    recordTokenExchangeFailure(response.status, undefined);
    throw error;
  }
}

export async function refreshAccessToken(input: {
  fetchImpl: typeof fetch;
  clientId: string;
  refreshToken: string;
  clientSecret?: string | null;
  cancel?: AbortSignal;
  timeoutMs?: number;
}): Promise<RefreshedTokens> {
  const body = withClientSecret(
    new URLSearchParams({
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token'
    }),
    input.clientSecret
  );
  const response = await postForm(
    input.fetchImpl,
    googleTokenUrl,
    body,
    input.timeoutMs ?? requestTimeoutMs,
    input.cancel
  );
  const payload = await readJson(response);
  if (!isRecord(payload)) throw new OAuthFlowError('provider-rejected');
  readError(payload);
  if (!response.ok) throw new OAuthFlowError('provider-rejected');
  return { refreshToken: optionalRefreshToken(payload.refresh_token) };
}

export async function revokeRefreshToken(input: {
  fetchImpl: typeof fetch;
  refreshToken: string;
  cancel?: AbortSignal;
  timeoutMs?: number;
}): Promise<'revoked' | 'local'> {
  const body = new URLSearchParams({ token: input.refreshToken });
  try {
    const response = await postForm(
      input.fetchImpl,
      googleRevokeUrl,
      body,
      input.timeoutMs ?? requestTimeoutMs,
      input.cancel
    );
    return response.status === 200 ? 'revoked' : 'local';
  } catch {
    return 'local';
  }
}
