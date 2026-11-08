import {
  appInfoChannel,
  parseIpcResult,
  type AuroraBridge,
  type IpcResult,
  type AppInfo
} from '../shared/app-info.ts';
import {
  gmailLabelsChannel,
  gmailOpenLinkChannel,
  gmailThreadChannel,
  gmailThreadsChannel,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailResult,
  parseGmailThread,
  parseGmailThreadList,
  type GmailLabelList,
  type GmailOpenedLink,
  type GmailResult,
  type GmailThread,
  type GmailThreadList,
  type GmailThreadQuery
} from '../shared/gmail.ts';
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
      }
    })
  });
}
