/**
 * Збирає інтерфейс етапу 1: відкриття скану, «Показати все», інформація про скан, рулетка.
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
import { GRID_CELL_MM, type Viewer } from '../scene/viewer';
import { createAlert, createProgress } from './dialogs';
import { createLegend, createTitle } from './hud';
import { createRuler, type RulerState } from './ruler';
import { createToolbar } from './toolbar';

export interface AppState {
  /** idle — нічого не відкрито; loading — відкривається; ready — скан показано. */
  status: 'idle' | 'loading' | 'ready';
  scanName: string | null;
  scanInfo: ScanInfo | null;
  ruler: RulerState;
  /** Остання помилка відкриття (для тестів). */
  error: string | null;
}

export interface App {
  readonly state: AppState;
  /** Відкрити скан із файлів (так само, як після вибору в «Файлах»). */
  openFiles(files: readonly ScanFile[]): Promise<void>;
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
  const state: AppState = { status: 'idle', scanName: null, scanInfo: null, ruler: { active: false, points: [], distanceMm: null }, error: null };

  // Вибір файлу. Без жорсткого accept: на iOS він може зробити .glb/.gltf/.zip неактивними —
  // тип перевіряємо після вибору (scan-loader).
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.dataset.testid = 'file-input';

  const title = createTitle();
  const legend = createLegend(GRID_CELL_MM);
  const progress = createProgress();
  const alert = createAlert();

  const ruler = createRuler(viewer, {
    onChange: (rulerState) => {
      state.ruler = rulerState;
    },
    onDone: () => setRuler(false),
  });

  const toolbar = createToolbar({
    onOpen: () => input.click(),
    onShowAll: () => viewer.showAll('current'),
    onRuler: () => {
      setRuler(!ruler.state.active);
    },
  });

  function setRuler(active: boolean): void {
    ruler.setActive(active);
    toolbar.setRulerActive(active);
    root.classList.toggle('is-ruler', active);
  }

  root.append(ruler.overlay, title.element, toolbar.element, ruler.panel, legend, progress.element, alert.element, input);

  async function openFiles(files: readonly ScanFile[]): Promise<void> {
    if (files.length === 0 || state.status === 'loading') return;
    const previousStatus = state.status;
    state.status = 'loading';
    state.error = null;
    toolbar.setBusy(true);
    setRuler(false);
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

      // 2. Звільняємо пам'ять від попереднього скану — два великі скани одночасно
      //    можуть не вміститися в пам'ять iPhone.
      if (scan) {
        viewer.setScan(null);
        scan.dispose();
        scan = null;
        closedPrevious = true;
      }
      state.scanName = null;
      state.scanInfo = null;
      title.showScan(null, null);
      toolbar.setScanLoaded(false);

      // 3. Будуємо 3D.
      const loaded = await buildScan(prepared, { maxTextureSide: MAX_TEXTURE_SIDE[device], onPhase: showPhase });
      scan = loaded;
      viewer.setScan(loaded.root);
      viewer.showAll('default');
      const info = describeScan(loaded.stats, device);
      state.scanName = loaded.name;
      state.scanInfo = info;
      state.status = 'ready';
      title.showScan(loaded.name, info);
      toolbar.setScanLoaded(true);
    } catch (error) {
      console.error(error);
      if (closedPrevious || !scan) state.status = 'idle';
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
  };
}
