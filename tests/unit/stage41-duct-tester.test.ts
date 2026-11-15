/**
 * Етап 4.1 (tester): повітропровід на поворотах 45° і на діагональних відрізках — перевірка «від вимог».
 *
 * Критерії: коліно 45° Ø200 — радіус по осі 200 мм, 3 сегменти, вісь коліна на трасі (±0,1 мм), пряма ділянка
 * коротша на R · tg 22,5°. Тут — усі 10 діаметрів, усі дозволені повороти, де є хоч один діагональний
 * відрізок (45° і 90°, у площинах XZ, XY, ZY), стики без щілин і перекриттів (дані й 3D), переходи на
 * діагоналях і біля колін 45°, прямокутні (рамка перерізу — незалежний розрахунок, позначка «не в площині
 * сторін»), довгі траси. Не дублює duct45.test.ts (там — по одному прикладу).
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import {
  DUCT_DIAMETERS_MM,
  type DuctLayout,
  type DuctSection,
  type DuctSpec,
  ductAxisLengthMm,
  ductLayout,
  elbowArcPoint,
  type Frame,
  pickDuctSegment,
  RECT_ELBOW_INNER_R_MM,
  roundElbowPolyline,
  transitionLengthMm,
  withTransition,
} from '../../src/core/duct.ts';
import { isValidRoute, type P3 } from '../../src/core/route.ts';
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
/** Відстань від точки до прямої через a у напрямку d (одиничний). */
const toLine = (p: P3, a: P3, d: P3) => len(cross(sub(p, a), d));

type Axis = 'X' | 'Y' | 'Z';
const KEY = { X: 'x', Y: 'y', Z: 'z' } as const;
interface Heading {
  name: string;
  /** Цілий вектор: складові 0 або ±1 (діагональ — дві ненульові). */
  v: P3;
  diagonal: boolean;
}
const s = (n: number) => (n > 0 ? '+' : '−');
const HEADINGS: Heading[] = [];
for (const a of ['X', 'Y', 'Z'] as Axis[]) {
  for (const sa of [1, -1]) HEADINGS.push({ name: `${a}${s(sa)}`, v: { x: 0, y: 0, z: 0, [KEY[a]]: sa } as P3, diagonal: false });
}
for (const [a, b] of [
  ['X', 'Y'],
  ['X', 'Z'],
  ['Y', 'Z'],
] as Array<[Axis, Axis]>) {
  for (const sa of [1, -1]) {
    for (const sb of [1, -1]) {
      HEADINGS.push({ name: `${a}${s(sa)}${b}${s(sb)}`, v: { x: 0, y: 0, z: 0, [KEY[a]]: sa, [KEY[b]]: sb } as P3, diagonal: true });
    }
  }
}
const angleDeg = (a: Heading, b: Heading) => Math.round((Math.acos(Math.max(-1, Math.min(1, dot(unit(a.v), unit(b.v))))) * 180) / Math.PI);

/** Усі дозволені повороти (45° чи 90°), де хоч один із відрізків — діагональ. */
const TURNS: Array<[Heading, Heading, number]> = [];
for (const a of HEADINGS) {
  for (const b of HEADINGS) {
    const angle = angleDeg(a, b);
    if ((angle === 45 || angle === 90) && (a.diagonal || b.diagonal)) TURNS.push([a, b, angle]);
  }
}

/** Траса з ніг: [напрямок, хід по кожній осі напрямку, мм] — вузли діагоналей рівно під 45°. */
function build(start: P3, legs: Array<[Heading, number]>): P3[] {
  const out = [start];
  for (const [h, k] of legs) out.push(add(out.at(-1)!, mul(h.v, k)));
  return out;
}

function vertices(geometry: BufferGeometry): P3[] {
  const pos = geometry.getAttribute('position');
  const out: P3[] = [];
  for (let i = 0; i < pos.count; i++) out.push({ x: mToMm(pos.getX(i)), y: mToMm(pos.getY(i)), z: mToMm(pos.getZ(i)) });
  return out;
}

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

const P0: P3 = { x: -812.5, y: 1650, z: 433.25 };

describe('етап 4.1 (tester): коліна на поворотах із діагоналями — модель, усі діаметри', () => {
  it('поворотів для перевірки: 45° (вісь ↔ діагональ) і 90° (вісь ↔ діагональ, діагональ ↔ діагональ) у всіх площинах', () => {
    expect(TURNS.filter(([, , a]) => a === 45)).toHaveLength(48);
    expect(TURNS.filter(([a, b, angle]) => angle === 90 && a.diagonal && b.diagonal)).toHaveLength(24);
    expect(TURNS.filter(([a, b, angle]) => angle === 90 && a.diagonal !== b.diagonal)).toHaveLength(48);
  });

  for (const D of DUCT_DIAMETERS_MM) {
    it(`Ø${D}: R = D; 45° — 3 сегменти, дотична R·tg 22,5°; 90° — 4 сегменти, дотична R; кінці коліна на трасі (±0,1 мм)`, () => {
      const errors: string[] = [];
      for (const [a, b, angle] of TURNS) {
        const tag = `Ø${D} ${a.name}→${b.name} (${angle}°)`;
        const nodes = build(P0, [
          [a, 1300],
          [b, 1100],
        ]);
        const layout = ductLayout(nodes, spec(round(D)));
        expect(layout.elbows, tag).toHaveLength(1);
        expect(layout.problems, tag).toEqual([]);
        expect(layout.oblique, tag).toEqual([]);
        const e = layout.elbows[0]!;
        const ua = unit(a.v);
        const ub = unit(b.v);
        const t = D * Math.tan((angle * Math.PI) / 360);
        const check = (ok: boolean, what: string) => {
          if (!ok) errors.push(`${tag}: ${what}`);
        };
        check(Math.abs(e.angleRad - (angle * Math.PI) / 180) < 1e-9, `кут ${(e.angleRad * 180) / Math.PI}`);
        check(e.radiusMm === D, `R = ${e.radiusMm}`);
        check(e.segments === (angle === 45 ? 3 : 4), `сегментів ${e.segments}`);
        check(Math.abs(e.tangentMm - t) < 1e-6, `дотична ${e.tangentMm}, очікувалось ${t}`);
        // Початок коліна — на першому відрізку (до вузла), кінець — на другому (після вузла).
        check(toLine(e.start, nodes[0]!, ua) <= TOL, 'початок коліна не на трасі');
        check(toLine(e.end, nodes[1]!, ub) <= TOL, 'кінець коліна не на трасі');
        check(Math.abs(dist(e.start, nodes[1]!) - t) <= TOL && dot(sub(nodes[1]!, e.start), ua) > 0, 'початок не за R·tg(кут/2) до вузла');
        check(Math.abs(dist(e.end, nodes[1]!) - t) <= TOL && dot(sub(e.end, nodes[1]!), ub) > 0, 'кінець не за R·tg(кут/2) після вузла');
        // Центр дуги: на відстані R від початку й кінця, перпендикулярно входу й виходу, у площині повороту.
        check(Math.abs(dist(e.centre, e.start) - D) <= TOL && Math.abs(dist(e.centre, e.end) - D) <= TOL, 'центр не на R від кінців');
        check(Math.abs(dot(sub(e.centre, e.start), ua)) <= TOL && Math.abs(dot(sub(e.centre, e.end), ub)) <= TOL, 'радіус не ⟂ осі');
        const n = unit(cross(ua, ub));
        // Ламана осі коліна: у площині повороту; вершини на R/cos(Δ/2); половинки на кінцях; уздовж входу й виходу.
        const pts = roundElbowPolyline(e);
        check(pts.length === e.segments + 1, `точок ламаної ${pts.length}`);
        const full = ((angle * Math.PI) / 180) / (e.segments - 1);
        for (const p of pts) check(Math.abs(dot(sub(p, nodes[1]!), n)) <= 1e-6, 'ламана не в площині повороту');
        for (const p of pts.slice(1, -1)) check(Math.abs(dist(p, e.centre) - D / Math.cos(full / 2)) <= 1e-6, 'вершина ламаної не на R/cos(Δ/2)');
        const lens = pts.slice(1).map((p, i) => dist(p, pts[i]!));
        lens.forEach((l, i) => {
          const want = (i === 0 || i === lens.length - 1 ? 1 : 2) * D * Math.tan(full / 2);
          check(Math.abs(l - want) <= 1e-6, `сегмент ${i + 1}: ${l}, очікувалось ${want}`);
        });
        check(dot(unit(sub(pts[1]!, pts[0]!)), ua) > 1 - 1e-9, 'перший сегмент не вздовж входу');
        check(dot(unit(sub(pts.at(-1)!, pts.at(-2)!)), ub) > 1 - 1e-9, 'останній сегмент не вздовж виходу');
        // Прямі: коротші на дотичну, стикуються з колінами без щілин і без перекриття.
        const [s0, s1] = layout.straights;
        check(layout.straights.length === 2, `прямих ${layout.straights.length}`);
        check(Math.abs(s0!.lengthMm - (dist(nodes[0]!, nodes[1]!) - t)) <= 1e-6, `пряма 1: ${s0!.lengthMm}`);
        check(Math.abs(s1!.lengthMm - (dist(nodes[1]!, nodes[2]!) - t)) <= 1e-6, `пряма 2: ${s1!.lengthMm}`);
        check(dist(s0!.from, nodes[0]!) <= 1e-6 && dist(s0!.to, e.start) <= 1e-6, 'пряма 1 не стикується з коліном');
        check(dist(s1!.from, e.end) <= 1e-6 && dist(s1!.to, nodes[2]!) <= 1e-6, 'пряма 2 не стикується з коліном');
        check(dot(s0!.dir, ua) > 1 - 1e-12 && dot(s1!.dir, ub) > 1 - 1e-12, 'напрямок прямої');
      }
      expect(errors).toEqual([]);
    });
  }

  it('коліно 90° між двома діагоналями (X+Z+ → X+Z−, X+Y+ → X−Y+, Y+Z− → Y−Z−): R = D, 4 сегменти, вхід/вихід — діагоналі', () => {
    const named = (n: string) => HEADINGS.find((h) => h.name === n)!;
    for (const [a, b] of [
      ['X+Z+', 'X+Z−'],
      ['X+Y+', 'X−Y+'],
      ['Y+Z−', 'Y−Z−'],
    ]) {
      const nodes = build(P0, [
        [named(a!), 1000],
        [named(b!), 1000],
      ]);
      const e = ductLayout(nodes, spec(round(250))).elbows[0]!;
      expect(Math.round((e.angleRad * 180) / Math.PI)).toBe(90);
      expect(e.segments).toBe(4);
      expect(e.tangentMm).toBeCloseTo(250, 9);
      expect(dot(e.dirIn, unit(named(a!).v))).toBeCloseTo(1, 12);
      expect(dot(e.dirOut, unit(named(b!).v))).toBeCloseTo(1, 12);
    }
  });

  it('довжина по осі: прямі + ламані колін (3 сегменти для 45°, 4 для 90°) — суцільна, без щілин і перекриттів', () => {
    const named = (n: string) => HEADINGS.find((h) => h.name === n)!;
    // Підйом під 45° у площині ZY, потім 90° між діагоналями, потім 45° на горизонталь і 90° униз.
    const nodes = build(P0, [
      [named('Z−'), 2000],
      [named('Y+Z−'), 800],
      [named('Y+Z+'), 600],
      [named('Z+'), 1500],
      [named('Y−'), 1200],
    ]);
    expect(isValidRoute(nodes)).toBe(true);
    const D = 315;
    const layout = ductLayout(nodes, spec(round(D)));
    expect(layout.elbows.map((e) => [Math.round((e.angleRad * 180) / Math.PI), e.segments])).toEqual([
      [45, 3],
      [90, 4],
      [45, 3],
      [90, 4],
    ]);
    expect(layout.problems).toEqual([]);
    // Ланцюжок деталей від першої точки до останньої: кожна починається там, де закінчилась попередня.
    const chain: Array<[P3, P3]> = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const st = layout.straights.find((x) => x.segment === i)!;
      chain.push([st.from, st.to]);
      const e = layout.elbows.find((x) => x.node === i + 1);
      if (e) chain.push([e.start, e.end]);
    }
    expect(dist(chain[0]![0], nodes[0]!)).toBeLessThan(1e-6);
    expect(dist(chain.at(-1)![1], nodes.at(-1)!)).toBeLessThan(1e-6);
    for (let i = 1; i < chain.length; i++) expect(dist(chain[i]![0], chain[i - 1]![1]), `стик ${i}`).toBeLessThan(1e-6);
    // Довжина по осі: траса мінус «зрізані кути» плюс ламані колін.
    let want = 0;
    for (let i = 1; i < nodes.length; i++) want += dist(nodes[i - 1]!, nodes[i]!);
    for (const e of layout.elbows) {
      const full = e.angleRad / (e.segments - 1);
      want += -2 * e.tangentMm + 2 * (e.segments - 1) * D * Math.tan(full / 2);
    }
    expect(ductAxisLengthMm(layout)).toBeCloseTo(want, 6);
  });

  it('вузли з похибкою до 0,05 мм (допуск траси) на діагоналях: коліна рівно 45°, без NaN', () => {
    const named = (n: string) => HEADINGS.find((h) => h.name === n)!;
    const nodes = build(P0, [
      [named('X+'), 1500],
      [named('X+Z−'), 900],
      [named('X+'), 1500],
    ]).map((p, i) => (i === 2 ? { ...p, x: p.x + 0.04, y: p.y - 0.05 } : p));
    expect(isValidRoute(nodes)).toBe(true);
    const layout = ductLayout(nodes, spec(round(200)));
    for (const e of layout.elbows) {
      expect((e.angleRad * 180) / Math.PI).toBeCloseTo(45, 9);
      for (const p of roundElbowPolyline(e)) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    }
  });
});

describe('етап 4.1 (tester): 3D-коліна на поворотах із діагоналями — стінки й стики', () => {
  for (const D of DUCT_DIAMETERS_MM) {
    it(`Ø${D}: кожна вершина сегмента коліна — на D/2 від його осі; стики коліно↔пряма і між сегментами — без щілин (±0,1 мм)`, () => {
      const errors: string[] = [];
      for (const [a, b, angle] of TURNS) {
        const tag = `Ø${D} ${a.name}→${b.name} (${angle}°)`;
        const nodes = build(P0, [
          [a, 1300],
          [b, 1100],
        ]);
        const layout = ductLayout(nodes, spec(round(D)));
        const e = layout.elbows[0]!;
        const axis = roundElbowPolyline(e);
        const pts = partVertices(nodes, layout, { elbows: [e] }, 0);
        const per = pts.length / e.segments;
        if (!Number.isInteger(per)) errors.push(`${tag}: вершин ${pts.length} не ділиться на ${e.segments}`);
        const segs = Array.from({ length: e.segments }, (_, k) => pts.slice(k * per, (k + 1) * per));
        segs.forEach((seg, k) => {
          const t = unit(sub(axis[k + 1]!, axis[k]!));
          const worst = Math.max(...seg.map((p) => Math.abs(toLine(p, axis[k]!, t) - D / 2)));
          if (worst > TOL) errors.push(`${tag}: сегмент ${k + 1} — відхилення від радіуса ${worst.toFixed(3)} мм`);
        });
        // Кільця на стиках: точки, що лежать на площині стику.
        const ringOn = (vs: P3[], at: P3, normal: P3) => vs.filter((p) => Math.abs(dot(sub(p, at), normal)) < 1e-3);
        const gap = (A: P3[], B: P3[]) => Math.max(...A.map((p) => Math.min(...B.map((q) => dist(p, q)))));
        const s0 = partVertices(nodes, layout, { straights: [layout.straights[0]!] }, 0);
        const s1 = partVertices(nodes, layout, { straights: [layout.straights[1]!] }, 1);
        const ua = unit(a.v);
        const ub = unit(b.v);
        const pairs: Array<[P3[], P3[], string]> = [
          [ringOn(s0, e.start, ua), ringOn(segs[0]!, e.start, ua), 'пряма → коліно'],
          [ringOn(s1, e.end, ub), ringOn(segs.at(-1)!, e.end, ub), 'коліно → пряма'],
        ];
        for (let k = 1; k < e.segments; k++) {
          const tPrev = unit(sub(axis[k]!, axis[k - 1]!));
          const tNext = unit(sub(axis[k + 1]!, axis[k]!));
          const plane = unit(add(tPrev, tNext));
          pairs.push([ringOn(segs[k - 1]!, axis[k]!, plane), ringOn(segs[k]!, axis[k]!, plane), `стик сегментів ${k}/${k + 1}`]);
        }
        for (const [A, B, which] of pairs) {
          if (A.length < 32 || B.length < 32) {
            errors.push(`${tag} ${which}: кільце не знайдено (${A.length}, ${B.length})`);
            continue;
          }
          const g = Math.max(gap(A, B), gap(B, A));
          if (g > TOL) errors.push(`${tag} ${which}: щілина/зсув ${g.toFixed(3)} мм`);
        }
      }
      expect(errors).toEqual([]);
    });
  }

  it('діагональна пряма Ø200 × 1414,2 мм: стінка рівно на 100 мм від осі, торці перпендикулярні осі', () => {
    for (const h of HEADINGS.filter((x) => x.diagonal)) {
      const nodes = build(P0, [[h, 1000]]);
      const geometry = buildDuctGeometry(nodes, ductLayout(nodes, spec(round(200))));
      const d = unit(h.v);
      for (const p of vertices(geometry)) {
        const along = dot(sub(p, nodes[0]!), d);
        expect(along, h.name).toBeGreaterThanOrEqual(-TOL);
        expect(along, h.name).toBeLessThanOrEqual(1000 * Math.SQRT2 + TOL);
        const r = toLine(p, nodes[0]!, d);
        expect(r, h.name).toBeLessThanOrEqual(100 + TOL);
        if (along > TOL && along < 1000 * Math.SQRT2 - TOL) expect(Math.abs(r - 100), h.name).toBeLessThanOrEqual(TOL);
      }
    }
  });
});

describe('етап 4.1 (tester): переходи на діагоналях і біля колін 45°', () => {
  const named = (n: string) => HEADINGS.find((h) => h.name === n)!;
  /** Оффсет у вертикальній площині: по Z, підйом Y+Z+, далі по Z. */
  const nodes = build(P0, [
    [named('Z+'), 2000],
    [named('Y+Z+'), 1000],
    [named('Z+'), 2000],
  ]);
  const t225 = Math.tan(Math.PI / 8);

  it('перехід на діагоналі: одразу після коліна 45° старого розміру; довжина за правилом; наступне коліно — нового розміру', () => {
    const duct = withTransition(spec(round(200)), 1, round(315), 3);
    const layout = ductLayout(nodes, duct);
    const [e1, e2] = layout.elbows;
    expect(e1!.section).toEqual(round(200));
    expect(e1!.tangentMm).toBeCloseTo(200 * t225, 9);
    expect(e2!.section).toEqual(round(315));
    expect(e2!.tangentMm).toBeCloseTo(315 * t225, 9);
    const tr = layout.transitions[0]!;
    expect(tr.segment).toBe(1);
    expect(dist(tr.from, e1!.end)).toBeLessThan(1e-6);
    expect(tr.lengthMm).toBeCloseTo(transitionLengthMm(round(200), round(315)), 9);
    expect(dot(tr.dir, unit(named('Y+Z+').v))).toBeCloseTo(1, 12);
    expect(toLine(tr.to, nodes[1]!, unit(named('Y+Z+').v))).toBeLessThan(1e-6);
    const st = layout.straights.find((x) => x.segment === 1)!;
    expect(st.section).toEqual(round(315));
    expect(dist(st.from, tr.to)).toBeLessThan(1e-6);
    expect(dist(st.to, e2!.start)).toBeLessThan(1e-6);
    expect(st.lengthMm).toBeCloseTo(1000 * Math.SQRT2 - 200 * t225 - tr.lengthMm - 315 * t225, 6);
    expect(layout.problems).toEqual([]);
    // 3D-конус уздовж діагоналі: радіус лінійно від 100 до 157,5, вісь на трасі.
    const pts = partVertices(nodes, layout, { transitions: [tr] }, 1);
    for (const p of pts) {
      const k = dot(sub(p, tr.from), tr.dir) / tr.lengthMm;
      expect(k).toBeGreaterThanOrEqual(-1e-3);
      expect(k).toBeLessThanOrEqual(1 + 1e-3);
      expect(Math.abs(toLine(p, tr.from, tr.dir) - (100 + k * 57.5))).toBeLessThanOrEqual(TOL);
    }
  });

  it('перехід на прямому відрізку після коліна 45°: від кінця коліна (розмір коліна — старий)', () => {
    const layout = ductLayout(nodes, withTransition(spec(round(250)), 2, round(160), 3));
    const e2 = layout.elbows[1]!;
    expect(e2.section).toEqual(round(250));
    const tr = layout.transitions[0]!;
    expect(dist(tr.from, e2.end)).toBeLessThan(1e-6);
    expect(dist(e2.end, nodes[2]!)).toBeCloseTo(250 * t225, 9);
    expect(layout.straights.find((x) => x.segment === 2)!.section).toEqual(round(160));
  });

  it('закоротка діагональ з переходом: потрібно R1·tg 22,5° + L + R2·tg 22,5°, є — довжина діагоналі', () => {
    const short = build(P0, [
      [named('Z+'), 2000],
      [named('Y+Z+'), 200],
      [named('Z+'), 2000],
    ]);
    const layout = ductLayout(short, withTransition(spec(round(200)), 1, round(400), 3));
    expect(layout.problems).toHaveLength(1);
    const p = layout.problems[0]!;
    expect(p.segment).toBe(1);
    expect(p.needMm).toBeCloseTo(200 * t225 + transitionLengthMm(round(200), round(400)) + 400 * t225, 6);
    expect(p.haveMm).toBeCloseTo(200 * Math.SQRT2, 6);
  });

  it('прямокутний перехід на діагоналі в горизонталі: рамка переходу — рамка відрізка (В вертикально)', () => {
    const flat = build(P0, [
      [named('X+'), 2000],
      [named('X+Z−'), 1200],
      [named('X+'), 2000],
    ]);
    const layout = ductLayout(flat, withTransition(spec(rect(600, 300)), 1, rect(400, 300), 3));
    const tr = layout.transitions[0]!;
    expect(Math.abs(tr.frame.v.y)).toBeCloseTo(1, 9);
    expect(dot(tr.frame.u, tr.dir)).toBeCloseTo(0, 9);
    const pts = partVertices(flat, layout, { transitions: [tr] }, 1);
    const ys = pts.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(P0.y - 150, 1);
    expect(Math.max(...ys)).toBeCloseTo(P0.y + 150, 1);
    // Ширина на початку 600, у кінці 400 — уздовж горизонталі ⟂ діагоналі.
    const across = unit(cross({ x: 0, y: 1, z: 0 }, tr.dir));
    const at = (k: number) => pts.filter((p) => Math.abs(dot(sub(p, tr.from), tr.dir) - k * tr.lengthMm) < 1e-3).map((p) => dot(sub(p, tr.from), across));
    expect(Math.max(...at(0)) - Math.min(...at(0))).toBeCloseTo(600, 1);
    expect(Math.max(...at(1)) - Math.min(...at(1))).toBeCloseTo(400, 1);
  });
});

describe('етап 4.1 (tester): прямокутні на поворотах 45°', () => {
  const named = (n: string) => HEADINGS.find((h) => h.name === n)!;

  /** Незалежна рамка перерізу: перша — «висота якнайвище», далі поворот Родріга на кут між відрізками. */
  function referenceFrames(dirs: P3[]): Frame[] {
    const Y = { x: 0, y: 1, z: 0 };
    const d0 = dirs[0]!;
    let v: P3;
    let u: P3;
    if (Math.abs(d0.y) > 0.999) {
      u = { x: 1, y: 0, z: 0 };
      v = cross(d0, u);
    } else {
      v = unit(sub(Y, mul(d0, d0.y)));
      u = cross(v, d0);
    }
    const out: Frame[] = [{ u, v }];
    for (let i = 1; i < dirs.length; i++) {
      const a = dirs[i - 1]!;
      const b = dirs[i]!;
      const c = dot(a, b);
      if (c > 0.999) {
        out.push(out.at(-1)!);
        continue;
      }
      const axb = cross(a, b);
      const sn = len(axb);
      const n = mul(axb, 1 / sn);
      const rot = (w: P3) => add(add(mul(w, c), mul(cross(n, w), sn)), mul(n, dot(n, w) * (1 - c)));
      const f = out.at(-1)!;
      out.push({ u: rot(f.u), v: rot(f.v) });
    }
    return out;
  }

  it('300 випадкових трас по 30 відрізків (осі й діагоналі): рамка = незалежний розрахунок; «не в площині сторін» — рівно там, де вісь повороту не паралельна стороні', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let obliqueSeen = 0;
    let plainSeen = 0;
    for (let trial = 0; trial < 300; trial++) {
      const legs: Array<[Heading, number]> = [];
      let previous: Heading | null = null;
      for (let k = 0; k < 30; k++) {
        const options = HEADINGS.filter((h) => !previous || [45, 90].includes(angleDeg(previous, h)));
        const h = options[Math.floor(rnd() * options.length)]!;
        legs.push([h, 2000]);
        previous = h;
      }
      const nodes = build(P0, legs);
      const layout = ductLayout(nodes, spec(rect(500, 300)));
      const ref = referenceFrames(legs.map(([h]) => unit(h.v)));
      layout.segments.forEach((seg, i) => {
        expect(dot(seg.frame.u, ref[i]!.u), `спроба ${trial}, відрізок ${i}`).toBeCloseTo(1, 6);
        expect(dot(seg.frame.v, ref[i]!.v), `спроба ${trial}, відрізок ${i}`).toBeCloseTo(1, 6);
      });
      const wantOblique: number[] = [];
      for (let k = 1; k < legs.length; k++) {
        const n = unit(cross(unit(legs[k - 1]![0].v), unit(legs[k]![0].v)));
        const f = ref[k - 1]!;
        if (Math.min(Math.abs(dot(f.u, n)), Math.abs(dot(f.v, n))) > 1e-6) wantOblique.push(k);
      }
      expect(layout.oblique, `спроба ${trial}`).toEqual(wantOblique);
      obliqueSeen += wantOblique.length;
      plainSeen += layout.elbows.length - wantOblique.length;
      // Радіус по осі коліна «в площині сторін»: 100 + половина сторони, що лежить у площині повороту.
      for (const e of layout.elbows) {
        if (layout.oblique.includes(e.node)) continue;
        const bendIsWidth = Math.abs(dot(e.frameIn.u, e.inward)) > 0.999;
        expect(e.radiusMm).toBe(RECT_ELBOW_INNER_R_MM + (bendIsWidth ? 250 : 150));
      }
    }
    // Обидва випадки справді зустрічались.
    expect(obliqueSeen).toBeGreaterThan(50);
    expect(plainSeen).toBeGreaterThan(1000);
  });

  it('підйом під 45° (X+ → X+Y+): радіус 100 + В/2; у 3D внутрішня стінка рівно на 100 мм від осі згину, боковини — на ±Ш/2', () => {
    const nodes = build(P0, [
      [named('X+'), 2000],
      [named('X+Y+'), 1000],
      [named('X+'), 2000],
    ]);
    const layout = ductLayout(nodes, spec(rect(500, 300)));
    expect(layout.oblique).toEqual([]);
    const e = layout.elbows[0]!;
    expect(e.radiusMm).toBe(100 + 150);
    expect(e.tangentMm).toBeCloseTo(250 * Math.tan(Math.PI / 8), 9);
    expect(dist(elbowArcPoint(e, e.angleRad), e.end)).toBeLessThan(1e-9);
    const pts = partVertices(nodes, layout, { elbows: [e] }, 0);
    // Вісь згину — паралельна Z через центр дуги.
    const radial = pts.map((p) => Math.hypot(p.x - e.centre.x, p.y - e.centre.y));
    expect(Math.min(...radial)).toBeCloseTo(100, 1);
    expect(Math.max(...radial)).toBeCloseTo(400, 1);
    const zs = pts.map((p) => p.z);
    expect(Math.min(...zs)).toBeCloseTo(P0.z - 250, 1);
    expect(Math.max(...zs)).toBeCloseTo(P0.z + 250, 1);
  });

  it('після 45° у горизонталі — підйом 90°: у площині сторін; далі поворот на X — «не в площині сторін» (поясненням)', () => {
    const nodes = build(P0, [
      [named('X+'), 2000],
      [named('X+Z+'), 1000],
      [named('Y+'), 2000],
      [named('X+'), 2000],
    ]);
    const layout = ductLayout(nodes, spec(rect(400, 200)));
    expect(layout.oblique).toEqual([3]);
    // Для круглої труби — звичайні коліна.
    expect(ductLayout(nodes, spec(round(200))).oblique).toEqual([]);
  });
});

describe('етап 4.1 (tester): довгі траси з діагоналями, вибір дотиком', () => {
  it('600 точок з поворотами 45° і 90° (круглі Ø450 і прямокутні 600×400): розкладання й 3D швидкі, без проблем і NaN', () => {
    let seed = 777;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const legs: Array<[Heading, number]> = [];
    let previous: Heading | null = null;
    while (legs.length < 599) {
      const options = HEADINGS.filter((h) => !previous || [45, 90].includes(angleDeg(previous, h)));
      const h = options[Math.floor(rnd() * options.length)]!;
      legs.push([h, 1500]);
      previous = h;
    }
    const nodes = build(P0, legs);
    expect(isValidRoute(nodes)).toBe(true);
    for (const section of [round(450), rect(600, 400)]) {
      const started = performance.now();
      const layout = ductLayout(nodes, spec(section));
      const geometry = buildDuctGeometry(nodes, layout);
      const elapsed = performance.now() - started;
      expect(layout.elbows).toHaveLength(598);
      expect(layout.problems).toEqual([]);
      expect(layout.elbows.filter((e) => e.segments === 3).length).toBeGreaterThan(100);
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i]!)) throw new Error(`NaN у вершині ${i}`);
      expect(elapsed).toBeLessThan(1500);
      geometry.dispose();
    }
  });

  it('дотик по діагональній трубі вибирає її відрізок; повз неї — нічого', () => {
    const named = (n: string) => HEADINGS.find((h) => h.name === n)!;
    const nodes = build({ x: 0, y: 1500, z: 0 }, [
      [named('X+'), 1000],
      [named('X+Z+'), 1000],
      [named('X+'), 1000],
    ]);
    const routes = [{ id: 4, nodes, duct: spec(round(200)) }];
    const mid = { x: 1500, y: 1500, z: 500 };
    // Згори вниз крізь середину діагоналі.
    expect(pickDuctSegment({ ...mid, y: 5000 }, { x: 0, y: -1, z: 0 }, routes, 0)).toEqual({ routeId: 4, segment: 1 });
    // Збоку від діагоналі на 300 мм (⟂ у горизонталі) — повз трубу Ø200.
    const off = add(mid, mul(unit({ x: 1, y: 0, z: -1 }), 300));
    expect(pickDuctSegment({ ...off, y: 5000 }, { x: 0, y: -1, z: 0 }, routes, 0)).toBeNull();
  });
});
