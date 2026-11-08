import './style.css';
import { createViewer, type Viewer } from './scene/viewer';
import { type App, createApp } from './ui/app';
import { createFatalMessage } from './ui/hud';
import { createVersionBadge } from './ui/version-badge';

declare global {
  interface Window {
    /** Доступ для автотестів (Playwright). */
    __trasa?: { viewer: Viewer; app?: App };
  }
}

// Safari ігнорує user-scalable=no: блокуємо системний зум сторінки жестом «щипок»,
// щоб він не конфліктував із зумом камери.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// Safari на iPhone показує підсвітку натискання (:active) лише якщо є хоч один слухач touchstart.
document.addEventListener('touchstart', () => {}, { passive: true });

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Немає елемента #app');

const stage = document.createElement('div');
stage.className = 'stage';
root.append(stage);

let viewer: Viewer | null = null;
try {
  viewer = createViewer(stage);
} catch (error) {
  console.error(error);
  root.append(
    createFatalMessage(
      'Не вдалося запустити 3D-сцену. Перезавантажте сторінку; якщо не допоможе — оновіть iOS / iPadOS.',
    ),
  );
  root.append(createVersionBadge(true));
}

if (viewer) {
  window.__trasa = { viewer };
  window.__trasa.app = createApp(root, viewer);
}
