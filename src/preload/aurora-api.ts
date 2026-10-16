import {
  appInfoChannel,
  parseIpcResult,
  type AuroraBridge,
  type IpcResult,
  type AppInfo
} from '../shared/app-info.ts';

export type AppInfoInvoke = (channel: typeof appInfoChannel) => Promise<unknown>;

export function createAuroraApi(invoke: AppInfoInvoke): AuroraBridge {
  return Object.freeze({
    app: Object.freeze({
      getInfo(): Promise<IpcResult<AppInfo>> {
        return Promise.resolve()
          .then(() => invoke(appInfoChannel))
          .then((raw) => parseIpcResult(raw))
          .catch(() => ({ ok: false, error: { code: 'internal' } }));
      }
    })
  });
}
