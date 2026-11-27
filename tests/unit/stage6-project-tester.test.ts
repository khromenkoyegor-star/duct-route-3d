/**
 * Етап 6 (tester): файл проєкту й чернетки — перевірка «від вимог», як чорна скринька.
 *
 * Критерії (ROADMAP, «Етап 6»):
 * - збережений і знову відкритий проєкт дає ту саму трасу (±0,1 мм): точки, номери трас, розміри труб і переходи;
 * - пошкоджений, чужий чи новіший файл — зрозуміле повідомлення;
 * - «той самий скан» — та сама кількість трикутників і габарит ±1 мм (назву не порівнюємо);
 * - чернетка окремо для кожного скану.
 *
 * Правила траси рахуємо тут незалежно від коду: 18 напрямків (6 осей і 12 діагоналей у XY, XZ, ZY),
 * між сусідніми відрізками — 0°, 45° або 90°.
 */
import { describe, expect, it } from 'vitest';
import type { DuctSpec } from '../../src/core/duct.ts';
import {
  type ProjectData,
  parseProject,
  projectFileName,
  sameScan,
  type ScanFingerprint,
  scanKey,
  serializeProject,
} from '../../src/core/project.ts';
import { addRoute, isValidRoute, type PointMm, type RouteSet } from '../../src/core/route.ts';
import { createDrafts, DRAFTS_KEY, DRAFTS_LIMIT, type DraftStorage } from '../../src/ui/drafts.ts';
import { lcg } from '../fixtures/gltf-builder.ts';

const SCAN: ScanFingerprint = { name: 'Цех №2 (Polycam).zip', triangles: 345_678, sizeMm: { x: 12_345.6, y: 4_210.2, z: 8_765.4 }, fileBytes: 9_000_000 };

type V = [number, number, number];
/** 18 напрямків відрізка: цілі вектори (складові 0 або ±1). */
const DIRS: V[] = (() => {
  const out: V[] = [];
  for (let a = 0; a < 3; a++) {
    for (const s of [1, -1]) {
      const v: V = [0, 0, 0];
      v[a] = s;
      out.push(v);
    }
  }
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const) {
    for (const sa of [1, -1]) {
      for (const sb of [1, -1]) {
        const v: V = [0, 0, 0];
        v[a] = sa;
        v[b] = sb;
        out.push(v);
      }
    }
  }
  return out;
})();

/** Кут між напрямками — лише 0°, 45° або 90° (cos = 1, √½ або 0). */
function allowedTurn(p: V, n: V): boolean {
  const dot = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const cos = dot / Math.sqrt((p[0] ** 2 + p[1] ** 2 + p[2] ** 2) * (n[0] ** 2 + n[1] ** 2 + n[2] ** 2));
  return [1, Math.SQRT1_2, 0].some((c) => Math.abs(cos - c) < 1e-9);
}

/** Площина діагоналі (XY, XZ, ZY) або null — відрізок уздовж осі. */
const plane = (v: V): string | null => (v.filter((c) => c !== 0).length === 2 ? (v[0] && v[1] ? 'XY' : v[0] && v[2] ? 'XZ' : 'ZY') : null);

/**
 * Довга траса за правилами: випадкові відрізки 200…3000 мм з дробовими частками, усі 18 напрямків,
 * повороти 45° і 90°. Повертає вузли й набір площин діагоналей, що трапились.
 */
function longRoute(points: number, seed: number, start: PointMm = { x: 0, y: 1000, z: 0 }): { nodes: PointMm[]; planes: Set<string> } {
  const rnd = lcg(seed);
  const nodes: PointMm[] = [{ ...start }];
  const planes = new Set<string>();
  let prev: V | null = null;
  while (nodes.length < points) {
    const options: V[] = DIRS.filter((d) => !prev || allowedTurn(prev, d));
    const dir: V = options[Math.floor(rnd() * options.length)]!;
    // Зміщення по осях однакові (рівно 45°), з частками мм — як після руху джойстиком.
    const step = Math.round((200 + rnd() * 2800) * 1e6) / 1e6;
    const last = nodes[nodes.length - 1]!;
    nodes.push({ x: last.x + dir[0] * step, y: last.y + dir[1] * step, z: last.z + dir[2] * step });
    const p = plane(dir);
    if (p) planes.add(p);
    prev = dir;
  }
  return { nodes, planes };
}

const data = (set: RouteSet, extra: Partial<ProjectData> = {}): ProjectData => ({
  name: 'Цех 2 · 27.11.2026',
  savedAt: '2026-11-27T12:00:00.000Z',
  scan: SCAN,
  set,
  view: { position: { x: 5000.123, y: 3000, z: -7000.5 }, target: { x: 0.25, y: 1200, z: 0 }, projection: 'perspective' },
  display: { mode: 'both', transparency: 0.3 },
  ...extra,
});

const parse = (text: string) => {
  const r = parseProject(text);
  if (!r.ok) throw new Error(r.error);
  return r.project;
};
const errorOf = (value: unknown) => {
  const r = parseProject(typeof value === 'string' ? value : JSON.stringify(value));
  return r.ok ? null : r.error;
};

/** Усі точки однакові з точністю ±0,1 мм. */
function expectSameNodes(a: readonly PointMm[], b: readonly PointMm[]) {
  expect(b).toHaveLength(a.length);
  let worst = 0;
  a.forEach((n, i) => {
    for (const k of ['x', 'y', 'z'] as const) worst = Math.max(worst, Math.abs(b[i]![k] - n[k]));
  });
  expect(worst).toBeLessThanOrEqual(0.1);
}

describe('Етап 6 (tester): туди-назад ±0,1 мм', () => {
  it('траса на 520 точок з діагоналями 45° у всіх площинах XZ, XY, ZY — ті самі точки (і за правилами)', () => {
    const { nodes, planes } = longRoute(520, 7);
    expect([...planes].sort()).toEqual(['XY', 'XZ', 'ZY']);
    expect(isValidRoute(nodes)).toBe(true);
    const set: RouteSet = { routes: [{ id: 1, nodes, duct: null }], nextId: 2 };
    const p = parse(serializeProject(data(set)));
    expectSameNodes(nodes, p.set.routes[0]!.nodes);
    // JSON зберігає числа точно — фактично рівність.
    expect(p.set.routes[0]!.nodes).toEqual(nodes);
    expect(isValidRoute(p.set.routes[0]!.nodes)).toBe(true);
  });

  it('кілька довгих трас (5 × 600 точок) з номерами з пропусками 1, 3, 7 і nextId 12 — ті самі номери й nextId', () => {
    const ids = [1, 3, 7, 9, 11];
    const set: RouteSet = {
      routes: ids.map((id, i) => ({ id, nodes: longRoute(600, 100 + i, { x: i * 10_000, y: 500, z: 0 }).nodes, duct: null })),
      nextId: 12,
    };
    const p = parse(serializeProject(data(set)));
    expect(p.set.routes.map((r) => r.id)).toEqual(ids);
    expect(p.set.nextId).toBe(12);
    set.routes.forEach((r, i) => expectSameNodes(r.nodes, p.set.routes[i]!.nodes));
    // Нова траса після відкриття отримує номер 12, а не 8 чи 6.
    const next = addRoute(p.set, [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
    ]);
    expect(next.route.id).toBe(12);
  });

  it('nextId дорівнює найбільшому номеру (зіпсований) — виправляється на більший; номери трас не змінюються', () => {
    const set: RouteSet = {
      routes: [
        { id: 3, nodes: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 900 }], duct: null },
        { id: 7, nodes: [{ x: 0, y: 0, z: 0 }, { x: 900, y: 0, z: 0 }], duct: null },
      ],
      nextId: 7,
    };
    const p = parse(serializeProject(data(set)));
    expect(p.set.routes.map((r) => r.id)).toEqual([3, 7]);
    expect(p.set.nextId).toBeGreaterThan(7);
  });

  it('прямокутний повітропровід з кількома переходами й круглий з переходами — ті самі розміри й місця переходів', () => {
    const rect: DuctSpec = {
      section: { shape: 'rect', widthMm: 500, heightMm: 300 },
      transitions: [
        { segment: 3, to: { shape: 'rect', widthMm: 400, heightMm: 300 } },
        { segment: 10, to: { shape: 'rect', widthMm: 400, heightMm: 250 } },
        { segment: 40, to: { shape: 'rect', widthMm: 1200.5, heightMm: 50 } },
      ],
    };
    const round: DuctSpec = {
      section: { shape: 'round', diameterMm: 450 },
      transitions: [
        { segment: 0, to: { shape: 'round', diameterMm: 400 } },
        { segment: 2, to: { shape: 'round', diameterMm: 315 } },
        { segment: 5, to: { shape: 'round', diameterMm: 100 } },
      ],
    };
    const a = longRoute(60, 3).nodes;
    const b = longRoute(8, 4).nodes;
    const set: RouteSet = {
      routes: [
        { id: 2, nodes: a, duct: rect },
        { id: 5, nodes: b, duct: round },
        { id: 6, nodes: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 3000, z: 0 }], duct: null },
      ],
      nextId: 8,
    };
    const p = parse(serializeProject(data(set)));
    expect(p.set.routes[0]!.duct).toEqual(rect);
    expect(p.set.routes[1]!.duct).toEqual(round);
    expect(p.set.routes[2]!.duct ?? null).toBeNull();
    expect(p.set.nextId).toBe(8);
  });

  it('вигляд камери (мм) і режим показу — ті самі', () => {
    const p = parse(serializeProject(data({ routes: [], nextId: 1 }, { view: { position: { x: -1.25, y: 2.5e4, z: 3 }, target: { x: 4, y: 5, z: 6 }, projection: 'ortho' } })));
    expect(p.view).toEqual({ position: { x: -1.25, y: 2.5e4, z: 3 }, target: { x: 4, y: 5, z: 6 }, projection: 'ortho' });
    expect(p.display).toEqual({ mode: 'both', transparency: 0.3 });
  });
});

describe('Етап 6 (tester): незвичайні файли', () => {
  const good = () => JSON.parse(
    serializeProject(
      data({
        routes: [
          {
            id: 1,
            nodes: [
              { x: 0, y: 2000, z: 0 },
              { x: 1000, y: 2000, z: 0 },
              { x: 2000, y: 2000, z: 1000 },
            ],
            duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [{ segment: 1, to: { shape: 'round', diameterMm: 160 } }] },
          },
        ],
        nextId: 2,
      }),
    ),
  );

  // Була помилка програми (виправлено) (дрібна): parseProject не прибирає BOM — JSON.parse падає, «не файл проєкту».
  // У браузері File.text() BOM прибирає сам (див. e2e stage6-tester), тож користувач цього не бачить.
  it('файл з BOM на початку (так зберігають деякі редактори) — читається', () => {
    // У браузері File.text() прибирає BOM сам, але parseProject — єдина точка читання формату.
    const r = parseProject('﻿' + JSON.stringify(good()));
    expect(r.ok).toBe(true);
  });

  it('зайві поля на всіх рівнях — ігноруються, проєкт читається', () => {
    const raw = good();
    raw.extra = { a: 1 };
    raw.routes[0].color = 'red';
    raw.routes[0].nodes[0].w = 5;
    raw.routes[0].duct.material = 'zinc';
    raw.routes[0].duct.section.widthMm = 999;
    raw.view.fov = 50;
    const p = parse(JSON.stringify(raw));
    expect(p.set.routes[0]!.nodes[0]).toEqual({ x: 0, y: 2000, z: 0 });
    expect(p.set.routes[0]!.duct).toEqual({ section: { shape: 'round', diameterMm: 200 }, transitions: [{ segment: 1, to: { shape: 'round', diameterMm: 160 } }] });
  });

  it('числа-рядки: у точці чи розмірі труби — помилка з номером траси; у версії — «не файл проєкту»', () => {
    const r1 = good();
    r1.routes[0].nodes[1].x = '1000';
    expect(errorOf(r1)).toMatch(/^Траса 1/);
    const r2 = good();
    r2.routes[0].duct.section.diameterMm = '200';
    expect(errorOf(r2)).toMatch(/^Траса 1: неправильний розмір/);
    const r3 = good();
    r3.version = '1';
    expect(errorOf(r3)).toMatch(/не файл проєкту/);
    const r4 = good();
    r4.routes[0].id = '1';
    expect(errorOf(r4)).toMatch(/немає правильного номера/);
  });

  it('траса з однієї точки, без точок, без поля nodes — помилка з номером траси', () => {
    for (const nodes of [[{ x: 0, y: 0, z: 0 }], [], undefined, null, 'abc', [null, null]]) {
      const raw = good();
      raw.routes[0].nodes = nodes;
      raw.routes[0].duct = null;
      expect(errorOf(raw)).toMatch(/^Траса 1 не за правилами/);
    }
  });

  it('дублікати точок (нульовий відрізок, також у межах 0,05 мм) і рух назад — помилка', () => {
    const zero = good();
    zero.routes[0].nodes.splice(1, 0, { x: 1000, y: 2000, z: 0 });
    zero.routes[0].duct = null;
    expect(errorOf(zero)).toMatch(/не за правилами/);
    const near = good();
    near.routes[0].nodes.splice(2, 0, { x: 1000.05, y: 2000, z: 0.03 });
    near.routes[0].duct = null;
    expect(errorOf(near)).toMatch(/не за правилами/);
    const back = good();
    back.routes[0].nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 500, y: 0, z: 0 },
    ];
    back.routes[0].duct = null;
    expect(errorOf(back)).toMatch(/не за правилами/);
    // 135° (діагональ назад) і 60° між двома діагоналями — теж ні.
    const sharp = good();
    sharp.routes[0].nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 0, y: 0, z: 1000 },
    ];
    sharp.routes[0].duct = null;
    expect(errorOf(sharp)).toMatch(/не за правилами/);
    const sixty = good();
    sixty.routes[0].nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 1000, z: 0 },
      { x: 2000, y: 1000, z: 1000 },
    ];
    sixty.routes[0].duct = null;
    expect(errorOf(sixty)).toMatch(/не за правилами/);
  });

  it('повітропровід не тієї форми чи поза межами — помилка', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- сирий JSON
    const cases: Array<(r: any) => void> = [
      (r) => (r.routes[0]!.duct.section = { shape: 'oval', diameterMm: 200 }),
      (r) => (r.routes[0]!.duct.section = { shape: 'rect', widthMm: 49, heightMm: 300 }),
      (r) => (r.routes[0]!.duct.section = { shape: 'rect', widthMm: 300, heightMm: 3001 }),
      (r) => (r.routes[0]!.duct.section = { shape: 'round', diameterMm: 0 }),
      (r) => (r.routes[0]!.duct.section = { shape: 'round', diameterMm: -200 }),
      // Перехід круглої траси на прямокутний розмір.
      (r) => (r.routes[0]!.duct.transitions = [{ segment: 1, to: { shape: 'rect', widthMm: 200, heightMm: 200 } }]),
      // Перехід «на той самий розмір».
      (r) => (r.routes[0]!.duct.transitions = [{ segment: 1, to: { shape: 'round', diameterMm: 200 } }]),
      (r) => (r.routes[0]!.duct.transitions = [{ segment: -1, to: { shape: 'round', diameterMm: 160 } }]),
      (r) => (r.routes[0]!.duct.transitions = [{ segment: 0.5, to: { shape: 'round', diameterMm: 160 } }]),
      (r) => (r.routes[0]!.duct.transitions = [{ segment: 2, to: { shape: 'round', diameterMm: 160 } }]),
      // Два переходи на одному відрізку, не за зростанням.
      (r) =>
        (r.routes[0]!.duct.transitions = [
          { segment: 1, to: { shape: 'round', diameterMm: 160 } },
          { segment: 1, to: { shape: 'round', diameterMm: 125 } },
        ]),
      (r) =>
        (r.routes[0]!.duct.transitions = [
          { segment: 1, to: { shape: 'round', diameterMm: 160 } },
          { segment: 0, to: { shape: 'round', diameterMm: 125 } },
        ]),
      (r) => delete r.routes[0]!.duct.transitions,
      (r) => (r.routes[0]!.duct = 'Ø200'),
    ];
    cases.forEach((mutate, i) => {
      const raw = good();
      mutate(raw);
      expect(errorOf(raw), `випадок ${i}`).toMatch(/^Траса 1: неправильний розмір повітропроводу/);
    });
  });

  it('порожній файл, пробіли, null, число, рядок — «не файл проєкту»', () => {
    for (const text of ['', '   \n', 'null', '42', '"trasa-3d-project"', 'true', '{}']) {
      expect(errorOf(text)).toMatch(/не файл проєкту/);
    }
  });

  it('зіпсовані елементи списку трас (null, масив, рядок) — зрозуміле повідомлення з номером у файлі', () => {
    for (const item of [null, [], 'траса', 5]) {
      const raw = good();
      raw.routes.push(item);
      expect(errorOf(raw)).toMatch(/Траса №2 у файлі/);
    }
  });

  it('величезний файл (20 МБ сміття) — повідомлення швидко, без зависання', () => {
    const big = '{"format":"trasa-3d-project","version":1,"routes":[' + 'x'.repeat(20 * 1024 * 1024);
    const t0 = performance.now();
    expect(errorOf(big)).toMatch(/не файл проєкту/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('великий правильний проєкт (40 трас × 600 точок) читається швидко', () => {
    const set: RouteSet = {
      routes: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, nodes: longRoute(600, 500 + i).nodes, duct: null })),
      nextId: 41,
    };
    const text = serializeProject(data(set));
    const t0 = performance.now();
    const p = parse(text);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(p.set.routes).toHaveLength(40);
  });

  // Була помилка програми (виправлено) (дрібна): isPositiveInt(1e20) — true, nextId 1e20 приймається; 1e20 + 1 === 1e20,
  // тож дві нові траси отримують однаковий номер (і «Видалити» прибере обидві).
  it('nextId, більший за найбільше «точне» ціле (1e20), не дає двом новим трасам однаковий номер', () => {
    // Пошкоджений файл: nextId = 1e20. Номери трас мають лишатися різними (за ними видаляють трасу).
    const raw = good();
    raw.nextId = 1e20;
    const r = parseProject(JSON.stringify(raw));
    if (!r.ok) return; // відхилити такий файл — теж правильно
    const a = addRoute(r.project.set, [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }]);
    const b = addRoute(a.set, [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1000, z: 0 }]);
    expect(b.route.id).not.toBe(a.route.id);
  });

  it('назва: число чи пробіли — «Без назви»; кирилиця, лапки, емодзі — як були', () => {
    const r1 = good();
    r1.name = 42;
    expect(parse(JSON.stringify(r1)).name).toBe('Без назви');
    const r2 = good();
    r2.name = '  \t ';
    expect(parse(JSON.stringify(r2)).name).toBe('Без назви');
    const r3 = good();
    r3.name = 'Цех «Схід» / кв. 3: «вентиляція» 🙂 \\ "A" <b>';
    expect(parse(JSON.stringify(r3)).name).toBe('Цех «Схід» / кв. 3: «вентиляція» 🙂 \\ "A" <b>');
  });
});

describe("Етап 6 (tester): ім'я файлу проєкту", () => {
  it('кожен із / \\ : * ? " < > | замінено; кирилиця, «», №, емодзі лишаються', () => {
    for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      const file = projectFileName(`Цех${ch}2`);
      expect(file, ch).toBe('Цех-2.json');
    }
    expect(projectFileName('Цех «Схід» №3 🙂')).toBe('Цех «Схід» №3 🙂.json');
    expect(projectFileName('Цех\n2\t·  кв')).toBe('Цех 2 · кв.json');
  });

  it('дуже довга назва — ім\'я файлу обрізане, але закінчується на .json', () => {
    const file = projectFileName('Дуже довга назва проєкту '.repeat(20));
    expect(file.endsWith('.json')).toBe(true);
    expect(file.length).toBeLessThanOrEqual(85);
  });

  // Була помилка програми (виправлено) (дрібна): projectFileName обрізає .slice(0, 80) по одиницях UTF-16 — може розрізати
  // емодзі навпіл (у імені файлу лишається «�»).
  it('обрізана назва не розрізає емодзі навпіл', () => {
    // 1 + 2·50 одиниць UTF-16: межа 80 припадає посеред емодзі.
    const cut = projectFileName('а' + '🙂'.repeat(50));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'половинка емодзі').toBe(false);
  });

  // Була помилка програми (виправлено) (дрібна): після обрізання не робиться trim — ім'я «…а .json».
  it('обрізана назва не лишає пробіл перед .json', () => {
    // 79 літер, пробіл, далі слово: межа 80 — одразу після пробілу.
    const spaced = projectFileName('а'.repeat(79) + ' кінець');
    expect(spaced.endsWith(' .json')).toBe(false);
  });

  // Була помилка програми (виправлено) (дрібна): «.Цех» → «.Цех.json» — прихований файл.
  it("назва з крапкою на початку не дає «прихованого» файлу (у «Файлах» iOS такі не видно)", () => {
    expect(projectFileName('.Цех').startsWith('.')).toBe(false);
  });
});

describe('Етап 6 (tester): «той самий скан»', () => {
  const fp = (x: number, triangles = 1000): ScanFingerprint => ({ name: 'a.zip', triangles, sizeMm: { x, y: 2700, z: 3000 }, fileBytes: 1 });

  it('габарит ±1 мм — той самий; 1,01 мм — інший; трикутники інші — інший; назва й розмір файлу не важать', () => {
    expect(sameScan(fp(4000), fp(4001))).toBe(true);
    expect(sameScan(fp(4001), fp(4000))).toBe(true);
    expect(sameScan(fp(4000), fp(4001.01))).toBe(false);
    expect(sameScan(fp(4000), fp(4000, 1001))).toBe(false);
    expect(sameScan(fp(4000), { ...fp(4000), name: 'інший.glb', fileBytes: 5 })).toBe(true);
  });

  // Була помилка програми (виправлено): sameScan — допуск ±1 мм, а scanKey (ключ чернетки) — округлення до мм. Скани, які
  // програма вважає «тим самим» для проєкту, можуть мати різні ключі чернетки (межа x,5 мм).
  it('той самий скан (різниця габариту 0,2 мм) має ту саму чернетку — scanKey однаковий', () => {
    // 4000,4 і 4000,6 мм — «той самий скан» за правилом ±1 мм, але округлення до мм дає 4000 і 4001.
    const a = fp(4000.4);
    const b = fp(4000.6);
    expect(sameScan(a, b)).toBe(true);
    expect(scanKey(a)).toBe(scanKey(b));
  });
});

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('Етап 6 (tester): чернетки', () => {
  const scanN = (n: number): ScanFingerprint => ({ name: `s${n}.zip`, triangles: 1000 + n, sizeMm: { x: 4000, y: 2700, z: 3000 }, fileBytes: 1 });
  const proj = (scan: ScanFingerprint, nodes: PointMm[]): ProjectData => data({ routes: [{ id: 1, nodes, duct: null }], nextId: 2 }, { scan });

  it('два скани — дві окремі чернетки; видалення трас одного не чіпає іншого', () => {
    const storage = memoryStorage();
    const drafts = createDrafts(storage);
    const a = longRoute(520, 11).nodes;
    const b = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 2500, z: 0 }];
    drafts.save(proj(scanN(1), a));
    drafts.save(proj(scanN(2), b));
    expect(drafts.get(scanN(1))!.project.set.routes[0]!.nodes).toEqual(a);
    expect(drafts.get(scanN(2))!.project.set.routes[0]!.nodes).toEqual(b);
    drafts.save(data({ routes: [], nextId: 2 }, { scan: scanN(1) }));
    expect(drafts.get(scanN(1))).toBeNull();
    expect(drafts.get(scanN(2))).not.toBeNull();
  });

  // Була помилка програми (виправлено) (дрібна): drafts.save сортує за savedAt і відкидає «найстаріші» — новий запис із
  // годинником, переведеним назад, відкидається одразу ж після запису.
  it('годинник пристрою перевели назад, чернеток уже 10 — щойно записана чернетка не губиться', () => {
    const storage = memoryStorage();
    let now = Date.UTC(2027, 0, 1);
    const drafts = createDrafts(storage, () => new Date(now));
    for (let i = 1; i <= DRAFTS_LIMIT; i++) {
      now += 1000;
      drafts.save(proj(scanN(i), [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }]));
    }
    // Годинник виправили (був на рік уперед) — новий запис «старіший» за всі.
    now = Date.UTC(2026, 0, 1);
    drafts.save(proj(scanN(99), [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1000 }]));
    expect(drafts.get(scanN(99))).not.toBeNull();
  });

  // Була помилка програми (виправлено) (дрібна): read() не перевіряє записи; сортування в save читає null.savedAt → TypeError,
  // і чернетки цього браузера більше ніколи не пишуться (зіпсований запис не прибирається).
  it('сховище з чужим/зіпсованим записом усередині (null замість чернетки) — нова чернетка все одно пишеться', () => {
    const storage = memoryStorage();
    storage.data.set(DRAFTS_KEY, JSON.stringify({ 'зіпсовано': null, 'ще': 5 }));
    const drafts = createDrafts(storage);
    expect(() => drafts.save(proj(scanN(1), [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }]))).not.toThrow();
    expect(drafts.get(scanN(1))).not.toBeNull();
  });

  it('чернетка — той самий формат, що й файл: траси (мм), повітропроводи, вигляд, режим показу', () => {
    const storage = memoryStorage();
    const drafts = createDrafts(storage);
    const nodes = longRoute(30, 5).nodes;
    const duct: DuctSpec = { section: { shape: 'rect', widthMm: 600, heightMm: 300 }, transitions: [{ segment: 4, to: { shape: 'rect', widthMm: 500, heightMm: 300 } }] };
    const p = data({ routes: [{ id: 4, nodes, duct }], nextId: 9 }, { scan: scanN(3), display: { mode: 'duct', transparency: 0.6 } });
    drafts.save(p);
    const got = drafts.get(scanN(3))!.project;
    expect(got.set).toEqual({ routes: [{ id: 4, nodes, duct }], nextId: 9 });
    expect(got.view).toEqual(p.view);
    expect(got.display).toEqual({ mode: 'duct', transparency: 0.6 });
  });
});
