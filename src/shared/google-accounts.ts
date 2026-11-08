export const googleClientGetChannel = 'google-client:get';
export const googleClientSaveChannel = 'google-client:save';
export const googleAccountsListChannel = 'google-accounts:list';
export const googleAccountsConnectChannel = 'google-accounts:connect';
export const googleAccountsReconnectChannel = 'google-accounts:reconnect';
export const googleAccountsCancelChannel = 'google-accounts:cancel';
export const googleAccountsDisconnectChannel = 'google-accounts:disconnect';

export const googleChannels = [
  googleClientGetChannel,
  googleClientSaveChannel,
  googleAccountsListChannel,
  googleAccountsConnectChannel,
  googleAccountsReconnectChannel,
  googleAccountsCancelChannel,
  googleAccountsDisconnectChannel
] as const;

export type GoogleChannel = (typeof googleChannels)[number];

export const gmailModifyScope = 'https://www.googleapis.com/auth/gmail.modify';

export const historicalReadonlyGrant =
  'openid email profile https://www.googleapis.com/auth/gmail.readonly';

export const requiredMailScopes = ['openid', 'email', 'profile', gmailModifyScope] as const;

const scopeTokenPattern = /^[A-Za-z0-9_.:/-]{1,200}$/;

export function parseGrantedScopes(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null;
  if (/^\s|\s$|\s{2}/.test(value)) return null;
  const parts = value.split(' ');
  if (parts.length > 32 || !parts.every((part) => scopeTokenPattern.test(part))) return null;
  return [...new Set(parts)];
}

export function formatGrantedScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].sort().join(' ');
}

export function grantAllowsMailChanges(scopes: readonly string[]): boolean {
  return requiredMailScopes.every((scope) => scopes.includes(scope));
}

export const googleAccountStatuses = ['connected', 'needs_reauth'] as const;

export type GoogleAccountStatus = (typeof googleAccountStatuses)[number];

export const disconnectOutcomes = ['revoked', 'disconnected-local'] as const;

export type DisconnectOutcome = (typeof disconnectOutcomes)[number];

export interface GoogleClientState {
  clientId: string | null;
  secretConfigured: boolean;
}

export interface GoogleClientSaved {
  clientId: string;
  secretConfigured: boolean;
}

export interface GoogleAccountSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  status: GoogleAccountStatus;
  canModifyMail: boolean;
}

export interface GoogleAccountList {
  accounts: GoogleAccountSummary[];
}

export interface GoogleCancelResult {
  cancelled: true;
}

export interface GoogleDisconnectResult {
  outcome: DisconnectOutcome;
}

export const googleErrorCodes = [
  'unauthorized',
  'invalid-request',
  'invalid-response',
  'needs-client',
  'client-in-use',
  'oauth-denied',
  'oauth-timeout',
  'oauth-cancelled',
  'callback-limit',
  'account-mismatch',
  'provider-rejected',
  'network',
  'encryption-unavailable',
  'needs-reauth',
  'operation-in-progress',
  'scope-denied',
  'internal'
] as const;

export type GoogleErrorCode = (typeof googleErrorCodes)[number];

export type GoogleResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: GoogleErrorCode } };

const messages: Record<GoogleErrorCode, string> = {
  unauthorized: 'Request rejected.',
  'invalid-request': 'Request rejected.',
  'invalid-response': 'Response rejected.',
  'needs-client': 'Add a Google OAuth Client ID in Settings.',
  'client-in-use': 'Disconnect the connected Google accounts before changing the Client ID.',
  'oauth-denied': 'Google sign-in was cancelled.',
  'oauth-timeout': 'Google sign-in timed out.',
  'oauth-cancelled': 'Google sign-in was cancelled.',
  'callback-limit': 'Google sign-in was interrupted.',
  'account-mismatch': 'The selected Google account does not match this connection.',
  'provider-rejected': 'Google rejected the sign-in.',
  network: 'Aurora could not reach Google.',
  'encryption-unavailable': 'Credential protection is unavailable.',
  'needs-reauth': 'The saved Google credential can no longer be used.',
  'operation-in-progress': 'Another Google account change is already in progress.',
  'scope-denied': 'Google did not grant permission to change mail. The saved account was kept.',
  internal: 'Request failed.'
};

export const disconnectedLocalMessage =
  'The account was removed from Aurora. The Google grant may still be active.';

export const revokedMessage = 'The account was disconnected and the Google grant was revoked.';

export class GoogleIpcError extends Error {
  readonly code: GoogleErrorCode;

  constructor(code: GoogleErrorCode) {
    super(messages[code]);
    this.name = 'GoogleIpcError';
    this.code = code;
  }
}

export function googleErrorMessage(code: GoogleErrorCode): string {
  return messages[code];
}

const clientIdSuffix = '.apps.googleusercontent.com';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isGoogleClientId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || !value.endsWith(clientIdSuffix)) {
    return false;
  }
  const prefix = value.slice(0, -clientIdSuffix.length);
  if (prefix.length < 1) return false;
  for (const character of prefix) {
    const code = character.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit && !upper && !lower && code !== 45 && code !== 95) return false;
  }
  return true;
}

export function isGoogleAccountId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function isGoogleClientSecret(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) return false;
  return !hasControlCharacter(value);
}

function isOptionalText(value: unknown, maxLength: number): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return false;
  return !hasControlCharacter(value);
}

export function isGoogleAccountSummary(value: unknown): value is GoogleAccountSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'email', 'displayName', 'status', 'canModifyMail']) ||
    typeof value.canModifyMail !== 'boolean' ||
    !isGoogleAccountId(value.id) ||
    !isOptionalText(value.email, 320) ||
    !isOptionalText(value.displayName, 256)
  ) {
    return false;
  }
  return googleAccountStatuses.some((status) => status === value.status);
}

function isGoogleErrorCode(value: unknown): value is GoogleErrorCode {
  return typeof value === 'string' && googleErrorCodes.some((code) => code === value);
}

export function parseGoogleResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T | null
): GoogleResult<T> {
  const invalid: GoogleResult<T> = { ok: false, error: { code: 'invalid-response' } };
  if (!isRecord(value) || typeof value.ok !== 'boolean') return invalid;
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'value'])) return invalid;
    const parsed = parseValue(value.value);
    if (parsed === null) return invalid;
    return { ok: true, value: parsed };
  }
  if (!hasExactKeys(value, ['ok', 'error']) || !isRecord(value.error)) return invalid;
  if (!hasExactKeys(value.error, ['code']) || !isGoogleErrorCode(value.error.code)) return invalid;
  return { ok: false, error: { code: value.error.code } };
}

export function parseGoogleClientState(value: unknown): GoogleClientState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['clientId', 'secretConfigured'])) return null;
  if (typeof value.secretConfigured !== 'boolean') return null;
  if (value.clientId !== null && !isGoogleClientId(value.clientId)) return null;
  return { clientId: value.clientId, secretConfigured: value.secretConfigured };
}

export function parseGoogleClientSaved(value: unknown): GoogleClientSaved | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['clientId', 'secretConfigured']) ||
    !isGoogleClientId(value.clientId) ||
    typeof value.secretConfigured !== 'boolean'
  ) {
    return null;
  }
  return { clientId: value.clientId, secretConfigured: value.secretConfigured };
}

export function parseGoogleAccountList(value: unknown): GoogleAccountList | null {
  if (!isRecord(value) || !hasExactKeys(value, ['accounts']) || !Array.isArray(value.accounts)) {
    return null;
  }
  if (value.accounts.length > 100) return null;
  const accounts: GoogleAccountSummary[] = [];
  for (const account of value.accounts) {
    if (!isGoogleAccountSummary(account)) return null;
    accounts.push(account);
  }
  return { accounts };
}

export function parseGoogleCancelResult(value: unknown): GoogleCancelResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ['cancelled']) || value.cancelled !== true) {
    return null;
  }
  return { cancelled: true };
}

function isDisconnectOutcome(value: unknown): value is DisconnectOutcome {
  return disconnectOutcomes.some((outcome) => outcome === value);
}

export function parseGoogleDisconnectResult(value: unknown): GoogleDisconnectResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ['outcome'])) return null;
  if (!isDisconnectOutcome(value.outcome)) return null;
  return { outcome: value.outcome };
}

export function unwrapGoogleResult<T>(value: unknown, parseValue: (value: unknown) => T | null): T {
  const result = parseGoogleResult(value, parseValue);
  if (!result.ok) throw new GoogleIpcError(result.error.code);
  return result.value;
}

export interface GoogleBridge {
  getClientId(): Promise<GoogleResult<GoogleClientState>>;
  saveClientId(
    clientId: string,
    clientSecret: string | null
  ): Promise<GoogleResult<GoogleClientSaved>>;
  listAccounts(): Promise<GoogleResult<GoogleAccountList>>;
  connect(): Promise<GoogleResult<GoogleAccountSummary>>;
  reconnect(accountId: string): Promise<GoogleResult<GoogleAccountSummary>>;
  cancel(): Promise<GoogleResult<GoogleCancelResult>>;
  disconnect(accountId: string): Promise<GoogleResult<GoogleDisconnectResult>>;
}

export interface GoogleApi {
  getClientId(): Promise<GoogleClientState>;
  saveClientId(clientId: string, clientSecret: string | null): Promise<GoogleClientSaved>;
  listAccounts(): Promise<GoogleAccountList>;
  connect(): Promise<GoogleAccountSummary>;
  reconnect(accountId: string): Promise<GoogleAccountSummary>;
  cancel(): Promise<GoogleCancelResult>;
  disconnect(accountId: string): Promise<GoogleDisconnectResult>;
}
