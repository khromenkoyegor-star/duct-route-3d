/**
 * Етап 6 (tester): збереження проєкту — перевірка «від вимог» у браузері, доповнення до project.spec.ts.
 *
 * Критерії (ROADMAP, «Етап 6»):
 * - збережений і знову відкритий проєкт дає ту саму трасу (±0,1 мм): точки, номери трас, розміри труб і переходи;
 *   камера й «Орто» — як були;
 * - проєкт, відкритий до скану, застосовується після відкриття потрібного скану; чужий скан — з попередженням;
 * - пошкоджений, чужий чи новіший файл — зрозуміле повідомлення, нічого на екрані не ламається;
 * - після перезавантаження сторінки той самий скан пропонує повернути траси з чернетки;
 *   перехід на інший скан траси не стирає безповоротно.
 * Тестова кімната 4000 × 2700 × 3000 мм; другий скан — коробка 6000 × 3000 × 4000 мм (GLB з пам'яті).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { Mesh, Object3D, Scene } from 'three';
import { boxRoom, buildGlb, lcg } from '../fixtures/gltf-builder.ts';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));
const BOX_GLB = { name: 'box-6000x3000x4000.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(buildGlb({ meshes: [boxRoom([-3, 0, -2], [3, 3, 2])] })) };

type P3 = { x: number; y: number; z: number };
type Section = { shape: 'round'; diameterMm: number } | { shape: 'rect'; widthMm: number; heightMm: number };
type Spec = { section: Section; transitions: Array<{ segment: number; to: Section }> };
type RouteIn = { id: number; nodes: P3[]; duct: Spec | null };
type SetIn = { routes: RouteIn[]; nextId: number };

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const frames = (page: Page, n = 3) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, n);

// ───────────── Траси для перевірок ─────────────

type V = [number, number, number];
/** 18 напрямків: 6 уздовж осей і 12 діагоналей 45° у площинах XY, XZ, ZY. */
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
const turnOk = (p: V, n: V) => {
  const cos = (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / Math.sqrt((p[0] ** 2 + p[1] ** 2 + p[2] ** 2) * (n[0] ** 2 + n[1] ** 2 + n[2] ** 2));
  return [1, Math.SQRT1_2, 0].some((c) => Math.abs(cos - c) < 1e-9);
};
/** Траса за правилами з `points` точок: відрізки 300…2000 мм з частками, повороти 45° і 90°. */
function longRoute(points: number, seed: number, start: P3): P3[] {
  const rnd = lcg(seed);
  const nodes: P3[] = [{ ...start }];
  let prev: V | null = null;
  while (nodes.length < points) {
    const options = DIRS.filter((d) => !prev || turnOk(prev, d));
    const dir = options[Math.floor(rnd() * options.length)]!;
    const step = Math.round((300 + rnd() * 1700) * 1e6) / 1e6;
    const last = nodes[nodes.length - 1]!;
    nodes.push({ x: last.x + dir[0] * step, y: last.y + dir[1] * step, z: last.z + dir[2] * step });
    prev = dir;
  }
  return nodes;
}

/** Номери з пропусками (1, 3, 7), 520 точок з діагоналями, прямокутна труба з переходами, кругла з переходами. */
const LONG_SET: SetIn = {
  routes: [
    {
      id: 1,
      nodes: longRoute(520, 21, { x: 0, y: 1500, z: 0 }),
      duct: { section: { shape: 'round', diameterMm: 160 }, transitions: [{ segment: 100, to: { shape: 'round', diameterMm: 125 } }, { segment: 300, to: { shape: 'round', diameterMm: 100 } }] },
    },
    {
      id: 3,
      nodes: longRoute(40, 22, { x: -1000, y: 2000, z: -500 }),
      duct: {
        section: { shape: 'rect', widthMm: 300, heightMm: 200 },
        transitions: [
          { segment: 5, to: { shape: 'rect', widthMm: 250, heightMm: 200 } },
          { segment: 20, to: { shape: 'rect', widthMm: 250, heightMm: 150.5 } },
        ],
      },
    },
    { id: 7, nodes: [{ x: 1000, y: 300, z: 900 }, { x: 1000, y: 1500, z: 900 }, { x: 1000, y: 2500, z: -100 }], duct: null },
  ],
  nextId: 12,
};

const ROUTES: SetIn = {
  routes: [
    {
      id: 1,
      nodes: [
        { x: -1500, y: 2200, z: -1000 },
        { x: -500, y: 2200, z: -1000 },
        { x: 500, y: 2200, z: 0 },
        { x: 1300, y: 2200, z: 0 },
      ],
      duct: { section: { shape: 'round', diameterMm: 250 }, transitions: [{ segment: 2, to: { shape: 'round', diameterMm: 200 } }] },
    },
    { id: 2, nodes: [{ x: 1000, y: 300, z: 900 }, { x: 1000, y: 1500, z: 900 }], duct: null },
  ],
  nextId: 3,
};

const OTHER: SetIn = {
  routes: [
    {
      id: 4,
      nodes: [
        { x: -1800, y: 2400, z: 1200 },
        { x: 1800, y: 2400, z: 1200 },
      ],
      duct: { section: { shape: 'rect', widthMm: 400, heightMm: 200 }, transitions: [] },
    },
  ],
  nextId: 9,
};

/** Файл проєкту «руками» (як його збереже програма; scan: null — підходить до будь-якого скану). */
function projectJson(set: SetIn, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'trasa-3d-project', version: 1, app: 'Траса 3D 2', name: 'Тест', savedAt: '2026-11-27T10:00:00.000Z', scan: null, nextId: set.nextId, routes: set.routes, view: null, display: null, ...extra });
}
const projectFile = (text: string, name = 'Проєкт.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });

/** Траси однакові: номери, nextId, точки (±0,1 мм), повітропроводи. */
function expectSameSet(actual: SetIn, expected: SetIn) {
  expect(actual.nextId).toBe(expected.nextId);
  expect(actual.routes.map((r) => r.id)).toEqual(expected.routes.map((r) => r.id));
  expected.routes.forEach((r, i) => {
    const got = actual.routes[i]!;
    expect(got.nodes).toHaveLength(r.nodes.length);
    let worst = 0;
    r.nodes.forEach((n, k) => {
      for (const key of ['x', 'y', 'z'] as const) worst = Math.max(worst, Math.abs(got.nodes[k]![key] - n[key]));
    });
    expect(worst, `траса ${r.id}: найбільше відхилення, мм`).toBeLessThanOrEqual(0.1);
    expect(got.duct ?? null).toEqual(r.duct ?? null);
  });
}

// ───────────── Дії ─────────────

async function openApp(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
}

async function openScan(page: Page, files: Parameters<Page['setInputFiles']>[1] = ROOM_ZIP) {
  await page.getByTestId('file-input').setInputFiles(files);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
}

async function openRoom(page: Page) {
  await openApp(page);
  await openScan(page);
}

const loadRoutes = (page: Page, set: SetIn) => page.evaluate((s) => window.__trasa!.app!.loadRoutes(s), set);

async function reloadApp(page: Page) {
  await page.reload();
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
}

/** Підмінити «Поділитися»: файл лишається в window.__shared. */
async function stubShare(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: { name: string; type: string; text: string } | null };
    w.__shared = null;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => !!data.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[] }) => {
        const file = data.files[0]!;
        w.__shared = { name: file.name, type: file.type, text: await file.text() };
      },
    });
  });
}
async function shared(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __shared: unknown }).__shared !== null);
  return page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; text: string } }).__shared);
}

async function saveViaMenu(page: Page, name?: string) {
  await page.getByTestId('open-scan').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByTestId('prompt')).toBeVisible();
  if (name !== undefined) await page.getByTestId('prompt-input').fill(name);
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('prompt')).toBeHidden();
}

/** Дві точки траси через інтерфейс (як у project.spec.ts): дотик по підлозі, повзунок угору. */
async function buildTwoPoints(page: Page) {
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
  await page.getByTestId('route').click();
  const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await page.getByTestId('confirm-point').filter({ visible: true }).click();
  const slider = (await page.getByTestId('stick-y').filter({ visible: true }).boundingBox())!;
  await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 - 50, { steps: 3 });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.getByTestId('confirm-point').filter({ visible: true }).click();
  expect((await state(page)).routes.building.nodes).toHaveLength(2);
}

/** Сцени Three.js (через __THREE_DEVTOOLS__) — щоб перевірити прозорість скану й видимість труб. */
async function installHook(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __scenes: unknown[]; __THREE_DEVTOOLS__: EventTarget };
    w.__scenes = [];
    const hub = new EventTarget();
    hub.addEventListener('observe', (e) => {
      const d = (e as CustomEvent).detail as { isScene?: boolean };
      if (d?.isScene) w.__scenes.push(d);
    });
    w.__THREE_DEVTOOLS__ = hub;
  });
}
const sceneInfo = (page: Page) =>
  page.evaluate(() => {
    const scenes = (window as unknown as { __scenes: Scene[] }).__scenes;
    const scanScene = scenes.find((s) => s.getObjectByName('scan-group'));
    const opacities: number[] = [];
    scanScene?.getObjectByName('scan-group')?.traverse((o: Object3D) => {
      const m = (o as Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) opacities.push(x.opacity);
    });
    const ducts = scenes.find((s) => s.getObjectByName('ducts'))?.getObjectByName('ducts');
    return { opacities, ductsVisible: ducts?.visible ?? null };
  });

const pageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

// ───────────── Тести ─────────────

test.describe('Етап 6 (tester): туди-назад через інтерфейс', () => {
  test('520 точок з діагоналями, кругла й прямокутна труби з переходами, номери 1, 3, 7, nextId 12 — ті самі (±0,1 мм), труби побудовано', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = pageErrors(page);
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, LONG_SET);
    await saveViaMenu(page, 'Довга траса');
    const file = (await shared(page))!;
    // Зберегли — далі сторінка «з нуля», без чернетки.
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice')).toBeHidden();
    await page.getByTestId('file-input').setInputFiles(projectFile(file.text, file.name));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 3);
    const s = await state(page);
    expectSameSet(s.routes.set, LONG_SET);
    for (const id of [1, 3]) expect(await page.evaluate((i) => window.__trasa!.app!.ductBox(i), id), `труба траси ${id}`).not.toBeNull();
    expect(s.ducts.routes.find((r: { id: number }) => r.id === 3).sections[30]).toBe('250×150.5');
    // Наступна траса — № 12 (не 8 і не 4).
    expect(s.routes.set.nextId).toBe(12);
    expect(errors).toEqual([]);
  });

  test('назва з кирилицею й символами / \\ : * ? " < > | — у файлі назва як є, ім\'я файлу без цих символів; файл — кілька кБ', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    const name = 'Цех №2: «Схід» / кв.3 *?"<>|\\ 🙂';
    await saveViaMenu(page, name);
    const file = (await shared(page))!;
    expect(file.name.endsWith('.json')).toBe(true);
    expect(file.name).not.toMatch(/[/\\:*?"<>|]/);
    for (const part of ['Цех №2', '«Схід»', 'кв.3', '🙂']) expect(file.name).toContain(part);
    const raw = JSON.parse(file.text);
    expect(raw.name).toBe(name);
    // «Сам скан у файл не потрапляє»: файл маленький.
    expect(file.text.length).toBeLessThan(20_000);
    expect(file.text).not.toMatch(/glTF|bufferView|base64/);
  });

  test('розмір і перехід, задані в панелі «Повітропровід», — у файлі й у чернетці; після відкриття ті самі', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
    // Траса 2 — Ø315 (була без труби).
    await page.getByTestId('duct-route-2').click();
    await page.getByTestId('duct-diameter').selectOption('315');
    // Траса 1 — ще перехід на відрізку 2 (індекс 1) на Ø315; далі, як і було, Ø200.
    await page.getByTestId('duct-route-1').click();
    await page.getByTestId('duct-segment-1').click();
    await page.getByTestId('duct-transition-diameter').selectOption('315');
    await page.getByTestId('duct-transition-here').click();
    await page.getByTestId('duct-close').click();
    const expected: SetIn = {
      routes: [
        {
          ...ROUTES.routes[0]!,
          duct: {
            section: { shape: 'round', diameterMm: 250 },
            transitions: [
              { segment: 1, to: { shape: 'round', diameterMm: 315 } },
              { segment: 2, to: { shape: 'round', diameterMm: 200 } },
            ],
          },
        },
        { ...ROUTES.routes[1]!, duct: { section: { shape: 'round', diameterMm: 315 }, transitions: [] } },
      ],
      nextId: 3,
    };
    expectSameSet((await state(page)).routes.set, expected);
    await saveViaMenu(page, 'Панель');
    const raw = JSON.parse((await shared(page))!.text);
    expectSameSet({ routes: raw.routes, nextId: raw.nextId }, expected);
    // Чернетка (одразу перезавантажили) — теж з новими розмірами.
    await reloadApp(page);
    await openScan(page);
    await page.getByTestId('choice-restore').click();
    expectSameSet((await state(page)).routes.set, expected);
    expect((await state(page)).ducts.routes.map((r: { sections: string[] }) => r.sections)).toEqual([['Ø250', 'Ø315', 'Ø200'], ['Ø315']]);
  });

  test('«Скасувати» у вікні назви — нічого не збережено, назва проєкту не змінилась', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await page.getByTestId('prompt-input').fill('Не треба');
    await page.getByTestId('prompt-cancel').click();
    await expect(page.getByTestId('prompt')).toBeHidden();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __shared: unknown }).__shared)).toBeNull();
    expect((await state(page)).project.name).toBeNull();
  });

  test('«Поділитися» не вдалось (не AbortError) — файл іде в «Завантаження»; закрили «Поділитися» (AbortError) — нічого', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shareError: string };
      w.__shareError = 'NotAllowedError';
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => Promise.reject(new DOMException('no', w.__shareError)) });
    });
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    const downloading = page.waitForEvent('download', { timeout: 5000 });
    await saveViaMenu(page, 'Офіс');
    const download = await downloading;
    const raw = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expectSameSet({ routes: raw.routes, nextId: raw.nextId }, ROUTES);
    // Тепер людина сама закрила «Поділитися».
    await page.evaluate(() => ((window as unknown as { __shareError: string }).__shareError = 'AbortError'));
    let downloaded = false;
    page.on('download', () => (downloaded = true));
    await saveViaMenu(page, 'Офіс');
    await page.waitForTimeout(800);
    expect(downloaded).toBe(false);
    await expect(page.getByTestId('alert')).toBeHidden();
  });
});

test.describe('Етап 6 (tester): незвичайні файли проєкту', () => {
  test('файл з BOM і з розширенням .JSON великими — відкривається', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('file-input').setInputFiles({ name: 'ПРОЄКТ.JSON', mimeType: 'application/json', buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(projectJson(ROUTES), 'utf8')]) });
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    expectSameSet((await state(page)).routes.set, ROUTES);
    await expect(page.getByTestId('alert')).toBeHidden();
  });

  test('порожній файл, траса з однієї точки, числа-рядки, труба не тієї форми, 20 МБ сміття — зрозуміле повідомлення; траси й скан на місці', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = pageErrors(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    const onePoint = projectJson({ routes: [{ id: 5, nodes: [{ x: 0, y: 0, z: 0 }], duct: null }], nextId: 6 });
    const strings = projectJson({ routes: [{ id: 5, nodes: [{ x: '0', y: '0', z: '0' }, { x: '1000', y: '0', z: '0' }] as unknown as P3[], duct: null }], nextId: 6 });
    const wrongShape = projectJson({
      routes: [{ id: 5, nodes: [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 1000, z: 0 }], duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [{ segment: 1, to: { shape: 'rect', widthMm: 200, heightMm: 200 } }] } }],
      nextId: 6,
    });
    const duplicate = projectJson({ routes: [{ id: 5, nodes: [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 900, z: 0 }], duct: null }], nextId: 6 });
    const huge = '{"format":"trasa-3d-project","version":1,"routes":[' + ' '.repeat(20 * 1024 * 1024);
    for (const [text, message] of [
      ['', 'не файл проєкту'],
      [onePoint, 'Траса 5 не за правилами'],
      [strings, 'Траса 5 не за правилами'],
      [wrongShape, 'Траса 5: неправильний розмір повітропроводу'],
      [duplicate, 'Траса 5 не за правилами'],
      [huge, 'не файл проєкту'],
    ] as const) {
      await page.getByTestId('file-input').setInputFiles(projectFile(text, 'файл.json'));
      await expect(page.getByTestId('alert')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('alert-text')).toContainText(message);
      await page.getByTestId('alert').getByRole('button').click();
      await expect(page.getByTestId('alert')).toBeHidden();
      const s = await state(page);
      expect(s.status).toBe('ready');
      expectSameSet(s.routes.set, ROUTES);
      await expect(page.getByTestId('choice')).toBeHidden();
    }
    expect(await page.evaluate(() => window.__trasa!.app!.ductBox(1))).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('координати поза будь-яким розумним розміром (1e300 мм) — повідомлення або нічого не ламається: «Показати все» повертає камеру', async ({ page }) => {
    const errors = pageErrors(page);
    await openRoom(page);
    const absurd = projectJson({
      routes: [{ id: 1, nodes: [{ x: 0, y: 1000, z: 0 }, { x: 1e300, y: 1000, z: 0 }], duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [] } }],
      nextId: 2,
    });
    await page.getByTestId('file-input').setInputFiles(projectFile(absurd, 'дивний.json'));
    await frames(page, 5);
    if (await page.getByTestId('alert').isVisible()) {
      expect((await state(page)).routes.set.routes).toHaveLength(0);
      return;
    }
    await page.getByTestId('duct').click();
    await frames(page, 5);
    await page.getByTestId('duct-close').click();
    await page.getByTestId('show-all').click();
    await frames(page, 5);
    const v = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Number.isFinite(v.position[k])).toBe(true);
      expect(Math.abs(v.position[k])).toBeLessThan(100);
    }
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 0, y: 0, z: 0 }));
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('скан разом із пошкодженим проєктом — повідомлення про проєкт, а скан відкривається', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('file-input').setInputFiles([
      { name: 'room-4000x2700x3000.zip', mimeType: 'application/zip', buffer: readFileSync(ROOM_ZIP) },
      projectFile('{зіпсовано', 'Цех.json'),
    ]);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await expect(page.getByTestId('alert')).toBeVisible();
    await expect(page.getByTestId('alert-text')).toContainText('не файл проєкту');
    const s = await state(page);
    expect(s.scanName).toBe('room-4000x2700x3000.zip');
    expect(s.routes.set.routes).toHaveLength(0);
    expect(s.project.pending).toBeNull();
  });
});

test.describe('Етап 6 (tester): порядок відкриття', () => {
  test('проєкт без скану → «Пізніше» → скан через «Файл» → «Відкрити скан або проєкт»: проєкт застосовано', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { name: 'Цех 5' })));
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-later').click();
    await expect(page.getByTestId('choice')).toBeHidden();
    expect((await state(page)).project.pending).toBe('Цех 5');
    await page.getByTestId('open-scan').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('menu-open').click();
    await (await chooser).setFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    const s = await state(page);
    expectSameSet(s.routes.set, ROUTES);
    expect(s.project).toEqual({ name: 'Цех 5', pending: null });
    expect(await page.evaluate(() => window.__trasa!.app!.ductBox(1))).not.toBeNull();
  });

  test('скан і проєкт для іншого скану разом — попередження (не мовчки)', async ({ page }) => {
    await openApp(page);
    const foreign = projectJson(ROUTES, { name: 'Склад', scan: { name: 'Склад.zip', triangles: 99_999, sizeMm: { x: 50_000, y: 9000, z: 20_000 }, fileBytes: 1 } });
    await page.getByTestId('file-input').setInputFiles([
      { name: 'room-4000x2700x3000.zip', mimeType: 'application/zip', buffer: readFileSync(ROOM_ZIP) },
      projectFile(foreign, 'Склад.json'),
    ]);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await expect(page.getByTestId('choice-text')).toContainText('зроблено для скану «Склад.zip»');
    expect((await state(page)).routes.set.routes).toHaveLength(0);
    await page.getByTestId('choice-show').click();
    expectSameSet((await state(page)).routes.set, ROUTES);
  });

  test('проєкт для іншого скану відкрито до скану → «Скасувати» на попередженні — програма все одно пропонує чернетку цього скану', async ({ page }) => {
    // Була помилка програми (виправлено): openFiles при pendingProject викликає лише confirmProjectForScan, а offerDraft — ні.
    // Скасували чужий проєкт — питання «Повернути траси з минулого разу?» не з'являється; перша ж нова траса
    // перезапише чернетку, і старі траси цього скану зникнуть безповоротно.
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await reloadApp(page);
    const foreign = projectJson(OTHER, { name: 'Склад', scan: { name: 'Склад.zip', triangles: 99_999, sizeMm: { x: 50_000, y: 9000, z: 20_000 }, fileBytes: 1 } });
    await page.getByTestId('file-input').setInputFiles(projectFile(foreign, 'Склад.json'));
    await page.getByTestId('choice-later').click();
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('зроблено для скану «Склад.zip»');
    await page.getByTestId('choice-cancel').click();
    await expect(page.locator('#choice-title')).toHaveText('Повернути траси з минулого разу?', { timeout: 3000 });
  });

  test('поки скан відкривається — «Файл» неактивна, меню не відкривається (проєкт посеред відкриття не вибрати)', async ({ page }) => {
    // Читання файлу скану сповільнено на 1,5 с, щоб застати стан «відкривається».
    await page.addInitScript(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function (this: Blob) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return original.call(this);
      };
    });
    await openApp(page);
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'loading');
    await expect(page.getByTestId('open-scan')).toBeDisabled();
    await expect(page.getByTestId('progress')).toBeVisible();
    const b = (await page.getByTestId('open-scan').boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('menu')).toBeHidden();
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await expect(page.getByTestId('open-scan')).toBeEnabled();
  });

  test('два проєкти поспіль — другий питає «Замінити траси?» і після «Замінити» — його траси й номери', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { name: 'Перший' })));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(OTHER, { name: 'Другий' })));
    await expect(page.getByTestId('choice-text')).toContainText('«Другий» (1 траса)');
    await page.getByTestId('choice-replace').click();
    const s = await state(page);
    expectSameSet(s.routes.set, OTHER);
    expect(s.project.name).toBe('Другий');
    expect(await page.evaluate(() => window.__trasa!.app!.ductBox(4))).not.toBeNull();
    expect(await page.evaluate(() => window.__trasa!.app!.ductBox(1))).toBeNull();
  });

  test('проєкт під час побудови траси (через «Файл») — попередження про недобудовану трасу; після «Замінити» побудову закрито', async ({ page }) => {
    await openRoom(page);
    await buildTwoPoints(page);
    const file = page.getByTestId('open-scan');
    test.skip(!(await file.isVisible()), 'кнопка «Файл» схована під час побудови (iPhone вертикально)');
    await file.click();
    await page.getByTestId('menu-open').click();
    await expect(page.getByTestId('choice-text')).toContainText('Недобудовану трасу 1 не буде збережено');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('choice-open').click();
    await (await chooser).setFiles(projectFile(projectJson(OTHER)));
    await expect(page.getByTestId('choice-text')).toContainText('Траси на екрані замінять');
    await page.getByTestId('choice-replace').click();
    const s = await state(page);
    expectSameSet(s.routes.set, OTHER);
    expect(s.routes.building).toBeNull();
    expect(s.routes.editor.active).toBe(false);
    expect(s.tool).toBe('none');
    await expect(page.getByTestId('route-panel')).toBeHidden();
  });

  test('проєкт під час побудови — «Скасувати» на «Замінити траси?»: недобудована траса лишається', async ({ page }) => {
    await openRoom(page);
    await buildTwoPoints(page);
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(OTHER)));
    await expect(page.getByTestId('choice-text')).toContainText('Траси на екрані замінять');
    await page.getByTestId('choice-cancel').click();
    const s = await state(page);
    expect(s.routes.building.nodes).toHaveLength(2);
    expect(s.routes.set.routes).toHaveLength(0);
    expect(s.tool).toBe('route');
  });

  for (const [tool, panel] of [
    ['duct', 'duct-panel'],
    ['route-delete', 'route-delete-panel'],
  ] as const) {
    test(`проєкт, коли відкрито «${tool === 'duct' ? 'Повітропровід' : 'Видалити траєкторію'}» — після «Замінити» панель закрита, траси й труби з проєкту`, async ({ page }) => {
      const errors = pageErrors(page);
      await openRoom(page);
      await loadRoutes(page, ROUTES);
      await page.getByTestId(tool).click();
      await expect(page.getByTestId(panel)).toBeVisible();
      if (tool === 'route-delete') await page.getByTestId('route-row-1').click();
      await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(OTHER)));
      await page.getByTestId('choice-replace').click();
      await expect(page.getByTestId(panel)).toBeHidden();
      const s = await state(page);
      expect(s.tool).toBe('none');
      expectSameSet(s.routes.set, OTHER);
      expect(s.routes.highlight).toBeNull();
      expect(s.ducts.selection).toBeNull();
      expect(s.ducts.routes.map((r: { id: number }) => r.id)).toEqual([4]);
      expect(await page.evaluate(() => window.__trasa!.app!.ductBox(4))).not.toBeNull();
      // Панель знову відкривається з новими трасами.
      await page.getByTestId(tool).click();
      await expect(page.getByTestId(panel)).toBeVisible();
      if (tool === 'route-delete') await expect(page.getByTestId('route-row-4')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test.describe('Етап 6 (tester): вигляд, «Орто», режим показу, прозорість', () => {
  test('режим «Траса» і прозорість 50 % з файлу — застосовано (труби сховано, скан напівпрозорий, панель показує 50 %)', async ({ page }) => {
    await installHook(page);
    await openRoom(page);
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { display: { mode: 'route', transparency: 0.5 } })));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    await frames(page);
    let s = await state(page);
    expect(s.ducts.mode).toBe('route');
    expect(s.ducts.transparency).toBe(0.5);
    let info = await sceneInfo(page);
    expect(info.ductsVisible).toBe(false);
    expect(info.opacities.length).toBeGreaterThan(0);
    for (const o of info.opacities) expect(o).toBeCloseTo(0.5, 5);
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('view-mode-route')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('scan-opacity')).toHaveValue('50');
    await page.getByTestId('duct-close').click();
    // Другий проєкт — «Обидва», без прозорості.
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { display: { mode: 'both', transparency: 0 } })));
    await page.getByTestId('choice-replace').click();
    await frames(page);
    s = await state(page);
    expect(s.ducts.mode).toBe('both');
    info = await sceneInfo(page);
    expect(info.ductsVisible).toBe(true);
    for (const o of info.opacities) expect(o).toBe(1);
  });

  test('зараз «Орто», у файлі — перспектива: після відкриття перспектива, кнопка «Орто» не натиснута, камера з файлу', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('view-ortho').click();
    expect((await state(page)).projection).toBe('ortho');
    const view = { position: { x: 3100, y: 3300, z: 4900 }, target: { x: 200, y: 1200, z: -100 }, projection: 'perspective' };
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { view })));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    expect((await state(page)).projection).toBe('perspective');
    expect(await page.evaluate(() => window.__trasa!.viewer.projection)).toBe('perspective');
    await expect(page.getByTestId('view-ortho')).toHaveAttribute('aria-pressed', 'false');
    const v = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    expect(Math.abs(v.position.x - 3.1)).toBeLessThan(1e-4);
    expect(Math.abs(v.position.z - 4.9)).toBeLessThan(1e-4);
    expect(Math.abs(v.target.y - 1.2)).toBeLessThan(1e-4);
  });

  test('«Орто» з файлу — той самий масштаб: відрізок 1000 мм має ту саму довжину на екрані, що й перед збереженням (±1 px)', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.1, y: 3.3, z: 4.9 }, { x: 0.2, y: 1.2, z: -0.1 }));
    await page.getByTestId('view-ortho').click();
    const measure = () =>
      page.evaluate(() => {
        const a = window.__trasa!.viewer.projectPoint({ x: -0.5, y: 1, z: 0 });
        const b = window.__trasa!.viewer.projectPoint({ x: 0.5, y: 1, z: 0 });
        return { ax: a.x, ay: a.y, len: Math.hypot(b.x - a.x, b.y - a.y) };
      });
    const before = await measure();
    await saveViaMenu(page, 'Орто');
    const text = (await shared(page))!.text;
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await openScan(page);
    await page.getByTestId('file-input').setInputFiles(projectFile(text));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    await frames(page);
    const after = await measure();
    expect((await state(page)).projection).toBe('ortho');
    expect(Math.abs(after.len - before.len)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.ax - before.ax)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.ay - before.ay)).toBeLessThanOrEqual(1);
  });

  test('кнопка виду «Y» була натиснута — після відкриття проєкту з іншою камерою вона не лишається підсвіченою', async ({ page }) => {
    // Була помилка програми (виправлено) (дрібна): applyProject ставить камеру з файлу (viewer.setView), але не знімає
    // підсвічування кнопки виду (viewBar.setActive(null)) — «Y» показує «план», хоча камера дивиться збоку.
    await openRoom(page);
    await page.getByTestId('view-y').click();
    await expect(page.getByTestId('view-y')).toHaveAttribute('aria-pressed', 'true');
    const view = { position: { x: 3100, y: 3300, z: 4900 }, target: { x: 200, y: 1200, z: -100 }, projection: 'perspective' };
    await page.getByTestId('file-input').setInputFiles(projectFile(projectJson(ROUTES, { view })));
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    await expect(page.getByTestId('view-y')).toHaveAttribute('aria-pressed', 'false', { timeout: 2000 });
  });
});

test.describe('Етап 6 (tester): чернетка', () => {
  test('перезавантаження одразу після зміни (без очікування 0,5 с) — чернетку дописано, той самий скан пропонує її', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
    await page.getByTestId('choice-restore').click();
    expectSameSet((await state(page)).routes.set, ROUTES);
  });

  test('«Почати заново» й нові зміни — чернетку перезаписано новими трасами', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await reloadApp(page);
    await openScan(page);
    await page.getByTestId('choice-fresh').click();
    await loadRoutes(page, OTHER);
    await page.waitForTimeout(800);
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('1 траса');
    await page.getByTestId('choice-restore').click();
    expectSameSet((await state(page)).routes.set, OTHER);
  });

  test('поки на питання «Повернути траси?» не відповіли — чернетку не стерто (ще одне перезавантаження — питання знову)', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.waitForTimeout(1200);
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
    // «Почати заново» без нових змін — теж не стирає.
    await page.getByTestId('choice-fresh').click();
    await page.waitForTimeout(1200);
    await reloadApp(page);
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
  });

  test('два різні скани — дві окремі чернетки; перехід між ними траси не стирає', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await openScan(page, BOX_GLB);
    await page.waitForFunction(() => window.__trasa!.app!.state.scanName === 'box-6000x3000x4000.glb');
    await frames(page, 5);
    // Для коробки чернетки ще немає.
    await expect(page.getByTestId('choice')).toBeHidden();
    await loadRoutes(page, OTHER);
    await openScan(page);
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
    await page.getByTestId('choice-restore').click();
    expectSameSet((await state(page)).routes.set, ROUTES);
    await openScan(page, BOX_GLB);
    await page.waitForFunction(() => window.__trasa!.app!.state.scanName === 'box-6000x3000x4000.glb');
    await expect(page.getByTestId('choice-text')).toContainText('1 траса');
    await page.getByTestId('choice-restore').click();
    expectSameSet((await state(page)).routes.set, OTHER);
  });

  test('чернетка повертає й вигляд: «Орто», камера, режим показу', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.getByTestId('view-ortho').click();
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.1, y: 3.3, z: 4.9 }, { x: 0.2, y: 1.2, z: -0.1 }));
    await page.getByTestId('duct').click();
    await page.getByTestId('view-mode-duct').click();
    await page.getByTestId('duct-close').click();
    await page.waitForTimeout(800);
    const view = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    await reloadApp(page);
    await openScan(page);
    await page.getByTestId('choice-restore').click();
    const s = await state(page);
    expect(s.projection).toBe('ortho');
    expect(s.ducts.mode).toBe('duct');
    const v = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(v.position[k] - view.position[k])).toBeLessThan(1e-3);
      expect(Math.abs(v.target[k] - view.target[k])).toBeLessThan(1e-3);
    }
  });

  test('сховище недоступне (localStorage кидає помилку) — програма працює, попереджає, що траси зникнуть; проєкт зберігається', async ({ page }) => {
    const errors = pageErrors(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Доступ заборонено', 'SecurityError');
        },
      });
    });
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-open').click();
    await expect(page.getByTestId('choice-text')).toContainText('зникнуть з екрана');
    await page.getByTestId('choice-cancel').click();
    await saveViaMenu(page, 'Без сховища');
    const raw = JSON.parse((await shared(page))!.text);
    expectSameSet({ routes: raw.routes, nextId: raw.nextId }, ROUTES);
    // Відкрили скан знову — питання про чернетку немає, помилок немає.
    await openScan(page);
    await frames(page, 5);
    await expect(page.getByTestId('choice')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('сховище переповнене (setItem кидає QuotaExceededError) — програма працює без помилок', async ({ page }) => {
    const errors = pageErrors(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = function () {
        throw new DOMException('Переповнено', 'QuotaExceededError');
      };
    });
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await openScan(page);
    await frames(page, 5);
    await expect(page.getByTestId('choice')).toBeHidden();
    await loadRoutes(page, OTHER);
    expect((await state(page)).routes.set.routes).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

test.describe('Етап 6 (tester): назва за замовчуванням', () => {
  const today = () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  };

  test('після «Повернути» з чернетки — підказка назви «скан · дата», а не «Чернетка»', async ({ page }) => {
    // Була помилка програми (виправлено): flushDraft пише чернетку з назвою state.project.name ?? 'Чернетка', а applyProject
    // ставить state.project.name = 'Чернетка'. ROADMAP: «назва (підказка — назва скану й дата)».
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await page.waitForTimeout(800);
    await reloadApp(page);
    await openScan(page);
    await page.getByTestId('choice-restore').click();
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('prompt-input')).toHaveValue(`room-4000x2700x3000 · ${today()}`, { timeout: 2000 });
  });

  test('проєкт «Цех 2» збережено, відкрито інший скан і намальовано траси — підказка назви вже не «Цех 2»', async ({ page }) => {
    // Була помилка програми (виправлено): openFiles не скидає state.project.name — назва попереднього проєкту переходить на
    // інший скан (і в його чернетку).
    await stubShare(page);
    await openRoom(page);
    await loadRoutes(page, ROUTES);
    await saveViaMenu(page, 'Цех 2');
    await openScan(page, BOX_GLB);
    await page.waitForFunction(() => window.__trasa!.app!.state.scanName === 'box-6000x3000x4000.glb');
    await loadRoutes(page, OTHER);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('prompt-input')).toHaveValue(`box-6000x3000x4000 · ${today()}`, { timeout: 2000 });
  });
});

test.describe('Етап 6 (tester): меню «Файл»', () => {
  test('дотик по іншій кнопці панелі, поки меню відкрите, — лише закриває меню (рулетка не вмикається); Esc — закриває', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('open-scan').click();
    await expect(page.getByTestId('menu')).toBeVisible();
    const ruler = (await page.getByTestId('ruler').boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
    await expect(page.getByTestId('menu')).toBeHidden();
    expect((await state(page)).tool).toBe('none');
    await page.getByTestId('open-scan').click();
    await expect(page.getByTestId('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('menu')).toBeHidden();
    // Без скану меню теж працює: «Зберегти проєкт» пояснює, що зберігати нічого.
    await reloadApp(page);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('alert-text')).toContainText('Відкрийте скан');
  });

  test('меню відкрите й телефон повернули — меню не виходить за екран', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('iPhone'), 'iPad — лише горизонтально');
    // Була помилка програми (виправлено) (дрібна): createMenu ставить left/top лише в show() і не слухає зміну розміру —
    // з горизонтальної в вертикальну меню лишається на старому місці, праворуч за краєм екрана.
    await openRoom(page);
    await page.getByTestId('open-scan').click();
    await expect(page.getByTestId('menu')).toBeVisible();
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await frames(page, 5);
    const menu = page.getByTestId('menu');
    if (await menu.isVisible()) {
      for (const item of await menu.getByRole('menuitem').all()) {
        const b = (await item.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(vp.height);
        expect(b.y + b.height).toBeLessThanOrEqual(vp.width);
      }
    }
  });
});
