/**
 * «Траса» — режим «Побудова траєкторії»: полілінія (вісь повітропроводу) від першої точки до останньої.
 *
 * 1. Дотик по скану ставить першу точку; її доводять джойстиком і повзунком і підтверджують.
 * 2. Кожна наступна точка з'являється в попередній і тягнеться ЛИШЕ джойстиком (X, Z) чи повзунком (Y)
 *    по одній осі (редактор точки в режимі «відрізок»); дотик по скану нових точок не ставить.
 *    «Підтвердити точку» робить її вузлом (поворотом), і наступна стартує з неї.
 * 3. «Видалити останню точку» прибирає останній підтверджений вузол.
 * 4. «Завершити побудову траєкторії» (коли є ≥ 2 точки) зберігає трасу з наступним номером і вимикає режим.
 * Траси й номери — у core/route.ts; на екрані їх малює route-layer.ts.
 */
import type { PointM } from '../core/nudge';
import {
  addRoute,
  emptyRouteSet,
  formatPointCount,
  isValidRoute,
  lastDirection,
  type PointMm,
  type RouteSet,
  removeRoute,
  routeLength,
  toMm,
} from '../core/route';
import { formatMm } from '../core/units';
import type { Viewer, ViewSnapshot } from '../scene/viewer';
import { createPointEditor, type PointEditorState } from './point-editor';
import { createRouteLayer } from './route-layer';
import { createRetapGuard, HINT_CONFIRM_MOVE, onTap } from './tap';
import { keepVisible } from './visibility';

/** off — режим вимкнено; first — чекаємо дотик першої точки; editFirst — доводимо її; pull — тягнемо наступну. */
export type RoutePhase = 'off' | 'first' | 'editFirst' | 'pull';

export interface RouteToolState {
  active: boolean;
  phase: RoutePhase;
  /** Усі завершені траси (вузли в мм) і номер для наступної. */
  set: RouteSet;
  /** Траса, яку будують: номер і підтверджені вузли (мм); null — режим вимкнено. */
  building: { id: number; nodes: PointMm[] } | null;
  /** Підсвічена траса (вибрана у списку на видалення). */
  highlight: number | null;
  editor: PointEditorState;
}

export interface RouteTool {
  panel: HTMLElement;
  /** Траси на сцені (лінії, вузли, номери). */
  layer: HTMLElement;
  editor: HTMLElement;
  editorOverlay: HTMLElement;
  readonly state: RouteToolState;
  setActive(active: boolean): void;
  /** Завершити трасу, яку будують (якщо в ній ≥ 2 точки). true — збережено. */
  finish(): boolean;
  /** Видалити завершену трасу за номером. */
  remove(id: number): void;
  /** Підсвітити трасу (null — зняти). */
  setHighlight(id: number | null): void;
  /** Прибрати всі траси (відкрили інший скан). Номери починаються знову з 1. */
  clearAll(): void;
  /** Підставити готовий набір трас (тести; пізніше — відкриття збереженого проєкту). */
  load(next: RouteSet): void;
  dispose(): void;
}

const HINTS: Record<Exclude<RoutePhase, 'off'>, string> = {
  first: 'Торкніться скану там, де починається траса',
  editFirst: 'Перша точка: підсуньте, якщо треба, і підтвердьте',
  pull: 'Тягніть наступну точку джойстиком чи повзунком і підтвердьте',
};
const HINT_MISS = 'Тут немає поверхні скану — торкніться самого скану';
const HINT_PULL_TAP = 'Наступна точка не ставиться дотиком — тягніть її джойстиком чи повзунком';

export function createRouteTool(
  viewer: Viewer,
  handlers: {
    onChange?(state: RouteToolState): void;
    onClose?(): void;
    onEditingChange?(editing: boolean): void;
  } = {},
): RouteTool {
  const panel = document.createElement('div');
  panel.className = 'panel route-panel';
  panel.dataset.testid = 'route-panel';
  panel.hidden = true;
  const head = document.createElement('div');
  head.className = 'ruler-head';
  const title = document.createElement('p');
  title.className = 'ruler-title';
  title.dataset.testid = 'route-title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ruler-done';
  close.dataset.testid = 'route-close';
  close.textContent = 'Закрити';
  close.addEventListener('click', () => handlers.onClose?.());
  head.append(title, close);
  const text = document.createElement('p');
  text.className = 'ruler-text route-text';
  text.dataset.testid = 'route-text';
  text.setAttribute('role', 'status');
  text.setAttribute('aria-live', 'polite');
  const sub = document.createElement('p');
  sub.className = 'ruler-sub';
  sub.dataset.testid = 'route-sub';
  const info = document.createElement('p');
  info.className = 'route-info';
  info.dataset.testid = 'route-info';
  const actions = document.createElement('div');
  actions.className = 'route-actions';
  const removeLast = document.createElement('button');
  removeLast.type = 'button';
  removeLast.className = 'panel-button';
  removeLast.dataset.testid = 'route-remove-last';
  removeLast.textContent = 'Видалити останню точку';
  const finishButton = document.createElement('button');
  finishButton.type = 'button';
  finishButton.className = 'panel-button panel-button--primary';
  finishButton.dataset.testid = 'route-finish';
  finishButton.textContent = 'Завершити побудову траєкторії';
  actions.append(removeLast, finishButton);
  panel.append(head, text, sub, info, actions);

  const routeLayer = createRouteLayer(viewer);

  let active = false;
  let phase: RoutePhase = 'off';
  let set: RouteSet = emptyRouteSet();
  /** Підтверджені вузли траси, яку будують (м сцени). */
  let nodes: PointM[] = [];
  /** Точка, яку доводять / тягнуть (м) — для лінії на сцені. */
  let pending: PointM | null = null;
  let highlight: number | null = null;
  let missed = false;
  let pullTapped = false;
  let downView: ViewSnapshot | null = null;
  const retap = createRetapGuard(() => render());

  const editorTitle = () => `Траса ${set.nextId} · точка ${nodes.length + 1}`;

  const editor = createPointEditor(viewer, {
    onChange(point) {
      pending = point;
      // Точку вже тягнуть — підказка про дотик більше не потрібна.
      pullTapped = false;
      render();
    },
    onConfirm(point) {
      if (phase !== 'editFirst' && phase !== 'pull') return;
      nodes = [...nodes, { ...point }];
      retap.clear();
      missed = false;
      pullTapped = false;
      startPull();
      render();
    },
    onSettle(point) {
      keepVisible(viewer, point);
      render();
    },
  });

  /** Наступна точка: стартує в останньому вузлі, назад по останньому відрізку — не можна. */
  function startPull(): void {
    const anchor = nodes.at(-1)!;
    phase = 'pull';
    pending = { ...anchor };
    editor.edit(anchor, '', { title: editorTitle(), segment: { anchor, back: lastDirection(nodes) } });
    handlers.onEditingChange?.(true);
  }

  const state = (): RouteToolState => ({
    active,
    phase,
    set,
    building: active ? { id: set.nextId, nodes: nodes.map(toMm) } : null,
    highlight,
    editor: editor.state,
  });

  function render(): void {
    panel.hidden = !active;
    title.textContent = `Траса ${set.nextId}`;
    if (active && phase !== 'off') text.textContent = HINTS[phase];
    const warning = missed ? HINT_MISS : retap.waiting ? HINT_CONFIRM_MOVE : pullTapped ? HINT_PULL_TAP : '';
    sub.textContent = warning;
    sub.hidden = warning === '';
    sub.classList.toggle('ruler-sub--warning', warning !== '');
    const mm = nodes.map(toMm);
    info.textContent = nodes.length ? `${formatPointCount(nodes.length)} · ${formatMm(routeLength(mm))}` : '';
    info.hidden = nodes.length === 0;
    removeLast.disabled = nodes.length === 0;
    finishButton.disabled = nodes.length < 2;
    routeLayer.update({
      routes: set.routes,
      draft: active ? { id: set.nextId, nodes, pending: editor.state.active ? pending : null } : null,
      highlight,
    });
    handlers.onChange?.(state());
  }

  const closeEditor = () => {
    if (!editor.state.active) return;
    editor.close();
    handlers.onEditingChange?.(false);
  };

  const resetBuilding = () => {
    nodes = [];
    pending = null;
    missed = false;
    pullTapped = false;
    retap.clear();
    closeEditor();
    phase = active ? 'first' : 'off';
  };

  removeLast.addEventListener('click', () => {
    if (nodes.length === 0) return;
    nodes = nodes.slice(0, -1);
    missed = false;
    pullTapped = false;
    retap.clear();
    if (nodes.length === 0) {
      // Прибрали першу точку — знову чекаємо дотик по скану.
      pending = null;
      closeEditor();
      phase = 'first';
    } else {
      startPull();
      keepVisible(viewer, nodes.at(-1)!);
    }
    render();
  });

  const finish = (): boolean => {
    if (nodes.length < 2) return false;
    set = addRoute(set, nodes.map(toMm)).set;
    resetBuilding();
    return true;
  };

  finishButton.addEventListener('click', () => {
    if (!finish()) return;
    // Траса збережена — режим побудови вимикається.
    handlers.onClose?.();
  });

  const stopTap = onTap(viewer.canvas, {
    onDown: () => {
      downView = active ? viewer.snapshotView() : null;
    },
    onTap: (x, y) => {
      if (!active) return;
      if (phase === 'pull') {
        // Наступна точка тягнеться лише джойстиком — дотик лише підказує, як.
        pullTapped = true;
        render();
        return;
      }
      // Скасувати мікроповорот камери від тремтіння — шукаємо точку в тому кадрі, куди цілились.
      if (downView) viewer.restoreView(downView);
      const hit = viewer.raycastScan(x, y);
      missed = !hit;
      if (hit) {
        if (phase === 'editFirst' && editor.state.moved && !retap.confirm(x, y)) {
          render();
          return;
        }
        retap.clear();
        const point = { x: hit.x, y: hit.y, z: hit.z };
        phase = 'editFirst';
        pending = point;
        editor.edit(point, '', { title: editorTitle() });
        handlers.onEditingChange?.(true);
        keepVisible(viewer, point);
      }
      render();
    },
  });

  render();

  return {
    panel,
    layer: routeLayer.element,
    editor: editor.element,
    editorOverlay: editor.overlay,
    get state() {
      return state();
    },
    setActive(value) {
      if (value === active) return;
      active = value;
      resetBuilding();
      render();
    },
    finish() {
      const saved = finish();
      render();
      return saved;
    },
    remove(id) {
      set = removeRoute(set, id);
      if (highlight === id) highlight = null;
      render();
    },
    setHighlight(id) {
      highlight = id;
      render();
    },
    clearAll() {
      set = emptyRouteSet();
      highlight = null;
      resetBuilding();
      render();
    },
    load(next) {
      if (!next.routes.every((r) => isValidRoute(r.nodes) && r.id < next.nextId)) {
        throw new RangeError('Траси мають бути за правилами, а nextId — більший за номери трас');
      }
      set = { routes: next.routes.map((r) => ({ id: r.id, nodes: r.nodes.map((n) => ({ ...n })) })), nextId: next.nextId };
      highlight = null;
      render();
    },
    dispose() {
      retap.clear();
      stopTap();
      editor.dispose();
      routeLayer.dispose();
      panel.remove();
    },
  };
}

/** «Траса 1 · 4 точки · 7 350 мм» — для списку трас. */
export function describeRoute(route: { id: number; nodes: readonly PointMm[] }): string {
  return `Траса ${route.id} · ${formatPointCount(route.nodes.length)} · ${formatMm(routeLength(route.nodes))}`;
}
