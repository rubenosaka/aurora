import { isAppInfo, type AppInfo, type IpcResult } from '../shared/app-info.ts';
import { isAuthorizedSender, type SenderSnapshot } from './trusted-sender.ts';

export function handleGetAppInfo(
  sender: SenderSnapshot,
  args: readonly unknown[],
  readInfo: () => unknown
): IpcResult<AppInfo> {
  if (!isAuthorizedSender(sender)) {
    return { ok: false, error: { code: 'unauthorized' } };
  }
  if (args.length !== 0) {
    return { ok: false, error: { code: 'invalid-request' } };
  }
  try {
    const info = readInfo();
    if (!isAppInfo(info)) {
      return { ok: false, error: { code: 'invalid-response' } };
    }
    return { ok: true, value: info };
  } catch {
    return { ok: false, error: { code: 'internal' } };
  }
}
