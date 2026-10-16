import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  createAuroraWindow,
  type AuroraBrowserWindow,
  type AuroraWindowDefinition
} from './aurora-window.ts';

function harness(rendererUrl: string | undefined): {
  definition: AuroraWindowDefinition | undefined;
  openHandler: (() => { action: 'deny' }) | undefined;
  navigate: ((event: { preventDefault(): void }) => void) | undefined;
  ready: (() => void) | undefined;
  shown: boolean;
  loadedUrl: string | undefined;
  loadedFile: string | undefined;
  window: AuroraBrowserWindow;
} {
  const state: {
    definition: AuroraWindowDefinition | undefined;
    openHandler: (() => { action: 'deny' }) | undefined;
    navigate: ((event: { preventDefault(): void }) => void) | undefined;
    ready: (() => void) | undefined;
    shown: boolean;
    loadedUrl: string | undefined;
    loadedFile: string | undefined;
    window: AuroraBrowserWindow;
  } = {
    definition: undefined,
    openHandler: undefined,
    navigate: undefined,
    ready: undefined,
    shown: false,
    loadedUrl: undefined,
    loadedFile: undefined,
    window: undefined as unknown as AuroraBrowserWindow
  };
  const window: AuroraBrowserWindow = {
    webContents: {
      setWindowOpenHandler(handler) {
        state.openHandler = handler;
      },
      on(_event, listener) {
        state.navigate = listener;
      }
    },
    on(_event, listener) {
      state.ready = listener;
    },
    show() {
      state.shown = true;
    },
    loadURL(url) {
      state.loadedUrl = url;
    },
    loadFile(filePath) {
      state.loadedFile = filePath;
    }
  };
  state.window = createAuroraWindow({
    preloadPath: 'preload.js',
    rendererUrl,
    rendererFile: 'index.html',
    openWindow(definition) {
      state.definition = definition;
      return window;
    }
  });
  return state;
}

describe('createAuroraWindow', () => {
  it('opens the sandboxed Aurora window and blocks in-window navigation', () => {
    const state = harness('http://localhost:5173/');
    assert.equal(state.definition?.title, 'Aurora');
    assert.deepEqual(state.definition?.webPreferences, {
      preload: 'preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    });
    assert.equal(state.definition?.show, false);
    assert.deepEqual(state.openHandler?.(), { action: 'deny' });
    let prevented = false;
    state.navigate?.({
      preventDefault() {
        prevented = true;
      }
    });
    assert.equal(prevented, true);
    state.ready?.();
    assert.equal(state.shown, true);
    assert.equal(state.loadedUrl, 'http://localhost:5173/');
    assert.equal(state.loadedFile, undefined);
  });

  it('loads the production file when no renderer URL is set', () => {
    const state = harness(undefined);
    assert.equal(state.loadedUrl, undefined);
    assert.equal(state.loadedFile, 'index.html');
  });

  it('is the window path used by the Electron main process', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    assert.equal(source.includes('createAuroraWindow('), true);
    assert.equal(source.includes('nodeIntegration: true'), false);
    assert.equal(source.includes('sandbox: false'), false);
    assert.equal(source.includes('contextIsolation: false'), false);
    assert.equal(source.includes('webSecurity: false'), false);
  });
});
