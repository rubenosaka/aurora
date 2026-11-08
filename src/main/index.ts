import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent
} from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type DatabaseSync } from 'node:sqlite';
import { appInfoChannel } from '../shared/app-info.ts';
import { handleGetAppInfo } from './app-info-handler.ts';
import { type SenderSnapshot } from './trusted-sender.ts';
import { createAuroraWindow } from './aurora-window.ts';
import { openAuroraDatabase } from './persistence/database.ts';
import { type SecretCipher, createSafeStorageCipher } from './persistence/safe-storage-cipher.ts';
import { openApplicationDatabase, persistenceStartupMessage } from './persistence/startup.ts';
import { attachGmailIpc } from './gmail-ipc.ts';
import { writeDownload } from './gmail/download-file.ts';
import { GmailError } from './gmail/errors.ts';
import { createGmailReader } from './gmail/reader.ts';
import { attachmentByteLimit } from '../shared/mail-draft.ts';
import { attachGoogleIpc } from './google-ipc.ts';
import { createGoogleAccountService, type GoogleAccountService } from './oauth/google-accounts.ts';

let mainWindow: BrowserWindow | null = null;
let applicationDatabase: DatabaseSync | null = null;
let credentialCipher: SecretCipher | null = null;
let googleAccounts: GoogleAccountService | null = null;

function closePersistence(): void {
  const database = applicationDatabase;
  applicationDatabase = null;
  if (credentialCipher !== null) credentialCipher = null;
  if (database === null) return;
  try {
    database.close();
  } catch (error) {
    void error;
  }
}

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

app.on('will-quit', () => {
  googleAccounts?.shutdown();
  googleAccounts = null;
  closePersistence();
});

void app.whenReady().then(() => {
  try {
    applicationDatabase = openApplicationDatabase({
      userDataPath: app.getPath('userData'),
      isPackaged: app.isPackaged,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      ensureDirectory: (directory) => {
        mkdirSync(directory, { recursive: true });
      },
      openDatabase: (filePath) => openAuroraDatabase(filePath)
    });
    credentialCipher = createSafeStorageCipher(safeStorage);
    const database = applicationDatabase;
    const cipher = credentialCipher;
    googleAccounts = createGoogleAccountService({
      database,
      cipher,
      fetchImpl: globalThis.fetch.bind(globalThis),
      openExternal: (url) => shell.openExternal(url)
    });
    attachGoogleIpc(
      (channel, listener) => {
        ipcMain.handle(channel, listener);
      },
      senderSnapshot,
      googleAccounts
    );
    const gmail = createGmailReader({
      accounts: googleAccounts,
      fetchImpl: globalThis.fetch.bind(globalThis),
      openExternal: (url) => shell.openExternal(url),
      pickFiles: async () => {
        const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
        if (parent === null) return [];
        const chosen = await dialog.showOpenDialog(parent, {
          properties: ['openFile', 'multiSelections']
        });
        if (chosen.canceled) return [];
        const picked: Array<{ name: string; bytes: Uint8Array }> = [];
        for (const filePath of chosen.filePaths) {
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          if (info.size > attachmentByteLimit) throw new GmailError('too-large');
          const bytes = await readFile(filePath);
          if (bytes.byteLength !== info.size) throw new GmailError('unavailable');
          picked.push({ name: basename(filePath), bytes });
        }
        return picked;
      },
      chooseSavePath: async (fileName) => {
        const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
        if (parent === null) return null;
        const chosen = await dialog.showSaveDialog(parent, { defaultPath: fileName });
        if (chosen.canceled || chosen.filePath === undefined) return null;
        return chosen.filePath;
      },
      writeSave: (target, bytes) => writeDownload(target, bytes)
    });
    attachGmailIpc(
      (channel, listener) => {
        ipcMain.handle(channel, listener);
      },
      senderSnapshot,
      gmail
    );
  } catch (error) {
    dialog.showErrorBox('Aurora', persistenceStartupMessage(error));
    app.quit();
    return;
  }

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
