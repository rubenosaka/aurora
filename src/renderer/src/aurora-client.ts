import {
  unwrapAppInfo,
  type AuroraApi,
  type AuroraBridge,
  AuroraIpcError
} from '../../shared/app-info.ts';
import {
  GmailIpcError,
  unwrapGmailResult,
  parseGmailLabelList,
  parseGmailOpenedLink,
  parseGmailThread,
  parseGmailThreadList,
  type GmailThreadQuery
} from '../../shared/gmail.ts';
import {
  GoogleIpcError,
  unwrapGoogleResult,
  isGoogleAccountSummary,
  parseGoogleAccountList,
  parseGoogleCancelResult,
  parseGoogleClientSaved,
  parseGoogleClientState,
  parseGoogleDisconnectResult,
  type GoogleAccountSummary
} from '../../shared/google-accounts.ts';

export function createRendererAppApi(bridge: AuroraBridge): AuroraApi {
  return Object.freeze({
    app: Object.freeze({
      async getInfo() {
        let raw: unknown;
        try {
          raw = await bridge.app.getInfo();
        } catch {
          throw new AuroraIpcError('internal');
        }
        return unwrapAppInfo(raw);
      }
    }),
    google: Object.freeze({
      async getClientId() {
        try {
          return unwrapGoogleResult(await bridge.google.getClientId(), parseGoogleClientState);
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async saveClientId(clientId: string, clientSecret: string | null) {
        try {
          return unwrapGoogleResult(
            await bridge.google.saveClientId(clientId, clientSecret),
            parseGoogleClientSaved
          );
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async listAccounts() {
        try {
          return unwrapGoogleResult(await bridge.google.listAccounts(), parseGoogleAccountList);
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async connect() {
        try {
          return unwrapGoogleResult(
            await bridge.google.connect(),
            (value): GoogleAccountSummary | null => (isGoogleAccountSummary(value) ? value : null)
          );
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async reconnect(accountId: string) {
        try {
          return unwrapGoogleResult(
            await bridge.google.reconnect(accountId),
            (value): GoogleAccountSummary | null => (isGoogleAccountSummary(value) ? value : null)
          );
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async cancel() {
        try {
          return unwrapGoogleResult(await bridge.google.cancel(), parseGoogleCancelResult);
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      },
      async disconnect(accountId: string) {
        try {
          return unwrapGoogleResult(
            await bridge.google.disconnect(accountId),
            parseGoogleDisconnectResult
          );
        } catch (error) {
          if (error instanceof GoogleIpcError) throw error;
          throw new GoogleIpcError('internal');
        }
      }
    }),
    gmail: Object.freeze({
      async listLabels(accountId: string) {
        try {
          return unwrapGmailResult(await bridge.gmail.listLabels(accountId), parseGmailLabelList);
        } catch (error) {
          if (error instanceof GmailIpcError) throw error;
          throw new GmailIpcError('internal');
        }
      },
      async listThreads(query: GmailThreadQuery) {
        try {
          return unwrapGmailResult(await bridge.gmail.listThreads(query), parseGmailThreadList);
        } catch (error) {
          if (error instanceof GmailIpcError) throw error;
          throw new GmailIpcError('internal');
        }
      },
      async readThread(accountId: string, threadId: string) {
        try {
          return unwrapGmailResult(
            await bridge.gmail.readThread(accountId, threadId),
            parseGmailThread
          );
        } catch (error) {
          if (error instanceof GmailIpcError) throw error;
          throw new GmailIpcError('internal');
        }
      },
      async openLink(url: string) {
        try {
          return unwrapGmailResult(await bridge.gmail.openLink(url), parseGmailOpenedLink);
        } catch (error) {
          if (error instanceof GmailIpcError) throw error;
          throw new GmailIpcError('internal');
        }
      }
    })
  });
}
