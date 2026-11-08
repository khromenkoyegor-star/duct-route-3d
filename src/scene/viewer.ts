import {
  Color,
  GridHelper,
  type Material,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mmToM } from '../core/units';
import { type AxisName, createAxes } from './axes';
import { currentTheme, type SceneTheme, watchTheme } from './theme';

/** Сітка підлоги: 10 × 10 м, клітинка 1 м. */
export const GRID_SIZE_MM = 10_000;
export const GRID_CELL_MM = 1_000;

/** Найбільша щільність пікселів: на iPhone (×3) економимо пам'ять і батарею. */
const MAX_PIXEL_RATIO = 2;

/** Куди дивиться камера на старті (м) і з якого боку. */
const VIEW_TARGET = new Vector3(0, 0.4, 0);
const VIEW_DIRECTION = new Vector3(1, 0.75, 1.35).normalize();
/** Радіус ділянки, яка має вміститися в кадр на старті (м). */
const VIEW_RADIUS = 3.2;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Viewer {
  readonly canvas: HTMLCanvasElement;
  /** Перемалювати кадр (сцена малюється лише тоді, коли щось змінилось). */
  requestRender(): void;
  /** Поставити камеру в початкове положення. */
  resetView(): void;
  /** Екранні координати (CSS px) початку координат і підписів осей — для тестів. */
  projectAxes(): Record<'origin' | AxisName, ScreenPoint>;
  /** Скільки кадрів намальовано — для тестів. */
  readonly frameCount: number;
  dispose(): void;
}

function disposeGrid(grid: GridHelper): void {
  grid.geometry.dispose();
  const materials: Material[] = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of materials) material.dispose();
}

function makeGrid(theme: SceneTheme): GridHelper {
  const size = mmToM(GRID_SIZE_MM);
  const divisions = Math.round(GRID_SIZE_MM / GRID_CELL_MM);
  // GridHelper лежить у площині XZ (підлога), Y = 0.
  const grid = new GridHelper(size, divisions, theme.gridCenter, theme.grid);
  grid.name = 'floor-grid';
  return grid;
}

export function createViewer(container: HTMLElement): Viewer {
  let theme = currentTheme();

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  const canvas = renderer.domElement;
  canvas.className = 'viewport';
  canvas.setAttribute('aria-label', '3D-сцена');
  container.appendChild(canvas);

  const scene = new Scene();
  scene.background = new Color(theme.background);

  const camera = new PerspectiveCamera(50, 1, 0.01, 1000);
  camera.up.set(0, 1, 0); // вертикаль — Y

  let grid = makeGrid(theme);
  scene.add(grid);

  const axes = createAxes(theme);
  scene.add(axes.group);

  // Базове обертання камери (повне налаштування керування — етап 1).
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.2;
  controls.maxDistance = 200;
  controls.target.copy(VIEW_TARGET);

  let needsRender = true;
  let frameCount = 0;
  const requestRender = () => {
    needsRender = true;
  };
  controls.addEventListener('change', requestRender);

  /** Кут огляду по меншій стороні кадру (рад): по висоті — горизонтально, по ширині — вертикально. */
  function fitAngle(): number {
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    return Math.min(vFov, hFov);
  }

  function resetView(): void {
    // Відстань, з якої коло радіуса VIEW_RADIUS вміщується і по висоті, і по ширині кадру.
    const distance = VIEW_RADIUS / Math.sin(fitAngle() / 2);
    controls.target.copy(VIEW_TARGET);
    camera.position.copy(VIEW_TARGET).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(VIEW_TARGET);
    controls.update();
    requestRender();
  }

  let lastWidth = 0;
  let lastHeight = 0;
  function resize(): void {
    const width = Math.max(1, Math.round(container.clientWidth));
    const height = Math.max(1, Math.round(container.clientHeight));
    if (width === lastWidth && height === lastHeight) return;
    const firstLayout = lastWidth === 0;
    lastWidth = width;
    lastHeight = height;
    const angleBefore = fitAngle();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (firstLayout) {
      resetView();
    } else {
      // Поворот пристрою / зміна вікна: зберігаємо видимий масштаб по меншій стороні кадру,
      // інакше сцена «стрибає» приблизно вдвічі. Напрямок погляду не змінюється.
      const scale = Math.sin(angleBefore / 2) / Math.sin(fitAngle() / 2);
      camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
      controls.update();
    }
    requestRender();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const stopWatchingTheme = watchTheme((next) => {
    theme = next;
    (scene.background as Color).setHex(theme.background);
    scene.remove(grid);
    disposeGrid(grid);
    grid = makeGrid(theme);
    scene.add(grid);
    axes.setTheme(theme);
    requestRender();
  });

  renderer.setAnimationLoop(() => {
    // update() повертає true, поки камера рухається (інерція після жесту).
    const moved = controls.update();
    if (moved || needsRender) {
      needsRender = false;
      renderer.render(scene, camera);
      frameCount += 1;
    }
  });

  return {
    canvas,
    requestRender,
    resetView,
    get frameCount() {
      return frameCount;
    },
    projectAxes() {
      const rect = canvas.getBoundingClientRect();
      const toScreen = (world: Vector3): ScreenPoint => {
        const ndc = world.clone().project(camera);
        return {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
      };
      return {
        origin: toScreen(new Vector3(0, 0, 0)),
        X: toScreen(axes.labelPosition('X')),
        Y: toScreen(axes.labelPosition('Y')),
        Z: toScreen(axes.labelPosition('Z')),
      };
    },
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      stopWatchingTheme();
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      disposeGrid(grid);
      axes.dispose();
      scene.clear();
      renderer.dispose();
      canvas.remove();
    },
  };
}
