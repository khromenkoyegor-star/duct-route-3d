/**
 * Етап 4 (tester): модель повітропроводу (core/duct.ts) за «Критеріями готовності» — як чорна скринька.
 * Не дублює duct.test.ts: тут усі діаметри зі списку, усі типи поворотів (X→Z, X→Y вгору/вниз, Y→Z, …),
 * прямокутні різних пропорцій, перенесення рамки (незалежна перевірка поворотом Родріга),
 * переходи на першому/останньому/кількох відрізках поспіль, «потрібно / є», крайові випадки
 * (2 точки, відрізок без повороту, відхилення в межах допуску 0,1 мм, нульовий відрізок, 1000 точок).
 */
import { describe, expect, it } from 'vitest';
import {
  DUCT_DIAMETERS_MM,
  type DuctSection,
  type DuctSpec,
  ductLayout,
  isValidDuctSpec,
  isValidSection,
  pickDuctSegment,
  roundElbowPolyline,
  sectionsBySegment,
  segmentFrames,
  transitionLengthMm,
  withoutTransition,
  withRouteDuct,
  withSection,
  withTransition,
} from '../../src/core/duct.ts';
import { addRoute, emptyRouteSet, isValidRoute, type P3 } from '../../src/core/route.ts';

const TOL = 0.1; // мм — точність координат за CLAUDE.md
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
const NX = mul(X, -1);
const NY = mul(Y, -1);
const NZ = mul(Z, -1);
const NAMES: Array<[string, P3]> = [
  ['+X', X],
  ['−X', NX],
  ['+Y', Y],
  ['−Y', NY],
  ['+Z', Z],
  ['−Z', NZ],
];
const name = (d: P3) => NAMES.find(([, v]) => dist(v, d) < 1e-9)![0];

/** Траса з відрізків: старт + напрямки й довжини (мм). */
function build(start: P3, legs: Array<[P3, number]>): P3[] {
  const out = [start];
  for (const [d, l] of legs) out.push(add(out.at(-1)!, mul(d, l)));
  return out;
}

/** Повороти, які мають бути перевірені обов'язково (а також усі інші пари осей). */
const TURNS: Array<[P3, P3]> = [];
for (const [, a] of NAMES) for (const [, b] of NAMES) if (Math.abs(dot(a, b)) < 1e-9) TURNS.push([a, b]);

describe('Критерій: Ø200, відрізок 1000 мм', () => {
  for (const [label, d] of NAMES) {
    it(`уздовж ${label}: одна пряма 1000 мм від вузла до вузла, без колін і проблем`, () => {
      const nodes = build({ x: -1234.5, y: 2400, z: 777.7 }, [[d, 1000]]);
      const layout = ductLayout(nodes, spec(round(200)));
      expect(layout.straights).toHaveLength(1);
      expect(layout.elbows).toHaveLength(0);
      expect(layout.transitions).toHaveLength(0);
      expect(layout.problems).toEqual([]);
      const s = layout.straights[0]!;
      expect(Math.abs(s.lengthMm - 1000)).toBeLessThanOrEqual(TOL);
      expect(dist(s.from, nodes[0]!)).toBeLessThanOrEqual(TOL);
      expect(dist(s.to, nodes[1]!)).toBeLessThanOrEqual(TOL);
      expect(s.section).toEqual(round(200));
    });
  }
});

describe('Критерій: коліна R = D, 4 сегменти, вісь на трасі — усі діаметри й усі повороти', () => {
  const LEG = 2000;
  for (const D of DUCT_DIAMETERS_MM) {
    it(`Ø${D}: на кожному з 24 поворотів R = D, кінці коліна на трасі, ламана з 4 сегментів у площині повороту`, () => {
      for (const [a, b] of TURNS) {
        const nodes = build({ x: 100, y: 1500, z: -300 }, [
          [a, LEG],
          [b, LEG],
        ]);
        const layout = ductLayout(nodes, spec(round(D)));
        const tag = `${name(a)}→${name(b)}`;
        expect(layout.problems, tag).toEqual([]);
        expect(layout.elbows, tag).toHaveLength(1);
        const e = layout.elbows[0]!;
        expect(e.node).toBe(1);
        expect(e.radiusMm, tag).toBe(D);
        expect(e.section).toEqual(round(D));
        // Кінці коліна — на осі траси на відстані R від вузла.
        expect(dist(e.start, sub(nodes[1]!, mul(a, D))), tag).toBeLessThanOrEqual(TOL);
        expect(dist(e.end, add(nodes[1]!, mul(b, D))), tag).toBeLessThanOrEqual(TOL);
        // Прямі коротшають рівно на R і стикуються з колінами.
        const [s0, s1] = layout.straights;
        expect(Math.abs(s0!.lengthMm - (LEG - D)), tag).toBeLessThanOrEqual(TOL);
        expect(Math.abs(s1!.lengthMm - (LEG - D)), tag).toBeLessThanOrEqual(TOL);
        expect(dist(s0!.from, nodes[0]!)).toBeLessThanOrEqual(TOL);
        expect(dist(s0!.to, e.start), tag).toBeLessThanOrEqual(TOL);
        expect(dist(s1!.from, e.end), tag).toBeLessThanOrEqual(TOL);
        expect(dist(s1!.to, nodes[2]!)).toBeLessThanOrEqual(TOL);

        const pts = roundElbowPolyline(e);
        expect(pts, tag).toHaveLength(5);
        const n = cross(a, b);
        // Уся ламана — у площині повороту (через вузол).
        for (const p of pts) expect(Math.abs(dot(sub(p, nodes[1]!), n)), tag).toBeLessThanOrEqual(TOL);
        // Напрямки сегментів: 0°, 30°, 60°, 90° від входу (стики по 30°; крайні — половинки).
        const dirs = pts.slice(1).map((p, i) => unit(sub(p, pts[i]!)));
        const angle = (u: P3) => (Math.atan2(dot(u, b), dot(u, a)) * 180) / Math.PI;
        expect(dirs.map((u) => Math.round(angle(u) * 1e6) / 1e6 + 0), tag).toEqual([0, 30, 60, 90]);
        // Довжини: половинка R·tg15°, цілі 2R·tg15°.
        const t15 = Math.tan(Math.PI / 12);
        const lens = pts.slice(1).map((p, i) => dist(p, pts[i]!));
        expect(Math.abs(lens[0]! - D * t15)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(lens[1]! - 2 * D * t15)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(lens[2]! - 2 * D * t15)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(lens[3]! - D * t15)).toBeLessThanOrEqual(TOL);
        // Середини сегментів (точки дотику) — рівно на радіусі R від центру дуги.
        const centre = add(sub(nodes[1]!, mul(a, D)), mul(b, D));
        expect(dist(e.centre, centre), tag).toBeLessThanOrEqual(TOL);
        for (let i = 1; i < 3; i++) {
          const mid = mul(add(pts[i]!, pts[i + 1]!), 0.5);
          expect(Math.abs(dist(mid, centre) - D), tag).toBeLessThanOrEqual(TOL);
        }
      }
    });
  }
});

describe('Критерій: прямокутні — внутрішній радіус 100 мм, R по осі = 100 + B/2', () => {
  const SIZES: Array<[number, number]> = [
    [500, 300],
    [300, 500],
    [200, 800],
    [1000, 100],
    [50, 50],
    [3000, 50],
  ];
  for (const [W, H] of SIZES) {
    it(`${W}×${H}: на першому повороті з горизонталі — B = Ш у горизонталі, B = В угору/вниз`, () => {
      for (const [a, b] of TURNS) {
        if (Math.abs(a.y) > 0.5) continue; // перша ділянка горизонтальна — рамка визначена правилом «висота вертикально»
        const nodes = build({ x: 0, y: 2000, z: 0 }, [
          [a, 5000],
          [b, 5000],
        ]);
        const layout = ductLayout(nodes, spec(rect(W, H)));
        const e = layout.elbows[0]!;
        const tag = `${W}×${H} ${name(a)}→${name(b)}`;
        const B = Math.abs(b.y) > 0.5 ? H : W;
        expect(e.radiusMm, tag).toBe(100 + B / 2);
        expect(dist(e.start, sub(nodes[1]!, mul(a, e.radiusMm)))).toBeLessThanOrEqual(TOL);
        expect(dist(e.end, add(nodes[1]!, mul(b, e.radiusMm)))).toBeLessThanOrEqual(TOL);
        expect(Math.abs(layout.straights[0]!.lengthMm - (5000 - e.radiusMm))).toBeLessThanOrEqual(TOL);
      }
    });
  }

  it('траса починається вертикально: ширина вздовж X; поворот на X — повертає Ш, на Z — В', () => {
    for (const up of [Y, NY]) {
      for (const [b, side] of [
        [X, 'W'],
        [NX, 'W'],
        [Z, 'H'],
        [NZ, 'H'],
      ] as const) {
        const nodes = build({ x: 0, y: 1000, z: 0 }, [
          [up, 3000],
          [b, 3000],
        ]);
        const e = ductLayout(nodes, spec(rect(600, 200))).elbows[0]!;
        expect(e.radiusMm, `${name(up)}→${name(b)}`).toBe(100 + (side === 'W' ? 300 : 100));
      }
    }
  });
});

describe('Критерій: переріз прямокутної труби повертається з колінами правильно (незалежна перевірка)', () => {
  /** Поворот вектора w навколо одиничної осі k на кут θ (формула Родріга). */
  const rotate = (w: P3, k: P3, theta: number): P3 =>
    add(add(mul(w, Math.cos(theta)), mul(cross(k, w), Math.sin(theta))), mul(k, dot(k, w) * (1 - Math.cos(theta))));

  /** Детермінований генератор випадкових чисел (тест відтворюється). */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('200 випадкових трас по 40 поворотів 90°: рамка = попередня, повернута на 90° навколо «вхід × вихід»', () => {
    const rand = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const dirs: P3[] = [NAMES[Math.floor(rand() * 6)]![1]];
      while (dirs.length < 40) {
        const prev = dirs.at(-1)!;
        const options = NAMES.map(([, v]) => v).filter((v) => Math.abs(dot(v, prev)) < 1e-9);
        dirs.push(options[Math.floor(rand() * options.length)]!);
      }
      const frames = segmentFrames(dirs);
      expect(frames).toHaveLength(dirs.length);
      for (let i = 1; i < dirs.length; i++) {
        const k = cross(dirs[i - 1]!, dirs[i]!);
        const u = rotate(frames[i - 1]!.u, k, Math.PI / 2);
        const v = rotate(frames[i - 1]!.v, k, Math.PI / 2);
        expect(dist(frames[i]!.u, u), `проба ${trial}, відрізок ${i}`).toBeLessThan(1e-9);
        expect(dist(frames[i]!.v, v), `проба ${trial}, відрізок ${i}`).toBeLessThan(1e-9);
        // Права трійка (u, v, вісь) зберігається — переріз не «дзеркалиться».
        expect(dot(cross(frames[i]!.u, frames[i]!.v), dirs[i]!)).toBeCloseTo(dot(cross(frames[0]!.u, frames[0]!.v), dirs[0]!), 9);
      }
    }
  });

  it('перша горизонтальна ділянка в будь-якому напрямку: В — вертикально, Ш — горизонтально ⟂ осі', () => {
    for (const d of [X, NX, Z, NZ]) {
      const [f] = segmentFrames([d]);
      expect(Math.abs(f!.v.y)).toBe(1);
      expect(Math.abs(dot(f!.u, d))).toBe(0);
      expect(f!.u.y).toBe(0);
    }
  });

  it('після «вгору, потім убік» труба лежить на боці: Ш — вертикально; після «вгору, потім назад у той самий бік» — знову В вертикально', () => {
    const side = segmentFrames([X, Y, Z]);
    expect(Math.abs(side[2]!.u.y)).toBe(1);
    const back = segmentFrames([X, Y, X]);
    expect(Math.abs(back[2]!.v.y)).toBe(1);
  });
});

describe('Критерій: переходи — на початку вибраного відрізка, довжина за правилом, далі новий розмір', () => {
  const L15 = (delta: number) => Math.max(100, delta / (2 * Math.tan(Math.PI / 12)));

  it('довжина: L = max(100; ΔD / (2·tg 15°)) для всіх пар діаметрів зі списку', () => {
    for (const d1 of DUCT_DIAMETERS_MM) {
      for (const d2 of DUCT_DIAMETERS_MM) {
        if (d1 === d2) continue;
        expect(Math.abs(transitionLengthMm(round(d1), round(d2)) - L15(Math.abs(d1 - d2)))).toBeLessThanOrEqual(TOL);
        // ≈ 1,87 × ΔD, коли більше за 100 мм.
        if (Math.abs(d1 - d2) > 60) expect(transitionLengthMm(round(d1), round(d2)) / Math.abs(d1 - d2)).toBeCloseTo(1.866, 2);
      }
    }
  });

  it('прямокутні: L за найбільшою різницею сторін (нахил найкрутішої стінки 15°)', () => {
    expect(transitionLengthMm(rect(800, 400), rect(600, 300))).toBeCloseTo(L15(200), 6);
    expect(transitionLengthMm(rect(600, 300), rect(600, 700))).toBeCloseTo(L15(400), 6);
    expect(transitionLengthMm(rect(600, 300), rect(610, 300))).toBe(100);
  });

  it('перехід посередині: після коліна старого розміру; наступне коліно — нового; пряма = довжина − R − L − R', () => {
    for (const [a, b, c] of [
      [X, Z, Y],
      [X, NY, Z],
      [Z, Y, NX],
      [Y, X, NZ],
    ] as const) {
      const nodes = build({ x: 0, y: 1000, z: 0 }, [
        [a, 2000],
        [b, 3000],
        [c, 2000],
      ]);
      const layout = ductLayout(nodes, spec(round(160), [{ segment: 1, to: round(400) }]));
      const tag = `${name(a)}→${name(b)}→${name(c)}`;
      const [e1, e2] = layout.elbows;
      expect(e1!.radiusMm, tag).toBe(160);
      expect(e1!.section).toEqual(round(160));
      expect(e2!.radiusMm, tag).toBe(400);
      expect(e2!.section).toEqual(round(400));
      expect(layout.transitions).toHaveLength(1);
      const t = layout.transitions[0]!;
      const L = L15(240);
      expect(Math.abs(t.lengthMm - L)).toBeLessThanOrEqual(TOL);
      expect(dist(t.from, e1!.end), tag).toBeLessThanOrEqual(TOL);
      expect(dist(t.from, add(nodes[1]!, mul(b, 160))), tag).toBeLessThanOrEqual(TOL);
      expect(dist(t.to, add(nodes[1]!, mul(b, 160 + L))), tag).toBeLessThanOrEqual(TOL);
      expect(t.fromSection).toEqual(round(160));
      expect(t.toSection).toEqual(round(400));
      const s1 = layout.straights.find((s) => s.segment === 1)!;
      expect(s1.section).toEqual(round(400));
      expect(Math.abs(s1.lengthMm - (3000 - 160 - L - 400)), tag).toBeLessThanOrEqual(TOL);
      expect(dist(s1.from, t.to)).toBeLessThanOrEqual(TOL);
      expect(dist(s1.to, e2!.start)).toBeLessThanOrEqual(TOL);
      // Відрізки до переходу — старого розміру, після — нового.
      expect(layout.straights.find((s) => s.segment === 0)!.section).toEqual(round(160));
      expect(layout.straights.find((s) => s.segment === 2)!.section).toEqual(round(400));
    }
  });

  it('перехід на першому відрізку — від першої точки траси; на останньому — одразу після останнього коліна', () => {
    const nodes = build({ x: 0, y: 1000, z: 0 }, [
      [X, 2000],
      [Z, 2000],
      [NY, 2000],
    ]);
    const first = ductLayout(nodes, spec(round(450), [{ segment: 0, to: round(200) }]));
    expect(dist(first.transitions[0]!.from, nodes[0]!)).toBeLessThanOrEqual(TOL);
    expect(first.transitions[0]!.fromSection).toEqual(round(450));
    expect(first.elbows.map((e) => e.radiusMm)).toEqual([200, 200]);
    expect(Math.abs(first.straights[0]!.lengthMm - (2000 - L15(250) - 200))).toBeLessThanOrEqual(TOL);

    const last = ductLayout(nodes, spec(round(200), [{ segment: 2, to: round(100) }]));
    const t = last.transitions[0]!;
    expect(last.elbows.map((e) => e.radiusMm)).toEqual([200, 200]);
    expect(dist(t.from, last.elbows[1]!.end)).toBeLessThanOrEqual(TOL);
    const s = last.straights.find((x) => x.segment === 2)!;
    expect(s.section).toEqual(round(100));
    expect(dist(s.to, nodes[3]!)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(s.lengthMm - (2000 - 200 - L15(100)))).toBeLessThanOrEqual(TOL);
  });

  it('кілька переходів поспіль (на відрізках 1, 2, 3): кожен від розміру попереднього', () => {
    const nodes = build({ x: 0, y: 1000, z: 0 }, [
      [X, 3000],
      [Z, 3000],
      [X, 3000],
      [Z, 3000],
    ]);
    const s = spec(round(200), [
      { segment: 1, to: round(250) },
      { segment: 2, to: round(315) },
      { segment: 3, to: round(400) },
    ]);
    expect(isValidDuctSpec(s, 4)).toBe(true);
    const layout = ductLayout(nodes, s);
    expect(layout.transitions.map((t) => [t.fromSection, t.toSection])).toEqual([
      [round(200), round(250)],
      [round(250), round(315)],
      [round(315), round(400)],
    ]);
    expect(layout.elbows.map((e) => e.radiusMm)).toEqual([200, 250, 315]);
    expect(sectionsBySegment(s, 4)).toEqual([round(200), round(250), round(315), round(400)]);
    expect(layout.problems).toEqual([]);
    for (const t of layout.transitions) {
      const e = layout.elbows.find((x) => x.node === t.segment)!;
      expect(dist(t.from, e.end)).toBeLessThanOrEqual(TOL);
    }
  });

  it('траса з 2 точок і переходом: перехід від першої точки, далі новий розмір до кінця', () => {
    const nodes = build({ x: 0, y: 1000, z: 0 }, [[Z, 1500]]);
    const layout = ductLayout(nodes, spec(round(315), [{ segment: 0, to: round(160) }]));
    expect(layout.elbows).toEqual([]);
    expect(dist(layout.transitions[0]!.from, nodes[0]!)).toBeLessThanOrEqual(TOL);
    const L = L15(155);
    expect(Math.abs(layout.straights[0]!.lengthMm - (1500 - L))).toBeLessThanOrEqual(TOL);
    expect(layout.straights[0]!.section).toEqual(round(160));
    expect(layout.problems).toEqual([]);
  });

  it('прямокутний перехід перед поворотом: коліно після переходу рахується від нової сторони', () => {
    const nodes = build({ x: 0, y: 1000, z: 0 }, [
      [X, 3000],
      [Z, 3000],
      [Y, 3000],
    ]);
    const layout = ductLayout(nodes, spec(rect(600, 300), [{ segment: 1, to: rect(400, 500) }]));
    // Коліно 1 (X→Z, горизонталь): старий розмір, повертає Ш 600 → R = 400.
    expect(layout.elbows[0]!.radiusMm).toBe(400);
    // Коліно 2 (Z→Y, вгору): новий розмір, повертає В 500 → R = 350.
    expect(layout.elbows[1]!.radiusMm).toBe(350);
    expect(layout.transitions[0]!.lengthMm).toBeCloseTo(L15(200), 6);
  });
});

describe('Критерій: закороткий відрізок — проблема з правильними «потрібно / є»', () => {
  it('між двома колінами Ø: потрібно 2·D, є довжина; рівно 2·D — ще вміщається', () => {
    for (const D of DUCT_DIAMETERS_MM) {
      const mk = (mid: number) =>
        build({ x: 0, y: 1500, z: 0 }, [
          [X, 2000],
          [Z, mid],
          [X, 2000],
        ]);
      expect(ductLayout(mk(2 * D), spec(round(D))).problems, `Ø${D} рівно`).toEqual([]);
      expect(ductLayout(mk(2 * D - 0.05), spec(round(D))).problems, `Ø${D} −0,05`).toEqual([]);
      const p = ductLayout(mk(2 * D - 1), spec(round(D))).problems;
      expect(p).toHaveLength(1);
      expect(p[0]!.segment).toBe(1);
      expect(Math.abs(p[0]!.needMm - 2 * D)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(p[0]!.haveMm - (2 * D - 1))).toBeLessThanOrEqual(TOL);
    }
  });

  it('з переходом: потрібно R(старий) + L + R(новий)', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 2000],
      [Z, 800],
      [X, 2000],
    ]);
    const p = ductLayout(nodes, spec(round(200), [{ segment: 1, to: round(450) }])).problems;
    const L = 250 / (2 * Math.tan(Math.PI / 12));
    expect(p).toHaveLength(1);
    expect(p[0]!.segment).toBe(1);
    expect(Math.abs(p[0]!.needMm - (200 + L + 450))).toBeLessThanOrEqual(TOL);
    expect(p[0]!.haveMm).toBe(800);
  });

  it('перший і останній відрізки: коліно лише з одного боку', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 150],
      [Z, 2000],
      [X, 199],
    ]);
    const p = ductLayout(nodes, spec(round(200))).problems;
    expect(p.map((x) => [x.segment, x.needMm, x.haveMm])).toEqual([
      [0, 200, 150],
      [2, 200, 199],
    ]);
  });

  it('траса з 2 точок, перехід довший за відрізок: потрібно L, є довжина', () => {
    const nodes = build({ x: 0, y: 1500, z: 0 }, [[X, 300]]);
    const p = ductLayout(nodes, spec(round(100), [{ segment: 0, to: round(450) }])).problems;
    expect(p).toHaveLength(1);
    expect(Math.abs(p[0]!.needMm - 350 / (2 * Math.tan(Math.PI / 12)))).toBeLessThanOrEqual(TOL);
    expect(p[0]!.haveMm).toBe(300);
  });

  it('прямокутні: потрібно (100 + B1/2) + (100 + B2/2), де B — сторона в площині кожного повороту', () => {
    // 600×300: X→Z (Ш у площині) R = 400; Z→Y (В у площині) R = 250 → потрібно 650 мм.
    const nodes = build({ x: 0, y: 1000, z: 0 }, [
      [X, 2000],
      [Z, 600],
      [Y, 2000],
    ]);
    const p = ductLayout(nodes, spec(rect(600, 300))).problems;
    expect(p).toEqual([{ segment: 1, needMm: 650, haveMm: 600 }]);
  });
});

describe('Крайові випадки моделі', () => {
  it('траса з 2 точок: лише пряма, без колін', () => {
    const nodes = build({ x: 0, y: 0, z: 0 }, [[Y, 2500]]);
    const layout = ductLayout(nodes, spec(rect(400, 200)));
    expect(layout.elbows).toEqual([]);
    expect(layout.straights).toHaveLength(1);
    expect(layout.straights[0]!.lengthMm).toBe(2500);
  });

  it('порожня траса й траса з 1 точки — без деталей і без помилок', () => {
    expect(ductLayout([], spec(round(200)))).toMatchObject({ straights: [], elbows: [], transitions: [], problems: [] });
    expect(ductLayout([{ x: 0, y: 0, z: 0 }], spec(round(200)))).toMatchObject({ straights: [], elbows: [] });
  });

  it('нульовий відрізок (дві однакові точки) — зрозуміла помилка RangeError, а не NaN у геометрії', () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ];
    expect(isValidRoute(nodes)).toBe(false);
    expect(() => ductLayout(nodes, spec(round(200)))).toThrow(RangeError);
  });

  it('вузол без повороту (траса йде далі прямо — так дозволяє «Траса»): без коліна, повітропровід суцільний', () => {
    // Редактор траси дозволяє підтвердити точку посередині й тягнути далі в тому самому напрямку.
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [X, 1000],
      [X, 1000],
    ]);
    expect(isValidRoute(nodes)).toBe(true);
    const layout = ductLayout(nodes, spec(round(200)));
    expect(layout.elbows, 'у вузлі без повороту коліна не має бути').toEqual([]);
    const total = layout.straights.reduce((sum, s) => sum + s.lengthMm, 0);
    expect(Math.abs(total - 2000), 'прямі мають покривати всю трасу без щілини').toBeLessThanOrEqual(TOL);
    expect(layout.problems).toEqual([]);
  });

  it('вузол без повороту: рамка перерізу після нього не зникає (не нульова)', () => {
    const frames = segmentFrames([X, X, Z]);
    for (const f of frames) {
      expect(len(f.u), 'u').toBeCloseTo(1, 9);
      expect(len(f.v), 'v').toBeCloseTo(1, 9);
    }
  });

  it('відхилення вузла в межах допуску траси (0,05 мм) — траса за правилами, отже й повітропровід будується', () => {
    // isValidRoute приймає ±0,1 мм (NODE_TOLERANCE_MM) — такі траси можуть прийти з loadRoutes / збереженого файлу.
    const nodes = [
      { x: 0, y: 1500, z: 0 },
      { x: 1000, y: 1500.05, z: 0 },
      { x: 1000, y: 1500.05, z: 1000 },
    ];
    expect(isValidRoute(nodes)).toBe(true);
    expect(() => ductLayout(nodes, spec(round(200)))).not.toThrow();
  });

  it('1000 точок (999 колін): розкладання < 100 мс, без проблем', () => {
    const legs: Array<[P3, number]> = [];
    for (let i = 0; i < 999; i++) legs.push([i % 2 === 0 ? X : Z, 600]);
    const nodes = build({ x: 0, y: 2000, z: 0 }, legs);
    const t0 = performance.now();
    const layout = ductLayout(nodes, spec(round(200)));
    expect(performance.now() - t0).toBeLessThan(100);
    expect(layout.elbows).toHaveLength(998);
    expect(layout.straights).toHaveLength(999);
    expect(layout.problems).toEqual([]);
  });

  it('довгий прямокутний «серпантин» вгору-вниз-убік (600 точок): рамки одиничні й ⟂ осі на всій довжині', () => {
    const cycle = [X, Y, Z, NY, X, NY, NZ, Y];
    const dirs: P3[] = [];
    for (let i = 0; i < 600; i++) dirs.push(cycle[i % cycle.length]!);
    const frames = segmentFrames(dirs);
    frames.forEach((f, i) => {
      expect(Math.abs(dot(f.u, dirs[i]!))).toBeLessThan(1e-9);
      expect(Math.abs(dot(f.v, dirs[i]!))).toBeLessThan(1e-9);
      expect(Math.abs(dot(f.u, f.v))).toBeLessThan(1e-9);
      expect(len(f.u)).toBeCloseTo(1, 9);
      expect(len(f.v)).toBeCloseTo(1, 9);
    });
  });
});

describe('Специфікація: переходи й зміна розміру траси', () => {
  it('перехід, потім зміна розміру тієї самої форми: перехід лишається; на той самий розмір — зникає', () => {
    let s = withSection(null, round(200));
    s = withTransition(s, 1, round(315), 3);
    s = withSection(s, round(250));
    expect(sectionsBySegment(s, 3)).toEqual([round(250), round(315), round(315)]);
    s = withSection(s, round(315));
    expect(s.transitions).toEqual([]);
    expect(sectionsBySegment(s, 3)).toEqual([round(315), round(315), round(315)]);
  });

  it('зміна форми прибирає всі переходи', () => {
    let s = withSection(null, rect(500, 300));
    s = withTransition(s, 1, rect(400, 300), 3);
    s = withTransition(s, 2, rect(300, 300), 3);
    expect(s.transitions).toHaveLength(2);
    const r = withSection(s, round(200));
    expect(r).toEqual({ section: round(200), transitions: [] });
    expect(withSection(r, rect(500, 300)).transitions).toEqual([]);
  });

  it('прибрати перехід посередині: далі розмір того, що був до нього; наступний перехід лишається, якщо він на інший розмір', () => {
    let s = withSection(null, round(200));
    s = withTransition(s, 1, round(250), 4);
    s = withTransition(s, 2, round(315), 4);
    s = withoutTransition(s, 1);
    expect(sectionsBySegment(s, 4)).toEqual([round(200), round(200), round(315), round(315)]);
  });

  it('прибрати неіснуючий перехід — нічого не змінюється', () => {
    const s = withTransition(withSection(null, round(200)), 1, round(250), 3);
    expect(withoutTransition(s, 2)).toEqual(s);
  });

  it('перехід на «той самий розмір» у прямокутних — RangeError (інтерфейс має показати пояснення)', () => {
    const s = withSection(null, rect(500, 300));
    expect(() => withTransition(s, 1, rect(500, 300), 3)).toThrow(RangeError);
  });

  it('межі прямокутних: 50…3000 включно; дробові, 0, від’ємні, NaN, Infinity — ні', () => {
    for (const ok of [50, 51, 3000, 1234]) expect(isValidSection(rect(ok, ok))).toBe(true);
    for (const bad of [0, 10, 49.9, 3000.1, 3001, -500, Number.NaN, Infinity]) {
      expect(isValidSection(rect(bad, 300)), String(bad)).toBe(false);
      expect(isValidSection(rect(300, bad)), String(bad)).toBe(false);
    }
  });

  it('withRouteDuct: NaN у розмірі чи переході — RangeError, набір трас не змінюється', () => {
    const nodes = build({ x: 0, y: 0, z: 0 }, [
      [X, 1000],
      [Z, 1000],
    ]);
    const set = addRoute(emptyRouteSet(), nodes).set;
    expect(() => withRouteDuct(set, 1, spec(round(Number.NaN)))).toThrow(RangeError);
    expect(() => withRouteDuct(set, 1, spec(rect(500, Number.NaN)))).toThrow(RangeError);
    expect(() => withRouteDuct(set, 1, spec(round(200), [{ segment: Number.NaN, to: round(250) }]))).toThrow(RangeError);
    expect(() => withRouteDuct(set, 1, spec(round(200), [{ segment: 1, to: round(Number.NaN) }]))).toThrow(RangeError);
    expect(set.routes[0]!.duct).toBeUndefined();
  });
});

describe('Вибір відрізка дотиком, коли труби перекриваються', () => {
  const routes = () => {
    // Дві паралельні траси вздовж X: ближча до камери (z = 1000, Ø100) і дальня (z = 0, Ø450).
    const near = build({ x: 0, y: 2000, z: 1000 }, [
      [X, 2000],
      [NY, 1000],
    ]);
    const far = build({ x: 0, y: 2000, z: 0 }, [
      [X, 2000],
      [Y, 500],
    ]);
    let set = addRoute(emptyRouteSet(), near).set;
    set = addRoute(set, far).set;
    set = withRouteDuct(set, 1, spec(round(100)));
    set = withRouteDuct(set, 2, spec(round(450)));
    return set.routes;
  };
  const back = { x: 0, y: 0, z: -1 };

  it('промінь проходить крізь обидві — вибирається ближча до камери', () => {
    expect(pickDuctSegment({ x: 1000, y: 2000, z: 5000 }, back, routes())).toEqual({ routeId: 1, segment: 0 });
  });

  it('промінь повз тонку ближню, але крізь товсту дальню — дальня', () => {
    // 150 мм над віссю: повз Ø100 (+30 мм запасу), але всередині Ø450.
    expect(pickDuctSegment({ x: 1000, y: 2150, z: 5000 }, back, routes())).toEqual({ routeId: 2, segment: 0 });
  });

  it('траси позаду камери не вибираються', () => {
    expect(pickDuctSegment({ x: 1000, y: 2000, z: -2000 }, back, routes())).toBeNull();
  });

  it('у вузлі (коліно) вибирається один із двох відрізків цього коліна, а не інша траса', () => {
    const hit = pickDuctSegment({ x: 2000, y: 2000, z: 5000 }, back, routes());
    expect(hit?.routeId).toBe(1);
    expect([0, 1]).toContain(hit?.segment);
  });

  it('після переходу на більший розмір дотик по товстій частині вибирає відрізок (запас — від нового розміру)', () => {
    const nodes = build({ x: 0, y: 2000, z: 0 }, [
      [X, 2000],
      [Z, 3000],
    ]);
    let set = addRoute(emptyRouteSet(), nodes).set;
    set = withRouteDuct(set, 1, spec(round(100), [{ segment: 1, to: round(450) }]));
    // Згори, на 200 мм убік від осі відрізка 2 (Ø450 → радіус 225).
    expect(pickDuctSegment({ x: 2200, y: 9000, z: 2000 }, { x: 0, y: -1, z: 0 }, set.routes)).toEqual({ routeId: 1, segment: 1 });
  });

  it('запас на палець функцією від відстані по променю (мм): отримує відстань до труби; далека труба — більший запас', () => {
    const seen: number[] = [];
    const slack = (t: number) => {
      seen.push(t);
      return t * 0.01; // 1 % відстані — як «пікселі на екрані» далі від камери
    };
    // Траса 1: Ø100 на відстані 5 м від камери; промінь проходить на 90 мм від осі (50 + 0,01·5000 = 100 ≥ 90).
    expect(pickDuctSegment({ x: 1000, y: 2090, z: 6000 }, back, routes(), slack)).toEqual({ routeId: 1, segment: 0 });
    expect(seen.some((t) => Math.abs(t - 5000) < 1)).toBe(true);
    // Сталий запас 30 мм: той самий промінь повз Ø100 (90 > 80) — потрапляє вже в Ø450 дальньої траси.
    expect(pickDuctSegment({ x: 1000, y: 2090, z: 6000 }, back, routes(), 30)).toEqual({ routeId: 2, segment: 0 });
  });
});
