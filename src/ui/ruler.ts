/**
 * «Рулетка»: два короткі дотики по скану → відстань між точками в мм.
 * Перетягування, як завжди, обертає камеру й точку не ставить (див. tap.ts).
 * Наступний дотик після виміру починає новий вимір.
 */
import type { Vector3 } from 'three';
import { formatMm, mToMm } from '../core/units';
import { createRulerLine } from '../scene/ruler-line';
import type { Viewer } from '../scene/viewer';
import { onTap } from './tap';

export interface RulerState {
  active: boolean;
  /** Точки виміру в метрах сцени. */
  points: Array<{ x: number; y: number; z: number }>;
  /** Відстань у мм або null, поки точок менше двох. */
  distanceMm: number | null;
}

export interface Ruler {
  /** Панель з підказкою й результатом. */
  panel: HTMLElement;
  /** Шар з маркерами точок і підписом відстані. */
  overlay: HTMLElement;
  readonly state: RulerState;
  setActive(active: boolean): void;
  /** Скинути точки (наприклад, відкрили інший скан). */
  clear(): void;
  dispose(): void;
}

const HINT_FIRST = 'Торкніться першої точки на скані';
const HINT_SECOND = 'Тепер — другої точки';
const HINT_MISS = 'Тут немає поверхні скану — торкніться самого скану';

export function createRuler(viewer: Viewer, onChange?: (state: RulerState) => void): Ruler {
  const panel = document.createElement('div');
  panel.className = 'panel ruler-panel';
  panel.dataset.testid = 'ruler-panel';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.hidden = true;
  const title = document.createElement('p');
  title.className = 'ruler-title';
  title.textContent = 'Рулетка';
  const text = document.createElement('p');
  text.className = 'ruler-text';
  text.dataset.testid = 'ruler-text';
  panel.append(title, text);

  const overlay = document.createElement('div');
  overlay.className = 'ruler-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const markers = [0, 1].map(() => {
    const marker = document.createElement('div');
    marker.className = 'ruler-marker';
    marker.hidden = true;
    overlay.append(marker);
    return marker;
  });
  const label = document.createElement('div');
  label.className = 'ruler-label';
  label.hidden = true;
  overlay.append(label);

  const line = createRulerLine();
  viewer.add(line.object);

  let active = false;
  let points: Vector3[] = [];

  const state = (): RulerState => {
    const [a, b] = points;
    return {
      active,
      points: points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      distanceMm: a && b ? mToMm(a.distanceTo(b)) : null,
    };
  };

  /** Поставити HTML-елемент у проєкцію точки; shift — центрування відносно точки. */
  const place = (element: HTMLElement, world: Vector3 | undefined, shift = 'translate(-50%, -50%)') => {
    if (!world) {
      element.hidden = true;
      return;
    }
    const screen = viewer.projectPoint(world);
    element.hidden = !screen.visible;
    element.style.transform = `translate(${screen.x}px, ${screen.y}px) ${shift}`;
  };

  const updateOverlay = () => {
    const show = active;
    place(markers[0]!, show ? points[0] : undefined);
    place(markers[1]!, show ? points[1] : undefined);
    const [a, b] = points;
    if (show && a && b) {
      place(label, a.clone().add(b).multiplyScalar(0.5), 'translate(-50%, -140%)');
    } else {
      label.hidden = true;
    }
  };
  const stopFrames = viewer.onFrame(updateOverlay);

  const render = (hint?: string) => {
    const current = state();
    panel.hidden = !active;
    if (current.distanceMm !== null) {
      const value = formatMm(current.distanceMm);
      text.textContent = hint ?? value;
      text.classList.toggle('ruler-text--result', !hint);
      label.textContent = value;
    } else {
      text.textContent = hint ?? (points.length === 0 ? HINT_FIRST : HINT_SECOND);
      text.classList.remove('ruler-text--result');
    }
    line.set(active ? (points[0] ?? null) : null, active ? (points[1] ?? null) : null);
    viewer.requestRender();
    updateOverlay();
    onChange?.(current);
  };

  const stopTap = onTap(viewer.canvas, (x, y) => {
    if (!active) return;
    const hit = viewer.raycastScan(x, y);
    if (!hit) {
      render(HINT_MISS);
      return;
    }
    points = points.length >= 2 ? [hit] : [...points, hit];
    render();
  });

  return {
    panel,
    overlay,
    get state() {
      return state();
    },
    setActive(value) {
      active = value;
      if (!active) points = [];
      render();
    },
    clear() {
      points = [];
      render();
    },
    dispose() {
      stopTap();
      stopFrames();
      viewer.remove(line.object);
      line.dispose();
      panel.remove();
      overlay.remove();
    },
  };
}
