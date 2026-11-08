import './style.css';
import { createViewer, GRID_CELL_MM, type Viewer } from './scene/viewer';
import { createFatalMessage, createLegend, createTitle } from './ui/hud';
import { createVersionBadge } from './ui/version-badge';

declare global {
  interface Window {
    /** Доступ для автотестів (Playwright). */
    __trasa?: { viewer: Viewer };
  }
}

// Safari ігнорує user-scalable=no: блокуємо системний зум сторінки жестом «щипок»,
// щоб він не конфліктував із зумом камери.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Немає елемента #app');

const stage = document.createElement('div');
stage.className = 'stage';
app.append(stage);

try {
  const viewer = createViewer(stage);
  window.__trasa = { viewer };
  app.append(createTitle(), createLegend(GRID_CELL_MM));
} catch (error) {
  console.error(error);
  app.append(
    createFatalMessage(
      'Не вдалося запустити 3D-сцену. Перезавантажте сторінку; якщо не допоможе — оновіть iOS / iPadOS.',
    ),
  );
  app.append(createVersionBadge(true));
}
