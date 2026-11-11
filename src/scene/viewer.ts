import {
  Box3,
  Color,
  GridHelper,
  Group,
  type Material,
  type Mesh,
  type Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
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

export interface ProjectedPath {
  nodes: Array<ScreenPoint & { visible: boolean }>;
  segments: Array<[ScreenPoint, ScreenPoint] | null>;
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
  /**
   * Полілінія (м) → екран за один раз (для трас на сотні точок): вузли й відрізки.
   * Відрізок, що заходить за камеру, обрізається площиною перед нею — без «стрибків» через увесь екран;
   * null — відрізок цілком за камерою.
   */
  projectPath(points: readonly Vec3Like[]): ProjectedPath;
  /**
   * Куди на екрані дивляться осі +X, +Y, +Z біля точки (вектори в CSS px; довжина — для 1/10
   * відстані до камери). Нульовий вектор — вісь за камерою. Для джойстика і стрілок осей.
   */
  screenAxes(point: Vec3Like): Record<'X' | 'Y' | 'Z', ScreenPoint>;
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
  /**
   * Вид уздовж осі: камера дивиться строго вздовж X (збоку), Y (згори) чи Z (спереду) —
   * перпендикулярно площині двох інших осей. Відстань до точки, на яку дивимось, та сама.
   * `around` — на що дивитись (наприклад, точка, яку доводять); інакше — поточний центр огляду.
   * `at` — де на екрані має опинитись `around` (CSS px), наприклад у вільній від панелей частині:
   * камера зсувається паралельно екрану, тож вид лишається строго вздовж осі.
   * Повторне натискання того самого виду — вид з протилежного боку.
   * Повертає, з якого боку тепер дивимось: +1 або −1.
   */
  viewAlong(axis: 'X' | 'Y' | 'Z', around?: Vec3Like, at?: ScreenPoint): 1 | -1;
  /** Викликається, коли людина сама почала рухати камеру (жест, колесо). Повертає відписку. */
  onUserCamera(callback: () => void): () => void;
  /**
   * Повернути камеру на місці так, щоб точка опинилась у центрі кадру або в заданому місці
   * екрана `at` (CSS px) — наприклад, у вільній від панелей частині. Камера не рухається.
   */
  centerOn(point: Vec3Like, at?: ScreenPoint): void;
  /**
   * Показати точки (м) цілком, не змінюючи напрямку погляду: камера наближається чи віддаляється
   * й зсувається паралельно екрану так, щоб усі точки вмістились у прямокутник `area` (CSS px) —
   * наприклад, у вільну від панелей частину екрана (інакше — у весь кадр).
   */
  fitPoints(points: readonly Vec3Like[], area?: { left: number; right: number; top: number; bottom: number }): void;
  /** Запам'ятати положення камери (наприклад, у момент натискання). */
  snapshotView(): ViewSnapshot;
  /** Повернути камеру в запам'ятоване положення й зупинити інерцію. */
  restoreView(snapshot: ViewSnapshot): void;
  /** Додати/прибрати допоміжний об'єкт (лінія рулетки тощо). */
  add(object: Object3D): void;
  remove(object: Object3D): void;
  /**
   * Освітлення для металевих (PBR) матеріалів — «кімната» RoomEnvironment. Вмикається один раз,
   * коли з'являється перший повітропровід; на скан (MeshBasicMaterial) не впливає.
   */
  enableMetalLighting(): void;
  /** Прозорість скану: 0 — непрозорий, 0,9 — майже прозорий (видно повітропровід крізь стіни). */
  setScanTransparency(transparency: number): void;
  /** Промінь з камери через екранну точку (CSS px): початок і одиничний напрямок, м. */
  screenRay(clientX: number, clientY: number): { origin: Vec3Like; direction: Vec3Like } | null;
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
    axes.setScreen(height, camera.fov);
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

  /** Межі скану рахуються один раз (за вершинами — точно) при заміні скану. */
  let cachedScanBox: Box3 | null = null;
  function scanBox(): Box3 | null {
    return cachedScanBox ? cachedScanBox.clone() : null;
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

  /** Освітлення металу (див. enableMetalLighting) і прозорість скану. */
  let environment: Texture | null = null;
  let scanTransparency = 0;
  /** Застосувати прозорість до всіх матеріалів скану (зокрема щойно відкритого). */
  function applyScanTransparency(): void {
    const opacity = 1 - scanTransparency;
    scanGroup.traverse((object) => {
      const material = (object as Mesh).material as Material | Material[] | undefined;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        const transparent = opacity < 1;
        if (m.transparent !== transparent) m.needsUpdate = true;
        m.transparent = transparent;
        m.opacity = opacity;
        // Напівпрозорий скан не закриває повітропровід у буфері глибини.
        m.depthWrite = !transparent;
      }
    });
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

  /** Зупинити інерцію камери одразу (без анімації залишку руху). */
  function flushInertia(): void {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
  }

  // Поки палець/мишка тримає сцену — це жест, а не інерція.
  let interacting = false;
  controls.addEventListener('start', () => {
    interacting = true;
  });
  controls.addEventListener('end', () => {
    interacting = false;
  });

  /**
   * Інерція згасає плавно, але її «хвіст» — десятки кадрів, де камера зсувається менше ніж на піксель.
   * Коли рух за кадр стає таким (кут < 3e-4 рад ≈ 0,3 px на iPad), зупиняємо інерцію одразу:
   * на око різниці немає, а відеокарта й батарея відпочивають. Інерція OrbitControls згасає
   * за кадрами, тож на повільних пристроях без цього вона тягнулася б секундами.
   */
  const INERTIA_STOP_STEP = 3e-4;
  const lastPosition = new Vector3();
  const lastQuaternion = new Quaternion();

  renderer.setAnimationLoop(() => {
    // update() повертає true, поки камера рухається (інерція після жесту).
    const moved = controls.update();
    if (moved && !interacting) {
      const turn = lastQuaternion.angleTo(camera.quaternion);
      const shift = lastPosition.distanceTo(camera.position) / Math.max(controls.getDistance(), 1e-3);
      if (Math.max(turn, shift) < INERTIA_STOP_STEP) flushInertia();
    }
    if (moved || needsRender) {
      needsRender = false;
      renderer.render(scene, camera);
      lastPosition.copy(camera.position);
      lastQuaternion.copy(camera.quaternion);
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

  function projectPath(points: readonly Vec3Like[]): ProjectedPath {
    const rect = canvas.getBoundingClientRect();
    // Трохи далі за найближчу площину камери, щоб точка на ній не «вилітала» в нескінченність.
    const clipZ = -camera.near * 1.01;
    const view = points.map((p) => new Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse));
    const toScreen = (v: Vector3): ScreenPoint => {
      const ndc = v.clone().applyMatrix4(camera.projectionMatrix);
      return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
    };
    const nodes = view.map((v) => ({ ...toScreen(v), visible: v.z < clipZ }));
    const segments: ProjectedPath['segments'] = [];
    for (let i = 1; i < view.length; i++) {
      let a = view[i - 1]!;
      let b = view[i]!;
      const aIn = a.z < clipZ;
      const bIn = b.z < clipZ;
      if (!aIn && !bIn) {
        segments.push(null);
        continue;
      }
      if (!aIn || !bIn) {
        const t = (clipZ - a.z) / (b.z - a.z);
        const cut = a.clone().lerp(b, t);
        if (aIn) b = cut;
        else a = cut;
      }
      segments.push([aIn ? nodes[i - 1]! : toScreen(a), bIn ? nodes[i]! : toScreen(b)]);
    }
    return { nodes, segments };
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
    projectPath,
    screenAxes(point) {
      const base = new Vector3(point.x, point.y, point.z);
      const length = Math.max(camera.position.distanceTo(base) * 0.1, 0.001);
      const origin = projectPoint(base);
      const along = (dx: number, dy: number, dz: number): ScreenPoint => {
        const tip = projectPoint({ x: base.x + dx * length, y: base.y + dy * length, z: base.z + dz * length });
        return tip.visible && origin.visible ? { x: tip.x - origin.x, y: tip.y - origin.y } : { x: 0, y: 0 };
      };
      return { X: along(1, 0, 0), Y: along(0, 1, 0), Z: along(0, 0, 1) };
    },
    setScan(root) {
      scanGroup.clear();
      cachedScanBox = null;
      if (root) {
        scanGroup.add(root);
        applyScanTransparency();
        scanGroup.updateMatrixWorld(true);
        const box = new Box3().setFromObject(scanGroup, true);
        cachedScanBox = box.isEmpty() ? null : box;
      }
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
    fitPoints(points, area) {
      if (points.length === 0) return;
      flushInertia();
      const box = new Box3().setFromPoints(points.map((p) => new Vector3(p.x, p.y, p.z)));
      const sphere = box.getBoundingSphere(new Sphere());
      // Коротку трасу не наближаємо впритул: принаймні коло радіусом 0,3 м.
      const radius = Math.max(sphere.radius, 0.3);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const a = area ?? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      const tanV = Math.tan((camera.fov * Math.PI) / 360);
      const tanH = tanV * camera.aspect;
      // Півкут, під яким видно прямокутник `area` (якби він був по центру кадру).
      const half = Math.min(
        Math.atan(tanV * Math.max(0.05, (a.bottom - a.top) / height)),
        Math.atan(tanH * Math.max(0.05, (a.right - a.left) / width)),
      );
      const distance = (radius / Math.sin(half)) * 1.1;
      let dir = camera.position.clone().sub(controls.target).normalize();
      if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir = VIEW_DIRECTION.clone();
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).addScaledVector(dir, distance);
      camera.far = Math.max(camera.far, (distance + radius) * 4);
      camera.updateProjectionMatrix();
      controls.maxDistance = Math.max(controls.maxDistance, distance * 2);
      camera.lookAt(sphere.center);
      // Паралельний зсув: центр точок — у центр прямокутника `area`.
      const metresPerPx = (2 * distance * tanV) / height;
      const dx = ((a.left + a.right) / 2 - (rect.left + width / 2)) * metresPerPx;
      const dy = ((a.top + a.bottom) / 2 - (rect.top + height / 2)) * metresPerPx;
      camera.updateMatrixWorld();
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      const shift = right.multiplyScalar(-dx).add(up.multiplyScalar(dy));
      camera.position.add(shift);
      controls.target.add(shift);
      controls.update();
      requestRender();
    },
    snapshotView() {
      return { position: camera.position.clone(), target: controls.target.clone() };
    },
    restoreView(snapshot) {
      // Спершу «доїсти» залишок інерції без анімації, потім повернути камеру.
      flushInertia();
      controls.target.copy(snapshot.target);
      camera.position.copy(snapshot.position);
      camera.lookAt(controls.target);
      controls.update();
      requestRender();
    },
    centerOn(point, at) {
      // Камера лишається на місці й лише повертається («як голова») — так вона ніколи не пройде
      // крізь підлогу чи стіну, на відміну від зсуву.
      flushInertia();
      const p = new Vector3(point.x, point.y, point.z);
      const distance = Math.max(camera.position.distanceTo(p), 0.01);
      camera.lookAt(p);
      if (at) {
        const rect = canvas.getBoundingClientRect();
        const nx = (at.x - (rect.left + rect.width / 2)) / (rect.width / 2);
        const ny = -(at.y - (rect.top + rect.height / 2)) / (rect.height / 2);
        const tanV = Math.tan((camera.fov * Math.PI) / 360);
        const tanH = tanV * camera.aspect;
        // Щоб точка опинилась праворуч від центру — камера повертається вліво (навколо вертикалі),
        // щоб вище центру — нахиляється вниз (навколо своєї горизонтальної осі).
        camera.rotateOnWorldAxis(new Vector3(0, 1, 0), Math.atan(nx * tanH));
        camera.rotateX(-Math.atan(ny * tanV));
      }
      camera.updateMatrixWorld();
      const forward = new Vector3();
      camera.getWorldDirection(forward);
      controls.target.copy(camera.position).addScaledVector(forward, distance);
      controls.update();
      requestRender();
    },
    viewAlong(axis, around, at) {
      flushInertia();
      const target = around ? new Vector3(around.x, around.y, around.z) : controls.target.clone();
      const offset = camera.position.clone().sub(controls.target);
      const distance = Math.max(offset.length(), controls.minDistance * 2, 0.5);
      const index = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
      const along = offset.getComponent(index) / offset.length();
      // Уже дивимось уздовж цієї осі — показуємо протилежний бік; інакше — найближчий бік.
      // Для Y (згори) типовий бік — згори (+Y).
      const aligned = Math.abs(along) > 0.999;
      let side: 1 | -1 = along >= 0 ? 1 : -1;
      if (axis === 'Y' && !aligned) side = 1;
      if (aligned) side = side === 1 ? -1 : 1;
      const direction = new Vector3();
      direction.setComponent(index, side);
      if (axis === 'Y') {
        // Строго згори камера «не знає», де верх екрана, — трохи зсуваємо, щоб на екрані
        // −Z було вгорі, а +X — праворуч (як план на папері).
        direction.z += side * 1e-4;
        direction.normalize();
      }
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
      if (at) {
        // Паралельний зсув камери й цілі: напрямок погляду не змінюється.
        const rect = canvas.getBoundingClientRect();
        const metresPerPx = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, rect.height);
        const dx = (at.x - (rect.left + rect.width / 2)) * metresPerPx;
        const dy = (at.y - (rect.top + rect.height / 2)) * metresPerPx;
        camera.updateMatrixWorld();
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const shift = right.multiplyScalar(-dx).add(up.multiplyScalar(dy));
        camera.position.add(shift);
        controls.target.add(shift);
      }
      controls.update();
      requestRender();
      return side;
    },
    onUserCamera(callback) {
      controls.addEventListener('start', callback);
      return () => controls.removeEventListener('start', callback);
    },
    setView(position, target) {
      controls.target.set(target.x, target.y, target.z);
      camera.position.set(position.x, position.y, position.z);
      camera.lookAt(controls.target);
      controls.update();
      requestRender();
    },
    enableMetalLighting() {
      if (environment) return;
      const pmrem = new PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      environment = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
      scene.environment = environment;
      requestRender();
    },
    setScanTransparency(transparency) {
      const t = Math.min(0.9, Math.max(0, Number.isFinite(transparency) ? transparency : 0));
      scanTransparency = t;
      applyScanTransparency();
      requestRender();
    },
    screenRay(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(pointer, camera);
      const { origin, direction } = raycaster.ray;
      return { origin: { x: origin.x, y: origin.y, z: origin.z }, direction: { x: direction.x, y: direction.y, z: direction.z } };
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
      environment?.dispose();
      scene.environment = null;
      scene.clear();
      renderer.dispose();
      canvas.remove();
    },
  };
}
