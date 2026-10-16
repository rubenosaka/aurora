import { contextBridge, ipcRenderer } from 'electron';
import { createAuroraApi } from './aurora-api.ts';

contextBridge.exposeInMainWorld(
  'aurora',
  createAuroraApi((channel) => ipcRenderer.invoke(channel))
);
