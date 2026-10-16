export interface AuroraWebContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }) => void): void;
}

export interface AuroraBrowserWindow {
  webContents: AuroraWebContents;
  on(event: 'ready-to-show', listener: () => void): void;
  show(): void;
  loadURL(url: string): void;
  loadFile(filePath: string): void;
}

export interface AuroraWindowDefinition {
  width: 1120;
  height: 740;
  minWidth: 760;
  minHeight: 560;
  show: false;
  title: 'Aurora';
  autoHideMenuBar: true;
  webPreferences: {
    preload: string;
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    webSecurity: true;
  };
}

export function createAuroraWindow<T extends AuroraBrowserWindow>(input: {
  preloadPath: string;
  rendererUrl: string | undefined;
  rendererFile: string;
  openWindow: (definition: AuroraWindowDefinition) => T;
}): T {
  const window = input.openWindow({
    width: 1120,
    height: 740,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Aurora',
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  window.on('ready-to-show', () => {
    window.show();
  });

  if (input.rendererUrl) {
    void window.loadURL(input.rendererUrl);
  } else {
    void window.loadFile(input.rendererFile);
  }

  return window;
}
