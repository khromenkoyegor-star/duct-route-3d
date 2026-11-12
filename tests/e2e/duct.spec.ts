/**
 * Етап 4: повітропровід по трасі — розмір усієї траси, переходи, прямокутні, показ і прозорість.
 * Тестова кімната 4000 × 2700 × 3000 мм; траси підставляються через app.loadRoutes (мм).
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const ducts = async (page: Page) => (await state(page)).ducts;

/** Траса під стелею: 2500 по +X → 1800 по +Z → 1000 вниз. */
const ROUTE: P3[] = [
  { x: -1500, y: 2200, z: -1000 },
  { x: 1000, y: 2200, z: -1000 },
  { x: 1000, y: 2200, z: 800 },
  { x: 1000, y: 1200, z: 800 },
];

async function openRoom(page: Page, routes: Array<{ id: number; nodes: P3[] }> = [{ id: 1, nodes: ROUTE }]) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.2, y: 3.4, z: 5.2 }, { x: 0, y: 1.4, z: 0 }));
  await page.evaluate((r) => window.__trasa!.app!.loadRoutes({ routes: r, nextId: Math.max(...r.map((x) => x.id)) + 1 }), routes);
}

async function openPanel(page: Page) {
  await page.getByTestId('duct').click();
  await expect(page.getByTestId('duct-panel')).toBeVisible();
}

async function setDiameter(page: Page, d: number) {
  await page.getByTestId('duct-diameter').selectOption(String(d));
}

test.describe('Повітропровід', () => {
  test('кнопка неактивна без трас; з трасою — панель, траса вибрана, розмір ще не задано', async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await expect(page.getByTestId('duct')).toBeDisabled();
    await page.evaluate((nodes) => window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes }], nextId: 2 }), ROUTE);
    await expect(page.getByTestId('duct')).toBeEnabled();
    await openPanel(page);
    await expect(page.getByTestId('duct-route-1')).toHaveAttribute('aria-pressed', 'true');
    expect((await ducts(page)).routes[0].duct).toBeNull();
    await expect(page.getByTestId('duct-panel')).toContainText('Задайте розмір');
  });

  test('Ø200, відрізок 1000 мм → 3D-труба 1000 × 200 × 200 мм (±0,5 мм)', async ({ page }) => {
    await openRoom(page, [
      {
        id: 1,
        nodes: [
          { x: -500, y: 1500, z: 0 },
          { x: 500, y: 1500, z: 0 },
        ],
      },
    ]);
    await openPanel(page);
    await setDiameter(page, 200);
    const d = await ducts(page);
    expect(d.routes[0].duct).toEqual({ section: { shape: 'round', diameterMm: 200 }, transitions: [] });
    const box = await page.evaluate(() => window.__trasa!.app!.ductBox(1));
    expect(box).not.toBeNull();
    expect(Math.abs(box!.max.x - box!.min.x - 1000)).toBeLessThan(0.5);
    expect(Math.abs(box!.max.y - box!.min.y - 200)).toBeLessThan(0.5);
    expect(Math.abs(box!.max.z - box!.min.z - 200)).toBeLessThan(0.5);
    // Вісь труби — на трасі.
    expect(Math.abs((box!.max.y + box!.min.y) / 2 - 1500)).toBeLessThan(0.5);
    expect(Math.abs((box!.max.z + box!.min.z) / 2)).toBeLessThan(0.5);
  });

  test('уся траса одного розміру; перехід на відрізку 2 → далі Ø315; прибрати перехід', async ({ page }) => {
    await openRoom(page);
    await openPanel(page);
    await setDiameter(page, 200);
    expect((await ducts(page)).routes[0].sections).toEqual(['Ø200', 'Ø200', 'Ø200']);
    await page.getByTestId('duct-segment-1').click();
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 1 });
    // Редактор переходу — одразу під вибраним рядком, рядок — синій; кільце там, де стане перехід.
    await expect(page.getByTestId('duct-segment-1')).toHaveClass(/duct-segment--selected/);
    await expect(page.getByTestId('route-marker')).toBeVisible();
    // Без діаметра — пояснення; після успіху воно зникає.
    await page.getByTestId('duct-transition-here').click();
    await expect(page.getByTestId('duct-message')).toContainText('Виберіть діаметр');
    await page.getByTestId('duct-transition-diameter').selectOption('315');
    await page.getByTestId('duct-transition-here').click();
    await expect(page.getByTestId('duct-message')).toHaveCount(0);
    let d = await ducts(page);
    expect(d.routes[0].sections).toEqual(['Ø200', 'Ø315', 'Ø315']);
    expect(d.routes[0].duct.transitions).toEqual([{ segment: 1, to: { shape: 'round', diameterMm: 315 } }]);
    await expect(page.getByTestId('duct-transitions')).toContainText('Перехід на відрізку 2: Ø200 → Ø315');
    // Зміна форми прибрала б перехід — спершу питання; «Скасувати» нічого не змінює.
    await page.getByTestId('duct-shape-rect').click();
    await page.getByTestId('duct-width').fill('400');
    await page.getByTestId('duct-height').fill('250');
    await page.getByTestId('duct-apply-rect').click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-cancel').click();
    expect((await ducts(page)).routes[0].sections).toEqual(['Ø200', 'Ø315', 'Ø315']);
    await page.getByTestId('duct-transition-1-remove').click();
    d = await ducts(page);
    expect(d.routes[0].sections).toEqual(['Ø200', 'Ø200', 'Ø200']);
  });

  test('прямокутні 500 × 300: уся траса; неправильний розмір — пояснення', async ({ page }) => {
    await openRoom(page);
    await openPanel(page);
    await page.getByTestId('duct-shape-rect').click();
    await page.getByTestId('duct-width').fill('20');
    await page.getByTestId('duct-height').fill('300');
    await page.getByTestId('duct-apply-rect').click();
    await expect(page.getByTestId('duct-message')).toContainText('від 50 до 3000 мм');
    await expect(page.getByTestId('duct-width')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('duct-height')).toHaveAttribute('aria-invalid', 'false');
    expect((await ducts(page)).routes[0].duct).toBeNull();
    await page.getByTestId('duct-width').fill('500');
    // Enter у полі — те саме, що «Задати».
    await page.getByTestId('duct-width').press('Enter');
    await expect(page.getByTestId('duct-message')).toHaveCount(0);
    const d = await ducts(page);
    expect(d.routes[0].duct.section).toEqual({ shape: 'rect', widthMm: 500, heightMm: 300 });
    expect(d.routes[0].sections).toEqual(['500×300', '500×300', '500×300']);
    // Перший відрізок уздовж X під стелею: висота 300 — вертикально, ширина 500 — по Z.
    const box = await page.evaluate(() => window.__trasa!.app!.ductBox(1));
    expect(Math.round(box!.max.y - box!.min.y)).toBeGreaterThanOrEqual(300);
  });

  test('закороткий відрізок — червоне пояснення «потрібно / є»', async ({ page }) => {
    await openRoom(page, [
      {
        id: 1,
        nodes: [
          { x: -1500, y: 2000, z: 0 },
          { x: 0, y: 2000, z: 0 },
          { x: 0, y: 2000, z: 300 },
          { x: 1500, y: 2000, z: 300 },
        ],
      },
    ]);
    await openPanel(page);
    await setDiameter(page, 200);
    await expect(page.getByTestId('duct-problems')).toContainText('Відрізок 2 закороткий');
    await expect(page.getByTestId('duct-problems')).toContainText('потрібно щонайменше 400 мм, є 300 мм');
    expect((await ducts(page)).routes[0].problems).toEqual([{ segment: 1, needMm: 400, haveMm: 300 }]);
    await setDiameter(page, 125);
    await expect(page.getByTestId('duct-problems')).toHaveCount(0);
  });

  test('дотик по трубі на сцені вибирає відрізок', async ({ page }) => {
    await openRoom(page);
    await openPanel(page);
    await setDiameter(page, 250);
    // Середина відрізка 2 (1000; 2200; −100) — на екрані.
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 1, y: 2.2, z: -0.1 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 1 });
    await expect(page.getByTestId('duct-segment-1')).toHaveAttribute('aria-pressed', 'true');
    // Промах повз трубу вибору не знімає.
    const away = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -1.8, y: 0.05, z: 1.2 }));
    await page.mouse.click(Math.round(away.x), Math.round(away.y));
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 1 });
  });

  test('показ «Траса / Повітропровід / Обидва» і прозорість скану', async ({ page }) => {
    await openRoom(page);
    await openPanel(page);
    await setDiameter(page, 200);
    await page.getByTestId('view-mode-duct').click();
    expect((await ducts(page)).mode).toBe('duct');
    // Лінію траси з трубою не малюємо, номер траси лишається.
    await expect(page.locator('[data-testid="route-layer"] g.route--no-line')).toHaveCount(1);
    await expect(page.locator('.route-tag')).toHaveText(['1']);
    await page.getByTestId('view-mode-route').click();
    await expect(page.locator('[data-testid="route-layer"] g.route--no-line')).toHaveCount(0);
    await page.getByTestId('view-mode-both').click();
    await page.getByTestId('scan-opacity').fill('60');
    expect((await ducts(page)).transparency).toBeCloseTo(0.6, 6);
  });

  test('видалення траси звільняє 3D-повітропровід', async ({ page }) => {
    await openRoom(page);
    await openPanel(page);
    await setDiameter(page, 200);
    expect((await ducts(page)).triangles).toBeGreaterThan(0);
    await page.getByTestId('duct-close').click();
    await page.getByTestId('route-delete').click();
    await page.getByTestId('route-row-1').click();
    await page.getByTestId('route-delete-confirm').click();
    expect((await ducts(page)).triangles).toBe(0);
  });

  test('траса на 600 точок з повітропроводом: одна 3D-модель, без перебудови при обертанні камери', async ({ page }) => {
    // Сходинки по X і Z з кроком 600 мм: 598 колін Ø200 (R = 200 мм) — усе вміщається.
    const nodes: P3[] = [];
    for (let i = 0; i < 600; i++) {
      const step = Math.floor(i / 2);
      nodes.push({ x: -1500 + (step + (i % 2)) * 600, y: 2000, z: -1000 + step * 600 });
    }
    await openRoom(page, [{ id: 1, nodes }]);
    const t0 = Date.now();
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({
        routes: [
          {
            ...window.__trasa!.app!.state.routes.set.routes[0]!,
            duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [] },
          },
        ],
        nextId: 2,
      }),
    );
    const built = Date.now() - t0;
    const d = await ducts(page);
    expect(d.routes[0].problems).toEqual([]);
    // Одна модель на трасу (один виклик малювання), трикутників — у межах бюджету.
    expect(d.meshes).toBe(1);
    expect(d.triangles).toBeGreaterThan(100_000);
    expect(d.triangles).toBeLessThan(250_000);
    // Побудова — разово й швидко (з запасом на повільний сервер CI).
    expect(built).toBeLessThan(5000);
    const builds = d.builds;
    // Обертання камери модель не перебудовує (кадр — лише малювання готової геометрії).
    await page.evaluate(async () => {
      const viewer = window.__trasa!.viewer;
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        viewer.setView({ x: Math.sin(a) * 7, y: 4, z: Math.cos(a) * 7 }, { x: 0, y: 1, z: 0 });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    });
    expect((await ducts(page)).builds).toBe(builds);
  });
});

test.describe('Скріншоти етапу 4', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('круглий з переходом, прямокутний, панель', async ({ page }, testInfo) => {
        const shot = (name: string) =>
          page.screenshot({ path: `test-results/screenshots/stage4-${testInfo.project.name.replace(/\s+/g, '-')}-${colorScheme}-${name}.png` });
        await openRoom(page, [
          { id: 1, nodes: ROUTE },
          {
            id: 2,
            nodes: [
              { x: -1700, y: 1000, z: 1200 },
              { x: -300, y: 1000, z: 1200 },
              { x: -300, y: 2300, z: 1200 },
              { x: -300, y: 2300, z: -200 },
            ],
          },
        ]);
        await page.evaluate(() => {
          const app = window.__trasa!.app!;
          const [a, b] = app.state.routes.set.routes;
          app.loadRoutes({
            routes: [
              {
                ...a!,
                duct: { section: { shape: 'round', diameterMm: 250 }, transitions: [{ segment: 1, to: { shape: 'round', diameterMm: 160 } }] },
              },
              { ...b!, duct: { section: { shape: 'rect', widthMm: 400, heightMm: 250 }, transitions: [] } },
            ],
            nextId: 3,
          });
        });
        await page.waitForTimeout(200);
        await shot('ducts');
        await openPanel(page);
        await page.getByTestId('duct-segment-1').click();
        await page.waitForTimeout(150);
        await shot('panel');
      });
    });
  }
});
