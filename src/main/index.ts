import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appInfoChannel } from '../shared/app-info.ts';
import { handleGetAppInfo } from './app-info-handler.ts';
import { type SenderSnapshot } from './trusted-sender.ts';
import { createAuroraWindow } from './aurora-window.ts';

let mainWindow: BrowserWindow | null = null;

function authorizedDocumentUrl(): string {
  return (
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(join(__dirname, '../renderer/index.html')).href
  );
}

function senderSnapshot(event: IpcMainInvokeEvent): SenderSnapshot {
  const frame = event.senderFrame;
  const authorizedWindow = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
  return {
    senderId: event.sender.id,
    authorizedSenderId: authorizedWindow?.webContents.id ?? null,
    frameUrl: frame?.url ?? null,
    isMainFrame: frame !== null && frame === event.sender.mainFrame,
    authorizedUrl: authorizedDocumentUrl()
  };
}

function registerAppInfoHandler(): void {
  ipcMain.handle(appInfoChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    return handleGetAppInfo(senderSnapshot(event), args, () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    }));
  });
}

function createWindow(): void {
  mainWindow = createAuroraWindow({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    openWindow: (definition) => new BrowserWindow(definition)
  });
}

registerAppInfoHandler();

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
