/**
 * Етап 4 (tester): 3D-геометрія повітропроводу (scene/duct-mesh.ts) — у мм після переведення через units.ts.
 * Не дублює duct-mesh.test.ts: тут габарити Ø200 × 1000 уздовж кожної осі, габарит цілої траси на всіх
 * поворотах і діаметрах, поверхні колін (круглі й прямокутні) на всіх поворотах, стики без щілин,
 * перенесення перерізу прямокутної труби (Ш × В) через коліна, конуси/піраміди переходів, торці,
 * підсвітка, вузол без повороту, довгі траси.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import {
  DUCT_DIAMETERS_MM,
  type DuctElbow,
  type DuctLayout,
  type DuctSection,
  type DuctSpec,
  ductLayout,
  roundElbowPolyline,
  transitionLengthMm,
} from '../../src/core/duct.ts';
import type { P3 } from '../../src/core/route.ts';
import { mToMm } from '../../src/core/units.ts';
import { buildDuctGeometry } from '../../src/scene/duct-mesh.ts';

const TOL = 0.1;
const round = (d: number): DuctSection => ({ shape: 'round', diameterMm: d });
const rect = (w: number, h: number): DuctSection => ({ shape: 'rect', widthMm: w, heightMm: h });
const spec = (section: DuctSection, transitions: DuctSpec['transitions'] = []): DuctSpec => ({ section, transitions });

const add = (a: P3, b: P3): P3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: P3, b: P3): P3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: P3, k: number): P3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: P3, b: P3): P3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
const dist = (a: P3, b: P3) => len(sub(a, b));
const unit = (a: P3) => mul(a, 1 / len(a));

const X: P3 = { x: 1, y: 0, z: 0 };
const Y: P3 = { x: 0, y: 1, z: 0 };
const Z: P3 = { x: 0, y: 0, z: 1 };
const NAMES: Array<[string, P3]> = [
  ['+X', X],
  ['−X', mul(X, -1)],
  ['+Y', Y],
  ['−Y', mul(Y, -1)],
  ['+Z', Z],
  ['−Z', mul(Z, -1)],
];
const name = (d: P3) => NAMES.find(([, v]) => dist(v, d) < 1e-9)![0];
const TURNS: Array<[P3, P3]> = [];
for (const [, a] of NAMES) for (const [, b] of NAMES) if (Math.abs(dot(a, b)) < 1e-9) TURNS.push([a, b]);

function build(start: P3, legs: Array<[P3, number]>): P3[] {
  const out = [start];
  for (const [d, l] of legs) out.push(add(out.at(-1)!, mul(d, l)));
  return out;
}

/** Вершини геометрії в мм (сцена — у метрах). */
function vertices(geometry: BufferGeometry): P3[] {
  const pos = geometry.getAttribute('position');
  const out: P3[] = [];
  for (let i = 0; i < pos.count; i++) out.push({ x: mToMm(pos.getX(i)), y: mToMm(pos.getY(i)), z: mToMm(pos.getZ(i)) });
  return out;
}

function boxOf(points: readonly P3[]) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const k of ['x', 'y', 'z'] as const) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

/** Габарит з Three.js (те, що повертає app.ductBox), у мм. */
function threeBox(geometry: BufferGeometry) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return {
    min: { x: mToMm(b.min.x), y: mToMm(b.min.y), z: mToMm(b.min.z) },
    max: { x: mToMm(b.max.x), y: mToMm(b.max.y), z: mToMm(b.max.z) },
  };
}

function expectBox(actual: ReturnType<typeof boxOf>, min: P3, max: P3, tag: string) {
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(actual.min[k] - min[k]), `${tag}: min.${k} = ${actual.min[k]}, очікувалось ${min[k]}`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(actual.max[k] - max[k]), `${tag}: max.${k} = ${actual.max[k]}, очікувалось ${max[k]}`).toBeLessThanOrEqual(TOL);
  }
}

/** Відстань від точки до прямої через a у напрямку d (одиничний). */
const toLine = (p: P3, a: P3, d: P3) => len(cross(sub(p, a), d));

/** Лише одна деталь розкладання (без торців). */
type Part = Partial<Pick<DuctLayout, 'straights' | 'elbows' | 'transitions'>>;
const only = (layout: DuctLayout, part: Part): DuctLayout => ({
  ...layout,
  straights: part.straights ?? [],
  elbows: part.elbows ?? [],
  transitions: part.transitions ?? [],
});
/** Вершини лише цієї деталі (фільтр за відрізком вимикає торці). */
const partVertices = (nodes: P3[], layout: DuctLayout, part: Part, segment: number) =>
  vertices(buildDuctGeometry(nodes, only(layout, part), { segments: new Set([segment]) }));

describe('Критерій: Ø200, відрізок 1000 мм → габарит 1000 × 200 × 200 (±0,1 мм)', () => {
  for (const [label, d] of NAMES) {
    it(`уздовж ${label}: габарит і вісь труби на трасі; бічна поверхня рівно на радіусі 100`, () => {
      const nodes = build({ x: -321.4, y: 1987.6, z: 456.7 }, [[d, 1000]]);
      const geometry = buildDuctGeometry(nodes, ductLayout(nodes, spec(round(200))));
      const lo = { x: Math.min(nodes[0]!.x, nodes[1]!.x), y: Math.min(nodes[0]!.y, nodes[1]!.y), z: Math.min(nodes[0]!.z, nodes[1]!.z) };
      const hi = { x: Math.max(nodes[0]!.x, nodes[1]!.x), y: Math.max(nodes[0]!.y, nodes[1]!.y), z: Math.max(nodes[0]!.z, nodes[1]!.z) };
      const r: P3 = { x: d.x === 0 ? 100 : 0, y: d.y === 0 ? 100 : 0, z: d.z === 0 ? 100 : 0 };
      expectBox(boxOf(vertices(geometry)), sub(lo, r), add(hi, r), label);
      expectBox(threeBox(geometry), sub(lo, r), add(hi, r), `${label} (Three.js boundingBox)`);
      for (const p of vertices(geometry)) {
        expect(toLine(p, nodes[0]!, d)).toBeLessThanOrEqual(100 + TOL);
        const along = dot(sub(p, nodes[0]!), d);
        // Не за межами відрізка: від 0 до 1000.
        expect(along).toBeGreaterThanOrEqual(-TOL);
        expect(along).toBeLessThanOrEqual(1000 + TOL);
        // На стінці (не на торцях) — рівно радіус 100.
        if (along > TOL && along < 1000 - TOL) expect(Math.abs(toLine(p, nodes[0]!, d) - 100)).toBeLessThanOrEqual(TOL);
      }
    });
  }
});

describe('Критерій: вісь повітропроводу на трасі — габарит траси з одним коліном, усі діаметри й повороти', () => {
  for (const D of DUCT_DIAMETERS_MM) {
    it(`Ø${D}: габарит = траса + D/2 убік (коліно не виходить за стінки прямих)`, () => {
      for (const [a, b] of TURNS) {
        const P0 = { x: 250, y: 1700, z: -800 };
        const nodes = build(P0, [
          [a, 1500],
          [b, 1500],
        ]);
        const geometry = buildDuctGeometry(nodes, ductLayout(nodes, spec(round(D))));
        const r = D / 2;
        const n = cross(a, b);
        // Межі вздовж a: від P0 до вузла + r; вздовж b: від вузла − r до P2; уздовж n: ±r.
        const corners = [
          P0,
          add(nodes[1]!, mul(a, r)),
          sub(nodes[1]!, mul(b, r)),
          nodes[2]!,
          add(nodes[1]!, mul(n, r)),
          sub(nodes[1]!, mul(n, r)),
        ];
        const want = boxOf(corners);
        expectBox(boxOf(vertices(geometry)), want.min, want.max, `Ø${D} ${name(a)}→${name(b)}`);
      }
    });
  }
});

describe('Критерій: коліно — 4 сегменти труби Ø навколо своєї ділянки осі, стики без щілин', () => {
  for (const D of [100, 200, 315, 450]) {
    it(`Ø${D}: на кожному повороті кожна вершина сегмента — на радіусі D/2 від його осі; кінці коліна збігаються з кінцями прямих`, () => {
      for (const [a, b] of TURNS) {
        const nodes = build({ x: 0, y: 1500, z: 0 }, [
          [a, 1500],
          [b, 1500],
        ]);
        const layout = ductLayout(nodes, spec(round(D)));
        const e = layout.elbows[0]!;
        const tag = `Ø${D} ${name(a)}→${name(b)}`;
        const axis = roundElbowPolyline(e);
        const pts = partVertices(nodes, layout, { elbows: [e] }, 0);
        expect(pts.length % 4).toBe(0);
        const per = pts.length / 4;
        for (let k = 0; k < 4; k++) {
          const t = unit(sub(axis[k + 1]!, axis[k]!));
          for (const p of pts.slice(k * per, (k + 1) * per)) {
            expect(Math.abs(toLine(p, axis[k]!, t) - D / 2), `${tag}, сегмент ${k + 1}`).toBeLessThanOrEqual(TOL);
          }
        }
        // Стик «пряма → коліно» і «коліно → пряма»: кільця вершин збігаються (немає щілини чи сходинки).
        const s0 = partVertices(nodes, layout, { straights: [layout.straights[0]!] }, 0);
        const s1 = partVertices(nodes, layout, { straights: [layout.straights[1]!] }, 1);
        const ringAt = (vs: P3[], at: P3, d: P3) => vs.filter((p) => Math.abs(dot(sub(p, at), d)) < 1e-3);
        const pairs: Array<[P3[], P3[], string]> = [
          [ringAt(s0, e.start, a), ringAt(pts.slice(0, per), e.start, a), 'вхід'],
          [ringAt(s1, e.end, b), ringAt(pts.slice(3 * per), e.end, b), 'вихід'],
        ];
        for (const [straightRing, elbowRing, which] of pairs) {
          expect(straightRing.length, `${tag} ${which}: кільце прямої`).toBeGreaterThanOrEqual(32);
          expect(elbowRing.length, `${tag} ${which}: кільце коліна`).toBeGreaterThanOrEqual(32);
          for (const p of elbowRing) {
            const nearest = Math.min(...straightRing.map((q) => dist(p, q)));
            expect(nearest, `${tag} ${which}`).toBeLessThanOrEqual(TOL);
          }
        }
      }
    });
  }
});

describe('Критерій: прямокутні Ш × В — короб як задано, коліно з внутрішнім радіусом 100 мм', () => {
  const SIZES: Array<[number, number]> = [
    [500, 300],
    [300, 500],
    [200, 800],
    [1000, 100],
    [50, 50],
  ];

  it('прямий короб уздовж ±X і ±Z: Ш — горизонтально ⟂ осі, В — вертикально (±0,1 мм)', () => {
    for (const [W, H] of SIZES) {
      for (const d of [X, mul(X, -1), Z, mul(Z, -1)]) {
        const nodes = build({ x: 10, y: 2000, z: -20 }, [[d, 2000]]);
        const box = boxOf(vertices(buildDuctGeometry(nodes, ductLayout(nodes, spec(rect(W, H))))));
        const across = Math.abs(d.x) > 0.5 ? 'z' : 'x';
        const tag = `${W}×${H} ${name(d)}`;
        expect(Math.abs(box.max[across] - box.min[across] - W), tag).toBeLessThanOrEqual(TOL);
        expect(Math.abs(box.max.y - box.min.y - H), tag).toBeLessThanOrEqual(TOL);
        expect(Math.abs((box.max.y + box.min.y) / 2 - 2000), tag).toBeLessThanOrEqual(TOL);
        expect(Math.abs((box.max[across] + box.min[across]) / 2 - (across === 'z' ? -20 : 10)), tag).toBeLessThanOrEqual(TOL);
      }
    }
  });

  for (const [W, H] of SIZES) {
    it(`${W}×${H}: на кожному повороті з горизонталі — внутрішня стінка на 100 мм від осі згину, зовнішня на 100 + B, боковини ±A/2`, () => {
      for (const [a, b] of TURNS) {
        if (Math.abs(a.y) > 0.5) continue;
        const nodes = build({ x: 0, y: 2000, z: 0 }, [
          [a, 4000],
          [b, 4000],
        ]);
        const layout = ductLayout(nodes, spec(rect(W, H)));
        const e: DuctElbow = layout.elbows[0]!;
        const tag = `${W}×${H} ${name(a)}→${name(b)}`;
        const vertical = Math.abs(b.y) > 0.5;
        const B = vertical ? H : W;
        const A = vertical ? W : H;
        const n = cross(a, b);
        const pts = partVertices(nodes, layout, { elbows: [e] }, 0);
        const radial = pts.map((p) => {
          const q = sub(p, e.centre);
          return len(sub(q, mul(n, dot(q, n))));
        });
        expect(Math.abs(Math.min(...radial) - 100), `${tag}: внутрішній радіус`).toBeLessThanOrEqual(TOL);
        expect(Math.abs(Math.max(...radial) - (100 + B)), `${tag}: зовнішній радіус`).toBeLessThanOrEqual(TOL);
        const acrossVals = pts.map((p) => dot(sub(p, e.centre), n));
        expect(Math.abs(Math.max(...acrossVals) - A / 2), `${tag}: боковина`).toBeLessThanOrEqual(TOL);
        expect(Math.abs(Math.min(...acrossVals) + A / 2), `${tag}: боковина`).toBeLessThanOrEqual(TOL);
        // Кутові точки коліна на вході = кутові точки короба на кінці прямої (без сходинки).
        const s0 = partVertices(nodes, layout, { straights: [layout.straights[0]!] }, 0);
        const atStart = (vs: P3[]) => vs.filter((p) => Math.abs(dot(sub(p, e.start), a)) < 1e-3);
        const elbowEnd = atStart(pts);
        const straightEnd = atStart(s0);
        expect(elbowEnd.length).toBeGreaterThan(0);
        for (const p of elbowEnd) expect(Math.min(...straightEnd.map((q) => dist(p, q))), tag).toBeLessThanOrEqual(TOL);
      }
    });
  }

  it('переріз повертається з колінами: X → вгору → Z — на останній ділянці Ш вертикально (труба «на боці»)', () => {
    const nodes = build({ x: 0, y: 1000, z: 0 }, [
      [X, 3000],
      [Y, 3000],
      [Z, 3000],
    ]);
    const layout = ductLayout(nodes, spec(rect(500, 300)));
    const box = (i: number) => boxOf(partVertices(nodes, layout, { straights: [layout.straights[i]!] }, i));
    const b0 = box(0);
    expect(b0.max.z - b0.min.z).toBeCloseTo(500, 1);
    expect(b0.max.y - b0.min.y).toBeCloseTo(300, 1);
    const b1 = box(1); // вгору: Ш — по Z, В — по X
    expect(b1.max.z - b1.min.z).toBeCloseTo(500, 1);
    expect(b1.max.x - b1.min.x).toBeCloseTo(300, 1);
    const b2 = box(2); // на Z: Ш — вертикально, В — по X
    expect(b2.max.y - b2.min.y).toBeCloseTo(500, 1);
    expect(b2.max.x - b2.min.x).toBeCloseTo(300, 1);
    // Друге коліно (Y→Z) повертає сторону Ш = 500 → R = 350; внутрішній радіус 100.
    expect(layout.elbows[1]!.radiusMm).toBe(350);
  });

  it('X → вниз → −X (обхід балки знизу): на останній ділянці В знову вертикально', () => {
    const nodes = build({ x: 0, y: 2500, z: 0 }, [
      [X, 3000],
      [mul(Y, -1), 1500],
      [mul(X, -1), 3000],
    ]);
    const layout = ductLayout(nodes, spec(rect(600, 200)));
    const s = layout.straights[2]!;
    const b = boxOf(partVertices(nodes, layout, { straights: [s] }, 2));
    expect(b.max.y - b.min.y).toBeCloseTo(200, 1);
    expect(b.max.z - b.min.z).toBeCloseTo(600, 1);
  });
});

describe('Критерій: переходи — конус / піраміда від старого до нового розміру, концентрично', () => {
  it('конус Ø450 → Ø200 на вертикальному відрізку: радіус лінійно 225 → 100, вісь на трасі', () => {
    const nodes = build({ x: 300, y: 500, z: -200 }, [
      [X, 2000],
      [Y, 2000],
    ]);
    const layout = ductLayout(nodes, spec(round(450), [{ segment: 1, to: round(200) }]));
    const t = layout.transitions[0]!;
    const L = transitionLengthMm(round(450), round(200));
    expect(t.lengthMm).toBeCloseTo(L, 6);
    const pts = partVertices(nodes, layout, { transitions: [t] }, 1);
    for (const p of pts) {
      const s = dot(sub(p, t.from), Y);
      expect(s).toBeGreaterThanOrEqual(-TOL);
      expect(s).toBeLessThanOrEqual(L + TOL);
      expect(Math.abs(toLine(p, t.from, Y) - (225 + ((100 - 225) * s) / L))).toBeLessThanOrEqual(TOL);
    }
    // Початок конуса — одразу після коліна Ø450 (R = 450 від вузла).
    expect(dist(t.from, add(nodes[1]!, mul(Y, 450)))).toBeLessThanOrEqual(TOL);
  });

  it('піраміда 800×400 → 400×200 після «X → Z»: на початку 800×400, у кінці 400×200, центр на осі', () => {
    const nodes = build({ x: 0, y: 2000, z: 0 }, [
      [X, 3000],
      [Z, 3000],
    ]);
    const layout = ductLayout(nodes, spec(rect(800, 400), [{ segment: 1, to: rect(400, 200) }]));
    const t = layout.transitions[0]!;
    expect(t.lengthMm).toBeCloseTo(400 / (2 * Math.tan(Math.PI / 12)), 6);
    const pts = partVertices(nodes, layout, { transitions: [t] }, 1);
    const at = (s: number) => pts.filter((p) => Math.abs(dot(sub(p, t.from), Z) - s) < 1e-3);
    const start = boxOf(at(0));
    const end = boxOf(at(t.lengthMm));
    expect(start.max.x - start.min.x).toBeCloseTo(800, 1);
    expect(start.max.y - start.min.y).toBeCloseTo(400, 1);
    expect(end.max.x - end.min.x).toBeCloseTo(400, 1);
    expect(end.max.y - end.min.y).toBeCloseTo(200, 1);
    for (const b of [start, end]) {
      expect((b.max.x + b.min.x) / 2).toBeCloseTo(nodes[1]!.x, 1);
      expect((b.max.y + b.min.y) / 2).toBeCloseTo(2000, 1);
    }
  });

  it('торці: на початку — розмір до переходу на першому відрізку; у кінці — розмір після останнього переходу', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [[X, 3000]]);
    const layout = ductLayout(nodes, spec(round(400), [{ segment: 0, to: round(160) }]));
    const pts = vertices(buildDuctGeometry(nodes, layout));
    const startCap = pts.filter((p) => Math.abs(p.x - 0) < 1e-3);
    const endCap = pts.filter((p) => Math.abs(p.x - 3000) < 1e-3);
    expect(Math.max(...startCap.map((p) => toLine(p, nodes[0]!, X)))).toBeCloseTo(200, 1);
    expect(Math.max(...endCap.map((p) => toLine(p, nodes[0]!, X)))).toBeCloseTo(80, 1);
    expect(boxOf(pts).max.x).toBeCloseTo(3000, 1);
    expect(boxOf(pts).min.x).toBeCloseTo(0, 1);
  });
});

describe('Підсвітка вибраного відрізка', () => {
  it('лише деталі відрізка (пряма, перехід, коліна на кінцях), трохи ширша за трубу', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 2000],
      [Z, 2000],
      [X, 2000],
    ]);
    const layout = ductLayout(nodes, spec(round(200)));
    const pts = vertices(buildDuctGeometry(nodes, layout, { segments: new Set([1]), grow: 6 }));
    const box = boxOf(pts);
    // Відрізок 2 (по Z) з колінами на обох кінцях: від z = −106 до z = 2106, по X — від 2000 − 200 до 2000 + 200.
    expect(box.min.z).toBeCloseTo(-106, 1);
    expect(box.max.z).toBeCloseTo(2106, 1);
    expect(box.min.x).toBeCloseTo(1800, 1);
    expect(box.max.x).toBeCloseTo(2200, 1);
  });
});

describe('Вузол без повороту (траса йде далі прямо)', () => {
  it('Ø200: [X 1000, X 1000] — труба суцільна, усі вершини стінки на радіусі 100 (немає «шийки» чи щілини)', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 1000],
      [X, 1000],
    ]);
    const pts = vertices(buildDuctGeometry(nodes, ductLayout(nodes, spec(round(200)))));
    const inside = pts.filter((p) => p.x > TOL && p.x < 2000 - TOL);
    const collapsed = inside.filter((p) => toLine(p, nodes[0]!, X) < 100 - TOL);
    expect(collapsed.length, 'вершини, що злиплися на осі (вироджене «коліно»)').toBe(0);
    // Між x = 800 і 1200 має бути стінка труби.
    expect(inside.some((p) => p.x > 850 && p.x < 1150 && Math.abs(toLine(p, nodes[0]!, X) - 100) < TOL)).toBe(true);
  });

  it('після вузла без повороту наступні ділянки не зникають: [X, X, Z] Ø200 і 500×300', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 1000],
      [X, 1000],
      [Z, 2000],
    ]);
    for (const section of [round(200), rect(500, 300)]) {
      const layout = ductLayout(nodes, spec(section));
      const last = layout.straights.find((s) => s.segment === 2)!;
      const b = boxOf(partVertices(nodes, layout, { straights: [last] }, 2));
      const sizeX = b.max.x - b.min.x;
      const sizeY = b.max.y - b.min.y;
      expect(Math.max(sizeX, sizeY), `${section.shape}: остання ділянка має переріз, а не нуль`).toBeGreaterThan(100);
    }
  });
});

describe('Довгі траси', () => {
  it('600 точок, прямокутні 400×200 (по колу вгору/вниз/убік): одна геометрія, < 1 с, без NaN', () => {
    const cycle: P3[] = [X, Y, Z, mul(Y, -1), X, mul(Z, -1)];
    const legs: Array<[P3, number]> = [];
    for (let i = 0; i < 599; i++) legs.push([cycle[i % cycle.length]!, 1000]);
    const nodes = build({ x: 0, y: 1000, z: 0 }, legs);
    const t0 = performance.now();
    const layout = ductLayout(nodes, spec(rect(400, 200)));
    const geometry = buildDuctGeometry(nodes, layout);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(layout.problems).toEqual([]);
    const arr = geometry.getAttribute('position').array as Float32Array;
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    geometry.dispose();
  });
});
