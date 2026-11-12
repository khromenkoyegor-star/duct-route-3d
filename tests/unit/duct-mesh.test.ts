/**
 * 3D-повітропровід (scene/duct-mesh.ts) без браузера: перевіряємо геометрію в мм.
 * Критерії етапу 4: Ø200 × 1000 мм — габарит; вісь труби й колін — на трасі; прямокутні Ш × В.
 */
import { describe, expect, it } from 'vitest';
import { type DuctSection, ductLayout, roundElbowPolyline, transitionLengthMm } from '../../src/core/duct.ts';
import type { P3 } from '../../src/core/route.ts';
import { mToMm } from '../../src/core/units.ts';
import { buildDuctGeometry } from '../../src/scene/duct-mesh.ts';

const round = (d: number): DuctSection => ({ shape: 'round', diameterMm: d });
const rect = (w: number, h: number): DuctSection => ({ shape: 'rect', widthMm: w, heightMm: h });

/** Вершини геометрії в мм. */
function vertices(geometry: ReturnType<typeof buildDuctGeometry>): P3[] {
  const pos = geometry.getAttribute('position');
  const out: P3[] = [];
  for (let i = 0; i < pos.count; i++) out.push({ x: mToMm(pos.getX(i)), y: mToMm(pos.getY(i)), z: mToMm(pos.getZ(i)) });
  return out;
}

function boxOf(points: P3[]) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const k of ['x', 'y', 'z'] as const) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } };
}

const L_ROUTE = [
  { x: 0, y: 2400, z: 0 },
  { x: 1000, y: 2400, z: 0 },
  { x: 1000, y: 2400, z: 2000 },
  { x: 1000, y: 3900, z: 2000 },
];

describe('3D-повітропровід', () => {
  it('Ø200, відрізок 1000 мм → труба 1000 × 200 × 200 мм, по осі траси', () => {
    const nodes = [
      { x: 0, y: 1000, z: 0 },
      { x: 1000, y: 1000, z: 0 },
    ];
    const pts = vertices(buildDuctGeometry(nodes, ductLayout(nodes, { section: round(200), transitions: [] })));
    const box = boxOf(pts);
    expect(box.size.x).toBeCloseTo(1000, 2);
    expect(box.size.y).toBeCloseTo(200, 2);
    expect(box.size.z).toBeCloseTo(200, 2);
    expect(box.min.x).toBeCloseTo(0, 2);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(1000, 2);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 2);
    // Бічна поверхня — рівно на радіусі 100 мм від осі (торці — всередині кола).
    for (const p of pts) expect(Math.hypot(p.y - 1000, p.z)).toBeLessThanOrEqual(100 + 1e-3);
  });

  it('сегментні коліна: кожен сегмент — труба R = 100 мм навколо своєї ділянки осі коліна; стики без щілин', () => {
    const layout = ductLayout(L_ROUTE, { section: round(200), transitions: [] });
    for (const elbow of layout.elbows) {
      const onlyElbow = { ...layout, straights: [], transitions: [], elbows: [elbow] };
      const pts = vertices(buildDuctGeometry(L_ROUTE, onlyElbow, { segments: new Set([elbow.node]) }));
      const axis = roundElbowPolyline(elbow);
      const perSegment = 32 * 6;
      expect(pts).toHaveLength(4 * perSegment);
      const ends: P3[][] = [];
      for (let k = 0; k < 4; k++) {
        const a = axis[k]!;
        const b = axis[k + 1]!;
        const chunk = pts.slice(k * perSegment, (k + 1) * perSegment);
        for (const p of chunk) {
          // Відстань до нескінченної прямої сегмента.
          const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
          const l = Math.hypot(ab.x, ab.y, ab.z);
          const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
          const c = { x: ap.y * ab.z - ap.z * ab.y, y: ap.z * ab.x - ap.x * ab.z, z: ap.x * ab.y - ap.y * ab.x };
          expect(Math.hypot(c.x, c.y, c.z) / l).toBeCloseTo(100, 3);
        }
        ends.push(chunk);
      }
      // Стик сегментів k і k+1: кожна точка кінця сегмента k є і на початку сегмента k+1.
      const unit = (a: P3, b: P3) => {
        const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const l = Math.hypot(d.x, d.y, d.z);
        return { x: d.x / l, y: d.y / l, z: d.z / l };
      };
      for (let k = 0; k < 3; k++) {
        const v = axis[k + 1]!;
        const t0 = unit(axis[k]!, v);
        const t1 = unit(v, axis[k + 2]!);
        const n = unit({ x: 0, y: 0, z: 0 }, { x: t0.x + t1.x, y: t0.y + t1.y, z: t0.z + t1.z });
        const onPlane = (p: P3) => Math.abs((p.x - v.x) * n.x + (p.y - v.y) * n.y + (p.z - v.z) * n.z) < 1e-2;
        const thisEnd = ends[k]!.filter(onPlane);
        const nextStart = ends[k + 1]!.filter(onPlane);
        expect(thisEnd.length).toBeGreaterThanOrEqual(32);
        expect(nextStart.length).toBeGreaterThanOrEqual(32);
        for (const p of thisEnd) {
          const nearest = Math.min(...nextStart.map((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)));
          expect(nearest).toBeLessThan(1e-2);
        }
      }
    }
  });

  it('4 сегменти коліна — 4 кільця граней (шви на стиках)', () => {
    const layout = ductLayout(L_ROUTE, { section: round(200), transitions: [] });
    const onlyElbow = { ...layout, straights: [], transitions: [], elbows: [layout.elbows[0]!] };
    const geometry = buildDuctGeometry(L_ROUTE, onlyElbow, { segments: new Set([0]) });
    // 4 сегменти × 32 грані × 2 трикутники.
    expect(geometry.getAttribute('position').count / 3).toBe(4 * 32 * 2);
  });

  it('прямокутний 500 × 300 уздовж X: ширина — по Z, висота — вертикально', () => {
    const nodes = [
      { x: 0, y: 1000, z: 0 },
      { x: 2000, y: 1000, z: 0 },
    ];
    const box = boxOf(vertices(buildDuctGeometry(nodes, ductLayout(nodes, { section: rect(500, 300), transitions: [] }))));
    expect(box.size.x).toBeCloseTo(2000, 2);
    expect(box.size.y).toBeCloseTo(300, 2);
    expect(box.size.z).toBeCloseTo(500, 2);
  });

  it('прямокутне радіусне коліно: внутрішній радіус 100 мм (найближча точка до центру дуги)', () => {
    const layout = ductLayout(L_ROUTE, { section: rect(500, 300), transitions: [] });
    const e = layout.elbows[0]!;
    const pts = vertices(buildDuctGeometry(L_ROUTE, { ...layout, straights: [], transitions: [], elbows: [e] }, { segments: new Set([0]) }));
    // Відстань від осі повороту (через центр, уздовж Y) у площині повороту.
    const radial = pts.map((p) => Math.hypot(p.x - e.centre.x, p.z - e.centre.z));
    expect(Math.min(...radial)).toBeCloseTo(100, 1);
    expect(Math.max(...radial)).toBeCloseTo(100 + 500, 1);
  });

  it('перехід Ø200 → Ø315: конус від радіуса 100 до 157,5 мм завдовжки L', () => {
    const nodes = [
      { x: 0, y: 1000, z: 0 },
      { x: 2000, y: 1000, z: 0 },
    ];
    const layout = ductLayout(nodes, { section: round(200), transitions: [{ segment: 0, to: round(315) }] });
    const onlyTransition = { ...layout, straights: [] };
    const pts = vertices(buildDuctGeometry(nodes, onlyTransition, { segments: new Set([0]) }));
    const L = transitionLengthMm(round(200), round(315));
    const box = boxOf(pts);
    expect(box.size.x).toBeCloseTo(L, 2);
    for (const p of pts) {
      const r = Math.hypot(p.y - 1000, p.z);
      const expected = 100 + (57.5 * p.x) / L;
      expect(r).toBeCloseTo(expected, 1);
    }
  });

  it('траса на 600 точок будується швидко і в одну геометрію', () => {
    const nodes: P3[] = [];
    for (let i = 0; i < 600; i++) {
      const step = Math.floor(i / 2);
      nodes.push({ x: (step + (i % 2)) * 1000, y: 2000, z: step * 1000 });
    }
    const t0 = performance.now();
    const geometry = buildDuctGeometry(nodes, ductLayout(nodes, { section: round(200), transitions: [] }));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    geometry.dispose();
  });
});
