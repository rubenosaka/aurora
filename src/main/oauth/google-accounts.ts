import { randomBytes } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import {
  type DisconnectOutcome,
  type GoogleAccountSummary,
  type GoogleCancelResult,
  type GoogleClientSaved,
  type GoogleClientState,
  type GoogleDisconnectResult,
  grantAllowsMailChanges
} from '../../shared/google-accounts.ts';
import {
  getConnectedAccount,
  readOAuthClient,
  deleteConnectedAccount
} from '../persistence/accounts.ts';
import {
  AccountLinkError,
  commitAccountConnection,
  listGoogleAccounts,
  markRefreshTokenUnusable,
  noteGoogleReauth,
  readGoogleClient,
  readGoogleClientState,
  replaceAccountRefreshToken,
  saveGoogleClient,
  saveGrantedScopes
} from '../persistence/account-link.ts';
import { readAccountRefreshToken, readClientSecret } from '../persistence/credentials.ts';
import { PersistenceError } from '../persistence/errors.ts';
import { type SecretCipher } from '../persistence/safe-storage-cipher.ts';
import { OAuthFlowError, type OAuthFlowCode } from './errors.ts';
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeRefreshToken,
  buildAuthorizationUrl,
  type RefreshedTokens
} from './google-flow.ts';
import { createGoogleJwksClient, verifyGoogleIdToken, type JwksClient } from './id-token.ts';
import {
  listenForAuthorizationCallback,
  type LoopbackFailure,
  type LoopbackSession
} from './loopback.ts';
import { createPkceVerifier } from './pkce.ts';

const flowTimeoutMs = 180_000;
const requestTimeoutMs = 10_000;

interface AuthorizingPhase {
  name: 'authorizing';
  generation: number;
  cancel: (reason: 'cancelled' | 'timeout' | 'shutdown') => void;
}

interface ExchangingPhase {
  name: 'exchanging';
  generation: number;
  abort: AbortController;
}

interface BusyPhase {
  name: 'busy';
  generation: number;
}

type Phase = { name: 'idle' } | AuthorizingPhase | ExchangingPhase | BusyPhase;

export interface GoogleAccountDependencies {
  database: DatabaseSync;
  cipher: SecretCipher;
  fetchImpl: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  listen?: (state: string) => Promise<LoopbackSession>;
  jwks?: JwksClient;
  now?: () => Date;
  flowTimeoutMs?: number;
  requestTimeoutMs?: number;
  revokeTimeoutMs?: number;
}

export interface GoogleAccountService {
  getClientId(): GoogleClientState;
  saveClientId(clientId: string, clientSecret?: string | null): GoogleClientSaved;
  listAccounts(): GoogleAccountSummary[];
  connect(): Promise<GoogleAccountSummary>;
  reconnect(accountId: string): Promise<GoogleAccountSummary>;
  cancel(): GoogleCancelResult;
  disconnect(accountId: string): Promise<GoogleDisconnectResult>;
  refreshAccount(accountId: string): Promise<void>;
  beginMailboxRead(): void;
  endMailboxRead(): void;
  mailboxAccess(accountId: string, force?: boolean): Promise<string>;
  modificationGrant(accountId: string): 'ready' | 'readonly' | 'needs-reauth';
  forgetMailboxAccess(accountId: string): void;
  shutdown(): void;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function mapLinkError(error: AccountLinkError): OAuthFlowError {
  if (error.code === 'client-in-use') return new OAuthFlowError('client-in-use');
  if (error.code === 'account-mismatch') return new OAuthFlowError('account-mismatch');
  if (error.code === 'needs-reauth') return new OAuthFlowError('needs-reauth');
  return new OAuthFlowError('provider-rejected');
}

function mapPersistenceError(error: PersistenceError): OAuthFlowError {
  if (error.code === 'encryption-unavailable') return new OAuthFlowError('encryption-unavailable');
  if (error.code === 'decrypt-failed') return new OAuthFlowError('needs-reauth');
  if (error.code === 'not-found' || error.code === 'invalid') {
    return new OAuthFlowError('invalid-request');
  }
  return new OAuthFlowError('internal');
}

function asFlowError(error: unknown): OAuthFlowError {
  if (error instanceof OAuthFlowError) return error;
  if (error instanceof AccountLinkError) return mapLinkError(error);
  if (error instanceof PersistenceError) return mapPersistenceError(error);
  return new OAuthFlowError('internal');
}

function loopbackCode(kind: LoopbackFailure): OAuthFlowCode {
  if (kind === 'denied') return 'oauth-denied';
  if (kind === 'limit') return 'callback-limit';
  if (kind === 'timeout') return 'oauth-timeout';
  if (kind === 'cancelled' || kind === 'shutdown') return 'oauth-cancelled';
  return 'provider-rejected';
}

function toSummary(account: {
  id: string;
  email: string | null;
  displayName: string | null;
  status: string;
  grantedScopes: string;
}): GoogleAccountSummary {
  if (account.status !== 'connected' && account.status !== 'needs_reauth') {
    throw new OAuthFlowError('internal');
  }
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    status: account.status,
    canModifyMail: grantAllowsMailChanges(account.grantedScopes.split(' '))
  };
}

export function createGoogleAccountService(deps: GoogleAccountDependencies): GoogleAccountService {
  const listen = deps.listen ?? listenForAuthorizationCallback;
  const jwks = deps.jwks ?? createGoogleJwksClient(deps.fetchImpl);
  const now = deps.now ?? (() => new Date());
  const authorizationTimeout = deps.flowTimeoutMs ?? flowTimeoutMs;
  const httpTimeout = deps.requestTimeoutMs ?? requestTimeoutMs;
  const revokeTimeout = deps.revokeTimeoutMs ?? requestTimeoutMs;
  const lifecycle = new AbortController();
  let generation = 0;
  let readers = 0;
  let phase: Phase = { name: 'idle' };
  const accessTokens = new Map<string, { token: string; expiresAt: number }>();
  const accessFlights = new Map<string, Promise<string>>();

  function blockIfReading(): void {
    if (readers > 0) throw new OAuthFlowError('operation-in-progress');
  }

  function forgetAccess(accountId: string): void {
    accessTokens.delete(accountId);
  }

  async function loadAccess(accountId: string): Promise<string> {
    const account = getConnectedAccount(deps.database, accountId);
    if (account.provider !== 'google') throw new OAuthFlowError('invalid-request');
    if (account.status !== 'connected') throw new OAuthFlowError('needs-reauth');
    let refreshToken: string;
    try {
      refreshToken = readAccountRefreshToken(deps.database, deps.cipher, accountId);
    } catch (error) {
      if (
        error instanceof PersistenceError &&
        (error.code === 'decrypt-failed' || error.code === 'not-found')
      ) {
        noteGoogleReauth(deps.database, accountId, now);
        forgetAccess(accountId);
        throw new OAuthFlowError('needs-reauth');
      }
      throw error;
    }
    const client = readOAuthClient(deps.database, account.oauthClientId);
    let refreshed: RefreshedTokens;
    try {
      refreshed = await refreshAccessToken({
        fetchImpl: deps.fetchImpl,
        clientId: client.clientId,
        refreshToken,
        clientSecret: configuredClientSecret(client.id),
        cancel: lifecycle.signal,
        timeoutMs: httpTimeout
      });
    } catch (error) {
      if (error instanceof OAuthFlowError && error.code === 'needs-reauth') {
        markRefreshTokenUnusable(deps.database, accountId, now);
        forgetAccess(accountId);
      }
      throw error;
    }
    if (refreshed.refreshToken !== null) {
      replaceAccountRefreshToken(
        deps.database,
        deps.cipher,
        accountId,
        refreshed.refreshToken,
        now
      );
    }
    if (refreshed.grantedScopes !== null) {
      saveGrantedScopes(deps.database, accountId, refreshed.grantedScopes, now);
    }
    if (refreshed.expiresIn !== null) {
      const expiresAt = now().getTime() + (refreshed.expiresIn - 60) * 1000;
      if (expiresAt > now().getTime()) {
        accessTokens.set(accountId, { token: refreshed.accessToken, expiresAt });
      }
    }
    return refreshed.accessToken;
  }

  function mailboxAccess(accountId: string, force = false): Promise<string> {
    if (!force) {
      const cached = accessTokens.get(accountId);
      if (cached !== undefined && cached.expiresAt > now().getTime()) {
        return Promise.resolve(cached.token);
      }
      const existing = accessFlights.get(accountId);
      if (existing !== undefined) return existing;
    }
    const flight = loadAccess(accountId).finally(() => {
      if (accessFlights.get(accountId) === flight) accessFlights.delete(accountId);
    });
    accessFlights.set(accountId, flight);
    return flight;
  }

  function owns(current: number): boolean {
    return generation === current;
  }

  function release(current: number): void {
    if (owns(current)) phase = { name: 'idle' };
  }

  function requireClient() {
    const client = readGoogleClient(deps.database);
    if (client === null) throw new OAuthFlowError('needs-client');
    return client;
  }

  function configuredClientSecret(oauthClientId: string): string | null {
    try {
      return readClientSecret(deps.database, deps.cipher, oauthClientId);
    } catch (error) {
      if (error instanceof PersistenceError && error.code === 'not-found') return null;
      if (error instanceof PersistenceError && error.code === 'decrypt-failed') {
        throw new OAuthFlowError('encryption-unavailable');
      }
      throw error;
    }
  }

  async function authorize(expectedAccountId: string | null): Promise<GoogleAccountSummary> {
    blockIfReading();
    const client = requireClient();
    if (expectedAccountId !== null) {
      let selected: ReturnType<typeof getConnectedAccount>;
      try {
        selected = getConnectedAccount(deps.database, expectedAccountId);
      } catch (error) {
        throw asFlowError(error);
      }
      if (selected.provider !== 'google') throw new OAuthFlowError('invalid-request');
    }
    if (phase.name === 'exchanging' || phase.name === 'busy') {
      throw new OAuthFlowError('operation-in-progress');
    }
    if (phase.name === 'authorizing') phase.cancel('cancelled');
    const current = ++generation;
    let cancelSession: (reason: 'cancelled' | 'timeout' | 'shutdown') => void = () => undefined;
    phase = {
      name: 'authorizing',
      generation: current,
      cancel(reason) {
        cancelSession(reason);
      }
    };
    const state = randomToken();
    const nonce = randomToken();
    const verifier = createPkceVerifier();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (owns(current) && phase.name === 'authorizing') phase.cancel('timeout');
    }, authorizationTimeout);
    try {
      const session = await listen(state);
      if (!owns(current)) {
        session.cancel('cancelled');
        throw new OAuthFlowError('oauth-cancelled');
      }
      if (timedOut) {
        session.cancel('timeout');
        throw new OAuthFlowError('oauth-timeout');
      }
      cancelSession = (reason) => {
        session.cancel(reason);
      };
      try {
        await deps.openExternal(
          buildAuthorizationUrl({
            clientId: client.clientId,
            redirectUri: session.redirectUri,
            state,
            nonce,
            verifier
          })
        );
      } catch {
        session.cancel('cancelled');
        throw new OAuthFlowError('internal');
      }
      if (!owns(current)) throw new OAuthFlowError('oauth-cancelled');
      const callback = await session.done;
      if (!owns(current)) throw new OAuthFlowError('oauth-cancelled');
      if (callback.kind !== 'code') throw new OAuthFlowError(loopbackCode(callback.kind));
      const abort = new AbortController();
      phase = { name: 'exchanging', generation: current, abort };
      const tokens = await exchangeAuthorizationCode({
        fetchImpl: deps.fetchImpl,
        clientId: client.clientId,
        code: callback.code,
        verifier,
        redirectUri: session.redirectUri,
        clientSecret: configuredClientSecret(client.id),
        cancel: AbortSignal.any([abort.signal, lifecycle.signal]),
        timeoutMs: httpTimeout
      });
      if (!owns(current)) throw new OAuthFlowError('oauth-cancelled');
      const identity = await verifyGoogleIdToken({
        idToken: tokens.idToken,
        clientId: client.clientId,
        nonce,
        jwks,
        now
      });
      if (!owns(current)) throw new OAuthFlowError('oauth-cancelled');
      phase = { name: 'busy', generation: current };
      const account = commitAccountConnection(
        deps.database,
        deps.cipher,
        {
          oauthClientId: client.id,
          providerAccountId: identity.subject,
          displayName: identity.displayName,
          email: identity.email,
          refreshToken: tokens.refreshToken,
          expectedAccountId,
          grantedScopes: tokens.grantedScopes
        },
        now
      );
      forgetAccess(account.id);
      return toSummary(account);
    } catch (error) {
      throw asFlowError(error);
    } finally {
      clearTimeout(timer);
      release(current);
    }
  }

  return {
    getClientId() {
      try {
        return readGoogleClientState(deps.database);
      } catch (error) {
        throw asFlowError(error);
      }
    },
    saveClientId(clientId: string, clientSecret: string | null = null) {
      blockIfReading();
      if (phase.name !== 'idle') throw new OAuthFlowError('operation-in-progress');
      try {
        return saveGoogleClient(deps.database, deps.cipher, clientId, clientSecret, now);
      } catch (error) {
        throw asFlowError(error);
      }
    },
    listAccounts() {
      return listGoogleAccounts(deps.database).map((account) => toSummary(account));
    },
    connect() {
      return authorize(null);
    },
    reconnect(accountId: string) {
      return authorize(accountId);
    },
    cancel() {
      if (phase.name === 'authorizing') {
        const cancelPhase = phase.cancel;
        generation += 1;
        phase = { name: 'idle' };
        cancelPhase('cancelled');
        return { cancelled: true };
      }
      if (phase.name === 'exchanging') {
        const abort = phase.abort;
        generation += 1;
        phase = { name: 'idle' };
        abort.abort();
        return { cancelled: true };
      }
      if (phase.name === 'busy') throw new OAuthFlowError('operation-in-progress');
      return { cancelled: true };
    },
    async disconnect(accountId: string) {
      blockIfReading();
      if (phase.name !== 'idle') throw new OAuthFlowError('operation-in-progress');
      const current = ++generation;
      phase = { name: 'busy', generation: current };
      try {
        const account = getConnectedAccount(deps.database, accountId);
        if (account.provider !== 'google') throw new OAuthFlowError('invalid-request');
        let token: string | null = null;
        try {
          token = readAccountRefreshToken(deps.database, deps.cipher, accountId);
        } catch (error) {
          if (
            !(error instanceof PersistenceError) ||
            (error.code !== 'decrypt-failed' && error.code !== 'not-found')
          ) {
            throw error;
          }
        }
        let outcome: DisconnectOutcome = 'disconnected-local';
        if (token !== null) {
          const revoked = await revokeRefreshToken({
            fetchImpl: deps.fetchImpl,
            refreshToken: token,
            cancel: lifecycle.signal,
            timeoutMs: revokeTimeout
          });
          outcome = revoked === 'revoked' ? 'revoked' : 'disconnected-local';
        }
        deleteConnectedAccount(deps.database, accountId);
        forgetAccess(accountId);
        return { outcome };
      } catch (error) {
        throw asFlowError(error);
      } finally {
        release(current);
      }
    },
    async refreshAccount(accountId: string) {
      blockIfReading();
      if (phase.name !== 'idle') throw new OAuthFlowError('operation-in-progress');
      const current = ++generation;
      phase = { name: 'busy', generation: current };
      try {
        let stage: 'account' | 'credential' | 'refresh' = 'account';
        try {
          const account = getConnectedAccount(deps.database, accountId);
          if (account.provider !== 'google') throw new OAuthFlowError('invalid-request');
          stage = 'credential';
          const token = readAccountRefreshToken(deps.database, deps.cipher, accountId);
          const client = readOAuthClient(deps.database, account.oauthClientId);
          stage = 'refresh';
          const refreshed = await refreshAccessToken({
            fetchImpl: deps.fetchImpl,
            clientId: client.clientId,
            refreshToken: token,
            clientSecret: configuredClientSecret(client.id),
            cancel: lifecycle.signal,
            timeoutMs: httpTimeout
          });
          if (refreshed.refreshToken !== null) {
            replaceAccountRefreshToken(
              deps.database,
              deps.cipher,
              accountId,
              refreshed.refreshToken,
              now
            );
          }
        } catch (error) {
          if (
            stage === 'refresh' &&
            error instanceof OAuthFlowError &&
            error.code === 'needs-reauth'
          ) {
            markRefreshTokenUnusable(deps.database, accountId, now);
          }
          if (
            stage === 'credential' &&
            error instanceof PersistenceError &&
            (error.code === 'decrypt-failed' || error.code === 'not-found')
          ) {
            noteGoogleReauth(deps.database, accountId, now);
          }
          throw error;
        }
      } catch (error) {
        throw asFlowError(error);
      } finally {
        release(current);
      }
    },
    beginMailboxRead() {
      if (phase.name !== 'idle') throw new OAuthFlowError('operation-in-progress');
      readers += 1;
    },
    endMailboxRead() {
      readers = Math.max(0, readers - 1);
    },
    mailboxAccess(accountId: string, force = false) {
      return mailboxAccess(accountId, force);
    },
    modificationGrant(accountId: string) {
      const account = getConnectedAccount(deps.database, accountId);
      if (account.provider !== 'google') throw new OAuthFlowError('invalid-request');
      if (account.status !== 'connected') return 'needs-reauth';
      return grantAllowsMailChanges(account.grantedScopes.split(' ')) ? 'ready' : 'readonly';
    },
    forgetMailboxAccess(accountId: string) {
      forgetAccess(accountId);
    },
    shutdown() {
      accessTokens.clear();
      accessFlights.clear();
      lifecycle.abort();
      if (phase.name === 'authorizing') {
        const cancelPhase = phase.cancel;
        generation += 1;
        phase = { name: 'idle' };
        cancelPhase('shutdown');
        return;
      }
      if (phase.name === 'exchanging') {
        const abort = phase.abort;
        generation += 1;
        phase = { name: 'idle' };
        abort.abort();
      }
    }
  };
}
