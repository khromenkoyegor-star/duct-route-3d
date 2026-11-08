import type { Viewer } from '../../src/scene/viewer';
import type { App } from '../../src/ui/app';

declare global {
  interface Window {
    /** Доступ для автотестів (див. src/main.ts). */
    __trasa?: { viewer: Viewer; app?: App };
  }
}

export {};
