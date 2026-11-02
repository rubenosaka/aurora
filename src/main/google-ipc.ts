import { type IpcMainInvokeEvent } from 'electron';
import { OAuthFlowError } from './oauth/errors.ts';
import { type GoogleAccountService } from './oauth/google-accounts.ts';
import { isAuthorizedSender, type SenderSnapshot } from './trusted-sender.ts';
import {
  googleAccountsCancelChannel,
  googleAccountsConnectChannel,
  googleAccountsDisconnectChannel,
  googleAccountsListChannel,
  googleAccountsReconnectChannel,
  googleClientGetChannel,
  googleClientSaveChannel,
  googleChannels,
  isGoogleAccountId,
  isGoogleAccountSummary,
  isGoogleClientId,
  isGoogleClientSecret,
  parseGoogleAccountList,
  parseGoogleCancelResult,
  parseGoogleClientSaved,
  parseGoogleClientState,
  parseGoogleDisconnectResult,
  type GoogleErrorCode,
  type GoogleResult
} from '../shared/google-accounts.ts';

type GoogleIpcValue =
  | ReturnType<GoogleAccountService['getClientId']>
  | ReturnType<GoogleAccountService['saveClientId']>
  | { accounts: ReturnType<GoogleAccountService['listAccounts']> }
  | Awaited<ReturnType<GoogleAccountService['connect']>>
  | ReturnType<GoogleAccountService['cancel']>
  | Awaited<ReturnType<GoogleAccountService['disconnect']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function rejected(code: GoogleErrorCode): GoogleResult<GoogleIpcValue> {
  return { ok: false, error: { code } };
}

function clientSaveArgument(
  args: readonly unknown[]
): { clientId: string; clientSecret: string | null } | null {
  if (args.length !== 1 || !isRecord(args[0])) return null;
  if (!hasExactKeys(args[0], ['clientId', 'clientSecret'])) return null;
  if (!isGoogleClientId(args[0].clientId)) return null;
  if (args[0].clientSecret === null) {
    return { clientId: args[0].clientId, clientSecret: null };
  }
  if (!isGoogleClientSecret(args[0].clientSecret)) return null;
  return { clientId: args[0].clientId, clientSecret: args[0].clientSecret };
}

function accountIdArgument(args: readonly unknown[]): string | null {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['accountId'])) return null;
  return isGoogleAccountId(args[0].accountId) ? args[0].accountId : null;
}

function codeOf(error: unknown): GoogleErrorCode {
  if (error instanceof OAuthFlowError) return error.code;
  return 'internal';
}

export async function handleGoogleChannel(
  channel: string,
  sender: SenderSnapshot,
  args: readonly unknown[],
  service: GoogleAccountService
): Promise<GoogleResult<GoogleIpcValue>> {
  if (!isAuthorizedSender(sender)) return rejected('unauthorized');
  try {
    if (channel === googleClientGetChannel) {
      if (args.length !== 0) return rejected('invalid-request');
      const value = service.getClientId();
      if (parseGoogleClientState(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleClientSaveChannel) {
      const input = clientSaveArgument(args);
      if (input === null) return rejected('invalid-request');
      const value = service.saveClientId(input.clientId, input.clientSecret);
      if (parseGoogleClientSaved(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleAccountsListChannel) {
      if (args.length !== 0) return rejected('invalid-request');
      const value = { accounts: service.listAccounts() };
      if (parseGoogleAccountList(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleAccountsConnectChannel) {
      if (args.length !== 0) return rejected('invalid-request');
      const value = await service.connect();
      if (!isGoogleAccountSummary(value)) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleAccountsReconnectChannel) {
      const accountId = accountIdArgument(args);
      if (accountId === null) return rejected('invalid-request');
      const value = await service.reconnect(accountId);
      if (!isGoogleAccountSummary(value)) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleAccountsCancelChannel) {
      if (args.length !== 0) return rejected('invalid-request');
      const value = service.cancel();
      if (parseGoogleCancelResult(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === googleAccountsDisconnectChannel) {
      const accountId = accountIdArgument(args);
      if (accountId === null) return rejected('invalid-request');
      const value = await service.disconnect(accountId);
      if (parseGoogleDisconnectResult(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    return rejected('invalid-request');
  } catch (error) {
    return rejected(codeOf(error));
  }
}

export function attachGoogleIpc(
  register: (
    channel: string,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<GoogleResult<GoogleIpcValue>>
  ) => void,
  senderFor: (event: IpcMainInvokeEvent) => SenderSnapshot,
  service: GoogleAccountService
): void {
  for (const channel of googleChannels) {
    register(channel, (event, ...args) =>
      handleGoogleChannel(channel, senderFor(event), args, service)
    );
  }
}
