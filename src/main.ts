import './style.css';
import { createViewer, type Viewer } from './scene/viewer';
import { type App, createApp } from './ui/app';
import { createFatalMessage } from './ui/hud';
import { installPageZoomGuard, type PageZoomGuard } from './ui/page-zoom';
import { createVersionBadge } from './ui/version-badge';

declare global {
  interface Window {
    /** Доступ для автотестів (Playwright). */
    __trasa?: { viewer: Viewer; app?: App; pageZoom?: PageZoomGuard };
  }
}

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Немає елемента #app');

// Safari ігнорує user-scalable=no: масштаб сторінки не має змінюватись ні «щипком», ні подвійним
// дотиком (у сцени свій зум камери). Слухач touchstart усередині заодно вмикає підсвітку :active на iPhone.
const pageZoom = installPageZoomGuard(root);

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
  window.__trasa = { viewer, pageZoom };
  window.__trasa.app = createApp(root, viewer);
}
