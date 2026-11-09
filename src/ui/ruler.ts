/**
 * «Рулетка»: точка А → доведення → «Підтвердити точку» → точка Б → доведення → «Підтвердити точку»
 * → відстань у мм.
 *
 * - Короткий дотик по скану ставить точку («прилипає» до поверхні). Перетягування обертає камеру
 *   й точку не ставить (tap.ts). Точка береться там, де натиснули; тремтіння не зсуває ні камеру, ні точку.
 * - Поки точка не підтверджена, її доводять редактором точки (джойстик X/Z, повзунок Y),
 *   а новий дотик по скану просто переставляє її.
 * - Після виміру наступний дотик починає новий вимір; «Готово» — вихід.
 */
import { Vector3 } from 'three';
import type { PointM } from '../core/nudge';
import { formatMm, mToMm } from '../core/units';
import type { Viewer, ViewSnapshot } from '../scene/viewer';
import { closedEditorState, type PointEditor, type PointEditorHandlers, type PointEditorState } from './point-editor';
import { createRetapGuard, HINT_CONFIRM_MOVE, onTap } from './tap';
import { keepVisible } from './visibility';

/** pickA — чекаємо точку А; editA — доводимо А; pickB / editB — так само Б; done — є результат. */
export type RulerPhase = 'pickA' | 'editA' | 'pickB' | 'editB' | 'done';

export interface RulerState {
  active: boolean;
  phase: RulerPhase;
  /** Точки виміру в метрах сцени (А, потім Б). */
  points: PointM[];
  /** Відстань у мм або null, поки точок менше двох. */
  distanceMm: number | null;
  /** Стан редактора точки (для тестів і підказок). */
  editor: PointEditorState;
}

export interface Ruler {
  /** Панель з підказкою й результатом. */
  panel: HTMLElement;
  /** Шар з лінією, маркерами точок і підписом відстані. */
  overlay: HTMLElement;
  readonly state: RulerState;
  /** Щойно підтвердили точку (захист від подвійного натискання). */
  recentlyConfirmed(): boolean;
  setActive(active: boolean): void;
  /** Скинути точки (наприклад, відкрили інший скан). */
  clear(): void;
  dispose(): void;
}

const HINTS: Record<RulerPhase, string> = {
  pickA: 'Торкніться першої точки (А) на скані',
  editA: 'Точка А: підсуньте, якщо треба, і натисніть «Підтвердити точку»',
  pickB: 'Тепер торкніться другої точки (Б)',
  editB: 'Точка Б: підсуньте, якщо треба, і натисніть «Підтвердити точку»',
  done: 'Торкніться скану, щоб почати новий вимір',
};
const HINT_MISS = 'Тут немає поверхні скану — торкніться самого скану';
/**
 * Після «Підтвердити точку» редактор зникає, і другий дотик подвійного натискання впав би
 * на те, що під кнопкою (скан чи кнопку «Рулетка»). Цей час такі дотики ігноруються.
 */
export const CONFIRM_COOLDOWN_MS = 350;
const LABELS = ['А', 'Б'] as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** editor — спільний редактор точки (джойстик, повзунок, «Підтвердити точку»); див. app.ts. */
export function createRuler(
  viewer: Viewer,
  editor: PointEditor,
  handlers: { onChange?(state: RulerState): void; onDone?(): void; onEditingChange?(editing: boolean): void } = {},
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
  // «Закрити», а не «Готово»: в iOS «Готово» означає «підтвердити», а тут — вихід з рулетки.
  done.textContent = 'Закрити';
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
  const markers = LABELS.map((letter) => {
    const marker = document.createElement('div');
    marker.className = 'ruler-marker';
    marker.hidden = true;
    const tag = document.createElement('span');
    tag.className = 'ruler-marker-tag';
    tag.textContent = letter;
    marker.append(tag);
    overlay.append(marker);
    return marker;
  });
  const label = document.createElement('div');
  label.className = 'ruler-label';
  label.hidden = true;
  overlay.append(label);

  let active = false;
  let phase: RulerPhase = 'pickA';
  let points: Vector3[] = [];
  let missed = false;
  /** Перенести вже підсунуту точку можна лише повторним дотиком у тому самому місці. */
  const retap = createRetapGuard(() => render());
  let confirmedAt = -Infinity;
  const recentlyConfirmed = () => performance.now() - confirmedAt < CONFIRM_COOLDOWN_MS;
  let downView: ViewSnapshot | null = null;

  const editingIndex = () => (phase === 'editA' ? 0 : phase === 'editB' ? 1 : -1);

  const editing: PointEditorHandlers = {
    onChange(point) {
      const i = editingIndex();
      if (i < 0) return;
      points[i] = new Vector3(point.x, point.y, point.z);
      render();
    },
    onConfirm(point) {
      const i = editingIndex();
      if (i < 0) return;
      points[i] = new Vector3(point.x, point.y, point.z);
      phase = i === 0 ? 'pickB' : 'done';
      retap.clear();
      confirmedAt = performance.now();
      editor.close();
      handlers.onEditingChange?.(false);
      render();
    },
    onSettle(point) {
      keepVisible(viewer, point);
      render();
    },
  };
  /** Чи редактор зараз доводить точку рулетки. */
  const owns = () => editor.ownedBy(editing);

  const state = (): RulerState => {
    const [a, b] = points;
    return {
      active,
      phase,
      points: points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      distanceMm: a && b ? mToMm(a.distanceTo(b)) : null,
      editor: owns() ? editor.state : closedEditorState(),
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
    const i = editingIndex();
    markers.forEach((m, k) => m.classList.toggle('ruler-marker--draft', k === i));
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
    // Поки Б доводять, підпис на сцені закривав би точку — число видно в панелі рулетки.
    if (a && b && phase !== 'editB') place(label, a.clone().add(b).multiplyScalar(0.5), 'translate(-50%, -150%)');
    else label.hidden = true;
  };
  const stopFrames = viewer.onFrame(updateOverlay);

  function render(): void {
    const current = state();
    panel.hidden = !active;
    const hasDistance = current.distanceMm !== null;
    text.classList.toggle('ruler-text--result', hasDistance);
    if (hasDistance) {
      const value = formatMm(current.distanceMm!);
      text.textContent = value;
      label.textContent = value;
    } else {
      text.textContent = HINTS[phase];
    }
    // Другий рядок: промах — попередження; інакше підказка, якщо головний рядок зайнятий числом.
    const warning = missed ? HINT_MISS : retap.waiting ? HINT_CONFIRM_MOVE : '';
    sub.textContent = warning || (hasDistance ? HINTS[phase] : '');
    sub.hidden = sub.textContent === '';
    sub.classList.toggle('ruler-sub--warning', warning !== '');
    viewer.requestRender();
    updateOverlay();
    handlers.onChange?.(current);
  }

  const startEditing = (index: 0 | 1, hit: Vector3) => {
    points = index === 0 ? [hit] : [points[0]!, hit];
    phase = index === 0 ? 'editA' : 'editB';
    editor.edit({ x: hit.x, y: hit.y, z: hit.z }, LABELS[index], editing);
    handlers.onEditingChange?.(true);
    keepVisible(viewer, hit);
  };

  const stopTap = onTap(viewer.canvas, {
    onDown: () => {
      downView = active ? viewer.snapshotView() : null;
    },
    onTap: (x, y) => {
      if (!active || recentlyConfirmed()) return;
      // Скасувати мікроповорот камери від тремтіння — шукаємо точку в тому кадрі, куди цілились.
      if (downView) viewer.restoreView(downView);
      const hit = viewer.raycastScan(x, y);
      missed = !hit;
      if (hit) {
        // Підсунуту точку випадковий дотик не переносить: потрібен другий дотик у тому самому місці.
        if (owns() && editor.state.moved && !retap.confirm(x, y)) {
          render();
          return;
        }
        retap.clear();
        // А (або новий вимір) — у фазах pickA/editA/done; Б — у pickB/editB.
        startEditing(phase === 'pickB' || phase === 'editB' ? 1 : 0, hit);
      }
      render();
    },
  });

  const reset = () => {
    points = [];
    phase = 'pickA';
    missed = false;
    retap.clear();
    if (owns()) {
      editor.close();
      handlers.onEditingChange?.(false);
    }
  };

  render();

  return {
    panel,
    overlay,
    get state() {
      return state();
    },
    recentlyConfirmed,
    setActive(value) {
      active = value;
      if (!active) reset();
      render();
    },
    clear() {
      reset();
      render();
    },
    dispose() {
      retap.clear();
      stopTap();
      stopFrames();
      panel.remove();
      overlay.remove();
    },
  };
}
