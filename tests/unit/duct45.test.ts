/**
 * Етап 4.1: повітропровід на поворотах 45° — сегментне коліно з 3 сегментів (R = D),
 * радіусне прямокутне коліно, рамка перерізу через 45°, 3D-геометрія.
 */
import { describe, expect, it } from 'vitest';
import {
  type DuctSection,
  ductAxisLengthMm,
  ductLayout,
  elbowArcPoint,
  roundElbowPolyline,
  segmentFrames,
} from '../../src/core/duct.ts';
import type { P3 } from '../../src/core/route.ts';
import { mToMm } from '../../src/core/units.ts';
import { buildDuctGeometry } from '../../src/scene/duct-mesh.ts';

const round = (d: number): DuctSection => ({ shape: 'round', diameterMm: d });
const rect = (w: number, h: number): DuctSection => ({ shape: 'rect', widthMm: w, heightMm: h });
const dist = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const T225 = Math.tan(Math.PI / 8);

/** «2000 по X → 45° (X+Z) на 1000 × 1000 → далі 2000 по X» — зміщення (оффсет) у горизонталі. */
const OFFSET = [
  { x: 0, y: 2400, z: 0 },
  { x: 2000, y: 2400, z: 0 },
  { x: 3000, y: 2400, z: 1000 },
  { x: 5000, y: 2400, z: 1000 },
];
/** Підйом під 45°: по X, потім X+Y, потім знову по X. */
const RISE = [
  { x: 0, y: 500, z: 0 },
  { x: 2000, y: 500, z: 0 },
  { x: 3200, y: 1700, z: 0 },
  { x: 5000, y: 1700, z: 0 },
];

function vertices(geometry: ReturnType<typeof buildDuctGeometry>): P3[] {
  const pos = geometry.getAttribute('position');
  const out: P3[] = [];
  for (let i = 0; i < pos.count; i++) out.push({ x: mToMm(pos.getX(i)), y: mToMm(pos.getY(i)), z: mToMm(pos.getZ(i)) });
  return out;
}

describe('коліно 45° круглого повітропроводу', () => {
  const layout = ductLayout(OFFSET, { section: round(200), transitions: [] });

  it('Ø200: два коліна по 45°, R = 200 мм, 3 сегменти; дотична R·tg 22,5°', () => {
    expect(layout.elbows).toHaveLength(2);
    for (const e of layout.elbows) {
      expect(e.angleRad).toBeCloseTo(Math.PI / 4, 12);
      expect(e.radiusMm).toBe(200);
      expect(e.segments).toBe(3);
      expect(e.tangentMm).toBeCloseTo(200 * T225, 9);
      expect(dist(e.start, e.at)).toBeCloseTo(200 * T225, 9);
      expect(dist(e.end, e.at)).toBeCloseTo(200 * T225, 9);
      expect(dist(e.centre, e.start)).toBeCloseTo(200, 9);
      expect(dist(e.centre, e.end)).toBeCloseTo(200, 9);
    }
    expect(layout.problems).toEqual([]);
    expect(layout.oblique).toEqual([]);
  });

  it('прямі ділянки коротші на R·tg 22,5° біля кожного коліна; стикуються з колінами без щілин', () => {
    const t = 200 * T225;
    const diagonal = Math.hypot(1000, 1000);
    const lengths = layout.straights.map((s) => s.lengthMm);
    expect(lengths[0]).toBeCloseTo(2000 - t, 6);
    expect(lengths[1]).toBeCloseTo(diagonal - 2 * t, 6);
    expect(lengths[2]).toBeCloseTo(2000 - t, 6);
    expect(dist(layout.straights[0]!.to, layout.elbows[0]!.start)).toBeLessThan(1e-6);
    expect(dist(layout.straights[1]!.from, layout.elbows[0]!.end)).toBeLessThan(1e-6);
    expect(dist(layout.straights[1]!.to, layout.elbows[1]!.start)).toBeLessThan(1e-6);
    expect(dist(layout.straights[2]!.from, layout.elbows[1]!.end)).toBeLessThan(1e-6);
  });

  it('вісь коліна — ламана з 3 сегментів: половинки R·tg 11,25°, цілий 2R·tg 11,25°; вершини на R/cos 11,25°', () => {
    const e = layout.elbows[0]!;
    const pts = roundElbowPolyline(e);
    expect(pts).toHaveLength(4);
    const t = Math.tan(Math.PI / 16);
    const lens = pts.slice(1).map((p, i) => dist(p, pts[i]!));
    expect(lens[0]).toBeCloseTo(200 * t, 9);
    expect(lens[1]).toBeCloseTo(400 * t, 9);
    expect(lens[2]).toBeCloseTo(200 * t, 9);
    for (const v of pts.slice(1, -1)) expect(dist(v, e.centre)).toBeCloseTo(200 / Math.cos(Math.PI / 16), 9);
    expect(dist(pts[0]!, e.start)).toBeLessThan(1e-9);
    expect(dist(pts[3]!, e.end)).toBeLessThan(1e-9);
    // Перший сегмент — уздовж входу, останній — уздовж виходу (стик з прямими без зламу).
    const first = { x: (pts[1]!.x - pts[0]!.x) / lens[0]!, y: (pts[1]!.y - pts[0]!.y) / lens[0]!, z: (pts[1]!.z - pts[0]!.z) / lens[0]! };
    expect(dot(first, e.dirIn)).toBeCloseTo(1, 9);
    const last = { x: (pts[3]!.x - pts[2]!.x) / lens[2]!, y: (pts[3]!.y - pts[2]!.y) / lens[2]!, z: (pts[3]!.z - pts[2]!.z) / lens[2]! };
    expect(dot(last, e.dirOut)).toBeCloseTo(1, 9);
    // Коліно лежить у площині повороту (горизонталь: Y не змінюється).
    for (const p of pts) expect(p.y).toBeCloseTo(2400, 9);
  });

  it('3D: кожен із 3 сегментів коліна — труба радіусом 100 мм навколо своєї ділянки осі', () => {
    const e = layout.elbows[0]!;
    const only = { ...layout, straights: [], transitions: [], elbows: [e] };
    const pts = vertices(buildDuctGeometry(OFFSET, only, { segments: new Set([e.node]) }));
    const perSegment = 32 * 6;
    expect(pts).toHaveLength(3 * perSegment);
    const axis = roundElbowPolyline(e);
    for (let k = 0; k < 3; k++) {
      const a = axis[k]!;
      const b = axis[k + 1]!;
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const l = Math.hypot(ab.x, ab.y, ab.z);
      for (const p of pts.slice(k * perSegment, (k + 1) * perSegment)) {
        const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
        const c = { x: ap.y * ab.z - ap.z * ab.y, y: ap.z * ab.x - ap.x * ab.z, z: ap.x * ab.y - ap.y * ab.x };
        expect(Math.hypot(c.x, c.y, c.z) / l).toBeCloseTo(100, 3);
      }
    }
  });

  it('підйом під 45° (X → X+Y → X): коліна у вертикальній площині, вісь на трасі', () => {
    const rise = ductLayout(RISE, { section: round(160), transitions: [] });
    expect(rise.elbows.map((e) => Math.round((e.angleRad * 180) / Math.PI))).toEqual([45, 45]);
    for (const e of rise.elbows) for (const p of roundElbowPolyline(e)) expect(p.z).toBeCloseTo(0, 9);
    // Довжина по осі: прямі + ламані колін (3 сегменти: 4·R·tg 11,25° на коліно).
    const elbowAxis = 4 * 160 * Math.tan(Math.PI / 16);
    const straight = 2000 - 160 * T225 + (Math.hypot(1200, 1200) - 2 * 160 * T225) + (1800 - 160 * T225);
    expect(ductAxisLengthMm(rise)).toBeCloseTo(straight + 2 * elbowAxis, 6);
  });

  it('змішана траса: 90° і 45° — у кожного коліна свій кут і кількість сегментів', () => {
    const mixed = ductLayout(
      [
        { x: 0, y: 0, z: 0 },
        { x: 2000, y: 0, z: 0 },
        { x: 2000, y: 0, z: 2000 },
        { x: 3000, y: 0, z: 3000 },
      ],
      { section: round(250), transitions: [] },
    );
    expect(mixed.elbows.map((e) => [Math.round((e.angleRad * 180) / Math.PI), e.segments, e.tangentMm])).toEqual([
      [90, 4, 250],
      [45, 3, expect.closeTo(250 * T225, 9)],
    ]);
  });

  it('закороткий діагональний відрізок: потрібно 2·R·tg 22,5°', () => {
    const short = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 1100, y: 0, z: 100 },
      { x: 2100, y: 0, z: 100 },
    ];
    const l = ductLayout(short, { section: round(250), transitions: [] });
    expect(l.problems).toHaveLength(1);
    expect(l.problems[0]!.segment).toBe(1);
    expect(l.problems[0]!.needMm).toBeCloseTo(2 * 250 * T225, 6);
    expect(l.problems[0]!.haveMm).toBeCloseTo(Math.hypot(100, 100), 6);
  });
});

describe('прямокутні на 45°', () => {
  it('рамка перерізу через 45°: одинична, перпендикулярна осі; у горизонталі висота лишається вертикальною', () => {
    const S = Math.SQRT1_2;
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: S, y: 0, z: S },
      { x: 1, y: 0, z: 0 },
      { x: S, y: S, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];
    const frames = segmentFrames(dirs);
    frames.forEach((f, i) => {
      expect(dot(f.u, dirs[i]!)).toBeCloseTo(0, 9);
      expect(dot(f.v, dirs[i]!)).toBeCloseTo(0, 9);
      expect(dot(f.u, f.v)).toBeCloseTo(0, 9);
      expect(Math.hypot(f.u.x, f.u.y, f.u.z)).toBeCloseTo(1, 9);
      expect(Math.hypot(f.v.x, f.v.y, f.v.z)).toBeCloseTo(1, 9);
    });
    // Повороти в горизонталі — висота вертикальна.
    for (const f of frames.slice(0, 3)) expect(Math.abs(f.v.y)).toBeCloseTo(1, 9);
    // На підйомі під 45° ширина (горизонтальна, поперек) не змінюється.
    expect(Math.abs(frames[3]!.u.z)).toBeCloseTo(1, 9);
  });

  it('перша ділянка під 45° на підйом: висота — у вертикальній площині, ширина — горизонтально', () => {
    const S = Math.SQRT1_2;
    const [f] = segmentFrames([{ x: S, y: S, z: 0 }]);
    expect(f!.u.y).toBeCloseTo(0, 9);
    expect(Math.abs(f!.u.z)).toBeCloseTo(1, 9);
    expect(f!.v.y).toBeGreaterThan(0.7);
  });

  it('500 × 300, оффсет у горизонталі: радіус по осі 100 + 250, дуга 45°; внутрішній радіус у 3D — 100 мм', () => {
    const layout = ductLayout(OFFSET, { section: rect(500, 300), transitions: [] });
    const e = layout.elbows[0]!;
    expect(e.radiusMm).toBe(350);
    expect(e.tangentMm).toBeCloseTo(350 * T225, 9);
    expect(layout.oblique).toEqual([]);
    expect(dist(elbowArcPoint(e, 0), e.start)).toBeLessThan(1e-9);
    expect(dist(elbowArcPoint(e, e.angleRad), e.end)).toBeLessThan(1e-9);
    const only = { ...layout, straights: [], transitions: [], elbows: [e] };
    const pts = vertices(buildDuctGeometry(OFFSET, only, { segments: new Set([e.node]) }));
    const radial = pts.map((p) => Math.hypot(p.x - e.centre.x, p.z - e.centre.z));
    expect(Math.min(...radial)).toBeCloseTo(100, 1);
    expect(Math.max(...radial)).toBeCloseTo(600, 1);
    // Висота 300 — вертикально, по центру траси.
    const ys = pts.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(2400 - 150, 1);
    expect(Math.max(...ys)).toBeCloseTo(2400 + 150, 1);
  });

  it('поворот не в площині сторін (по X, потім діагональ Y+Z) — позначено; для круглих — ні', () => {
    const skew = [
      { x: 0, y: 0, z: 0 },
      { x: 2000, y: 0, z: 0 },
      { x: 2000, y: 1500, z: 1500 },
    ];
    expect(ductLayout(skew, { section: rect(500, 300), transitions: [] }).oblique).toEqual([1]);
    const r = ductLayout(skew, { section: round(200), transitions: [] });
    expect(r.oblique).toEqual([]);
    expect(Math.round((r.elbows[0]!.angleRad * 180) / Math.PI)).toBe(90);
  });
});
