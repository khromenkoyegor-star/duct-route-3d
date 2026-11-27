/**
 * Етап 6: файл проєкту — збереження й читання туди-назад (±0,1 мм), перевірка пошкоджених і чужих
 * файлів, новіша версія, відбиток скану, назва й ім'я файлу.
 */
import { describe, expect, it } from 'vitest';
import type { DuctSpec } from '../../src/core/duct';
import {
  defaultProjectName,
  formatRouteCount,
  looksLikeProjectFile,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  type ProjectData,
  parseProject,
  projectFileName,
  sameScan,
  type ScanFingerprint,
  scanFingerprint,
  scanKey,
  serializeProject,
} from '../../src/core/project';
import type { RouteSet } from '../../src/core/route';

const SCAN: ScanFingerprint = { name: 'Цех2.zip', triangles: 120_000, sizeMm: { x: 4000, y: 2700, z: 3000 }, fileBytes: 2_500_000 };

/** Дві траси: з діагоналлю 45° і повітропроводом з переходом; проста без труби. */
const SET: RouteSet = {
  routes: [
    {
      id: 1,
      nodes: [
        { x: -1500.000000000002, y: 2200, z: -1000 },
        { x: -500.3333333, y: 2200, z: -1000 },
        { x: 499.6666667, y: 2200, z: -0.0000000001 },
        { x: 1300.25, y: 2200, z: 0 },
      ],
      duct: {
        section: { shape: 'round', diameterMm: 250 },
        transitions: [{ segment: 2, to: { shape: 'round', diameterMm: 200 } }],
      } satisfies DuctSpec,
    },
    { id: 3, nodes: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1250.5, z: 0 }], duct: null },
  ],
  nextId: 4,
};

const DATA: ProjectData = {
  name: 'Цех 2 · 27.11.2026',
  savedAt: '2026-11-27T12:05:00.000Z',
  scan: SCAN,
  set: SET,
  view: { position: { x: 3200, y: 3400, z: 5200 }, target: { x: 0, y: 1400, z: 0 }, projection: 'ortho' },
  display: { mode: 'duct', transparency: 0.4 },
};

const parse = (text: string) => {
  const r = parseProject(text);
  if (!r.ok) throw new Error(r.error);
  return r.project;
};

describe('файл проєкту: туди-назад', () => {
  it('ті самі траси (±0,1 мм, насправді — точно), номери, повітропроводи з переходами, вигляд і режим показу', () => {
    const p = parse(serializeProject(DATA));
    expect(p.set.nextId).toBe(4);
    expect(p.set.routes.map((r) => r.id)).toEqual([1, 3]);
    for (let i = 0; i < SET.routes.length; i++) {
      const a = SET.routes[i]!;
      const b = p.set.routes[i]!;
      expect(b.nodes).toHaveLength(a.nodes.length);
      a.nodes.forEach((n, k) => {
        for (const key of ['x', 'y', 'z'] as const) expect(Math.abs(b.nodes[k]![key] - n[key])).toBeLessThanOrEqual(0.1);
      });
      expect(b.duct ?? null).toEqual(a.duct ?? null);
    }
    expect(p.name).toBe(DATA.name);
    expect(p.savedAt).toBe(DATA.savedAt);
    expect(p.scan).toEqual(SCAN);
    expect(p.view).toEqual(DATA.view);
    expect(p.display).toEqual(DATA.display);
  });

  it('файл — читабельний JSON з форматом, версією й назвою програми', () => {
    const raw = JSON.parse(serializeProject(DATA));
    expect(raw.format).toBe(PROJECT_FORMAT);
    expect(raw.version).toBe(PROJECT_VERSION);
    expect(raw.app).toBe('Траса 3D 2');
    expect(serializeProject(DATA)).toContain('\n  "routes"');
  });

  it('порожній проєкт (без трас, без скану, без вигляду) — теж читається', () => {
    const p = parse(serializeProject({ ...DATA, scan: null, set: { routes: [], nextId: 1 }, view: null, display: null }));
    expect(p.set).toEqual({ routes: [], nextId: 1 });
    expect(p.scan).toBeNull();
    expect(p.view).toBeNull();
    expect(p.display).toBeNull();
  });
});

describe('файл проєкту: пошкоджені й чужі файли — зрозуміле повідомлення', () => {
  const base = () => JSON.parse(serializeProject(DATA));
  const error = (value: unknown) => {
    const r = parseProject(typeof value === 'string' ? value : JSON.stringify(value));
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error;
  };

  it('не JSON, чужий JSON, масив, без трас — «не файл проєкту»', () => {
    for (const bad of ['', 'abc', '{"a":1', '[]', '{"format":"other","version":1,"routes":[]}', { format: PROJECT_FORMAT, version: 1 }]) {
      expect(error(bad)).toMatch(/не файл проєкту/);
    }
  });

  it('новіша версія — просить оновити сторінку', () => {
    expect(error({ ...base(), version: PROJECT_VERSION + 1 })).toMatch(/новішою версією/);
  });

  it('траса не за правилами (кут 30°) — називає трасу', () => {
    const raw = base();
    raw.routes[1].nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 577 },
    ];
    expect(error(raw)).toMatch(/^Траса 3 не за правилами/);
  });

  it('точка з NaN чи текстом, номер-дріб, номер двічі — помилка з номером траси', () => {
    const r1 = base();
    r1.routes[0].nodes[1].x = 'abc';
    expect(error(r1)).toMatch(/^Траса 1 /);
    const r2 = base();
    r2.routes[0].id = 1.5;
    expect(error(r2)).toMatch(/немає правильного номера/);
    const r3 = base();
    r3.routes[1].id = 1;
    expect(error(r3)).toMatch(/у файлі двічі/);
  });

  it('повітропровід: невідомий діаметр, перехід поза відрізками — помилка', () => {
    const r1 = base();
    r1.routes[0].duct.section.diameterMm = 237;
    expect(error(r1)).toMatch(/неправильний розмір повітропроводу/);
    const r2 = base();
    r2.routes[0].duct.transitions[0].segment = 7;
    expect(error(r2)).toMatch(/неправильний розмір повітропроводу/);
  });

  it('замалий чи відсутній nextId — виправляється (більший за всі номери)', () => {
    const r = base();
    r.nextId = 2;
    expect(parse(JSON.stringify(r)).set.nextId).toBe(4);
    delete r.nextId;
    expect(parse(JSON.stringify(r)).set.nextId).toBe(4);
  });

  it('зіпсований вигляд камери чи режим показу — просто не застосовуються', () => {
    const r = base();
    r.view = { position: { x: 'a' }, target: null };
    r.display = { mode: 'sideways', transparency: 5 };
    const p = parse(JSON.stringify(r));
    expect(p.view).toBeNull();
    expect(p.display).toBeNull();
    // Прозорість поза межами — обмежується 0…0,9.
    r.display = { mode: 'both', transparency: 5 };
    expect(parse(JSON.stringify(r)).display).toEqual({ mode: 'both', transparency: 0.9 });
  });
});

describe('відбиток скану', () => {
  const info = { sizeMm: { x: 4000.2, y: 2700, z: 3000 }, offsetYMm: 0, triangles: 120_000, fileBytes: 999, warnings: [], risks: [] };

  it('той самий скан: трикутники рівні, габарит ±1 мм; назву й розмір файлу не порівнюємо', () => {
    const fp = scanFingerprint('інша-назва.glb', info);
    expect(sameScan(fp, SCAN)).toBe(true);
    expect(sameScan({ ...SCAN, triangles: 120_001 }, SCAN)).toBe(false);
    expect(sameScan({ ...SCAN, sizeMm: { x: 4002, y: 2700, z: 3000 } }, SCAN)).toBe(false);
    expect(scanKey(fp)).toBe(scanKey(SCAN));
  });
});

describe('назва й ім\'я файлу', () => {
  it('назва за замовчуванням — назва скану без розширення й дата', () => {
    expect(defaultProjectName('Цех2.zip', new Date(2026, 10, 27, 14, 5))).toBe('Цех2 · 27.11.2026');
    expect(defaultProjectName(null, new Date(2026, 0, 3))).toBe('Проєкт · 03.01.2026');
  });

  it('ім\'я файлу без символів, яких не приймають «Файли»; .json', () => {
    expect(projectFileName('Цех 2 · 27.11.2026')).toBe('Цех 2 · 27.11.2026.json');
    expect(projectFileName('a/b:c*?"<>|d')).toBe('a-b-c-d.json');
    expect(projectFileName('   ')).toBe('Проєкт.json');
    expect(looksLikeProjectFile('Цех 2.JSON')).toBe(true);
    expect(looksLikeProjectFile('scan.zip')).toBe(false);
  });

  it('«1 траса», «3 траси», «5 трас», «11 трас», «21 траса»', () => {
    expect([1, 3, 5, 11, 21, 22, 25].map(formatRouteCount)).toEqual([
      '1 траса',
      '3 траси',
      '5 трас',
      '11 трас',
      '21 траса',
      '22 траси',
      '25 трас',
    ]);
  });
});
