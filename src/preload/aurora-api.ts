import {
  appInfoChannel,
  parseIpcResult,
  type AuroraBridge,
  type IpcResult,
  type AppInfo
} from '../shared/app-info.ts';
import {
  gmailAddLabelChannel,
  gmailArchiveThreadChannel,
  gmailComposeSeedChannel,
  gmailLabelsChannel,
  gmailMarkReadChannel,
  gmailMarkUnreadChannel,
  gmailOpenLinkChannel,
  gmailRemoveLabelChannel,
  gmailSendMessageChannel,
  gmailStarMessageChannel,
  gmailThreadChannel,
  gmailThreadsChannel,
  gmailTrashThreadChannel,
  gmailUnstarMessageChannel,
  gmailUntrashThreadChannel,
  parseGmailLabelChanged,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailReadState,
  parseGmailResult,
  parseGmailStarChanged,
  parseGmailThread,
  parseGmailThreadChanged,
  parseGmailThreadList,
  type GmailLabelChanged,
  type GmailLabelList,
  type GmailOpenedLink,
  type GmailReadState,
  type GmailResult,
  type GmailStarChanged,
  type GmailThread,
  type GmailThreadChanged,
  type GmailThreadList,
  type GmailThreadQuery
} from '../shared/gmail.ts';
import {
  parseComposeSeed,
  parseComposeSent,
  type ComposeMessage,
  type ComposeSeed,
  type ComposeSeedQuery,
  type ComposeSent
} from '../shared/mail-compose.ts';
import {
  type GoogleResult,
  googleAccountsCancelChannel,
  googleAccountsConnectChannel,
  googleAccountsDisconnectChannel,
  googleAccountsListChannel,
  googleAccountsReconnectChannel,
  googleClientGetChannel,
  googleClientSaveChannel,
  parseGoogleAccountList,
  parseGoogleCancelResult,
  parseGoogleClientSaved,
  parseGoogleClientState,
  parseGoogleDisconnectResult,
  parseGoogleResult,
  isGoogleAccountSummary,
  type GoogleAccountList,
  type GoogleAccountSummary,
  type GoogleCancelResult,
  type GoogleClientSaved,
  type GoogleClientState,
  type GoogleDisconnectResult
} from '../shared/google-accounts.ts';

export type AuroraInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function internalGoogle<T>(): GoogleResult<T> {
  return { ok: false, error: { code: 'internal' } };
}

function internalGmail<T>(): GmailResult<T> {
  return { ok: false, error: { code: 'internal' } };
}

function gmailAction<T>(
  invoke: AuroraInvoke,
  channel: string,
  payload: unknown,
  parse: (value: unknown) => T | null
): Promise<GmailResult<T>> {
  return Promise.resolve()
    .then(() => invoke(channel, payload))
    .then((raw) => parseGmailResult(raw, parse))
    .catch(() => internalGmail());
}

export function createAuroraApi(invoke: AuroraInvoke): AuroraBridge {
  return Object.freeze({
    app: Object.freeze({
      getInfo(): Promise<IpcResult<AppInfo>> {
        return Promise.resolve()
          .then(() => invoke(appInfoChannel))
          .then((raw) => parseIpcResult(raw))
          .catch(() => ({ ok: false, error: { code: 'internal' } }));
      }
    }),
    google: Object.freeze({
      getClientId(): Promise<GoogleResult<GoogleClientState>> {
        return Promise.resolve()
          .then(() => invoke(googleClientGetChannel))
          .then((raw) => parseGoogleResult(raw, parseGoogleClientState))
          .catch(() => internalGoogle());
      },
      saveClientId(
        clientId: string,
        clientSecret: string | null
      ): Promise<GoogleResult<GoogleClientSaved>> {
        return Promise.resolve()
          .then(() => invoke(googleClientSaveChannel, { clientId, clientSecret }))
          .then((raw) => parseGoogleResult(raw, parseGoogleClientSaved))
          .catch(() => internalGoogle());
      },
      listAccounts(): Promise<GoogleResult<GoogleAccountList>> {
        return Promise.resolve()
          .then(() => invoke(googleAccountsListChannel))
          .then((raw) => parseGoogleResult(raw, parseGoogleAccountList))
          .catch(() => internalGoogle());
      },
      connect(): Promise<GoogleResult<GoogleAccountSummary>> {
        return Promise.resolve()
          .then(() => invoke(googleAccountsConnectChannel))
          .then((raw) =>
            parseGoogleResult(raw, (value) => (isGoogleAccountSummary(value) ? value : null))
          )
          .catch(() => internalGoogle());
      },
      reconnect(accountId: string): Promise<GoogleResult<GoogleAccountSummary>> {
        return Promise.resolve()
          .then(() => invoke(googleAccountsReconnectChannel, { accountId }))
          .then((raw) =>
            parseGoogleResult(raw, (value): GoogleAccountSummary | null =>
              isGoogleAccountSummary(value) ? value : null
            )
          )
          .catch(() => internalGoogle());
      },
      cancel(): Promise<GoogleResult<GoogleCancelResult>> {
        return Promise.resolve()
          .then(() => invoke(googleAccountsCancelChannel))
          .then((raw) => parseGoogleResult(raw, parseGoogleCancelResult))
          .catch(() => internalGoogle());
      },
      disconnect(accountId: string): Promise<GoogleResult<GoogleDisconnectResult>> {
        return Promise.resolve()
          .then(() => invoke(googleAccountsDisconnectChannel, { accountId }))
          .then((raw) => parseGoogleResult(raw, parseGoogleDisconnectResult))
          .catch(() => internalGoogle());
      }
    }),
    gmail: Object.freeze({
      listLabels(accountId: string): Promise<GmailResult<GmailLabelList>> {
        return Promise.resolve()
          .then(() => invoke(gmailLabelsChannel, { accountId }))
          .then((raw) => parseGmailResult(raw, parseGmailLabelList))
          .catch(() => internalGmail());
      },
      listThreads(query: GmailThreadQuery): Promise<GmailResult<GmailThreadList>> {
        return Promise.resolve()
          .then(() => invoke(gmailThreadsChannel, query))
          .then((raw) => parseGmailResult(raw, parseGmailThreadList))
          .catch(() => internalGmail());
      },
      readThread(accountId: string, threadId: string): Promise<GmailResult<GmailThread>> {
        return Promise.resolve()
          .then(() => invoke(gmailThreadChannel, { accountId, threadId }))
          .then((raw) => parseGmailResult(raw, parseGmailThread))
          .catch(() => internalGmail());
      },
      openLink(url: string): Promise<GmailResult<GmailOpenedLink>> {
        return Promise.resolve()
          .then(() => invoke(gmailOpenLinkChannel, { url }))
          .then((raw) => parseGmailResult(raw, parseGmailOpenedLink))
          .catch(() => internalGmail());
      },
      markRead(accountId: string, threadId: string): Promise<GmailResult<GmailReadState>> {
        return gmailAction(
          invoke,
          gmailMarkReadChannel,
          { accountId, threadId },
          parseGmailReadState
        );
      },
      markUnread(accountId: string, threadId: string): Promise<GmailResult<GmailReadState>> {
        return gmailAction(
          invoke,
          gmailMarkUnreadChannel,
          { accountId, threadId },
          parseGmailReadState
        );
      },
      archiveThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>> {
        return gmailAction(
          invoke,
          gmailArchiveThreadChannel,
          { accountId, threadId },
          parseGmailThreadChanged
        );
      },
      trashThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>> {
        return gmailAction(
          invoke,
          gmailTrashThreadChannel,
          { accountId, threadId },
          parseGmailThreadChanged
        );
      },
      untrashThread(accountId: string, threadId: string): Promise<GmailResult<GmailThreadChanged>> {
        return gmailAction(
          invoke,
          gmailUntrashThreadChannel,
          { accountId, threadId },
          parseGmailThreadChanged
        );
      },
      addLabel(
        accountId: string,
        threadId: string,
        labelId: string
      ): Promise<GmailResult<GmailLabelChanged>> {
        return gmailAction(
          invoke,
          gmailAddLabelChannel,
          { accountId, threadId, labelId },
          parseGmailLabelChanged
        );
      },
      removeLabel(
        accountId: string,
        threadId: string,
        labelId: string
      ): Promise<GmailResult<GmailLabelChanged>> {
        return gmailAction(
          invoke,
          gmailRemoveLabelChannel,
          { accountId, threadId, labelId },
          parseGmailLabelChanged
        );
      },
      starMessage(
        accountId: string,
        threadId: string,
        messageId: string
      ): Promise<GmailResult<GmailStarChanged>> {
        return gmailAction(
          invoke,
          gmailStarMessageChannel,
          { accountId, threadId, messageId },
          parseGmailStarChanged
        );
      },
      unstarMessage(
        accountId: string,
        threadId: string,
        messageId: string
      ): Promise<GmailResult<GmailStarChanged>> {
        return gmailAction(
          invoke,
          gmailUnstarMessageChannel,
          { accountId, threadId, messageId },
          parseGmailStarChanged
        );
      },
      composeSeed(query: ComposeSeedQuery): Promise<GmailResult<ComposeSeed>> {
        return gmailAction(invoke, gmailComposeSeedChannel, query, parseComposeSeed);
      },
      sendMessage(message: ComposeMessage): Promise<GmailResult<ComposeSent>> {
        return gmailAction(invoke, gmailSendMessageChannel, message, parseComposeSent);
      }
    })
  });
}
