export const auroraAppUserModelId = 'com.rubenosaka.aurora';

export interface SyncToastInput {
  title: string;
  body: string;
  onClick: () => void;
  onFailed: () => void;
}

export interface SyncToast {
  show(input: SyncToastInput): void;
}

interface DesktopNotice {
  show(): void;
  on(event: 'click' | 'failed', listener: () => void): void;
}

export interface ElectronNotifierDependencies {
  platform: NodeJS.Platform;
  setAppUserModelId: (id: string) => void;
  focus: () => void;
  create: (options: { title: string; body: string }) => DesktopNotice;
}

export function createElectronNotifier(deps: ElectronNotifierDependencies): SyncToast {
  let identified = false;
  return {
    show(input) {
      if (deps.platform === 'win32' && !identified) {
        deps.setAppUserModelId(auroraAppUserModelId);
        identified = true;
      }
      const notice = deps.create({ title: input.title, body: input.body });
      notice.on('click', () => {
        deps.focus();
        input.onClick();
      });
      notice.on('failed', () => {
        input.onFailed();
      });
      notice.show();
    }
  };
}
