/**
 * Збирає інтерфейс: «Файл» (відкрити скан чи проєкт, зберегти проєкт), «Показати все», «Рулетка», «Траса»,
 * «Видалити траєкторію», «Повітропровід», кнопки видів X/Y/Z. Одночасно працює лише один інструмент.
 * Етап 6: проєкт зберігається у файл (project.ts), а траси кожного скану — ще й у чернетку браузера (drafts.ts).
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
import type { Projection, Viewer } from '../scene/viewer';
import { type DuctProblem, type DuctSpec, ductLayout, formatSection, pickDuctSegment, sectionsBySegment } from '../core/duct';
import {
  defaultProjectName,
  formatRouteCount,
  looksLikeProjectFile,
  type ProjectData,
  parseProject,
  projectFileName,
  sameScan,
  type ScanFingerprint,
  scanFingerprint,
  serializeProject,
} from '../core/project';
import { formatPointCount, type RouteSet, toM, toMm } from '../core/route';
import { mmToM, mToMm } from '../core/units';
import { createDuctLayer } from '../scene/duct-layer';
import { createAlert, createChoice, createMenu, createProgress, createPrompt } from './dialogs';
import { browserStorage, createDrafts } from './drafts';
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
  /** Проекція камери: з перспективою чи ортогональна (кнопка «Орто»). */
  projection: Projection;
  /** Повітропроводи: показ, прозорість скану, вибір у панелі, розміри й проблеми трас. */
  ducts: DuctsState;
  /** Остання помилка відкриття (для тестів). */
  error: string | null;
  /** Проєкт (етап 6): назва останнього збереженого чи відкритого; проєкт, що чекає на свій скан. */
  project: { name: string | null; pending: string | null };
}

export interface DuctsState {
  mode: ViewMode;
  /** Прозорість скану 0…0,9. */
  transparency: number;
  selection: DuctSelection | null;
  routes: Array<{ id: number; duct: DuctSpec | null; sections: string[]; problems: DuctProblem[] }>;
  /** Трикутників у всіх повітропроводах (перевірка, що пам'ять звільняється). */
  triangles: number;
  /** Скільки разів будувались 3D-моделі трас і скільки їх на сцені (перевірка швидкодії). */
  builds: number;
  meshes: number;
}

export interface App {
  readonly state: AppState;
  /** Відкрити скан із файлів (так само, як після вибору в «Файлах»). */
  openFiles(files: readonly ScanFile[]): Promise<void>;
  /** Підставити траси (тести). */
  loadRoutes(set: RouteSet): void;
  /** Текст файлу проєкту з того, що зараз на екрані (тести). */
  projectText(name?: string): string;
  /** Габарит 3D-повітропроводу траси в мм (для тестів) або null. */
  ductBox(routeId: number): ReturnType<ReturnType<typeof createDuctLayer>['boxMm']>;
}

const PHASE_TEXT: Record<LoadPhase, string> = {
  reading: 'Читаю файл…',
  unzipping: 'Розпаковую архів…',
  parsing: 'Завантажую модель…',
  preparing: 'Готую до показу…',
};

/** Чернетку пишемо через стільки після останньої зміни трас (не на кожен рух точки). */
const DRAFT_DELAY_MS = 500;

/** «27.11 о 14:05» — коли записано чернетку. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'раніше';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} о ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  /** Останній вигляд ліній трас для панелі «Повітропровід» (щоб не перемальовувати без змін). */
  let ductViewKey = '';
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
    projection: 'perspective',
    ducts: { mode: 'both', transparency: 0, selection: null, routes: [], triangles: 0, builds: 0, meshes: 0 },
    error: null,
    project: { name: null, pending: null },
  };

  // Вибір файлу. Без жорсткого accept: на iOS він може зробити .glb/.gltf/.zip неактивними —
  // тип перевіряємо після вибору (scan-loader). Тут же вибирають і файл проєкту (.json).
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
  }, () => viewer.showAll('current'), () => {
    // «Орто»: якщо зараз доводять точку — саме вона лишається того самого розміру на екрані.
    const next: Projection = viewer.projection === 'ortho' ? 'perspective' : 'ortho';
    const editing = editor.state;
    viewer.setProjection(next, editing.active && editing.point ? editing.point : undefined);
    state.projection = next;
    viewBar.setProjection(next);
  });
  // Камеру повернули рукою — вид уже не «строго вздовж осі».
  viewer.onUserCamera(() => viewBar.setActive(null));
  const progress = createProgress();
  const alert = createAlert();
  const choice = createChoice();
  const fileMenu = createMenu('Файл');
  const prompt = createPrompt();
  const drafts = createDrafts(browserStorage());
  /** Проєкт, відкритий до скану: застосуємо, щойно відкриють скан. */
  let pendingProject: ProjectData | null = null;
  /** Поки відкривається скан (траси тимчасово порожні) — чернетку не пишемо. */
  let draftsPaused = false;
  let draftTimer = 0;
  /** Для якого скану відкладено запис чернетки (скан міг змінитися, поки чекали). */
  let draftScan: ScanFingerprint | null = null;
  /** Останній набір трас, з якого писали чернетку (новий об'єкт — лише коли траси змінились). */
  let lastDraftSet: RouteSet | null = null;
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
      if (routeState.set !== lastDraftSet) {
        lastDraftSet = routeState.set;
        scheduleDraft();
      }
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
      scheduleDraft();
    },
    onTransparency: (transparency) => {
      state.ducts.transparency = transparency;
      viewer.setScanTransparency(transparency);
      scheduleDraft();
    },
    onClose: () => requestTool('none'),
    confirm: (title, text, okLabel, onOk) =>
      choice.show(title, text, [
        { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
        { label: okLabel, role: 'destructive', testid: 'choice-ok', onSelect: onOk },
      ]),
  });
  /** Ціль для пальця навколо осі труби: щонайменше 22 px екрана в кожен бік (44 px разом). */
  const TAP_TARGET_HALF_PX = 22;
  // Дотик по трубі на сцені вибирає відрізок (для переходу), поки відкрита панель «Повітропровід».
  onTap(viewer.canvas, {
    onTap: (x, y) => {
      if (state.tool !== 'duct') return;
      const ray = viewer.screenRay(x, y);
      if (!ray) return;
      // Запас на палець — у пікселях екрана на тій відстані, де труба (мм ↔ м лише через units.ts).
      const slack = (distanceMm: number) => mToMm(viewer.metresPerPixelAt(mmToM(distanceMm))) * TAP_TARGET_HALF_PX;
      // Початок променя — точка (м → мм); напрямок — одиничний, без одиниць.
      const hit = pickDuctSegment(toMm(ray.origin), ray.direction, state.routes.set.routes, slack);
      // Промах повз трубу вибору не знімає (знімається повторним дотиком у списку).
      if (hit) ductPanel.select(hit);
    },
  });
  /** Камера до відкриття панелі (вона могла показати трасу); повертаємо, якщо людина камеру не крутила. */
  let viewBeforePanel: ReturnType<Viewer['snapshotView']> | null = null;
  viewer.onUserCamera(() => {
    viewBeforePanel = null;
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
      // «Файл»: лише два пункти; закривається дотиком поза меню.
      const anchor = toolbar.element.querySelector<HTMLElement>('[data-testid="open-scan"]')!;
      fileMenu.show(anchor, [
        { label: 'Відкрити скан або проєкт', testid: 'menu-open', onSelect: openPicker },
        { label: 'Зберегти проєкт', testid: 'menu-save', onSelect: startSave },
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
    state.ducts.builds = ductLayer.builds;
    state.ducts.meshes = ductLayer.meshes;
    syncDuctView();
  }

  /**
   * Лінії трас поруч із повітропроводом: у режимі «Повітропровід» не малюємо лінію трас, що вже мають трубу
   * (номери лишаються; траса без труби — лінією); у панелі — решта трас приглушені, на вибраному
   * відрізку — кільце там, де стане перехід.
   */
  function syncDuctView(): void {
    const routes = state.routes.set.routes;
    const linesHidden = new Set(state.ducts.mode === 'duct' ? routes.filter((r) => r.duct).map((r) => r.id) : []);
    const selection = ductPanel.open ? ductPanel.selection : null;
    const focus = selection?.routeId ?? null;
    let marker: ReturnType<typeof toM> | null = null;
    const selected = selection && selection.segment !== null ? routes.find((r) => r.id === selection.routeId) : undefined;
    if (selected?.duct && selection && selection.segment !== null) {
      const seg = selection.segment;
      // Перехід стає на початку відрізка — одразу після коліна (або на самому початку траси).
      const elbow = ductLayout(selected.nodes, selected.duct).elbows.find((e) => e.node === seg);
      marker = toM(elbow ? elbow.end : selected.nodes[seg]!);
    }
    const key = JSON.stringify([focus, [...linesHidden], marker]);
    if (key === ductViewKey) return;
    ductViewKey = key;
    route.setDuctView({ focus, linesHidden, marker });
  }

  /** «Траса / Повітропровід / Обидва». */
  function applyViewMode(): void {
    ductLayer.setVisible(state.ducts.mode !== 'route');
    syncDuctView();
  }

  /** Увімкнути інструмент (решта вимикаються). */
  function applyTool(next: ToolName): void {
    const panelBefore = state.tool === 'duct' || state.tool === 'delete';
    const panelAfter = next === 'duct' || next === 'delete';
    if (!panelBefore && panelAfter) viewBeforePanel = viewer.snapshotView();
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
    // Закрили список трас чи панель «Повітропровід» — камера повертається туди, де була.
    if (panelBefore && !panelAfter && viewBeforePanel) viewer.restoreView(viewBeforePanel);
    if (!panelAfter) viewBeforePanel = null;
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
    prompt.element,
    fileMenu.element,
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
      // Траси попереднього скану — у його чернетку (повернуться, коли його відкриють знову).
      flushDraft();
      draftsPaused = true;
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
      // Траси нового скану: проєкт, вибраний разом зі сканом чи раніше, — або чернетка з минулого разу.
      lastDraftSet = route.state.set;
      draftsPaused = false;
      const opened = currentScan()!;
      if (pendingProject) {
        const project = pendingProject;
        pendingProject = null;
        state.project.pending = null;
        confirmProjectForScan(project, opened);
      } else {
        offerDraft(opened);
      }
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
      draftsPaused = false;
      progress.hide();
      toolbar.setBusy(false);
    }
  }

  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : [];
    // Скинути вибір, щоб той самий файл можна було відкрити ще раз.
    input.value = '';
    void openPicked(files);
  });

  // ───────────────────────── Проєкт (етап 6) ─────────────────────────

  function currentScan(): ScanFingerprint | null {
    return state.scanName && state.scanInfo ? scanFingerprint(state.scanName, state.scanInfo) : null;
  }

  /** Проєкт з того, що зараз на екрані: траси, скан, вигляд камери, режим показу. */
  function projectData(name: string): ProjectData {
    const view = viewer.snapshotView();
    return {
      name,
      savedAt: new Date().toISOString(),
      scan: currentScan(),
      set: route.state.set,
      view: { position: toMm(view.position), target: toMm(view.target), projection: viewer.projection },
      display: { mode: state.ducts.mode, transparency: state.ducts.transparency },
    };
  }

  /** Траси змінились — записати чернетку цього скану трохи згодом (не на кожен рух). */
  function scheduleDraft(): void {
    if (draftsPaused) return;
    const opened = currentScan();
    if (!opened) return;
    draftScan = opened;
    if (draftTimer) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(flushDraft, DRAFT_DELAY_MS);
  }

  /** Записати відкладену чернетку зараз (перед зміною скану, коли сторінку ховають). */
  function flushDraft(): void {
    if (!draftTimer) return;
    window.clearTimeout(draftTimer);
    draftTimer = 0;
    const opened = currentScan();
    const target = draftScan;
    draftScan = null;
    // Скан змінився, поки чекали, — ці траси вже не його.
    if (!target || !opened || !sameScan(target, opened)) return;
    drafts.save(projectData(state.project.name ?? 'Чернетка'));
  }
  // iOS може закрити сторінку без попередження — дописати чернетку, коли її ховають.
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });

  /** Відкрили той самий скан, що й колись, — запропонувати повернути траси з чернетки. */
  function offerDraft(opened: ScanFingerprint): void {
    const draft = drafts.get(opened);
    if (!draft) return;
    const count = formatRouteCount(draft.project.set.routes.length);
    choice.show('Повернути траси з минулого разу?', `${count} · ${formatWhen(draft.savedAt)}`, [
      { label: 'Почати заново', role: 'cancel', testid: 'choice-fresh' },
      { label: 'Повернути', testid: 'choice-restore', onSelect: () => applyProject(draft.project) },
    ]);
  }

  /** Показати проєкт: траси, повітропроводи, вигляд камери, режим показу. */
  function applyProject(project: ProjectData): void {
    applyTool('none');
    try {
      route.load(project.set);
    } catch (error) {
      console.error(error);
      alert.show('Не вдалося відкрити проєкт', 'Траси у файлі не за правилами.');
      return;
    }
    if (project.view) {
      if (project.view.projection !== viewer.projection) {
        viewer.setProjection(project.view.projection);
        state.projection = project.view.projection;
        viewBar.setProjection(project.view.projection);
      }
      viewer.setView(toM(project.view.position), toM(project.view.target));
    }
    if (project.display) {
      state.ducts.mode = project.display.mode;
      state.ducts.transparency = project.display.transparency;
      viewer.setScanTransparency(project.display.transparency);
      applyViewMode();
    }
    state.project.name = project.name;
    syncRouteUi();
  }

  /** «Відкрити скан або проєкт»: на екрані є траси — спершу питання (вони лишаться в чернетці). */
  function openPicker(): void {
    const building = route.state.building;
    const hasRoutes = route.state.set.routes.length > 0 || (building?.nodes.length ?? 0) > 0;
    if (!hasRoutes) {
      input.click();
      return;
    }
    const unfinished =
      building && building.nodes.length >= 2 ? ` Недобудовану трасу ${building.id} не буде збережено — спершу завершіть її.` : '';
    const kept = drafts.available
      ? 'Траси цього скану лишаться в чернетці — повернуться, коли відкриєте його знову.'
      : 'Траси цього скану зникнуть з екрана — спершу збережіть проєкт.';
    choice.show('Відкрити інший скан чи проєкт?', `${kept}${unfinished}`, [
      { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
      // «Файли» відкриваються прямо в обробнику натискання — інакше iOS їх не покаже.
      { label: 'Відкрити', testid: 'choice-open', onSelect: () => input.click() },
    ]);
  }

  /** Вибрали файли: проєкт (.json) і/або скан — разом або окремо. */
  async function openPicked(files: readonly File[]): Promise<void> {
    const projectFiles = files.filter((f) => looksLikeProjectFile(f.name));
    const scanFiles = files.filter((f) => !looksLikeProjectFile(f.name));
    let project: ProjectData | null = null;
    if (projectFiles.length > 0) {
      const parsed = parseProject(await projectFiles[0]!.text());
      if (parsed.ok) {
        project = parsed.project;
      } else {
        state.error = parsed.error;
        alert.show('Не вдалося відкрити проєкт', parsed.error);
        if (scanFiles.length === 0) return;
      }
    }
    if (scanFiles.length > 0) {
      // Скан і проєкт разом: проєкт застосуємо, щойно скан відкриється.
      if (project) {
        pendingProject = project;
        state.project.pending = project.name;
      }
      await openFiles(scanFiles);
      return;
    }
    if (project) offerProject(project);
  }

  /** Відкрили лише проєкт: скан відкрито — показати; ні — попросити відкрити його скан. */
  function offerProject(project: ProjectData): void {
    const opened = currentScan();
    if (opened) {
      confirmProjectForScan(project, opened);
      return;
    }
    pendingProject = project;
    state.project.pending = project.name;
    const scanName = project.scan?.name ? `«${project.scan.name}»` : 'цього проєкту';
    choice.show(
      `Проєкт «${project.name}»`,
      `${formatRouteCount(project.set.routes.length)}. Відкрийте скан ${scanName} — траси з'являться на ньому.`,
      [
        { label: 'Пізніше', role: 'cancel', testid: 'choice-later' },
        { label: 'Відкрити скан', testid: 'choice-open-scan', onSelect: () => input.click() },
      ],
    );
  }

  /** Скан відкрито: проєкт для іншого скану — попередження; на екрані вже є траси — питання. */
  function confirmProjectForScan(project: ProjectData, opened: ScanFingerprint): void {
    if (project.scan && !sameScan(project.scan, opened)) {
      choice.show(
        'Проєкт для іншого скану',
        `«${project.name}» зроблено для скану «${project.scan.name}». Траси можуть не збігатися зі стінами. Показати все одно?`,
        [
          { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
          { label: 'Показати', testid: 'choice-show', onSelect: () => replaceRoutesWith(project) },
        ],
      );
      return;
    }
    replaceRoutesWith(project);
  }

  function replaceRoutesWith(project: ProjectData): void {
    const building = route.state.building;
    const hasRoutes = route.state.set.routes.length > 0 || (building?.nodes.length ?? 0) > 0;
    if (!hasRoutes) {
      applyProject(project);
      return;
    }
    choice.show(
      'Замінити траси?',
      `Траси на екрані замінять трасами з проєкту «${project.name}» (${formatRouteCount(project.set.routes.length)}).`,
      [
        { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
        { label: 'Замінити', role: 'destructive', testid: 'choice-replace', onSelect: () => applyProject(project) },
      ],
    );
  }

  /** «Зберегти проєкт»: недобудована траса — спершу питання; далі назва й файл. */
  function startSave(): void {
    const building = route.state.building;
    if (scan && building && building.nodes.length >= 2) {
      choice.show(`Траса ${building.id} не завершена`, `У ній ${formatPointCount(building.nodes.length)}. Зберегти її в проєкт?`, [
        {
          label: 'Зберегти трасу',
          testid: 'choice-save',
          onSelect: () => {
            route.finish();
            askProjectName();
          },
        },
        { label: 'Без неї', testid: 'choice-without', onSelect: askProjectName },
        { label: 'Скасувати', role: 'cancel', testid: 'choice-cancel' },
      ]);
      return;
    }
    askProjectName();
  }

  function askProjectName(): void {
    const count = route.state.set.routes.length;
    if (!scan || count === 0) {
      alert.show('Ще нічого зберігати', 'Відкрийте скан і намалюйте хоча б одну трасу — тоді проєкт можна зберегти.');
      return;
    }
    prompt.show({
      title: 'Зберегти проєкт',
      message: `${formatRouteCount(count)} · скан «${state.scanName}». Сам скан у файл не потрапляє.`,
      value: state.project.name ?? defaultProjectName(state.scanName, new Date()),
      okLabel: 'Зберегти',
      onOk: saveProjectFile,
    });
  }

  /** Файл проєкту: «Поділитися» (там — «Зберегти у Файли», AirDrop…), а якщо його немає — «Завантаження». */
  function saveProjectFile(name: string): void {
    const text = serializeProject(projectData(name));
    state.project.name = name;
    const file = new File([text], projectFileName(name), { type: 'application/json' });
    const nav = navigator as Navigator & { canShare?(data: ShareData): boolean };
    if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
      // Ще в обробнику натискання «Зберегти» — інакше iOS не відкриє «Поділитися».
      nav.share({ files: [file], title: name }).catch((error: unknown) => {
        // Людина закрила «Поділитися» — нічого; інша помилка — зберігаємо в «Завантаження».
        if (!(error instanceof DOMException && error.name === 'AbortError')) download(file);
      });
      return;
    }
    download(file);
  }

  function download(file: File): void {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.hidden = true;
    root.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return {
    get state() {
      return state;
    },
    openFiles,
    loadRoutes: (set) => route.load(set),
    projectText: (name = 'Проєкт') => serializeProject(projectData(name)),
    ductBox: (routeId) => ductLayer.boxMm(routeId),
  };
}
