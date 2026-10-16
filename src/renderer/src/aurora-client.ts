import {
  AuroraIpcError,
  unwrapAppInfo,
  type AuroraApi,
  type AuroraBridge
} from '../../shared/app-info.ts';

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
    })
  });
}
