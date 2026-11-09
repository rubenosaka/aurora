import { contextBridge, ipcRenderer } from 'electron';
import { createAuroraApi } from './aurora-api.ts';

contextBridge.exposeInMainWorld(
  'aurora',
  createAuroraApi(
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  )
);
