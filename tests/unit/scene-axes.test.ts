/**
 * Осі X/Y/Z сцени (src/scene/axes.ts) — перевірка як чорної скриньки:
 * довжина 300 мм, напрямки (Y — вгору), підписи на кінцях, кольори, звільнення ресурсів.
 *
 * Модуль малює підписи на <canvas>; у Node DOM немає, тому підставляємо мінімальний «document».
 */
import { Box3, type BufferGeometry, type Material, Mesh, type Object3D, Sprite, type Texture, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Допуск координат: ±0,1 мм = 0,0001 м. */
const TOL_M = 0.0001;
/** Довжина стрілок осей (м): маленькі осі на прохання Єгора — 300 мм. */
const AXIS_M = 0.3;

type AxesModule = typeof import('../../src/scene/axes.ts');
type ThemeModule = typeof import('../../src/scene/theme.ts');

let createAxes: AxesModule['createAxes'];
let LIGHT_THEME: ThemeModule['LIGHT_THEME'];
let DARK_THEME: ThemeModule['DARK_THEME'];

beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
  ({ createAxes } = await import('../../src/scene/axes.ts'));
  ({ LIGHT_THEME, DARK_THEME } = await import('../../src/scene/theme.ts'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function worldBox(object: Object3D): Box3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object);
}

/** Усі ресурси GPU всередині об'єкта (геометрії, матеріали, текстури). */
function collectResources(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Sprite) {
      // У Sprite геометрія — спільна внутрішня геометрія Three.js, її не звільняють.
      if (object instanceof Mesh) geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list as Material[]) {
        materials.add(material);
        const map = (material as Material & { map?: Texture | null }).map;
        if (map) textures.add(map);
      }
    }
  });
  return { geometries, materials, textures };
}

function trackDispose(resources: Iterable<{ addEventListener: (type: 'dispose', cb: () => void) => void }>) {
  const disposed = new Set<unknown>();
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
  return disposed;
}

describe('осі сцени: геометрія', () => {
  it('стрілка X: 300 мм уздовж +X, лежить на підлозі (Y = 0) і на Z = 0', () => {
    const axes = createAxes(LIGHT_THEME);
    const box = worldBox(axes.group.getObjectByName('axis-X')!);
    expect(box.max.x).toBeCloseTo(AXIS_M, 4); // кінець стрілки рівно на 300 мм
    expect(Math.abs(box.min.x)).toBeLessThan(TOL_M); // починається в нулі
    // Поперечний розмір — лише товщина стрілки (симетрично відносно осі).
    expect(Math.abs(box.max.y + box.min.y)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(TOL_M);
    expect(box.max.y).toBeLessThan(0.05);
    axes.dispose();
  });

  it('стрілка Y: 300 мм строго вгору (+Y), не нахилена', () => {
    const axes = createAxes(LIGHT_THEME);
    const box = worldBox(axes.group.getObjectByName('axis-Y')!);
    expect(box.max.y).toBeCloseTo(AXIS_M, 4);
    expect(Math.abs(box.min.y)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(TOL_M);
    expect(box.max.x).toBeLessThan(0.05);
    axes.dispose();
  });

  it('стрілка Z: 300 мм уздовж +Z, лежить на підлозі', () => {
    const axes = createAxes(LIGHT_THEME);
    const box = worldBox(axes.group.getObjectByName('axis-Z')!);
    expect(box.max.z).toBeCloseTo(AXIS_M, 4);
    expect(Math.abs(box.min.z)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.y + box.min.y)).toBeLessThan(TOL_M);
    axes.dispose();
  });

  it('система координат права: X × Y = Z (як у glTF і Three.js)', () => {
    const axes = createAxes(LIGHT_THEME);
    const tip = (name: string) => worldBox(axes.group.getObjectByName(name)!).getCenter(new Vector3()).normalize();
    const x = tip('axis-X');
    const y = tip('axis-Y');
    const z = tip('axis-Z');
    expect(new Vector3().crossVectors(x, y).dot(z)).toBeGreaterThan(0.99);
    axes.dispose();
  });

  it('підпис кожної осі стоїть за кінцем «своєї» стрілки, на самій осі', () => {
    const axes = createAxes(LIGHT_THEME);
    const dirs = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) } as const;
    for (const name of ['X', 'Y', 'Z'] as const) {
      const p = axes.labelPosition(name);
      const along = p.dot(dirs[name]);
      expect(along, name).toBeGreaterThan(AXIS_M); // далі кінця стрілки
      expect(along, name).toBeLessThan(AXIS_M * 2);
      // Поперечне відхилення від осі — нуль.
      expect(p.clone().addScaledVector(dirs[name], -along).length(), name).toBeLessThan(TOL_M);
    }
    axes.dispose();
  });

  it('група осей не масштабована й не повернута (1 одиниця = 1 м)', () => {
    const axes = createAxes(LIGHT_THEME);
    expect(axes.group.scale.toArray()).toEqual([1, 1, 1]);
    expect(axes.group.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(axes.group.position.toArray()).toEqual([0, 0, 0]);
    axes.dispose();
  });
});

describe('осі сцени: кольори', () => {
  const colorOf = (group: Object3D, name: string) => {
    const mesh = group.getObjectByName(name)!.children.find((c): c is Mesh => c instanceof Mesh)!;
    return (mesh.material as Material & { color: { getHex(): number } }).color.getHex();
  };

  it('X — червона, Y — зелена, Z — синя (світла тема)', () => {
    const axes = createAxes(LIGHT_THEME);
    expect(colorOf(axes.group, 'axis-X')).toBe(LIGHT_THEME.axisX);
    expect(colorOf(axes.group, 'axis-Y')).toBe(LIGHT_THEME.axisY);
    expect(colorOf(axes.group, 'axis-Z')).toBe(LIGHT_THEME.axisZ);
    // Справді червоний / зелений / синій домінує.
    const rgb = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as const;
    const [xr, xg, xb] = rgb(LIGHT_THEME.axisX);
    const [yr, yg, yb] = rgb(LIGHT_THEME.axisY);
    const [zr, zg, zb] = rgb(LIGHT_THEME.axisZ);
    expect(xr).toBeGreaterThan(Math.max(xg, xb));
    expect(yg).toBeGreaterThan(Math.max(yr, yb));
    expect(zb).toBeGreaterThan(Math.max(zr, zg));
    axes.dispose();
  });

  it('перемикання теми змінює кольори і звільняє старі текстури підписів', () => {
    const axes = createAxes(LIGHT_THEME);
    const before = collectResources(axes.group);
    const disposed = trackDispose(before.textures);
    axes.setTheme(DARK_THEME);
    expect(colorOf(axes.group, 'axis-X')).toBe(DARK_THEME.axisX);
    expect(colorOf(axes.group, 'axis-Y')).toBe(DARK_THEME.axisY);
    expect(colorOf(axes.group, 'axis-Z')).toBe(DARK_THEME.axisZ);
    // Кожна стара текстура звільнена (інакше пам'ять росте з кожним перемиканням теми).
    expect(before.textures.size).toBe(3);
    for (const texture of before.textures) expect(disposed.has(texture)).toBe(true);
    axes.dispose();
  });
});

describe('осі сцени: звільнення пам\'яті (dispose)', () => {
  it('dispose() звільняє всі геометрії, матеріали й текстури', () => {
    const axes = createAxes(LIGHT_THEME);
    const { geometries, materials, textures } = collectResources(axes.group);
    expect(textures.size).toBeGreaterThan(0);
    const disposedGeometries = trackDispose(geometries);
    const disposedMaterials = trackDispose(materials);
    const disposedTextures = trackDispose(textures);
    axes.dispose();
    expect(geometries.size).toBeGreaterThan(0);
    for (const g of geometries) expect(disposedGeometries.has(g), `геометрія ${g.type}`).toBe(true);
    for (const m of materials) expect(disposedMaterials.has(m), `матеріал ${m.type}`).toBe(true);
    for (const t of textures) expect(disposedTextures.has(t), 'текстура підпису').toBe(true);
    expect(axes.group.children.length).toBe(0);
  });

  it('після setTheme() dispose() звільняє і нові текстури', () => {
    const axes = createAxes(LIGHT_THEME);
    axes.setTheme(DARK_THEME);
    const { textures } = collectResources(axes.group);
    const disposed = trackDispose(textures);
    axes.dispose();
    expect(textures.size).toBe(3);
    for (const t of textures) expect(disposed.has(t)).toBe(true);
  });
});
