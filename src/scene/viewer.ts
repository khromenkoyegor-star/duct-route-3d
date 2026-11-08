import {
  Box3,
  Color,
  GridHelper,
  Group,
  type Material,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
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

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ViewSnapshot {
  position: Vector3;
  target: Vector3;
}

export interface Viewer {
  readonly canvas: HTMLCanvasElement;
  /** Перемалювати кадр (сцена малюється лише тоді, коли щось змінилось). */
  requestRender(): void;
  /** Поставити камеру в початкове положення. */
  resetView(): void;
  /** Екранні координати (CSS px) початку координат і підписів осей — для тестів. */
  projectAxes(): Record<'origin' | AxisName, ScreenPoint>;
  /** Точка сцени (м) → екран (CSS px); visible = перед камерою. */
  projectPoint(point: Vec3Like): ScreenPoint & { visible: boolean };
  /** Показати скан (null — прибрати). Звільнення пам'яті — справа того, хто завантажив. */
  setScan(root: Object3D | null): void;
  /** Межі скану в метрах або null, якщо скану немає. */
  scanBox(): Box3 | null;
  /** «Показати все»: камера охоплює весь скан (або стартовий вигляд, якщо скану немає). */
  showAll(direction?: 'default' | 'current'): void;
  /** Перша точка поверхні скану під екранною точкою (CSS px) або null. */
  raycastScan(clientX: number, clientY: number): Vector3 | null;
  /** Поставити камеру: звідки й куди дивитися (м). */
  setView(position: Vec3Like, target: Vec3Like): void;
  /** Запам'ятати положення камери (наприклад, у момент натискання). */
  snapshotView(): ViewSnapshot;
  /** Повернути камеру в запам'ятоване положення й зупинити інерцію. */
  restoreView(snapshot: ViewSnapshot): void;
  /** Додати/прибрати допоміжний об'єкт (лінія рулетки тощо). */
  add(object: Object3D): void;
  remove(object: Object3D): void;
  /** Викликається після кожного намальованого кадру. Повертає функцію відписки. */
  onFrame(callback: () => void): () => void;
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

  // Скан — окремою групою: його не масштабуємо й не рухаємо.
  const scanGroup = new Group();
  scanGroup.name = 'scan-group';
  scene.add(scanGroup);

  // Камера: мишка — ліва кнопка обертає, права зсуває, колесо наближає до курсора;
  // дотик — один палець обертає, два зсувають і наближають щипком (налаштування OrbitControls).
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.05;
  controls.maxDistance = 200;
  controls.target.copy(VIEW_TARGET);

  let needsRender = true;
  let frameCount = 0;
  const frameCallbacks = new Set<() => void>();
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

  function scanBox(): Box3 | null {
    if (scanGroup.children.length === 0) return null;
    scanGroup.updateMatrixWorld(true);
    const box = new Box3().setFromObject(scanGroup);
    return box.isEmpty() ? null : box;
  }

  function showAll(direction: 'default' | 'current' = 'current'): void {
    const box = scanBox();
    if (!box) {
      resetView();
      return;
    }
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.05);
    const dir =
      direction === 'default'
        ? VIEW_DIRECTION.clone()
        : camera.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.copy(VIEW_DIRECTION);
    const distance = (radius / Math.sin(fitAngle() / 2)) * 1.02;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(dir, distance);
    // Дальність видимості й межа віддалення — під розмір скану.
    camera.far = Math.max(1000, (distance + radius) * 4);
    camera.updateProjectionMatrix();
    controls.maxDistance = Math.max(200, distance * 5);
    camera.lookAt(sphere.center);
    controls.update();
    requestRender();
  }

  const raycaster = new Raycaster();
  const pointer = new Vector2();

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
      for (const callback of frameCallbacks) callback();
    }
  });

  function projectPoint(point: Vec3Like): ScreenPoint & { visible: boolean } {
    const rect = canvas.getBoundingClientRect();
    const world = new Vector3(point.x, point.y, point.z);
    const visible = world.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
    const ndc = world.project(camera);
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      visible,
    };
  }

  return {
    canvas,
    requestRender,
    resetView,
    get frameCount() {
      return frameCount;
    },
    projectAxes() {
      const toScreen = (world: Vector3): ScreenPoint => {
        const { x, y } = projectPoint(world);
        return { x, y };
      };
      return {
        origin: toScreen(new Vector3(0, 0, 0)),
        X: toScreen(axes.labelPosition('X')),
        Y: toScreen(axes.labelPosition('Y')),
        Z: toScreen(axes.labelPosition('Z')),
      };
    },
    projectPoint,
    setScan(root) {
      scanGroup.clear();
      if (root) scanGroup.add(root);
      requestRender();
    },
    scanBox,
    showAll,
    raycastScan(clientX, clientY) {
      if (scanGroup.children.length === 0) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(scanGroup, true)[0];
      return hit ? hit.point.clone() : null;
    },
    snapshotView() {
      return { position: camera.position.clone(), target: controls.target.clone() };
    },
    restoreView(snapshot) {
      // Спершу «доїсти» залишок інерції без анімації, потім повернути камеру.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      controls.target.copy(snapshot.target);
      camera.position.copy(snapshot.position);
      camera.lookAt(controls.target);
      controls.update();
      requestRender();
    },
    setView(position, target) {
      controls.target.set(target.x, target.y, target.z);
      camera.position.set(position.x, position.y, position.z);
      camera.lookAt(controls.target);
      controls.update();
      requestRender();
    },
    add(object) {
      scene.add(object);
      requestRender();
    },
    remove(object) {
      scene.remove(object);
      requestRender();
    },
    onFrame(callback) {
      frameCallbacks.add(callback);
      return () => frameCallbacks.delete(callback);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      frameCallbacks.clear();
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
