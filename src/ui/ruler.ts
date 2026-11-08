/**
 * «Рулетка»: два короткі дотики по скану → відстань між точками в мм.
 * Перетягування, як завжди, обертає камеру й точку не ставить (див. tap.ts).
 * Точка береться там, де натиснули, а камера повертається в положення на момент натискання —
 * тремтіння пальця чи мишки не зсуває ні камеру, ні точку.
 * Наступний дотик після виміру починає новий вимір.
 */
import type { Vector3 } from 'three';
import { formatMm, mToMm } from '../core/units';
import type { Viewer, ViewSnapshot } from '../scene/viewer';
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
  /** Шар з лінією, маркерами точок і підписом відстані. */
  overlay: HTMLElement;
  readonly state: RulerState;
  setActive(active: boolean): void;
  /** Скинути точки (наприклад, відкрили інший скан). */
  clear(): void;
  dispose(): void;
}

const HINT_FIRST = 'Торкніться першої точки на скані';
const HINT_SECOND = 'Тепер — другої точки';
const HINT_NEXT = 'Торкніться скану, щоб почати новий вимір';
const HINT_MISS = 'Тут немає поверхні скану — торкніться самого скану';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createRuler(
  viewer: Viewer,
  handlers: { onChange?(state: RulerState): void; onDone?(): void } = {},
): Ruler {
  const panel = document.createElement('div');
  panel.className = 'panel ruler-panel';
  panel.dataset.testid = 'ruler-panel';
  panel.hidden = true;
  const head = document.createElement('div');
  head.className = 'ruler-head';
  const title = document.createElement('p');
  title.className = 'ruler-title';
  title.textContent = 'Рулетка';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'ruler-done';
  done.dataset.testid = 'ruler-done';
  done.textContent = 'Готово';
  done.addEventListener('click', () => handlers.onDone?.());
  head.append(title, done);
  const text = document.createElement('p');
  text.className = 'ruler-text';
  text.dataset.testid = 'ruler-text';
  text.setAttribute('role', 'status');
  text.setAttribute('aria-live', 'polite');
  const sub = document.createElement('p');
  sub.className = 'ruler-sub';
  sub.dataset.testid = 'ruler-sub';
  panel.append(head, text, sub);

  const overlay = document.createElement('div');
  overlay.className = 'ruler-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ruler-svg');
  const halo = document.createElementNS(SVG_NS, 'line');
  halo.setAttribute('class', 'ruler-line-halo');
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'ruler-line');
  svg.append(halo, line);
  overlay.append(svg);
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

  let active = false;
  let points: Vector3[] = [];
  let downView: ViewSnapshot | null = null;

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
      return null;
    }
    const screen = viewer.projectPoint(world);
    element.hidden = !screen.visible;
    element.style.transform = `translate(${screen.x}px, ${screen.y}px) ${shift}`;
    return screen;
  };

  const updateOverlay = () => {
    overlay.hidden = !active;
    if (!active) return;
    const [a, b] = points;
    const sa = place(markers[0]!, a);
    const sb = place(markers[1]!, b);
    const lineVisible = !!(sa?.visible && sb?.visible);
    svg.style.display = lineVisible ? '' : 'none';
    if (sa && sb && lineVisible) {
      for (const el of [halo, line]) {
        el.setAttribute('x1', String(sa.x));
        el.setAttribute('y1', String(sa.y));
        el.setAttribute('x2', String(sb.x));
        el.setAttribute('y2', String(sb.y));
      }
    }
    if (a && b) place(label, a.clone().add(b).multiplyScalar(0.5), 'translate(-50%, -150%)');
    else label.hidden = true;
  };
  const stopFrames = viewer.onFrame(updateOverlay);

  const render = (missed = false) => {
    const current = state();
    panel.hidden = !active;
    text.classList.toggle('ruler-text--result', current.distanceMm !== null);
    if (current.distanceMm !== null) {
      const value = formatMm(current.distanceMm);
      text.textContent = value;
      label.textContent = value;
    } else {
      text.textContent = points.length === 0 ? HINT_FIRST : HINT_SECOND;
    }
    sub.textContent = missed ? HINT_MISS : current.distanceMm !== null ? HINT_NEXT : '';
    sub.hidden = sub.textContent === '';
    sub.classList.toggle('ruler-sub--warning', missed);
    viewer.requestRender();
    updateOverlay();
    handlers.onChange?.(current);
  };

  const stopTap = onTap(viewer.canvas, {
    onDown: () => {
      downView = active ? viewer.snapshotView() : null;
    },
    onTap: (x, y) => {
      if (!active) return;
      // Скасувати мікроповорот камери від тремтіння — шукаємо точку в тому кадрі, куди цілились.
      if (downView) viewer.restoreView(downView);
      const hit = viewer.raycastScan(x, y);
      if (!hit) {
        render(true);
        return;
      }
      points = points.length >= 2 ? [hit] : [...points, hit];
      render();
    },
  });

  render();

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
      panel.remove();
      overlay.remove();
    },
  };
}
