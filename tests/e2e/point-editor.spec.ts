/**
 * Редактор точки в «Рулетці»: джойстик X/Z (вісь — за напрямком на екрані, лише одна за раз),
 * повзунок Y, «Підтвердити точку». Тестова кімната 4000 × 2700 × 3000 мм.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const editorPoint = async (page: Page): Promise<P3> => (await state(page)).ruler.editor.point;

/** Відкрити кімнату, увімкнути рулетку й поставити точку А на підлозі в (0,5; 0; 0,4). */
async function startEditing(page: Page, view: { from: P3; to: P3 } = { from: { x: 2.5, y: 4, z: 9 }, to: { x: 0, y: 0.8, z: 0 } }) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate((v) => window.__trasa!.viewer.setView(v.from, v.to), view);
  await page.getByTestId('ruler').click();
  const a = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 0.5, y: 0, z: 0.4 }));
  await page.mouse.click(Math.round(a.x), Math.round(a.y));
  await expect(page.getByTestId('point-editor')).toBeVisible();
  return editorPoint(page);
}

/** Відхилити елемент (джойстик/повзунок) мишкою на частку радіуса й потримати. */
async function hold(page: Page, testid: string, dx: number, dy: number, ms: number) {
  const box = (await page.getByTestId(testid).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const knob = 52;
  const rx = Math.max(1, (box.width - knob) / 2);
  const ry = Math.max(1, (box.height - knob) / 2);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx * rx, cy + dy * ry, { steps: 3 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(50);
}

/** Напрямок осі на екрані біля точки. */
const screenAxes = (page: Page, p: P3) => page.evaluate((point) => window.__trasa!.viewer.screenAxes(point), p);

test.describe('Редактор точки: джойстик і повзунок', () => {
  test('тягнемо джойстик уздовж стрілки X — змінюється тільки X, у бік стрілки', async ({ page }) => {
    const start = await startEditing(page);
    const axes = await screenAxes(page, start);
    const len = Math.hypot(axes.X.x, axes.X.y);
    await hold(page, 'stick-xz', (axes.X.x / len) * 0.9, (axes.X.y / len) * 0.9, 400);
    const end = await editorPoint(page);
    expect(end.x).toBeGreaterThan(start.x + 0.02);
    expect(end.y).toBe(start.y);
    expect(end.z).toBe(start.z);
    await expect(page.getByTestId('point-shift')).toHaveText(/^Зсунуто: X \+/);
  });

  test('тягнемо проти стрілки Z — змінюється тільки Z, у мінус', async ({ page }) => {
    const start = await startEditing(page);
    const axes = await screenAxes(page, start);
    const len = Math.hypot(axes.Z.x, axes.Z.y);
    await hold(page, 'stick-xz', (-axes.Z.x / len) * 0.9, (-axes.Z.y / len) * 0.9, 400);
    const end = await editorPoint(page);
    expect(end.z).toBeLessThan(start.z - 0.02);
    expect(end.x).toBe(start.x);
    expect(end.y).toBe(start.y);
  });

  test('по діагоналі точка не їде: змінюється лише одна координата', async ({ page }) => {
    const start = await startEditing(page);
    const axes = await screenAxes(page, start);
    // Рівно посередині між стрілками X і Z.
    const ux = axes.X.x / Math.hypot(axes.X.x, axes.X.y) + axes.Z.x / Math.hypot(axes.Z.x, axes.Z.y);
    const uy = axes.X.y / Math.hypot(axes.X.x, axes.X.y) + axes.Z.y / Math.hypot(axes.Z.x, axes.Z.y);
    const l = Math.hypot(ux, uy);
    await hold(page, 'stick-xz', (ux / l) * 0.9, (uy / l) * 0.9, 400);
    const end = await editorPoint(page);
    const changed = (['x', 'y', 'z'] as const).filter((k) => end[k] !== start[k]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).not.toBe('y');
  });

  test('ледь відхилив — повільно (мм), до краю — швидко (сотні мм)', async ({ page }) => {
    const start = await startEditing(page);
    const axes = await screenAxes(page, start);
    const len = Math.hypot(axes.X.x, axes.X.y);
    const ux = axes.X.x / len;
    const uy = axes.X.y / len;
    await hold(page, 'stick-xz', ux * 0.2, uy * 0.2, 600);
    const slow = Math.abs((await editorPoint(page)).x - start.x) * 1000;
    const mid = await editorPoint(page);
    await hold(page, 'stick-xz', ux, uy, 600);
    const fast = Math.abs((await editorPoint(page)).x - mid.x) * 1000;
    expect(slow).toBeGreaterThan(0.5);
    expect(slow).toBeLessThan(20);
    expect(fast).toBeGreaterThan(100);
    expect(fast).toBeLessThan(450); // не більше 0,5 м/с × 0,6 с + запас на кадри
    expect(fast).toBeGreaterThan(slow * 10);
  });

  test('повзунок Y: вгору — тільки висота росте, вниз — зменшується', async ({ page }) => {
    const start = await startEditing(page);
    await hold(page, 'stick-y', 0, -0.9, 300);
    const up = await editorPoint(page);
    expect(up.y).toBeGreaterThan(start.y + 0.02);
    expect(up.x).toBe(start.x);
    expect(up.z).toBe(start.z);
    await hold(page, 'stick-y', 0, 0.9, 300);
    const down = await editorPoint(page);
    expect(down.y).toBeLessThan(up.y - 0.02);
    expect(down.x).toBe(start.x);
    expect(down.z).toBe(start.z);
  });

  test('вид згори: джойстик вгору — точка до −Z (туди, куди на екрані дивиться «вгору»)', async ({ page }) => {
    const start = await startEditing(page, { from: { x: 0.5, y: 9, z: 0.41 }, to: { x: 0.5, y: 0, z: 0.4 } });
    await hold(page, 'stick-xz', 0, -0.9, 300);
    const end = await editorPoint(page);
    expect(end.z).toBeLessThan(start.z - 0.02);
    expect(end.x).toBe(start.x);
    expect(end.y).toBe(start.y);
  });

  test('крутіння камери точку не зсуває', async ({ page }) => {
    const start = await startEditing(page);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.6, vp.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.6 + 120, vp.height * 0.3 + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(await editorPoint(page)).toEqual(start);
  });

  test('дотиком (палець) джойстик працює так само', async ({ page }) => {
    const start = await startEditing(page);
    const axes = await screenAxes(page, start);
    const len = Math.hypot(axes.X.x, axes.X.y);
    const box = (await page.getByTestId('stick-xz').boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const r = (box.width - 52) / 2;
    const to = { x: c.x + (axes.X.x / len) * r * 0.9, y: c.y + (axes.X.y / len) * r * 0.9 };
    await page.evaluate(
      async ({ c, to }) => {
        const el = document.querySelector('[data-testid="stick-xz"]')!;
        const ev = (type: string, p: { x: number; y: number }) =>
          new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true });
        el.dispatchEvent(ev('pointerdown', c));
        el.dispatchEvent(ev('pointermove', to));
        await new Promise((r) => setTimeout(r, 400));
        el.dispatchEvent(ev('pointerup', to));
      },
      { c, to },
    );
    await page.waitForTimeout(50);
    const end = await editorPoint(page);
    expect(end.x).toBeGreaterThan(start.x + 0.02);
    expect(end.y).toBe(start.y);
    expect(end.z).toBe(start.z);
  });

  test('«Підтвердити точку» фіксує доведену точку А; потім ставиться Б', async ({ page }) => {
    const start = await startEditing(page);
    await hold(page, 'stick-y', 0, -0.9, 300);
    const moved = await editorPoint(page);
    await page.getByTestId('confirm-point').click();
    const s = await state(page);
    expect(s.ruler.phase).toBe('pickB');
    expect(s.ruler.points[0]).toEqual(moved);
    expect(s.ruler.points[0].y).toBeGreaterThan(start.y);
    await expect(page.getByTestId('point-editor')).toBeHidden();
  });

  test('координати й зсув — у мм; кнопки ≥ 44 px; панель у межах екрана і не на кнопках', async ({ page }) => {
    await startEditing(page);
    await expect(page.getByTestId('point-coords')).toHaveText(/^X -?[\d\s]+(,\d)? · Y -?[\d\s]+(,\d)? · Z -?[\d\s]+(,\d)? мм$/);
    await expect(page.getByTestId('point-shift')).toHaveText(/Підсуньте джойстиком/);
    const vp = page.viewportSize()!;
    const editor = (await page.getByTestId('point-editor').boundingBox())!;
    expect(editor.x).toBeGreaterThanOrEqual(0);
    expect(editor.y).toBeGreaterThanOrEqual(0);
    expect(editor.x + editor.width).toBeLessThanOrEqual(vp.width);
    expect(editor.y + editor.height).toBeLessThanOrEqual(vp.height);
    for (const id of ['stick-xz', 'stick-y', 'confirm-point']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.width, id).toBeGreaterThanOrEqual(44);
      expect(b.height, id).toBeGreaterThanOrEqual(44);
    }
    for (const id of ['open-scan', 'show-all', 'ruler', 'ruler-panel']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      const overlap =
        editor.x < b.x + b.width && b.x < editor.x + editor.width && editor.y < b.y + b.height && b.y < editor.y + editor.height;
      expect(overlap, id).toBe(false);
    }
  });
});
