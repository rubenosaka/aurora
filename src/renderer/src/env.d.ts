/// <reference types="vite/client" />

import type { AuroraBridge } from '../../shared/app-info.ts';

declare global {
  interface Window {
    aurora: AuroraBridge;
  }
}

export {};
