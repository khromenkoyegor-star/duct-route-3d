import type { Viewer } from '../../src/scene/viewer';

declare global {
  interface Window {
    /** Доступ для автотестів (див. src/main.ts). */
    __trasa?: { viewer: Viewer };
  }
}

export {};
