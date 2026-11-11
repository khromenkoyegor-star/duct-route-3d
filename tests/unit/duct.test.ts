import { describe, expect, it } from 'vitest';
import {
  DUCT_DIAMETERS_MM,
  type DuctSection,
  type DuctSpec,
  ductAxisLengthMm,
  ductLayout,
  elbowArcPoint,
  formatSection,
  isValidDuctSpec,
  isValidSection,
  pickDuctSegment,
  raySegmentDistance,
  RECT_ELBOW_INNER_R_MM,
  roundElbowPolyline,
  sectionsBySegment,
  segmentFrames,
  TRANSITION_MIN_MM,
  transitionLengthMm,
  withoutTransition,
  withRouteDuct,
  withSection,
  withTransition,
} from '../../src/core/duct.ts';
import { addRoute, emptyRouteSet, type P3 } from '../../src/core/route.ts';

const round = (d: number): DuctSection => ({ shape: 'round', diameterMm: d });
const rect = (w: number, h: number): DuctSection => ({ shape: 'rect', widthMm: w, heightMm: h });
const spec = (section: DuctSection, transitions: DuctSpec['transitions'] = []): DuctSpec => ({ section, transitions });
const dist = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** «1000 по +X → 2000 по +Z → 1500 вгору» (мм). */
const L_ROUTE = [
  { x: 0, y: 2400, z: 0 },
  { x: 1000, y: 2400, z: 0 },
  { x: 1000, y: 2400, z: 2000 },
  { x: 1000, y: 3900, z: 2000 },
];

describe('розміри', () => {
  it('діаметри — список Єгора', () => {
    expect(DUCT_DIAMETERS_MM).toEqual([100, 125, 150, 160, 200, 250, 315, 355, 400, 450]);
  });

  it('круглі — лише зі списку; прямокутні — у межах', () => {
    expect(isValidSection(round(200))).toBe(true);
    expect(isValidSection(round(210))).toBe(false);
    expect(isValidSection(rect(500, 300))).toBe(true);
    expect(isValidSection(rect(10, 300))).toBe(false);
    expect(isValidSection(rect(500, Number.NaN))).toBe(false);
    expect(formatSection(round(315))).toBe('Ø315');
    expect(formatSection(rect(500, 300))).toBe('500×300');
  });

  it('довжина переходу: нахил стінки 15° (каталог: 1000→710 ≈ 545 мм), не коротше 100 мм', () => {
    expect(transitionLengthMm(round(450), round(200))).toBeCloseTo(250 / (2 * Math.tan(Math.PI / 12)), 6);
    // Каталожні довжини Гипервент — у межах 5 %.
    for (const [d2, l] of [
      [710, 545],
      [800, 375],
      [900, 190],
    ] as const) {
      const ours = (1000 - d2) / (2 * Math.tan(Math.PI / 12));
      expect(Math.abs(ours - l) / l).toBeLessThan(0.05);
    }
    expect(transitionLengthMm(round(160), round(150))).toBe(TRANSITION_MIN_MM);
    // Прямокутний — за найбільшою різницею сторін.
    expect(transitionLengthMm(rect(800, 300), rect(500, 300))).toBeCloseTo(300 / (2 * Math.tan(Math.PI / 12)), 6);
    expect(() => transitionLengthMm(round(200), rect(200, 200))).toThrow(RangeError);
  });
});

describe('переходи в специфікації', () => {
  it('розмір по відрізках: перехід на початку відрізка, далі — новий розмір', () => {
    const s = spec(round(200), [{ segment: 1, to: round(315) }]);
    expect(sectionsBySegment(s, 3).map(formatSection)).toEqual(['Ø200', 'Ø315', 'Ø315']);
    expect(isValidDuctSpec(s, 3)).toBe(true);
  });

  it('поставити, замінити, прибрати перехід; «на той самий розмір» — не можна', () => {
    let s = withSection(null, round(200));
    s = withTransition(s, 2, round(315), 3);
    expect(s.transitions).toEqual([{ segment: 2, to: round(315) }]);
    s = withTransition(s, 2, round(250), 3);
    expect(s.transitions).toEqual([{ segment: 2, to: round(250) }]);
    expect(() => withTransition(s, 1, round(200), 3)).toThrow(RangeError);
    expect(() => withTransition(s, 1, rect(200, 200), 3)).toThrow(RangeError);
    expect(() => withTransition(s, 5, round(315), 3)).toThrow(RangeError);
    s = withoutTransition(s, 2);
    expect(s.transitions).toEqual([]);
  });

  it('зміна розміру траси: та сама форма — переходи лишаються (крім «на той самий»), інша — прибираються', () => {
    const s = spec(round(200), [
      { segment: 1, to: round(315) },
      { segment: 2, to: round(200) },
    ]);
    expect(withSection(s, round(250)).transitions).toEqual(s.transitions);
    expect(withSection(s, round(315)).transitions).toEqual([{ segment: 2, to: round(200) }]);
    expect(withSection(s, rect(500, 300)).transitions).toEqual([]);
    expect(() => withSection(s, round(201))).toThrow(RangeError);
  });

  it('специфікація не за правилами: перехід поза трасою, двічі на відрізку, іншої форми', () => {
    expect(isValidDuctSpec(spec(round(200), [{ segment: 3, to: round(315) }]), 3)).toBe(false);
    expect(
      isValidDuctSpec(
        spec(round(200), [
          { segment: 1, to: round(315) },
          { segment: 1, to: round(250) },
        ]),
        3,
      ),
    ).toBe(false);
    expect(isValidDuctSpec(spec(round(200), [{ segment: 1, to: rect(300, 200) }]), 3)).toBe(false);
  });

  it('повітропровід задається одній трасі; номери й інші траси не змінюються', () => {
    let set = addRoute(emptyRouteSet(), L_ROUTE).set;
    set = addRoute(set, [L_ROUTE[0]!, L_ROUTE[1]!]).set;
    const next = withRouteDuct(set, 2, spec(round(160)));
    expect(next.routes[0]).toBe(set.routes[0]);
    expect(next.routes[1]!.duct).toEqual(spec(round(160)));
    expect(next.nextId).toBe(3);
    expect(() => withRouteDuct(set, 2, spec(round(160), [{ segment: 1, to: round(200) }]))).toThrow(RangeError);
    expect(() => withRouteDuct(set, 9, spec(round(160)))).toThrow(RangeError);
  });
});

describe('Ø200, відрізок 1000 мм — критерій готовності', () => {
  it('одна пряма ділянка Ø200 завдовжки рівно 1000 мм, вісь — по трасі', () => {
    const nodes = [
      { x: 0, y: 1000, z: 0 },
      { x: 1000, y: 1000, z: 0 },
    ];
    const layout = ductLayout(nodes, spec(round(200)));
    expect(layout.straights).toHaveLength(1);
    const s = layout.straights[0]!;
    expect(s.lengthMm).toBeCloseTo(1000, 6);
    expect(s.from).toEqual(nodes[0]);
    expect(s.to).toEqual(nodes[1]);
    expect(s.section).toEqual(round(200));
    expect(layout.elbows).toHaveLength(0);
    expect(layout.problems).toHaveLength(0);
  });
});

describe('сегментні коліна (R = D, 4 сегменти)', () => {
  it('коліно в кожному повороті; прямі коротшають на R із кожного боку', () => {
    const layout = ductLayout(L_ROUTE, spec(round(200)));
    expect(layout.elbows.map((e) => e.node)).toEqual([1, 2]);
    for (const e of layout.elbows) {
      expect(e.radiusMm).toBe(200);
      expect(dist(e.start, e.at)).toBeCloseTo(200, 9);
      expect(dist(e.end, e.at)).toBeCloseTo(200, 9);
      // Центр дуги — на відстані R від початку й кінця коліна.
      expect(dist(e.centre, e.start)).toBeCloseTo(200, 9);
      expect(dist(e.centre, e.end)).toBeCloseTo(200, 9);
    }
    expect(layout.straights.map((s) => Math.round(s.lengthMm * 1000) / 1000)).toEqual([800, 1600, 1300]);
    // Пряма закінчується там, де починається коліно.
    expect(dist(layout.straights[0]!.to, layout.elbows[0]!.start)).toBeLessThan(1e-9);
    expect(dist(layout.straights[1]!.from, layout.elbows[0]!.end)).toBeLessThan(1e-9);
  });

  it('вісь коліна — ламана з 4 сегментів: половинки R·tg15°, цілі 2R·tg15°; вершини на R/cos15° від центру', () => {
    const e = ductLayout(L_ROUTE, spec(round(200))).elbows[0]!;
    const pts = roundElbowPolyline(e);
    expect(pts).toHaveLength(5);
    const t = Math.tan(Math.PI / 12);
    const lens = pts.slice(1).map((p, i) => dist(p, pts[i]!));
    expect(lens[0]).toBeCloseTo(200 * t, 9);
    expect(lens[1]).toBeCloseTo(400 * t, 9);
    expect(lens[2]).toBeCloseTo(400 * t, 9);
    expect(lens[3]).toBeCloseTo(200 * t, 9);
    for (const v of pts.slice(1, -1)) expect(dist(v, e.centre)).toBeCloseTo(200 / Math.cos(Math.PI / 12), 9);
    // Перший сегмент — уздовж входу, останній — уздовж виходу (стик з прямими без зламу).
    const first = { x: pts[1]!.x - pts[0]!.x, y: pts[1]!.y - pts[0]!.y, z: pts[1]!.z - pts[0]!.z };
    expect(first.x / lens[0]!).toBeCloseTo(e.dirIn.x, 9);
    const last = { x: pts[4]!.x - pts[3]!.x, y: pts[4]!.y - pts[3]!.y, z: pts[4]!.z - pts[3]!.z };
    expect(last.z / lens[3]!).toBeCloseTo(e.dirOut.z, 9);
    // Коліно лежить у площині повороту (Y не змінюється для X→Z).
    for (const p of pts) expect(p.y).toBeCloseTo(2400, 9);
  });

  it('довжина по осі = прямі + ламані колін', () => {
    const layout = ductLayout(L_ROUTE, spec(round(200)));
    const elbowAxis = 6 * 200 * Math.tan(Math.PI / 12);
    expect(ductAxisLengthMm(layout)).toBeCloseTo(800 + 1600 + 1300 + 2 * elbowAxis, 6);
  });
});

describe('переходи на трасі', () => {
  it('перехід на початку відрізка (одразу після коліна); коліно перед ним — старого розміру, після — нового', () => {
    const s = spec(round(200), [{ segment: 1, to: round(315) }]);
    const layout = ductLayout(L_ROUTE, s);
    expect(layout.transitions).toHaveLength(1);
    const t = layout.transitions[0]!;
    const e0 = layout.elbows[0]!;
    expect(dist(t.from, e0.end)).toBeLessThan(1e-9);
    expect(t.lengthMm).toBeCloseTo(transitionLengthMm(round(200), round(315)), 9);
    expect(t.fromSection).toEqual(round(200));
    expect(t.toSection).toEqual(round(315));
    expect(e0.radiusMm).toBe(200);
    expect(layout.elbows[1]!.radiusMm).toBe(315);
    // Пряма відрізка 2 = 2000 − 200 − L − 315.
    const straight = layout.straights.find((x) => x.segment === 1)!;
    expect(straight.lengthMm).toBeCloseTo(2000 - 200 - t.lengthMm - 315, 6);
    expect(straight.section).toEqual(round(315));
    expect(dist(straight.from, t.to)).toBeLessThan(1e-9);
  });

  it('перехід на першому відрізку — від самого початку траси', () => {
    const layout = ductLayout(L_ROUTE, spec(round(200), [{ segment: 0, to: round(125) }]));
    expect(layout.transitions[0]!.from).toEqual(L_ROUTE[0]);
    expect(layout.elbows[0]!.radiusMm).toBe(125);
  });

  it('закороткий відрізок — проблема з поясненням «потрібно / є»', () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 1000, y: 0, z: 400 },
      { x: 2000, y: 0, z: 400 },
    ];
    const layout = ductLayout(nodes, spec(round(250)));
    expect(layout.problems).toEqual([{ segment: 1, needMm: 500, haveMm: 400 }]);
    expect(layout.straights.some((s) => s.segment === 1)).toBe(false);
    expect(ductLayout(nodes, spec(round(200))).problems).toEqual([]);
  });
});

describe('прямокутні: рамка перерізу й коліна', () => {
  const X = { x: 1, y: 0, z: 0 };
  const Y = { x: 0, y: 1, z: 0 };
  const Z = { x: 0, y: 0, z: 1 };

  it('перша горизонтальна ділянка: висота — вертикально', () => {
    const [f] = segmentFrames([X]);
    expect(Math.abs(f!.v.y)).toBe(1);
    expect(Math.abs(f!.u.z)).toBe(1);
  });

  it('повороти в горизонталі: висота лишається вертикальною', () => {
    const frames = segmentFrames([X, Z, { x: -1, y: 0, z: 0 }]);
    for (const f of frames) expect(Math.abs(f.v.y)).toBe(1);
  });

  it('вгору, а потім убік: переріз повертається з трубою — труба лягає «на бік»', () => {
    const frames = segmentFrames([X, Y, Z]);
    // На підйомі висота — уздовж X (у площині повороту), ширина — та сама (Z).
    expect(Math.abs(frames[1]!.v.x)).toBe(1);
    expect(Math.abs(frames[1]!.u.z)).toBe(1);
    // Після повороту на Z: ширина — вертикально, висота — уздовж X.
    expect(Math.abs(frames[2]!.u.y)).toBe(1);
    expect(Math.abs(frames[2]!.v.x)).toBe(1);
    // Вгору й назад у той самий бік — висота знову вертикальна.
    const back = segmentFrames([X, Y, X]);
    expect(Math.abs(back[2]!.v.y)).toBe(1);
  });

  it('рамка завжди перпендикулярна осі й одинична', () => {
    const dirs = [X, Y, Z, { x: -1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, Z];
    const frames = segmentFrames(dirs);
    frames.forEach((f, i) => {
      const d = dirs[i]!;
      expect(f.u.x * d.x + f.u.y * d.y + f.u.z * d.z).toBe(0);
      expect(f.v.x * d.x + f.v.y * d.y + f.v.z * d.z).toBe(0);
      expect(f.u.x * f.v.x + f.u.y * f.v.y + f.u.z * f.v.z).toBe(0);
      expect(Math.hypot(f.u.x, f.u.y, f.u.z)).toBe(1);
    });
  });

  it('радіус коліна: внутрішній 100 мм + половина сторони, що повертає', () => {
    // 500×300: поворот у горизонталі — повертає ширина (500); вгору — висота (300).
    const layout = ductLayout(L_ROUTE, spec(rect(500, 300)));
    expect(layout.elbows[0]!.radiusMm).toBe(RECT_ELBOW_INNER_R_MM + 250);
    expect(layout.elbows[1]!.radiusMm).toBe(RECT_ELBOW_INNER_R_MM + 150);
    // Дуга радіусного коліна: кінці збігаються з початком і кінцем коліна.
    const e = layout.elbows[0]!;
    expect(dist(elbowArcPoint(e, 0), e.start)).toBeLessThan(1e-9);
    expect(dist(elbowArcPoint(e, Math.PI / 2), e.end)).toBeLessThan(1e-9);
    expect(dist(elbowArcPoint(e, Math.PI / 4), e.centre)).toBeCloseTo(e.radiusMm, 9);
  });
});

describe('довга траса', () => {
  it('600 вузлів: розкладання швидке й без проблем при довгих відрізках', () => {
    const nodes: P3[] = [];
    for (let i = 0; i < 600; i++) {
      const step = Math.floor(i / 2);
      nodes.push({ x: (step + (i % 2)) * 1000, y: 2000, z: step * 1000 });
    }
    const t0 = performance.now();
    const layout = ductLayout(nodes, spec(round(200)));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(layout.elbows).toHaveLength(598);
    expect(layout.problems).toHaveLength(0);
  });
});

describe('вибір відрізка дотиком по трубі', () => {
  it('промінь крізь трубу вибирає її відрізок; повз — нічого; з двох — ближчий до камери', () => {
    let set = addRoute(emptyRouteSet(), L_ROUTE).set;
    set = withRouteDuct(set, 1, spec(round(200)));
    // Згори вниз на середину першого відрізка (500; 2400; 0).
    const down = { x: 0, y: -1, z: 0 };
    expect(pickDuctSegment({ x: 500, y: 5000, z: 0 }, down, set.routes)).toEqual({ routeId: 1, segment: 0 });
    // На 90 мм убік — ще всередині труби Ø200 (+ запас).
    expect(pickDuctSegment({ x: 500, y: 5000, z: 90 }, down, set.routes)).toEqual({ routeId: 1, segment: 0 });
    // На 400 мм убік — повз.
    expect(pickDuctSegment({ x: 500, y: 5000, z: 400 }, down, set.routes)).toBeNull();
    // Уздовж X на висоті траси з боку −X: перший на шляху — відрізок 0.
    expect(pickDuctSegment({ x: -3000, y: 2400, z: 0 }, { x: 1, y: 0, z: 0 }, set.routes)?.segment).toBe(0);
    // Траса без повітропроводу не вибирається.
    expect(pickDuctSegment({ x: 500, y: 5000, z: 0 }, down, addRoute(emptyRouteSet(), L_ROUTE).set.routes)).toBeNull();
  });

  it('відстань промінь — відрізок', () => {
    const r = raySegmentDistance({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, { x: -5, y: 0, z: 3 }, { x: 5, y: 0, z: 3 });
    expect(r.distance).toBeCloseTo(3, 9);
    expect(r.t).toBeCloseTo(10, 9);
    // Відрізок позаду камери не «вибирається» спереду.
    const behind = raySegmentDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: -5 }, { x: 1, y: 0, z: -5 });
    expect(behind.distance).toBeCloseTo(5, 9);
  });
});
