/**
 * Збирає інтерфейс: відкриття скану, «Показати все», «Рулетка», «Траса», «Видалити траєкторію»,
 * «Повітропровід», кнопки видів X/Y/Z. Одночасно працює лише один інструмент.
 * Інформація про скан (габарит, зсув, попередження) — у стані для тестів; на екрані постійно
 * не показується (на прохання Єгора), лише віконце, якщо скан завеликий для пристрою.
 */
import { type DeviceClass, describeScan, formatBytes, MAX_TEXTURE_SIDE, type ScanInfo } from '../core/scan-info';
import {
  buildScan,
  type LoadedScan,
  type LoadPhase,
  prepareScan,
  type PreparedScan,
  ScanLoadError,
  type ScanFile,
} from '../scene/scan-loader';
import type { Viewer } from '../scene/viewer';
import { type DuctProblem, type DuctSpec, ductLayout, formatSection, pickDuctSegment, sectionsBySegment } from '../core/duct';
import { formatPointCount, type RouteSet, toMm } from '../core/route';
import { createDuctLayer } from '../scene/duct-layer';
import { createAlert, createChoice, createProgress } from './dialogs';
import { createDuctPanel, type DuctSelection, type ViewMode } from './duct-panel';
import { closedEditorState, createPointEditor } from './point-editor';
import { createRouteDelete } from './route-delete';
import { createRouteTool, type RouteToolState } from './route-tool';
import { createRuler, type RulerState } from './ruler';
import { onTap } from './tap';
import { createToolbar, type ToolName } from './toolbar';
import { createViewBar } from './view-bar';
import { freeAreaCenter } from './visibility';

export interface AppState {
  /** idle — нічого не відкрито; loading — відкривається; ready — скан показано. */
  status: 'idle' | 'loading' | 'ready';
  scanName: string | null;
  scanInfo: ScanInfo | null;
  ruler: RulerState;
  /** Траси: завершені, та, що будується, і редактор точки. */
  routes: RouteToolState;
  /** Увімкнений інструмент. */
  tool: ToolName;
  /** Повітропроводи: показ, прозорість скану, вибір у панелі, розміри й проблеми трас. */
  ducts: DuctsState;
  /** Остання помилка відкриття (для тестів). */
  error: string | null;
}

export interface DuctsState {
  mode: ViewMode;
  /** Прозорість скану 0…0,9. */
  transparency: number;
  selection: DuctSelection | null;
  routes: Array<{ id: number; duct: DuctSpec | null; sections: string[]; problems: DuctProblem[] }>;
  /** Трикутників у всіх повітропроводах (перевірка, що пам'ять звільняється). */
  triangles: number;
}

export interface App {
  readonly state: AppState;
  /** Відкрити скан із файлів (так само, як після вибору в «Файлах»). */
  openFiles(files: readonly ScanFile[]): Promise<void>;
  /** Підставити траси (тести; пізніше — відкриття збереженого проєкту). */
  loadRoutes(set: RouteSet): void;
  /** Габарит 3D-повітропроводу траси в мм (для тестів) або null. */
  ductBox(routeId: number): ReturnType<ReturnType<typeof createDuctLayer>['boxMm']>;
}

const PHASE_TEXT: Record<LoadPhase, string> = {
  reading: 'Читаю файл…',
  unzipping: 'Розпаковую архів…',
  parsing: 'Завантажую модель…',
  preparing: 'Готую до показу…',
};

/** iPhone чи iPad: від цього залежать межі «завеликого» скану й розмір текстур. */
export function detectDeviceClass(): DeviceClass {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const shortSide = Math.min(screen.width, screen.height);
  return coarse && shortSide < 600 ? 'phone' : 'tablet';
}

export function createApp(root: HTMLElement, viewer: Viewer): App {
  const device = detectDeviceClass();
  let scan: LoadedScan | null = null;
  /** Чи вже створено всі частини інтерфейсу (до того зміни трас лише записуємо в стан). */
  let ready = false;
  const state: AppState = {
    status: 'idle',
    scanName: null,
    scanInfo: null,
    ruler: {
      active: false,
      phase: 'pickA',
      points: [],
      distanceMm: null,
      editor: closedEditorState(),
    },
    routes: {
      active: false,
      phase: 'off',
      set: { routes: [], nextId: 1 },
      building: null,
      highlight: null,
      editor: closedEditorState(),
    },
    tool: 'none',
    ducts: { mode: 'both', transparency: 0, selection: null, routes: [], triangles: 0 },
    error: null,
  };

  // Вибір файлу. Без жорсткого accept: на iOS він може зробити .glb/.gltf/.zip неактивними —
  // тип перевіряємо після вибору (scan-loader).
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.dataset.testid = 'file-input';

  // Кнопки видів X/Y/Z. Якщо зараз доводять чи тягнуть точку — дивимось саме на неї.
  const viewBar = createViewBar((axis) => {
    const editing = editor.state;
    // Точка стає посередині вільної від панелей частини екрана (її не закриває джойстик).
    const side =
      editing.active && editing.point
        ? viewer.viewAlong(axis, editing.point, freeAreaCenter() ?? undefined)
        : viewer.viewAlong(axis);
    viewBar.setActive(axis, side);
  }, () => viewer.showAll('current'));
  // Камеру повернули рукою — вид уже не «строго вздовж осі».
  viewer.onUserCamera(() => viewBar.setActive(null));
  const progress = createProgress();
  const alert = createAlert();
  const choice = createChoice();
  // Поки точку доводять, розкладка звільняє місце для джойстика (див. style.css).
  const onEditingChange = (editing: boolean) => root.classList.toggle('is-editing-point', editing);

  // Редактор точки один на всі інструменти (працює одночасно лише один інструмент).
  const editor = createPointEditor(viewer);

  const ruler = createRuler(viewer, editor, {
    onChange: (rulerState) => {
      state.ruler = rulerState;
    },
    onDone: () => requestTool('none'),
    onEditingChange,
  });

  const route = createRouteTool(viewer, editor, {
    onChange: (routeState) => {
      state.routes = routeState;
      syncRouteUi();
    },
    onClose: () => requestTool('none'),
    onEditingChange,
  });

  // Повітропроводи трас (3D) і панель «Повітропровід».
  const ductLayer = createDuctLayer(viewer);
  const ductPanel = createDuctPanel({
    onDuct: (id, duct) => route.setDuct(id, duct),
    onSelect: (selection) => {
      // Вибрали іншу трасу — показати її цілком у вільній від панелей частині екрана.
      if (selection && selection.routeId !== state.ducts.selection?.routeId) route.reveal(selection.routeId);
      state.ducts.selection = selection;
      route.setSegmentHighlight(selection && selection.segment !== null ? { id: selection.routeId, index: selection.segment } : null);
      syncRouteUi();
    },
    onMode: (mode) => {
      state.ducts.mode = mode;
      applyViewMode();
    },
    onTransparency: (transparency) => {
      state.ducts.transparency = transparency;
      viewer.setScanTransparency(transparency);
    },
    onClose: () => requestTool('none'),
  });
  // Дотик по трубі на сцені вибирає відрізок (для переходу), поки відкрита панель «Повітропровід».
  onTap(viewer.canvas, {
    onTap: (x, y) => {
      if (state.tool !== 'duct') return;
      const ray = viewer.screenRay(x, y);
      if (!ray) return;
      // Початок променя — точка (м → мм); напрямок — одиничний, без одиниць.
      const hit = pickDuctSegment(toMm(ray.origin), ray.direction, state.routes.set.routes);
      const current = ductPanel.selection;
      ductPanel.select(hit ?? (current ? { routeId: current.routeId, segment: null } : null));
    },
  });

  const routeDelete = createRouteDelete({
    onSelect: (id) => {
      route.setHighlight(id);
      // Вибрану трасу має бути видно цілком (на iPhone її легко закриває сам список).
      if (id !== null) route.reveal(id);
    },
    onDelete: (id) => {
      route.remove(id);
      // Трас не лишилось — список закривається.
      if (route.state.set.routes.length === 0) requestTool('none');
    },
    onClose: () => requestTool('none'),
  });

  /** Кнопка інструмента: увімкнути або (повторне натискання) вимкнути. */
  const toggleTool = (tool: ToolName) => {
    // Другий дотик подвійного натискання «Підтвердити точку» міг упасти на кнопку.
    if (ruler.recentlyConfirmed()) return;
    requestTool(state.tool === tool ? 'none' : tool);
  };

  const toolbar = createToolbar({
    onOpen: () => {
      const building = route.state.building;
      const hasRoutes = route.state.set.routes.length > 0 || (building?.nodes.length ?? 0) > 0;
      if (!hasRoutes) {
        input.click();
        return;
      }
      // Траси належать скану; збереження проєкту буде пізніше (етап 6).
      choice.show('Відкрити інший скан?', 'Усі траси в цій сцені буде видалено.', [
        { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
        // «Файли» відкриваються прямо в обробнику натискання — інакше iOS їх не покаже.
        { label: 'Відкрити', role: 'destructive', testid: 'choice-open', onSelect: () => input.click() },
      ]);
    },
    onShowAll: () => viewer.showAll('current'),
    onRuler: () => toggleTool('ruler'),
    onRoute: () => toggleTool('route'),
    onRouteDelete: () => toggleTool('delete'),
    onDuct: () => toggleTool('duct'),
  });

  // Інтерфейс створено — тепер зміни трас можна показувати на кнопках і в списку.
  ready = true;
  syncRouteUi();

  /**
   * Траси змінились: кнопки «Видалити траєкторію» й «Повітропровід» активні, лише коли є траси;
   * відкриті списки й 3D-повітропроводи — актуальні.
   */
  function syncRouteUi(): void {
    if (!ready) return;
    const routes = state.routes.set.routes;
    toolbar.setHasRoutes(routes.length > 0);
    if (routeDelete.open) routeDelete.show(routes);
    if (ductPanel.open) ductPanel.show(routes, state.ducts.mode, state.ducts.transparency);
    const selection = ductPanel.open ? ductPanel.selection : null;
    ductLayer.update(
      routes,
      selection && selection.segment !== null ? { routeId: selection.routeId, segment: selection.segment } : null,
    );
    state.ducts.selection = selection;
    state.ducts.routes = routes.map((r) => ({
      id: r.id,
      duct: r.duct ?? null,
      sections: r.duct ? sectionsBySegment(r.duct, r.nodes.length - 1).map(formatSection) : [],
      problems: r.duct ? ductLayout(r.nodes, r.duct).problems : [],
    }));
    state.ducts.triangles = ductLayer.triangles;
  }

  /** «Траса / Повітропровід / Обидва»: лінії трас ховаються лише поза побудовою траси. */
  function applyViewMode(): void {
    const mode = state.ducts.mode;
    route.layer.hidden = mode === 'duct' && state.tool !== 'route';
    ductLayer.setVisible(mode !== 'route');
  }

  /** Увімкнути інструмент (решта вимикаються). */
  function applyTool(next: ToolName): void {
    state.tool = next;
    ruler.setActive(next === 'ruler');
    route.setActive(next === 'route');
    if (next === 'delete') routeDelete.show(route.state.set.routes);
    else routeDelete.hide();
    if (next === 'duct') ductPanel.show(route.state.set.routes, state.ducts.mode, state.ducts.transparency);
    else if (ductPanel.open) {
      ductPanel.hide();
      route.setSegmentHighlight(null);
    }
    route.setHighlight(null);
    applyViewMode();
    syncRouteUi();
    toolbar.setActiveTool(next);
    root.classList.toggle('is-ruler', next === 'ruler');
    root.classList.toggle('is-route', next === 'route');
    root.classList.toggle('is-route-delete', next === 'delete');
    root.classList.toggle('is-duct', next === 'duct');
  }

  /**
   * Перемкнути інструмент. Якщо йде побудова траси з ≥ 2 точками — спершу питаємо,
   * зберегти її чи видалити (або лишитись у побудові).
   */
  function requestTool(next: ToolName): void {
    if (next === state.tool) return;
    const building = route.state.building;
    if (state.tool === 'route' && building && building.nodes.length >= 2) {
      choice.show(`Траса ${building.id} не завершена`, `У ній ${formatPointCount(building.nodes.length)}. Зберегти її?`, [
        {
          label: 'Зберегти трасу',
          testid: 'choice-save',
          onSelect: () => {
            route.finish();
            applyTool(next);
          },
        },
        { label: 'Видалити трасу', role: 'destructive', testid: 'choice-discard', onSelect: () => applyTool(next) },
        { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
      ]);
      return;
    }
    applyTool(next);
  }

  root.append(
    route.layer,
    ruler.overlay,
    editor.overlay,
    viewBar.element,
    toolbar.element,
    ruler.panel,
    route.panel,
    routeDelete.element,
    ductPanel.element,
    editor.element,
    progress.element,
    alert.element,
    choice.element,
    input,
  );

  async function openFiles(files: readonly ScanFile[]): Promise<void> {
    if (files.length === 0 || state.status === 'loading') return;
    const previousStatus = state.status;
    state.status = 'loading';
    state.error = null;
    toolbar.setBusy(true);
    const sizeText = formatBytes(files.reduce((sum, f) => sum + f.size, 0));
    const showPhase = (phase: LoadPhase) => progress.show(PHASE_TEXT[phase], sizeText);
    showPhase('reading');

    let closedPrevious = false;
    try {
      // 1. Швидка перевірка: якщо вибрано не той файл — уже відкритий скан лишається.
      let prepared: PreparedScan;
      try {
        prepared = await prepareScan(files, showPhase);
      } catch (error) {
        state.status = previousStatus;
        throw error;
      }

      // 2. Файл підходить — вимикаємо інструменти (невдалий файл нічого не скидає: поки він
      //    готується, екран закрито індикатором). Звільняємо пам'ять від попереднього скану —
      //    два великі скани одночасно можуть не вміститися в пам'ять iPhone.
      applyTool('none');
      if (scan) {
        viewer.setScan(null);
        scan.dispose();
        scan = null;
        closedPrevious = true;
      }
      // Траси належали попередньому скану.
      route.clearAll();
      state.scanName = null;
      state.scanInfo = null;
      toolbar.setScanLoaded(false);

      // 3. Будуємо 3D. Скан стає «відкритим» лише коли все вдалося — інакше звільняємо його.
      const loaded = await buildScan(prepared, { maxTextureSide: MAX_TEXTURE_SIDE[device], onPhase: showPhase });
      let info: ScanInfo;
      try {
        info = describeScan(loaded.stats, device);
        viewer.setScan(loaded.root);
        viewer.showAll('default');
      } catch (error) {
        viewer.setScan(null);
        loaded.dispose();
        throw error;
      }
      scan = loaded;
      state.scanName = loaded.name;
      state.scanInfo = info;
      state.status = 'ready';
      // Скан завеликий для пристрою — одне віконце одразу після відкриття.
      if (info.risks.length > 0) alert.show('Увага', info.risks.join('\n'));
      toolbar.setScanLoaded(true);
    } catch (error) {
      console.error(error);
      // Що б не сталося — стан не лишається «відкривається»: є скан — готово, немає — порожньо.
      state.status = scan ? 'ready' : 'idle';
      let message =
        error instanceof ScanLoadError
          ? error.message
          : 'Невідома помилка. Можливо, скан завеликий для цього пристрою — спробуйте менший або відкрийте на iPad.';
      if (closedPrevious) message += ' Попередній скан закрито — відкрийте його знову.';
      state.error = message;
      if (!scan) viewer.showAll('default');
      alert.show('Не вдалося відкрити скан', message);
    } finally {
      progress.hide();
      toolbar.setBusy(false);
    }
  }

  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : [];
    // Скинути вибір, щоб той самий файл можна було відкрити ще раз.
    input.value = '';
    void openFiles(files);
  });

  return {
    get state() {
      return state;
    },
    openFiles,
    loadRoutes: (set) => route.load(set),
    ductBox: (routeId) => ductLayer.boxMm(routeId),
  };
}
