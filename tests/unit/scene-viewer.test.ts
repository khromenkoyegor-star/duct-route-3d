/**
 * 3D-сцена (src/scene/viewer.ts) без браузера: WebGL підмінено «порожнім» рендерером,
 * DOM — мінімальними заглушками. Перевіряємо дані сцени, а не пікселі:
 *   - сітка підлоги 10 × 10 м у площині XZ на Y = 0, клітинка 1000 мм;
 *   - вертикаль — Y, масштаб сцени 1 : 1 (нічого не масштабовано й не повернуто);
 *   - малювання тільки при змінах;
 *   - зміна розміру / орієнтації екрана;
 *   - перемикання теми й dispose() без витоку пам'яті.
 */
import {
  Box3,
  type BufferGeometry,
  type Camera,
  type Color,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  Vector3,
} from 'three';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  /** Елемент-заглушка з підрахунком слухачів подій. */
  class FakeElement extends EventTarget {
    listeners = new Map<string, number>();
    style: Record<string, string> = {};
    className = '';
    attributes: Record<string, string> = {};
    parent: FakeContainer | null = null;
    clientWidth = 0;
    clientHeight = 0;
    ownerDocument: FakeElement | null = null;
    override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: unknown) {
      this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
      super.addEventListener(type, cb, opts as AddEventListenerOptions);
    }
    override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: unknown) {
      this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 0) - 1));
      super.removeEventListener(type, cb, opts as EventListenerOptions);
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
    getBoundingClientRect() {
      const w = this.parent?.clientWidth ?? 0;
      const h = this.parent?.clientHeight ?? 0;
      return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 };
    }
    setPointerCapture() {}
    releasePointerCapture() {}
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      }
    }
  }

  class FakeContainer extends FakeElement {
    children: FakeElement[] = [];
    appendChild(child: FakeElement) {
      child.parent = this;
      this.children.push(child);
      return child;
    }
  }

  const ownerDocument = new FakeElement();

  interface RenderCall {
    scene: unknown;
    camera: unknown;
  }

  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    domElement = new FakeElement();
    pixelRatio = 1;
    size: [number, number] | null = null;
    loop: (() => void) | null = null;
    loopHistory: Array<(() => void) | null> = [];
    renders: RenderCall[] = [];
    disposed = false;
    constructor() {
      this.domElement.ownerDocument = ownerDocument;
      FakeRenderer.instances.push(this);
    }
    setPixelRatio(ratio: number) {
      this.pixelRatio = ratio;
    }
    getPixelRatio() {
      return this.pixelRatio;
    }
    setSize(width: number, height: number) {
      this.size = [width, height];
    }
    setAnimationLoop(cb: (() => void) | null) {
      this.loop = cb;
      this.loopHistory.push(cb);
    }
    render(scene: unknown, camera: unknown) {
      this.renders.push({ scene, camera });
    }
    dispose() {
      this.disposed = true;
    }
  }

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: unknown[] = [];
    disconnected = false;
    constructor(public callback: () => void) {
      FakeResizeObserver.instances.push(this);
    }
    observe(target: unknown) {
      this.observed.push(target);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  /** Системна тема: можна «перемкнути» з тесту. */
  const media = {
    matches: false,
    listeners: new Set<() => void>(),
    addEventListener(_type: string, cb: () => void) {
      this.listeners.add(cb);
    },
    removeEventListener(_type: string, cb: () => void) {
      this.listeners.delete(cb);
    },
    set(dark: boolean) {
      this.matches = dark;
      for (const cb of [...this.listeners]) cb();
    },
  };

  return { FakeElement, FakeContainer, FakeRenderer, FakeResizeObserver, media, ownerDocument };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: fake.FakeRenderer };
});

type ViewerModule = typeof import('../../src/scene/viewer.ts');
type ThemeModule = typeof import('../../src/scene/theme.ts');
type FakeRendererT = InstanceType<typeof fake.FakeRenderer>;
type FakeContainerT = InstanceType<typeof fake.FakeContainer>;

let createViewer: ViewerModule['createViewer'];
let LIGHT_THEME: ThemeModule['LIGHT_THEME'];
let DARK_THEME: ThemeModule['DARK_THEME'];

/** Допуск координат: ±0,1 мм = 0,0001 м. */
const TOL_M = 0.0001;

beforeAll(async () => {
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
  vi.stubGlobal('ResizeObserver', fake.FakeResizeObserver);
  vi.stubGlobal('matchMedia', () => fake.media);
  // theme.ts читає matchMedia під час імпорту — тому імпорт після заглушок.
  ({ createViewer } = await import('../../src/scene/viewer.ts'));
  ({ LIGHT_THEME, DARK_THEME } = await import('../../src/scene/theme.ts'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fake.media.matches = false;
});

interface Setup {
  container: FakeContainerT;
  renderer: FakeRendererT;
  viewer: ReturnType<ViewerModule['createViewer']>;
  observer: InstanceType<typeof fake.FakeResizeObserver>;
  /** Один кадр циклу анімації. */
  tick(times?: number): void;
  scene(): Scene;
  camera(): PerspectiveCamera;
}

function setup(width = 1180, height = 820): Setup {
  const container = new fake.FakeContainer();
  container.clientWidth = width;
  container.clientHeight = height;
  const viewer = createViewer(container as unknown as HTMLElement);
  const renderer = fake.FakeRenderer.instances.at(-1)!;
  const observer = fake.FakeResizeObserver.instances.at(-1)!;
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) renderer.loop?.();
  };
  // Перший кадр — щоб отримати сцену й камеру.
  tick();
  return {
    container,
    renderer,
    viewer,
    observer,
    tick,
    scene: () => renderer.renders.at(-1)!.scene as Scene,
    camera: () => renderer.renders.at(-1)!.camera as PerspectiveCamera,
  };
}

function gridOf(scene: Scene): Object3D & { geometry: BufferGeometry; material: Material } {
  const grids: Object3D[] = [];
  scene.traverse((o) => {
    if ((o as { type?: string }).type === 'GridHelper') grids.push(o);
  });
  expect(grids.length, 'у сцені рівно одна сітка підлоги').toBe(1);
  return grids[0] as Object3D & { geometry: BufferGeometry; material: Material };
}

/** Чи видно точку світу в кадрі (NDC у межах −1…1 і перед камерою). */
function inFrame(camera: Camera, world: Vector3): boolean {
  const ndc = world.clone().project(camera);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1;
}

describe('сцена: сітка підлоги', () => {
  it('10 × 10 м у площині XZ, на висоті Y = 0', () => {
    const s = setup();
    const grid = gridOf(s.scene());
    grid.updateMatrixWorld(true);
    const box = new Box3().setFromObject(grid);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(0, 6);
    expect(box.min.x).toBeCloseTo(-5, 4);
    expect(box.max.x).toBeCloseTo(5, 4);
    expect(box.min.z).toBeCloseTo(-5, 4);
    expect(box.max.z).toBeCloseTo(5, 4);
    s.viewer.dispose();
  });

  it('клітинка рівно 1000 мм: лінії через кожен метр від −5 до +5 по X і по Z', () => {
    const s = setup();
    const grid = gridOf(s.scene());
    const pos = grid.geometry.getAttribute('position');
    const linesAlongZ = new Set<number>(); // x = const
    const linesAlongX = new Set<number>(); // z = const
    for (let i = 0; i < pos.count; i += 2) {
      const a = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(grid.matrixWorld);
      const b = new Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(grid.matrixWorld);
      expect(Math.abs(a.y) + Math.abs(b.y)).toBeLessThan(TOL_M);
      if (Math.abs(a.x - b.x) < TOL_M) linesAlongZ.add(Math.round(a.x * 10_000) / 10_000);
      else if (Math.abs(a.z - b.z) < TOL_M) linesAlongX.add(Math.round(a.z * 10_000) / 10_000);
      else throw new Error('лінія сітки не паралельна ні X, ні Z');
    }
    const expected = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    expect([...linesAlongZ].sort((p, q) => p - q)).toEqual(expected);
    expect([...linesAlongX].sort((p, q) => p - q)).toEqual(expected);
    s.viewer.dispose();
  });
});

describe('сцена: осі й масштаб', () => {
  it('сцена не масштабована й не повернута (1 одиниця = 1 м, вертикаль — Y)', () => {
    const s = setup();
    const scene = s.scene();
    expect(scene.scale.toArray()).toEqual([1, 1, 1]);
    expect(scene.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(scene.position.toArray()).toEqual([0, 0, 0]);
    const grid = gridOf(scene);
    expect(grid.scale.toArray()).toEqual([1, 1, 1]);
    expect(grid.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(scene.getObjectByName('axes'), 'осі в сцені').toBeTruthy();
    s.viewer.dispose();
  });

  it('камера: «верх» — +Y, дивиться згори-збоку', () => {
    const s = setup();
    const camera = s.camera();
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(camera.position.y).toBeGreaterThan(0);
    // Екранна вертикаль = світова вертикаль: проєкція точки (0, 1, 0) — над (0, 0, 0) і на тій самій вертикалі.
    camera.updateMatrixWorld(true);
    const o = new Vector3(0, 0, 0).project(camera);
    const y = new Vector3(0, 1, 0).project(camera);
    expect(y.y).toBeGreaterThan(o.y);
    expect(Math.abs(y.x - o.x)).toBeLessThan(1e-6);
    s.viewer.dispose();
  });

  it('projectAxes(): Y-підпис над початком координат', () => {
    const s = setup();
    const p = s.viewer.projectAxes();
    expect(p.Y.y).toBeLessThan(p.origin.y);
    expect(Math.abs(p.Y.x - p.origin.x)).toBeLessThan(0.5);
    s.viewer.dispose();
  });

  it('projectPath(): вузли як у projectPoint; відрізок за камеру обрізається, цілком позаду — null', () => {
    const s = setup();
    // Камера в (0; 1; 5) дивиться на −Z.
    s.viewer.setView({ x: 0, y: 1, z: 5 }, { x: 0, y: 1, z: 0 });
    s.tick();
    const path = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 1, z: 10 }, // за камерою
      { x: 1, y: 1, z: 12 }, // теж за камерою
    ];
    const projected = s.viewer.projectPath(path);
    expect(projected.nodes).toHaveLength(4);
    for (let i = 0; i < path.length; i++) {
      const single = s.viewer.projectPoint(path[i]!);
      expect(projected.nodes[i]!.visible).toBe(single.visible);
      if (single.visible) {
        expect(projected.nodes[i]!.x).toBeCloseTo(single.x, 6);
        expect(projected.nodes[i]!.y).toBeCloseTo(single.y, 6);
      }
    }
    expect(projected.segments).toHaveLength(3);
    expect(projected.segments[0]).not.toBeNull();
    // Другий відрізок обрізано: кінець — скінченна точка на екрані, праворуч від початку.
    const [a, b] = projected.segments[1]!;
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
    expect(b.x).toBeGreaterThan(a.x);
    expect(projected.segments[2]).toBeNull();
    s.viewer.dispose();
  });

  it('fitPoints(): усі точки — у заданій частині екрана, напрямок погляду той самий', () => {
    const s = setup();
    s.viewer.setView({ x: 3, y: 4, z: 6 }, { x: 0, y: 1, z: 0 });
    s.tick();
    const before = s.viewer.snapshotView();
    const dirBefore = before.position.clone().sub(before.target).normalize();
    const points = [
      { x: -2, y: 2.4, z: -1.3 },
      { x: 0.8, y: 2.4, z: -1.3 },
      { x: 0.8, y: 2.4, z: 0.6 },
      { x: 0.8, y: 0.5, z: 0.6 },
    ];
    // Ліва половина екрана під верхньою смугою (праву займає панель).
    const area = { left: 0, right: 590, top: 60, bottom: 820 };
    s.viewer.fitPoints(points, area);
    s.tick();
    for (const p of points) {
      const sp = s.viewer.projectPoint(p);
      expect(sp.visible).toBe(true);
      expect(sp.x).toBeGreaterThan(area.left);
      expect(sp.x).toBeLessThan(area.right);
      expect(sp.y).toBeGreaterThan(area.top);
      expect(sp.y).toBeLessThan(area.bottom);
    }
    const after = s.viewer.snapshotView();
    const dirAfter = after.position.clone().sub(after.target).normalize();
    expect(dirAfter.dot(dirBefore)).toBeGreaterThan(0.9999);
    s.viewer.dispose();
  });
});

describe('сцена: малювання тільки при змінах', () => {
  it('перший кадр малюється, далі в спокої — ні', () => {
    const s = setup();
    expect(s.renderer.renders.length).toBe(1);
    s.tick(120); // ~2 секунди при 60 кадр/с
    expect(s.renderer.renders.length).toBe(1);
    s.viewer.dispose();
  });

  it('requestRender() → рівно один новий кадр', () => {
    const s = setup();
    s.viewer.requestRender();
    s.tick(10);
    expect(s.renderer.renders.length).toBe(2);
    expect(s.viewer.frameCount).toBe(2);
    s.viewer.dispose();
  });

  it('resetView() перемальовує кадр і повертає камеру на старт', () => {
    const s = setup();
    const start = s.camera().position.clone();
    s.camera().position.set(10, 10, 10);
    s.viewer.resetView();
    s.tick();
    expect(s.renderer.renders.length).toBe(2);
    expect(s.camera().position.distanceTo(start)).toBeLessThan(TOL_M);
    s.viewer.dispose();
  });
});

describe('сцена: розмір екрана й поворот пристрою', () => {
  it('щільність пікселів не перевищує щільність екрана', () => {
    const s = setup();
    expect(s.renderer.pixelRatio).toBeGreaterThanOrEqual(1);
    expect(s.renderer.pixelRatio).toBeLessThanOrEqual(3);
    s.viewer.dispose();
  });

  it('зміна розміру → новий розмір полотна, пропорції камери, перемальовка', () => {
    const s = setup(1180, 820);
    expect(s.renderer.size).toEqual([1180, 820]);
    s.container.clientWidth = 820;
    s.container.clientHeight = 1180;
    s.observer.callback();
    s.tick();
    expect(s.renderer.size).toEqual([820, 1180]);
    expect(s.camera().aspect).toBeCloseTo(820 / 1180, 6);
    expect(s.renderer.renders.length).toBe(2);
    s.viewer.dispose();
  });

  it('нульовий розмір контейнера (приховано) не ламає камеру', () => {
    const s = setup(0, 0);
    const camera = s.camera();
    expect(Number.isFinite(camera.aspect)).toBe(true);
    expect(camera.aspect).toBeGreaterThan(0);
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
    s.viewer.dispose();
  });

  const axisEnds = [new Vector3(0, 0, 0), new Vector3(1.22, 0, 0), new Vector3(0, 1.22, 0), new Vector3(0, 0, 1.22)];

  for (const [name, w, h] of [
    ['iPad горизонтально', 1180, 820],
    ['iPhone 15 Pro Max вертикально', 430, 932],
    ['iPhone 15 Pro Max горизонтально', 932, 430],
  ] as const) {
    it(`${name}: на старті осі з підписами в кадрі`, () => {
      const s = setup(w, h);
      const camera = s.camera();
      camera.updateMatrixWorld(true);
      for (const p of axisEnds) expect(inFrame(camera, p), `точка ${p.toArray()}`).toBe(true);
      s.viewer.dispose();
    });
  }

  for (const [name, from, to] of [
    ['iPhone: горизонтально → вертикально', [932, 430], [430, 932]],
    ['iPhone: вертикально → горизонтально', [430, 932], [932, 430]],
    ['iPad: горизонтально → вертикально', [1180, 820], [820, 1180]],
  ] as const) {
    it(`${name}: після повороту пристрою осі з підписами лишаються в кадрі`, () => {
      const s = setup(from[0], from[1]);
      s.container.clientWidth = to[0];
      s.container.clientHeight = to[1];
      s.observer.callback();
      s.tick();
      const camera = s.camera();
      camera.updateMatrixWorld(true);
      for (const p of axisEnds) expect(inFrame(camera, p), `точка ${p.toArray()}`).toBe(true);
      s.viewer.dispose();
    });
  }
});

describe('сцена: світла й темна тема', () => {
  it('фон відповідає системній темі на старті', () => {
    fake.media.matches = true;
    const s = setup();
    expect((s.scene().background as Color).getHex()).toBe(DARK_THEME.background);
    s.viewer.dispose();
  });

  it('перемикання теми: стара сітка звільнена, нова — одна, кадр перемальовано', () => {
    const s = setup();
    expect((s.scene().background as Color).getHex()).toBe(LIGHT_THEME.background);
    const oldGrid = gridOf(s.scene());
    let geometryDisposed = false;
    let materialDisposed = false;
    oldGrid.geometry.addEventListener('dispose', () => (geometryDisposed = true));
    oldGrid.material.addEventListener('dispose', () => (materialDisposed = true));

    fake.media.set(true);
    s.tick();
    expect(s.renderer.renders.length).toBe(2);
    expect((s.scene().background as Color).getHex()).toBe(DARK_THEME.background);
    const newGrid = gridOf(s.scene()); // рівно одна
    expect(newGrid).not.toBe(oldGrid);
    expect(geometryDisposed).toBe(true);
    expect(materialDisposed).toBe(true);

    // Багато перемикань — сітка все одно одна.
    for (let i = 0; i < 10; i++) fake.media.set(i % 2 === 0);
    gridOf(s.scene());
    s.viewer.dispose();
  });
});

describe('сцена: dispose() звільняє все', () => {
  it('геометрії, матеріали, текстури, рендерер, цикл, спостерігачі, полотно', () => {
    const s = setup();
    const scene = s.scene();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    scene.traverse((o) => {
      const any = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; isSprite?: boolean };
      if (any.geometry && !any.isSprite) geometries.add(any.geometry);
      const list = any.material ? (Array.isArray(any.material) ? any.material : [any.material]) : [];
      for (const m of list) {
        materials.add(m);
        const map = (m as Material & { map?: Texture | null }).map;
        if (map) textures.add(map);
      }
    });
    const disposed = new Set<unknown>();
    for (const r of [...geometries, ...materials, ...textures]) r.addEventListener('dispose', () => disposed.add(r));

    const canvas = s.renderer.domElement;
    expect(s.container.children).toContain(canvas);
    expect(canvas.listeners.get('pointerdown')).toBeGreaterThan(0);

    s.viewer.dispose();

    for (const g of geometries) expect(disposed.has(g), `геометрія ${g.type}`).toBe(true);
    for (const m of materials) expect(disposed.has(m), `матеріал ${m.type}`).toBe(true);
    for (const t of textures) expect(disposed.has(t), 'текстура').toBe(true);
    expect(s.renderer.disposed).toBe(true);
    expect(s.renderer.loop).toBeNull();
    expect(s.observer.disconnected).toBe(true);
    expect(s.container.children).not.toContain(canvas);
    // Керування камерою відпущене: жодних слухачів на полотні.
    for (const type of ['pointerdown', 'pointercancel', 'wheel', 'contextmenu']) {
      expect(canvas.listeners.get(type) ?? 0, type).toBe(0);
    }
    // Тема більше не слухається: перемикання після dispose нічого не створює.
    const listenersBefore = fake.media.listeners.size;
    fake.media.set(true);
    expect(fake.media.listeners.size).toBe(listenersBefore);
    let grids = 0;
    scene.traverse((o) => {
      if ((o as { type?: string }).type === 'GridHelper') grids++;
    });
    expect(grids).toBe(0);
  });

  it('кілька сцен підряд (створити → dispose) не лишають підписок на тему', () => {
    const before = fake.media.listeners.size;
    for (let i = 0; i < 5; i++) setup().viewer.dispose();
    expect(fake.media.listeners.size).toBe(before);
  });
});
