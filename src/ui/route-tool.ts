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
  distance,
  emptyRouteSet,
  formatPointCount,
  isValidRoute,
  lastDirection,
  type PointMm,
  type RouteSet,
  removeRoute,
  routeLength,
  toM,
  toMm,
} from '../core/route';
import { type DuctSpec, isValidDuctSpec, withRouteDuct } from '../core/duct';
import { formatMm, mToMm } from '../core/units';
import type { Viewer, ViewSnapshot } from '../scene/viewer';
import { closedEditorState, type PointEditor, type PointEditorHandlers, type PointEditorState } from './point-editor';
import { createRouteLayer } from './route-layer';
import { createRetapGuard, HINT_CONFIRM_MOVE, onTap } from './tap';
import { freeAreaRect, keepVisible } from './visibility';

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
  readonly state: RouteToolState;
  setActive(active: boolean): void;
  /** Завершити трасу, яку будують (якщо в ній ≥ 2 точки). true — збережено. */
  finish(): boolean;
  /** Видалити завершену трасу за номером. */
  remove(id: number): void;
  /** Підсвітити трасу (null — зняти). */
  setHighlight(id: number | null): void;
  /** Підсвітити відрізок траси (панель «Повітропровід»; null — зняти). */
  setSegmentHighlight(segment: { id: number; index: number } | null): void;
  /** Панель «Повітропровід»: траса, з якою працюють; приховані лінії трас; маркер переходу (м). */
  setDuctView(view: { focus: number | null; linesHidden: ReadonlySet<number>; marker: PointM | null }): void;
  /** Задати (null — прибрати) повітропровід траси: розмір і переходи (core/duct.ts). */
  setDuct(id: number, duct: DuctSpec | null): void;
  /** Показати трасу цілком у вільній від панелей частині екрана (якщо її щось закриває). */
  reveal(id: number): void;
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
/** Уперше за відкриття додатка тягнуть наступну точку — «посмикати» джойстик, щоб було видно чим. */
let pullShown = false;

/** Кнопка з повною назвою (iPad) і короткою (iPhone; див. style.css). Повна — для VoiceOver. */
function panelButton(testid: string, full: string, short: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'panel-button panel-button--primary' : 'panel-button';
  button.dataset.testid = testid;
  const long = document.createElement('span');
  long.className = 'label-full';
  long.textContent = full;
  const brief = document.createElement('span');
  brief.className = 'label-short';
  brief.textContent = short;
  brief.setAttribute('aria-hidden', 'true');
  button.append(long, brief);
  button.setAttribute('aria-label', full);
  return button;
}

/** editor — спільний редактор точки (джойстик, повзунок, «Підтвердити точку»); див. app.ts. */
export function createRouteTool(
  viewer: Viewer,
  editor: PointEditor,
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
  const removeLast = panelButton('route-remove-last', 'Видалити останню точку', 'Видалити точку');
  const finishButton = panelButton('route-finish', 'Завершити побудову траєкторії', 'Завершити трасу', true);
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
  let segmentHighlight: { id: number; index: number } | null = null;
  let ductView: { focus: number | null; linesHidden: ReadonlySet<number>; marker: PointM | null } = {
    focus: null,
    linesHidden: new Set(),
    marker: null,
  };
  let missed = false;
  let downView: ViewSnapshot | null = null;
  const retap = createRetapGuard(() => render());

  const editorTitle = () => `Траса ${set.nextId} · точка ${nodes.length + 1}`;

  const editing: PointEditorHandlers = {
    onChange(point) {
      pending = point;
      render();
    },
    onConfirm(point) {
      if (phase !== 'editFirst' && phase !== 'pull') return;
      nodes = [...nodes, { ...point }];
      retap.clear();
      missed = false;
      startPull();
      render();
    },
    onSettle(point) {
      keepVisible(viewer, point);
      render();
    },
  };
  /** Чи редактор зараз доводить точку траси. */
  const owns = () => editor.ownedBy(editing);

  /** Наступна точка: стартує в останньому вузлі, назад по останньому відрізку — не можна. */
  function startPull(): void {
    const anchor = nodes.at(-1)!;
    phase = 'pull';
    pending = { ...anchor };
    editor.edit(anchor, '', editing, { title: editorTitle(), segment: { anchor, back: lastDirection(nodes) } });
    handlers.onEditingChange?.(true);
    if (!pullShown) {
      pullShown = true;
      editor.notice('Тягніть наступну точку джойстиком (X, Z) чи повзунком (Y)', { wiggle: true });
    }
  }

  const state = (): RouteToolState => ({
    active,
    phase,
    set,
    building: active ? { id: set.nextId, nodes: nodes.map(toMm) } : null,
    highlight,
    editor: owns() ? editor.state : closedEditorState(),
  });

  function render(): void {
    panel.hidden = !active;
    title.textContent = `Траса ${set.nextId}`;
    if (active && phase !== 'off') text.textContent = HINTS[phase];
    const warning = missed ? HINT_MISS : retap.waiting ? HINT_CONFIRM_MOVE : '';
    sub.textContent = warning;
    sub.hidden = warning === '';
    sub.classList.toggle('ruler-sub--warning', warning !== '');
    const mm = nodes.map(toMm);
    // Відрізок, який зараз тягнуть, — у дужках (ще не підтверджений).
    const pendingMm = phase === 'pull' && pending && nodes.length ? mToMm(distance(nodes.at(-1)!, pending)) : 0;
    let summary = `${formatPointCount(nodes.length)} · ${formatMm(routeLength(mm))}`;
    if (pendingMm >= 0.05) summary += ` (+${formatMm(pendingMm)})`;
    else if (nodes.length === 1) summary = '1 точка — щоб завершити, потрібна ще одна';
    info.textContent = nodes.length ? summary : '';
    info.hidden = nodes.length === 0;
    removeLast.disabled = nodes.length === 0;
    finishButton.disabled = nodes.length < 2;
    routeLayer.update({
      routes: set.routes,
      draft: active ? { id: set.nextId, nodes, pending: owns() ? pending : null } : null,
      highlight,
      segment: segmentHighlight,
      ...ductView,
    });
    handlers.onChange?.(state());
  }

  const closeEditor = () => {
    if (!owns()) return;
    editor.close();
    handlers.onEditingChange?.(false);
  };

  const resetBuilding = () => {
    nodes = [];
    pending = null;
    missed = false;
    retap.clear();
    closeEditor();
    phase = active ? 'first' : 'off';
  };

  removeLast.addEventListener('click', () => {
    if (nodes.length === 0) return;
    nodes = nodes.slice(0, -1);
    missed = false;
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
        // Наступна точка тягнеться лише джойстиком — дотик лише підказує як, біля самого джойстика.
        editor.notice(HINT_PULL_TAP, { wiggle: true });
        return;
      }
      // Скасувати мікроповорот камери від тремтіння — шукаємо точку в тому кадрі, куди цілились.
      if (downView) viewer.restoreView(downView);
      const hit = viewer.raycastScan(x, y);
      missed = !hit;
      if (hit) {
        if (phase === 'editFirst' && owns() && editor.state.moved && !retap.confirm(x, y)) {
          render();
          return;
        }
        retap.clear();
        const point = { x: hit.x, y: hit.y, z: hit.z };
        phase = 'editFirst';
        pending = point;
        editor.edit(point, '', editing, { title: editorTitle() });
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
    setSegmentHighlight(segment) {
      segmentHighlight = segment;
      render();
    },
    setDuctView(view) {
      ductView = view;
      render();
    },
    setDuct(id, duct) {
      set = withRouteDuct(set, id, duct);
      render();
    },
    reveal(id) {
      const route = set.routes.find((r) => r.id === id);
      if (!route) return;
      const points = route.nodes.map(toM);
      const area = freeAreaRect();
      const bounds = area ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const margin = 24;
      const inside = viewer
        .projectPath(points)
        .nodes.every(
          (n) =>
            n.visible &&
            n.x > bounds.left + margin &&
            n.x < bounds.right - margin &&
            n.y > bounds.top + margin &&
            n.y < bounds.bottom - margin,
        );
      if (!inside) viewer.fitPoints(points, area ?? undefined);
    },
    clearAll() {
      set = emptyRouteSet();
      highlight = null;
      resetBuilding();
      render();
    },
    load(next) {
      const ok = (r: (typeof next.routes)[number]) =>
        isValidRoute(r.nodes) && r.id < next.nextId && (!r.duct || isValidDuctSpec(r.duct, r.nodes.length - 1));
      if (!next.routes.every(ok)) {
        throw new RangeError('Траси (і повітропроводи) мають бути за правилами, а nextId — більший за номери трас');
      }
      set = {
        routes: next.routes.map((r) => ({ id: r.id, nodes: r.nodes.map((n) => ({ ...n })), duct: r.duct ?? null })),
        nextId: next.nextId,
      };
      highlight = null;
      render();
    },
    dispose() {
      retap.clear();
      stopTap();
      routeLayer.dispose();
      panel.remove();
    },
  };
}

/** «Траса 1 · 4 точки · 7 350 мм» — для списку трас. */
export function describeRoute(route: { id: number; nodes: readonly PointMm[] }): string {
  return `Траса ${route.id} · ${formatPointCount(route.nodes.length)} · ${formatMm(routeLength(route.nodes))}`;
}
