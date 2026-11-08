import { type IpcMainInvokeEvent } from 'electron';
import { GmailError } from './gmail/errors.ts';
import { type GmailReader } from './gmail/reader.ts';
import { isAuthorizedSender, type SenderSnapshot } from './trusted-sender.ts';
import { isGoogleAccountId } from '../shared/google-accounts.ts';
import {
  gmailAddLabelChannel,
  gmailArchiveThreadChannel,
  gmailChannels,
  gmailLabelsChannel,
  gmailMarkReadChannel,
  gmailMarkUnreadChannel,
  gmailOpenLinkChannel,
  gmailRemoveLabelChannel,
  gmailStarMessageChannel,
  gmailThreadChannel,
  gmailThreadsChannel,
  gmailTrashThreadChannel,
  gmailUnstarMessageChannel,
  gmailUntrashThreadChannel,
  isGmailId,
  parseGmailLabelChanged,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailReadState,
  parseGmailStarChanged,
  parseGmailThread,
  parseGmailThreadChanged,
  parseGmailThreadList,
  parseGmailThreadQuery,
  type GmailErrorCode,
  type GmailResult
} from '../shared/gmail.ts';

type GmailIpcValue =
  | Awaited<ReturnType<GmailReader['listLabels']>>
  | Awaited<ReturnType<GmailReader['listThreads']>>
  | Awaited<ReturnType<GmailReader['readThread']>>
  | Awaited<ReturnType<GmailReader['openLink']>>
  | Awaited<ReturnType<GmailReader['markRead']>>
  | Awaited<ReturnType<GmailReader['archiveThread']>>
  | Awaited<ReturnType<GmailReader['addLabel']>>
  | Awaited<ReturnType<GmailReader['starMessage']>>;

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

function labelArgument(
  args: readonly unknown[]
): { accountId: string; threadId: string; labelId: string } | null {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ['accountId', 'threadId', 'labelId'])
  ) {
    return null;
  }
  if (
    !isGoogleAccountId(args[0].accountId) ||
    !isGmailId(args[0].threadId) ||
    !isGmailId(args[0].labelId)
  ) {
    return null;
  }
  return { accountId: args[0].accountId, threadId: args[0].threadId, labelId: args[0].labelId };
}

function messageArgument(
  args: readonly unknown[]
): { accountId: string; threadId: string; messageId: string } | null {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ['accountId', 'threadId', 'messageId'])
  ) {
    return null;
  }
  if (
    !isGoogleAccountId(args[0].accountId) ||
    !isGmailId(args[0].threadId) ||
    !isGmailId(args[0].messageId)
  ) {
    return null;
  }
  return {
    accountId: args[0].accountId,
    threadId: args[0].threadId,
    messageId: args[0].messageId
  };
}

function linkArgument(args: readonly unknown[]): string | null {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], ['url'])) return null;
  return typeof args[0].url === 'string' ? args[0].url : null;
}

async function threadAction(
  channel: string,
  reader: GmailReader,
  accountId: string,
  threadId: string
): Promise<GmailIpcValue> {
  if (channel === gmailMarkReadChannel) return reader.markRead(accountId, threadId);
  if (channel === gmailMarkUnreadChannel) return reader.markUnread(accountId, threadId);
  if (channel === gmailArchiveThreadChannel) return reader.archiveThread(accountId, threadId);
  if (channel === gmailTrashThreadChannel) return reader.trashThread(accountId, threadId);
  return reader.untrashThread(accountId, threadId);
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
    if (
      channel === gmailMarkReadChannel ||
      channel === gmailMarkUnreadChannel ||
      channel === gmailArchiveThreadChannel ||
      channel === gmailTrashThreadChannel ||
      channel === gmailUntrashThreadChannel
    ) {
      const input = threadArgument(args);
      if (input === null) return rejected('invalid-request');
      const value = await threadAction(channel, reader, input.accountId, input.threadId);
      const parsed =
        channel === gmailMarkReadChannel || channel === gmailMarkUnreadChannel
          ? parseGmailReadState(value)
          : parseGmailThreadChanged(value);
      if (parsed === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === gmailAddLabelChannel || channel === gmailRemoveLabelChannel) {
      const input = labelArgument(args);
      if (input === null) return rejected('invalid-request');
      const value =
        channel === gmailAddLabelChannel
          ? await reader.addLabel(input.accountId, input.threadId, input.labelId)
          : await reader.removeLabel(input.accountId, input.threadId, input.labelId);
      if (parseGmailLabelChanged(value) === null) return rejected('invalid-response');
      return { ok: true, value };
    }
    if (channel === gmailStarMessageChannel || channel === gmailUnstarMessageChannel) {
      const input = messageArgument(args);
      if (input === null) return rejected('invalid-request');
      const value =
        channel === gmailStarMessageChannel
          ? await reader.starMessage(input.accountId, input.threadId, input.messageId)
          : await reader.unstarMessage(input.accountId, input.threadId, input.messageId);
      if (parseGmailStarChanged(value) === null) return rejected('invalid-response');
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
