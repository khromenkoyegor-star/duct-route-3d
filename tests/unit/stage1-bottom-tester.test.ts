/**
 * Низ скану на Y = 0 (src/scene/scan-loader.ts + src/core/scan-info.ts), перевірка від tester.
 * Вимога: після відкриття скан зсувається ТІЛЬКИ по Y так, щоб найнижча точка (за вершинами) була на Y = 0.
 * Масштаб, осі, X і Z — не змінюються; габарит той самий; у панелі — «піднято/опущено на N мм».
 * Точність координат — ±0,1 мм.
 */
import { Box3, type Mesh, type Object3D, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeScan, formatOffsetY } from '../../src/core/scan-info.ts';
import { boxRoom, buildGlb, buildGltf, type MeshInput, quad, quatY, toGlb, type Quat } from '../fixtures/gltf-builder.ts';

type LoaderModule = typeof import('../../src/scene/scan-loader.ts');
let loadScan: LoaderModule['loadScan'];
let ScanLoadError: LoaderModule['ScanLoadError'];

/** ±0,1 мм у метрах. */
const TOL_M = 0.0001;

beforeAll(async () => {
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal(
    'ProgressEvent',
    class extends Event {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type);
        Object.assign(this, init);
      }
    },
  );
  ({ loadScan, ScanLoadError } = await import('../../src/scene/scan-loader.ts'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const file = (name: string, bytes: Uint8Array) => ({
  name,
  size: bytes.byteLength,
  arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
});
const TABLET = { maxTextureSide: 8192 };

/** Усі вершини у світових координатах (м). */
function worldVertices(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const out: Vector3[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  });
  return out;
}

/** Поворот навколо X на кут (градуси). */
function quatX(deg: number): Quat {
  const r = (deg * Math.PI) / 180 / 2;
  return [Math.sin(r), 0, 0, Math.cos(r)];
}

/** Маленький «уламок» (трикутник ~5 см) — як сміття в скані Polycam під підлогою. */
function shard(at: [number, number, number]): MeshInput {
  const [x, y, z] = at;
  return {
    name: 'shard',
    positions: new Float32Array([x, y, z, x + 0.05, y, z, x, y, z + 0.05]),
    indices: new Uint16Array([0, 1, 2]),
  };
}

describe('низ скану на Y = 0: зсув лише по Y', () => {
  it('кожна вершина зсунута рівно на (0, offsetY, 0): X і Z бітово ті самі, Y — на зсув (±0,1 мм)', async () => {
    const mesh = boxRoom([-2, -1.4, -1.5], [2, 1.3, 1.5]);
    const scan = await loadScan([file('a.glb', buildGlb({ meshes: [mesh] }))], TABLET);
    expect(scan.stats.offsetY).toBeCloseTo(1.4, 6);
    const p = mesh.positions;
    const v = worldVertices(scan.root);
    expect(v).toHaveLength(p.length / 3);
    v.forEach((w, i) => {
      expect(w.x).toBe(p[i * 3]!);
      expect(w.z).toBe(p[i * 3 + 2]!);
      expect(Math.abs(w.y - (p[i * 3 + 1]! + scan.stats.offsetY))).toBeLessThan(1e-9);
    });
    // Найнижча вершина — рівно на 0 (±0,1 мм), найвища — на висоті кімнати.
    expect(Math.abs(Math.min(...v.map((w) => w.y)))).toBeLessThan(TOL_M);
    expect(Math.abs(Math.max(...v.map((w) => w.y)) - 2.7)).toBeLessThan(TOL_M);
    // Масштаб і поворот обгортки — без змін.
    expect(scan.root.scale.toArray()).toEqual([1, 1, 1]);
    expect(scan.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    scan.dispose();
  });

  it('«сміття» нижче підлоги: на Y = 0 стає найнижча вершина (уламок), а не підлога; X і Z — як у файлі', async () => {
    // Підлога на −1,4 м, уламок ще на 0,35 м нижче. За вимогою — найнижча точка за вершинами.
    const meshes = [boxRoom([-2, -1.4, -1.5], [2, 1.3, 1.5]), shard([0.7, -1.75, 0.2])];
    const scan = await loadScan([file('garbage.glb', buildGlb({ meshes }))], TABLET);
    expect(Math.abs(scan.stats.offsetY - 1.75)).toBeLessThan(TOL_M);
    expect(Math.abs(scan.stats.min[1])).toBeLessThan(TOL_M);
    // Підлога кімнати тепер на +350 мм над нулем — це варто показати Єгору в звіті.
    expect(Math.abs(describeScan(scan.stats, 'tablet').sizeMm.y - 3050)).toBeLessThan(0.1);
    expect(scan.stats.min[0]).toBe(-2);
    expect(scan.stats.max[0]).toBe(2);
    expect(scan.stats.min[2]).toBe(-1.5);
    expect(scan.stats.max[2]).toBe(1.5);
    scan.dispose();
  });

  it('межі — за справжніми вершинами: повернутий на 45° навколо X вузол (кут куба найнижчий) → рівно 0', async () => {
    const cube = boxRoom([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 'cube');
    const scan = await loadScan([file('rot.glb', buildGlb({ meshes: [{ ...cube, rotation: quatX(45) }] }))], TABLET);
    const v = worldVertices(scan.root);
    expect(Math.abs(Math.min(...v.map((w) => w.y)))).toBeLessThan(TOL_M);
    // Ребро куба 1 м, повернутого на 45°: висота = √2 м.
    expect(Math.abs(scan.stats.max[1] - Math.SQRT2)).toBeLessThan(TOL_M);
    expect(Math.abs(scan.stats.offsetY - Math.SQRT2 / 2)).toBeLessThan(TOL_M);
    scan.dispose();
  });

  it('«брехливі» min/max у файлі (accessor) не впливають: рахується за вершинами', async () => {
    const { json, bin } = buildGltf({ meshes: [boxRoom([-2, 0.3, -1.5], [2, 3, 1.5])] });
    const accessor = (json as unknown as { accessors: Array<{ min?: number[]; max?: number[] }> }).accessors[0]!;
    accessor.min = [-50, -20, -50];
    accessor.max = [50, 40, 50];
    const scan = await loadScan([file('lying.glb', toGlb(json, bin))], TABLET);
    expect(Math.abs(scan.stats.offsetY - -0.3)).toBeLessThan(TOL_M);
    expect(Math.abs(scan.stats.min[1])).toBeLessThan(TOL_M);
    expect(Math.abs(scan.stats.max[1] - 2.7)).toBeLessThan(TOL_M);
    scan.dispose();
  });

  it('кілька вузлів зі своїми зсувами: найнижчий — у вкладеному вузлі; scale вузла 0,001 (модель у мм)', async () => {
    const mm = boxRoom([-2000, 0, -1500], [2000, 2700, 1500]);
    const deep = { ...quad([[0, -900, 0], [100, -900, 0], [100, -900, 100], [0, -900, 100]], 'deep'), translation: [0, -100, 0] as [number, number, number] };
    const scan = await loadScan(
      [file('mm.glb', buildGlb({ meshes: [mm, deep], root: { scale: [0.001, 0.001, 0.001], translation: [0, 2, 0] } }))],
      TABLET,
    );
    // Найнижче: (−900 − 100) мм × 0,001 + 2 м = 1 м → зсув −1 м (опущено на 1000 мм).
    expect(Math.abs(scan.stats.offsetY - -1)).toBeLessThan(TOL_M);
    expect(Math.abs(scan.stats.min[1])).toBeLessThan(TOL_M);
    const info = describeScan(scan.stats, 'tablet');
    expect(Math.abs(info.sizeMm.x - 4000)).toBeLessThan(0.1);
    expect(Math.abs(info.sizeMm.y - 3700)).toBeLessThan(0.1);
    expect(Math.abs(info.offsetYMm - -1000)).toBeLessThan(0.1);
    expect(formatOffsetY(info.offsetYMm).replace(/\s/g, ' ')).toBe('Низ скану на Y = 0 · скан опущено на 1 000 мм');
    scan.dispose();
  });

  it('скан уже стоїть на Y = 0 — зсуву немає (0), підпис без «піднято/опущено»', async () => {
    const scan = await loadScan([file('ok.glb', buildGlb({ meshes: [boxRoom([-2, 0, -1.5], [2, 2.7, 1.5])] }))], TABLET);
    expect(scan.stats.offsetY === 0).toBe(true);
    expect(formatOffsetY(describeScan(scan.stats, 'tablet').offsetYMm)).toBe('Низ скану на Y = 0');
    scan.dispose();
  });

  it('скан повернутий на 90° навколо Y і далеко від нуля: X ↔ Z міняються як у файлі, зсув лише по Y', async () => {
    const glb = buildGlb({ meshes: [{ ...boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]), rotation: quatY(90) }], root: { translation: [120, 7.5, -80] } });
    const scan = await loadScan([file('far.glb', glb)], TABLET);
    expect(Math.abs(scan.stats.offsetY - -7.5)).toBeLessThan(TOL_M);
    const box = new Box3().setFromObject(scan.root, true);
    expect(Math.abs(box.min.x - 118.5)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.x - 121.5)).toBeLessThan(TOL_M);
    expect(Math.abs(box.min.z - -82)).toBeLessThan(TOL_M);
    expect(Math.abs(box.max.z - -78)).toBeLessThan(TOL_M);
    expect(Math.abs(box.min.y)).toBeLessThan(TOL_M);
    scan.dispose();
  });

  it('файл без поверхонь — зсуву немає, межі нульові, без NaN', async () => {
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'empty' }] };
    const scan = await loadScan([file('empty.gltf', new TextEncoder().encode(JSON.stringify(json)))], TABLET);
    expect(scan.stats.offsetY).toBe(0);
    expect([...scan.stats.min, ...scan.stats.max].every(Number.isFinite)).toBe(true);
    expect(() => describeScan(scan.stats, 'tablet')).not.toThrow();
    scan.dispose();
  });

  it('пошкоджена вершина (NaN) у файлі: або зрозуміла помилка, або скан без NaN у межах і зсуві', async () => {
    const broken = boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]);
    broken.positions[4] = Number.NaN; // Y другої вершини
    let scan;
    try {
      scan = await loadScan([file('nan.glb', buildGlb({ meshes: [broken] }))], TABLET);
    } catch (error) {
      expect(error, String(error)).toBeInstanceOf(ScanLoadError);
      return;
    }
    const s = scan.stats;
    expect(Number.isFinite(s.offsetY), `offsetY = ${s.offsetY}`).toBe(true);
    expect([...s.min, ...s.max].every(Number.isFinite), `min ${s.min} max ${s.max}`).toBe(true);
    expect(Number.isFinite(scan.root.position.y), 'обгортка скану не на NaN').toBe(true);
    expect(() => describeScan(s, 'tablet')).not.toThrow();
    scan.dispose();
  });
});

describe('підпис зсуву', () => {
  const plain = (s: string) => s.replace(/\s/g, ' ');
  it('межа 0,5 мм: менше — не згадуємо; від 0,5 — згадуємо, з точністю 0,1 мм; без знака мінус', () => {
    expect(formatOffsetY(0.49)).toBe('Низ скану на Y = 0');
    expect(formatOffsetY(-0.49)).toBe('Низ скану на Y = 0');
    expect(plain(formatOffsetY(0.5))).toBe('Низ скану на Y = 0 · скан піднято на 0,5 мм');
    expect(plain(formatOffsetY(-0.5))).toBe('Низ скану на Y = 0 · скан опущено на 0,5 мм');
    expect(plain(formatOffsetY(1234.56))).toBe('Низ скану на Y = 0 · скан піднято на 1 234,6 мм');
    expect(plain(formatOffsetY(-98765.4))).toBe('Низ скану на Y = 0 · скан опущено на 98 765,4 мм');
  });

  it('describeScan: offsetYMm = offsetY × 1000 (через units.ts), габарит від зсуву не залежить', () => {
    const base = { min: [-2, 0, -1.5] as const, max: [2, 2.7, 1.5] as const, triangles: 12, fileBytes: 1, textures: 0, texturePixels: 0, texturesReduced: 0 };
    const a = describeScan({ ...base, offsetY: 0 }, 'tablet');
    const b = describeScan({ ...base, offsetY: -3.2105 }, 'phone');
    expect(a.sizeMm).toEqual(b.sizeMm);
    expect(Math.abs(b.offsetYMm - -3210.5)).toBeLessThan(1e-9);
  });
});
