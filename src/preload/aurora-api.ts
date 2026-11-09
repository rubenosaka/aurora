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
  gmailAttachmentDownloadChannel,
  gmailAttachmentDropChannel,
  gmailAttachmentPickChannel,
  gmailBulkLabelChannel,
  gmailBulkThreadsChannel,
  gmailComposeSeedChannel,
  gmailLabelCreateChannel,
  gmailLabelDeleteChannel,
  gmailLabelRenameChannel,
  gmailNotificationOpenChannel,
  gmailNotificationsSetChannel,
  gmailSyncChangedChannel,
  gmailSyncFocusChannel,
  gmailSyncStatusChannel,
  gmailSyncViewChannel,
  gmailDraftDeleteChannel,
  gmailDraftOpenChannel,
  gmailDraftSaveChannel,
  gmailDraftSendChannel,
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
  parseGmailBulkResult,
  parseGmailLabelChanged,
  parseGmailLabelDefinition,
  parseGmailLabelDeleted,
  parseGmailLabelList,
  parseGmailNotificationOpen,
  parseGmailOpenedLink,
  parseGmailReadState,
  parseGmailResult,
  parseGmailStarChanged,
  parseGmailSyncAccepted,
  parseGmailSyncChanged,
  parseGmailSyncStatus,
  parseGmailThread,
  parseGmailThreadChanged,
  parseGmailThreadList,
  type GmailBulkLabelRequest,
  type GmailBulkResult,
  type GmailBulkThreadsRequest,
  type GmailLabelChanged,
  type GmailLabelDefinition,
  type GmailLabelDeleteRequest,
  type GmailLabelDeleted,
  type GmailLabelList,
  type GmailLabelNameRequest,
  type GmailLabelRenameRequest,
  type GmailNotificationOpen,
  type GmailNotificationPreference,
  type GmailOpenedLink,
  type GmailReadState,
  type GmailResult,
  type GmailStarChanged,
  type GmailSyncAccepted,
  type GmailSyncChanged,
  type GmailSyncStatus,
  type GmailSyncView,
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
  parseAttachmentDropped,
  parseAttachmentSaved,
  parseDraftDeleted,
  parseDraftOpened,
  parseDraftSaved,
  parsePickedAttachments,
  type AttachmentDownloadRequest,
  type AttachmentDropRequest,
  type AttachmentPickRequest,
  type DraftDeleteRequest,
  type DraftOpenRequest,
  type DraftSaveRequest
} from '../shared/mail-draft.ts';
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

export type AuroraListen = (channel: string, listener: (payload: unknown) => void) => () => void;

const syncEventChannels = new Set([gmailSyncChangedChannel, gmailNotificationOpenChannel]);

function subscribe<T>(
  listen: AuroraListen | undefined,
  channel: string,
  parse: (value: unknown) => T | null,
  listener: (value: T) => void
): () => void {
  if (listen === undefined || !syncEventChannels.has(channel)) return () => undefined;
  return listen(channel, (payload) => {
    const parsed = parse(payload);
    if (parsed !== null) listener(parsed);
  });
}

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

export function createAuroraApi(invoke: AuroraInvoke, listen?: AuroraListen): AuroraBridge {
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
      },
      saveDraft(request: DraftSaveRequest) {
        return gmailAction(invoke, gmailDraftSaveChannel, request, parseDraftSaved);
      },
      openDraft(request: DraftOpenRequest) {
        return gmailAction(invoke, gmailDraftOpenChannel, request, parseDraftOpened);
      },
      deleteDraft(request: DraftDeleteRequest) {
        return gmailAction(invoke, gmailDraftDeleteChannel, request, parseDraftDeleted);
      },
      sendDraft(request: DraftSaveRequest): Promise<GmailResult<ComposeSent>> {
        return gmailAction(invoke, gmailDraftSendChannel, request, parseComposeSent);
      },
      pickAttachments(request: AttachmentPickRequest) {
        return gmailAction(invoke, gmailAttachmentPickChannel, request, parsePickedAttachments);
      },
      dropAttachment(request: AttachmentDropRequest) {
        return gmailAction(invoke, gmailAttachmentDropChannel, request, parseAttachmentDropped);
      },
      downloadAttachment(request: AttachmentDownloadRequest) {
        return gmailAction(invoke, gmailAttachmentDownloadChannel, request, parseAttachmentSaved);
      },
      bulkThreads(request: GmailBulkThreadsRequest): Promise<GmailResult<GmailBulkResult>> {
        return gmailAction(invoke, gmailBulkThreadsChannel, request, parseGmailBulkResult);
      },
      bulkLabel(request: GmailBulkLabelRequest): Promise<GmailResult<GmailBulkResult>> {
        return gmailAction(invoke, gmailBulkLabelChannel, request, parseGmailBulkResult);
      },
      createLabel(request: GmailLabelNameRequest): Promise<GmailResult<GmailLabelDefinition>> {
        return gmailAction(invoke, gmailLabelCreateChannel, request, parseGmailLabelDefinition);
      },
      renameLabel(request: GmailLabelRenameRequest): Promise<GmailResult<GmailLabelDefinition>> {
        return gmailAction(invoke, gmailLabelRenameChannel, request, parseGmailLabelDefinition);
      },
      deleteLabel(request: GmailLabelDeleteRequest): Promise<GmailResult<GmailLabelDeleted>> {
        return gmailAction(invoke, gmailLabelDeleteChannel, request, parseGmailLabelDeleted);
      },
      syncStatus(accountId: string): Promise<GmailResult<GmailSyncStatus>> {
        return gmailAction(invoke, gmailSyncStatusChannel, { accountId }, parseGmailSyncStatus);
      },
      setNotifications(
        preference: GmailNotificationPreference
      ): Promise<GmailResult<GmailSyncStatus>> {
        return gmailAction(invoke, gmailNotificationsSetChannel, preference, parseGmailSyncStatus);
      },
      reportSyncView(view: GmailSyncView): Promise<GmailResult<GmailSyncAccepted>> {
        return gmailAction(invoke, gmailSyncViewChannel, view, parseGmailSyncAccepted);
      },
      syncFocus(accountId: string): Promise<GmailResult<GmailSyncStatus>> {
        return gmailAction(invoke, gmailSyncFocusChannel, { accountId }, parseGmailSyncStatus);
      },
      listenSync(listener: (event: GmailSyncChanged) => void): () => void {
        return subscribe(listen, gmailSyncChangedChannel, parseGmailSyncChanged, listener);
      },
      listenOpen(listener: (event: GmailNotificationOpen) => void): () => void {
        return subscribe(
          listen,
          gmailNotificationOpenChannel,
          parseGmailNotificationOpen,
          listener
        );
      }
    })
  });
}
