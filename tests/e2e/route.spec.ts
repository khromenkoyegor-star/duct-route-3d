/**
 * Етап 2: «Траса» — побудова полілінії. Тестова кімната 4000 × 2700 × 3000 мм.
 * Перша точка — дотиком по скану; кожна наступна тягнеться джойстиком (X, Z) чи повзунком (Y)
 * лише по одній осі; «Видалити останню точку», «Завершити побудову траєкторії», список
 * «Видалити траєкторію» з номерами, що не змінюються.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };
type Axis = 'X' | 'Y' | 'Z';

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const routes = async (page: Page) => (await state(page)).routes;
const editorPoint = async (page: Page): Promise<P3> => (await routes(page)).editor.point;

/** Відкрити кімнату, увімкнути «Трасу» й поставити першу точку на підлозі. */
async function openRoom(page: Page, view = { from: { x: 2.5, y: 4, z: 9 }, to: { x: 0, y: 0.8, z: 0 } }) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate((v) => window.__trasa!.viewer.setView(v.from, v.to), view);
}

async function startRoute(page: Page, at: P3 = { x: -0.5, y: 0, z: 0.4 }) {
  await page.getByTestId('route').click();
  await expect(page.getByTestId('route-panel')).toBeVisible();
  const p = await page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), at);
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await expect(page.getByTestId('point-editor').filter({ visible: true })).toBeVisible();
  expect((await routes(page)).phase).toBe('editFirst');
}

/** Утримати джойстик / повзунок (testid) з відхиленням (частка ходу 64 px). */
async function hold(page: Page, testid: string, dx: number, dy: number, ms: number) {
  const box = (await page.getByTestId(testid).filter({ visible: true }).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx * 64, cy + dy * 64, { steps: 3 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(50);
}

/** Потягнути точку по осі (sign — у бік + чи −) і повернути, на скільки мм вона відійшла від початку. */
async function pull(page: Page, axis: Axis, sign: 1 | -1, ms = 500) {
  if (axis === 'Y') {
    await hold(page, 'stick-y', 0, -0.9 * sign, ms);
    return;
  }
  const point = await editorPoint(page);
  const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), point);
  const dir = axes[axis];
  const len = Math.hypot(dir.x, dir.y);
  await hold(page, 'stick-xz', (sign * 0.9 * dir.x) / len, (sign * 0.9 * dir.y) / len, ms);
}

async function confirm(page: Page) {
  await page.getByTestId('confirm-point').filter({ visible: true }).click();
  await page.waitForTimeout(80);
}

/** Відрізки траси (мм): яка координата змінюється. */
function changedAxes(a: P3, b: P3): string[] {
  return (['x', 'y', 'z'] as const).filter((k) => Math.abs(a[k] - b[k]) > 0.1);
}

test.describe('Траса: побудова полілінії', () => {
  test('перша точка дотиком, далі X → Z → Y по одній осі; «Завершити» зберігає «Трасу 1»', async ({ page }) => {
    await openRoom(page);
    await expect(page.getByTestId('route-delete')).toBeDisabled();
    await startRoute(page);
    await expect(page.getByTestId('route-finish')).toBeDisabled();
    await expect(page.getByTestId('route-remove-last')).toBeDisabled();
    await confirm(page);

    let r = await routes(page);
    expect(r.phase).toBe('pull');
    expect(r.building.nodes).toHaveLength(1);
    // Наступна точка стартує в першій, підтвердити нульовий відрізок не можна.
    expect(r.editor.point).toEqual(r.editor.segment.anchor);
    await expect(page.getByTestId('confirm-point').filter({ visible: true })).toBeDisabled();
    await expect(page.getByTestId('route-finish')).toBeDisabled();

    await pull(page, 'X', 1);
    r = await routes(page);
    expect(r.editor.segment.axis).toBe('X');
    await expect(page.getByTestId('point-shift').filter({ visible: true })).toHaveText(/^Відрізок: X \+/);
    await confirm(page);
    await expect(page.getByTestId('route-finish')).toBeEnabled();

    await pull(page, 'Z', 1);
    expect((await routes(page)).editor.segment.axis).toBe('Z');
    await confirm(page);
    await pull(page, 'Y', 1);
    expect((await routes(page)).editor.segment.axis).toBe('Y');
    await confirm(page);

    r = await routes(page);
    const nodes: P3[] = r.building.nodes;
    expect(nodes).toHaveLength(4);
    expect(changedAxes(nodes[0]!, nodes[1]!)).toEqual(['x']);
    expect(changedAxes(nodes[1]!, nodes[2]!)).toEqual(['z']);
    expect(changedAxes(nodes[2]!, nodes[3]!)).toEqual(['y']);
    // Дві інші координати сусідніх точок — рівно однакові.
    expect(nodes[1]!.y).toBe(nodes[0]!.y);
    expect(nodes[1]!.z).toBe(nodes[0]!.z);
    expect(nodes[2]!.x).toBe(nodes[1]!.x);
    expect(nodes[2]!.y).toBe(nodes[1]!.y);
    expect(nodes[3]!.x).toBe(nodes[2]!.x);
    expect(nodes[3]!.z).toBe(nodes[2]!.z);
    await expect(page.getByTestId('route-info')).toHaveText(/^4 точки · /);

    await page.getByTestId('route-finish').click();
    const s = await state(page);
    expect(s.tool).toBe('none');
    expect(s.routes.active).toBe(false);
    expect(s.routes.set.routes).toHaveLength(1);
    expect(s.routes.set.routes[0].id).toBe(1);
    expect(s.routes.set.routes[0].nodes).toEqual(nodes);
    expect(s.routes.set.nextId).toBe(2);
    await expect(page.getByTestId('route-panel')).toBeHidden();
    await expect(page.getByTestId('route-delete')).toBeEnabled();
  });

  test('назад по попередньому відрізку траса не йде; повернувшись на початок, можна вибрати іншу вісь', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1);
    await confirm(page);
    const anchor = (await routes(page)).editor.segment.anchor;
    // Проти щойно пройденого відрізка — точка стоїть, підказка пояснює чому.
    await pull(page, 'X', -1, 300);
    expect(await editorPoint(page)).toEqual(anchor);
    await page.mouse.move(5, 5);
    // Уперед по X — можна.
    await pull(page, 'X', 1, 300);
    const ahead = await editorPoint(page);
    expect(ahead.x).toBeGreaterThan(anchor.x);
    // Тягнемо назад — точка зупиняється рівно на початку відрізка.
    await pull(page, 'X', -1, 2500);
    expect(await editorPoint(page)).toEqual(anchor);
    expect((await routes(page)).editor.segment.axis).toBeNull();
    // Вісь знову вільна: вибираємо Z.
    await pull(page, 'Z', -1, 300);
    const side = await editorPoint(page);
    expect(side.z).toBeLessThan(anchor.z);
    expect(side.x).toBe(anchor.x);
    expect(side.y).toBe(anchor.y);
  });

  test('відрізок по X: повзунок Y не працює, джойстик рухає лише X', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1, 300);
    const before = await editorPoint(page);
    await hold(page, 'stick-y', 0, -0.9, 300);
    expect(await editorPoint(page)).toEqual(before);
    await expect(page.getByTestId('stick-y').filter({ visible: true })).toHaveAttribute('aria-disabled', 'true');
    // Тягнемо джойстик у бік Z — змінюється лише X (або нічого), Z і Y — ні.
    await pull(page, 'Z', 1, 300);
    const after = await editorPoint(page);
    expect(after.y).toBe(before.y);
    expect(after.z).toBe(before.z);
  });

  test('дотик по скану під час «тягни наступну» нових точок не ставить', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 1, y: 0, z: -0.5 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    const r = await routes(page);
    expect(r.phase).toBe('pull');
    expect(r.building.nodes).toHaveLength(1);
    expect(r.editor.point).toEqual(r.editor.segment.anchor);
    // Підказка — біля самого джойстика.
    await expect(page.getByTestId('point-shift').filter({ visible: true })).toContainText('не ставиться дотиком');
  });

  test('«Видалити останню точку»: прибирає вузол, наступна тягнеться від попереднього', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1, 300);
    await confirm(page);
    await pull(page, 'Z', 1, 300);
    await confirm(page);
    let r = await routes(page);
    expect(r.building.nodes).toHaveLength(3);
    const [first, second] = r.building.nodes;
    await page.getByTestId('route-remove-last').click();
    r = await routes(page);
    expect(r.building.nodes).toEqual([first, second]);
    expect(r.phase).toBe('pull');
    // Редактор стартує з другої точки (у мм — ті самі координати).
    const anchorMm = { x: r.editor.segment.anchor.x * 1000, y: r.editor.segment.anchor.y * 1000, z: r.editor.segment.anchor.z * 1000 };
    for (const k of ['x', 'y', 'z'] as const) expect(anchorMm[k]).toBeCloseTo(second[k], 6);
    await page.getByTestId('route-remove-last').click();
    await page.getByTestId('route-remove-last').click();
    r = await routes(page);
    expect(r.building.nodes).toHaveLength(0);
    expect(r.phase).toBe('first');
    await expect(page.getByTestId('route-remove-last')).toBeDisabled();
    await expect(page.getByTestId('point-editor').filter({ visible: true })).toHaveCount(0);
  });

  test('кілька трас з номерами; видалення Траси 2 — номери 1 і 3 лишаються, нова — 4', async ({ page }) => {
    await openRoom(page);
    for (const at of [
      { x: -1, y: 0, z: 0.5 },
      { x: -0.5, y: 0, z: -0.5 },
      { x: 0.5, y: 0, z: 0.8 },
    ]) {
      await startRoute(page, at);
      await confirm(page);
      await pull(page, 'Y', 1, 400);
      await confirm(page);
      await page.getByTestId('route-finish').click();
    }
    let s = await state(page);
    expect(s.routes.set.routes.map((r: { id: number }) => r.id)).toEqual([1, 2, 3]);
    await expect(page.locator('.route-tag')).toHaveText(['1', '2', '3']);

    await page.getByTestId('route-delete').click();
    await expect(page.getByTestId('route-delete-panel')).toBeVisible();
    await expect(page.getByTestId('route-row-1')).toContainText('Траса 1');
    await expect(page.getByTestId('route-row-1')).toContainText('2 точки');
    await expect(page.getByTestId('route-delete-confirm')).toBeDisabled();
    await page.getByTestId('route-row-2').click();
    expect((await routes(page)).highlight).toBe(2);
    await expect(page.getByTestId('route-delete-confirm')).toHaveText('Видалити Трасу 2');
    await page.getByTestId('route-delete-confirm').click();
    s = await state(page);
    expect(s.routes.set.routes.map((r: { id: number }) => r.id)).toEqual([1, 3]);
    await expect(page.getByTestId('route-row-2')).toHaveCount(0);
    await page.getByTestId('route-delete-close').click();

    // Вибір у списку міг повернути камеру (показати трасу цілком) — ставимо вид знову.
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
    await startRoute(page);
    await expect(page.getByTestId('route-title')).toHaveText('Траса 4');
    await confirm(page);
    await pull(page, 'X', 1, 300);
    await confirm(page);
    await page.getByTestId('route-finish').click();
    s = await state(page);
    expect(s.routes.set.routes.map((r: { id: number }) => r.id)).toEqual([1, 3, 4]);
  });

  test('вийти з незавершеної траси: питає, зберегти чи видалити', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1, 300);
    await confirm(page);
    // На iPhone вертикально під час побудови нижні кнопки сховані (там джойстик) — тоді «Закрити».
    const ruler = page.getByTestId('ruler');
    await ((await ruler.isVisible()) ? ruler : page.getByTestId('route-close')).click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-cancel').click();
    expect((await state(page)).tool).toBe('route');
    await page.getByTestId('route-close').click();
    await page.getByTestId('choice-save').click();
    const s = await state(page);
    expect(s.tool).toBe('none');
    expect(s.routes.set.routes).toHaveLength(1);
  });

  test('інший скан при наявних трасах — спершу питання', async ({ page }) => {
    await openRoom(page);
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({
        routes: [{ id: 1, nodes: [{ x: 0, y: 500, z: 0 }, { x: 1000, y: 500, z: 0 }] }],
        nextId: 2,
      }),
    );
    await page.getByTestId('open-scan').click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await expect(page.getByTestId('choice-text')).toContainText('траси');
    await page.getByTestId('choice-cancel').click();
    expect((await routes(page)).set.routes).toHaveLength(1);
    // Відкрили інший скан — траси прибрано, номери знову з 1.
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.routes.set.routes.length === 0);
    expect((await routes(page)).set.nextId).toBe(1);
  });

  test('кнопки видів під час побудови: вид уздовж осі, точку, яку тягнуть, не закривають панелі', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1, 400);
    const point = await editorPoint(page);
    for (const axis of ['x', 'z', 'y'] as const) {
      await page.getByTestId(`view-${axis}`).click();
      const view = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
      const d = { x: view.position.x - view.target.x, y: view.position.y - view.target.y, z: view.position.z - view.target.z };
      expect(Math.abs(d[axis]) / Math.hypot(d.x, d.y, d.z), `вид уздовж ${axis}`).toBeGreaterThan(0.9999);
      const sp = await page.evaluate((p) => window.__trasa!.viewer.projectPoint(p), point);
      const vp = page.viewportSize()!;
      expect(sp.visible).toBe(true);
      expect(sp.x > 0 && sp.y > 0 && sp.x < vp.width && sp.y < vp.height).toBe(true);
      for (const id of ['point-editor', 'route-panel']) {
        const r = (await page.getByTestId(id).filter({ visible: true }).boundingBox())!;
        const inside = sp.x > r.x - 12 && sp.x < r.x + r.width + 12 && sp.y > r.y - 12 && sp.y < r.y + r.height + 12;
        expect(inside, `${axis}: точку закриває ${id}`).toBe(false);
      }
    }
    expect(await editorPoint(page)).toEqual(point);
  });

  test('обертання камери точок не зсуває', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    await confirm(page);
    await pull(page, 'X', 1, 300);
    const before = await routes(page);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.55, vp.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.55 + 120, vp.height * 0.35 + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await routes(page);
    expect(after.building).toEqual(before.building);
    expect(after.editor.point).toEqual(before.editor.point);
  });

  test('траса на 600 точок: малюється, а кадр з нею не довший за кадр без неї більше ніж на 8 мс', async ({ page }) => {
    await openRoom(page);
    // Сходинки 600 точок у кімнаті: по X і по Z почергово, крок 5 мм.
    const nodes: P3[] = [];
    for (let i = 0; i < 600; i++) {
      const step = Math.floor(i / 2);
      nodes.push({ x: -1500 + (step + (i % 2)) * 5, y: 1200, z: -1000 + step * 5 });
    }
    const measure = () =>
      page.evaluate(async () => {
        const viewer = window.__trasa!.viewer;
        const layer = document.querySelector('[data-testid="route-layer"]')!;
        let total = 0;
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          viewer.setView({ x: Math.sin(a) * 7, y: 4, z: Math.cos(a) * 7 }, { x: 0, y: 1, z: 0 });
          const t0 = performance.now();
          // Кадр сцени й шар трас — синхронно (без очікування requestAnimationFrame).
          viewer.requestRender();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          total += performance.now() - t0;
        }
        return { avg: total / 40, paths: layer.querySelectorAll('path').length };
      });
    const without = await measure();
    await page.evaluate((n) => window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: n }], nextId: 2 }), nodes);
    const withRoute = await measure();
    expect(withRoute.paths).toBeGreaterThan(0);
    expect(withRoute.avg - without.avg).toBeLessThan(8);
  });
});

test.describe('Скріншоти етапу 2', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('побудова траси, готові траси, список на видалення', async ({ page }, testInfo) => {
        const shot = (name: string) =>
          page.screenshot({ path: `test-results/screenshots/stage2-${testInfo.project.name.replace(/\s+/g, '-')}-${colorScheme}-${name}.png` });
        await openRoom(page, { from: { x: 3.2, y: 3.6, z: 5.5 }, to: { x: 0, y: 0.9, z: 0 } });
        // Готова Траса 1 — щоб було видно, як виглядають завершені траси.
        await page.evaluate(() =>
          window.__trasa!.app!.loadRoutes({
            routes: [
              {
                id: 1,
                nodes: [
                  { x: -1800, y: 2400, z: -1300 },
                  { x: 800, y: 2400, z: -1300 },
                  { x: 800, y: 2400, z: 600 },
                ],
              },
            ],
            nextId: 2,
          }),
        );
        await startRoute(page, { x: -1, y: 0, z: 0.6 });
        await confirm(page);
        await pull(page, 'Y', 1, 1200);
        await confirm(page);
        await pull(page, 'X', 1, 1100);
        await page.waitForTimeout(150);
        await shot('building');
        await confirm(page);
        await page.getByTestId('route-finish').click();
        await page.waitForTimeout(150);
        await shot('routes');
        await page.getByTestId('route-delete').click();
        await page.getByTestId('route-row-2').click();
        await page.waitForTimeout(150);
        await shot('delete');
      });
    });
  }
});
