import { type IpcMainInvokeEvent } from 'electron';
import { GmailError } from './gmail/errors.ts';
import { type GmailReader } from './gmail/reader.ts';
import { isAuthorizedSender, type SenderSnapshot } from './trusted-sender.ts';
import { isGoogleAccountId } from '../shared/google-accounts.ts';
import {
  gmailChannels,
  gmailLabelsChannel,
  gmailOpenLinkChannel,
  gmailThreadChannel,
  gmailThreadsChannel,
  isGmailId,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailThread,
  parseGmailThreadList,
  parseGmailThreadQuery,
  type GmailErrorCode,
  type GmailResult
} from '../shared/gmail.ts';

type GmailIpcValue =
  | Awaited<ReturnType<GmailReader['listLabels']>>
  | Awaited<ReturnType<GmailReader['listThreads']>>
  | Awaited<ReturnType<GmailReader['readThread']>>
  | Awaited<ReturnType<GmailReader['openLink']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function rejected(code: GmailErrorCode): GmailResult<GmailIpcValue> {
  return { ok: false, error: { code } };
}

function accountArgument(args: readonly unknown[]): string | null {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['accountId'])) return null;
  return isGoogleAccountId(args[0].accountId) ? args[0].accountId : null;
}

function threadArgument(args: readonly unknown[]): { accountId: string; threadId: string } | null {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ['accountId', 'threadId'])
  ) {
    return null;
  }
  if (!isGoogleAccountId(args[0].accountId) || !isGmailId(args[0].threadId)) return null;
  return { accountId: args[0].accountId, threadId: args[0].threadId };
}

function linkArgument(args: readonly unknown[]): string | null {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['url'])) return null;
  return typeof args[0].url === 'string' ? args[0].url : null;
}

function codeOf(error: unknown): GmailErrorCode {
  if (error instanceof GmailError) return error.code;
  return 'internal';
}

export async function handleGmailChannel(
  channel: string,
  sender: SenderSnapshot,
  args: readonly unknown[],
  reader: GmailReader
): Promise<GmailResult<GmailIpcValue>> {
  if (!isAuthorizedSender(sender)) return rejected('unauthorized');
  try {
    if (channel === gmailLabelsChannel) {
      const accountId = accountArgument(args);
      if (accountId === null) return rejected('invalid-request');
      const value = await reader.listLabels(accountId);
      if (parseGmailLabelList(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === gmailThreadsChannel) {
      if (args.length !== 1 || parseGmailThreadQuery(args[0]) === null)
        return rejected('invalid-request');
      const query = parseGmailThreadQuery(args[0]);
      if (query === null) return rejected('invalid-request');
      const value = await reader.listThreads(query);
      if (parseGmailThreadList(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === gmailThreadChannel) {
      const input = threadArgument(args);
      if (input === null) return rejected('invalid-request');
      const value = await reader.readThread(input.accountId, input.threadId);
      if (parseGmailThread(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === gmailOpenLinkChannel) {
      const url = linkArgument(args);
      if (url === null) return rejected('invalid-request');
      const value = await reader.openLink(url);
      if (parseGmailOpenedLink(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    return rejected('invalid-request');
  } catch (error) {
    return rejected(codeOf(error));
  }
}

export function attachGmailIpc(
  register: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<GmailResult<GmailIpcValue>>
  ) => void,
  senderFor: (event: IpcMainInvokeEvent) => SenderSnapshot,
  reader: GmailReader
): void {
  for (const channel of gmailChannels) {
    register(channel, (event, ...args) =>
      handleGmailChannel(channel, senderFor(event), args, reader)
    );
  }
}
