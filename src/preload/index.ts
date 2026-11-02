import { contextBridge, ipcRenderer } from 'electron';
import { createAuroraApi } from './aurora-api.ts';

contextBridge.exposeInMainWorld(
  'aurora',
  createAuroraApi((channel, ...args) => ipcRenderer.invoke(channel, ...args))
);
