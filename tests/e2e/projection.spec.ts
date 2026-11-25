/**
 * Етап 4.1: ортогональна проекція (кнопка «Орто» біля X / Y / Z) — без перспективи, як на кресленні.
 * Тестова кімната 4000 × 2700 × 3000 мм: X від −2 до 2 м, Y від 0 до 2,7 м, Z від −1,5 до 1,5 м.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const project = (page: Page, p: P3) => page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), p);
const setView = (page: Page, from: P3, to: P3) =>
  page.evaluate(([f, t]) => window.__trasa!.viewer.setView(f!, t!), [from, to] as const);
/** Дочекатись кількох кадрів (камера й накладки оновились). */
const frames = (page: Page, n = 3) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, n);

/** Довжина відрізка на екрані, px. */
async function screenLength(page: Page, a: P3, b: P3): Promise<number> {
  const [pa, pb] = [await project(page, a), await project(page, b)];
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Напрямок погляду (від камери до цілі) і відстань до цілі. */
const view = (page: Page) =>
  page.evaluate(() => {
    const v = window.__trasa!.viewer.snapshotView();
    const d = { x: v.target.x - v.position.x, y: v.target.y - v.position.y, z: v.target.z - v.position.z };
    const l = Math.hypot(d.x, d.y, d.z);
    return { dir: { x: d.x / l, y: d.y / l, z: d.z / l }, distance: l, position: { x: v.position.x, y: v.position.y, z: v.position.z } };
  });

async function openRoom(page: Page, from: P3 = { x: 3.2, y: 3.4, z: 5.2 }, to: P3 = { x: 0, y: 1.4, z: 0 }) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await setView(page, from, to);
  await frames(page);
}

/** Наблизити колесом біля курсора (кілька «клацань» колеса). */
async function zoomIn(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120);
    await frames(page, 2);
  }
  await frames(page, 30);
}

/** «Підтвердити точку»; після цього ~0,35 с дотики по скану ігноруються (захист від подвійного натискання). */
async function confirmPoint(page: Page) {
  await page.getByTestId('confirm-point').filter({ visible: true }).click();
  await page.waitForTimeout(400);
}

async function toggleOrtho(page: Page, expected: 'ortho' | 'perspective') {
  await page.getByTestId('view-ortho').click();
  expect((await state(page)).projection).toBe(expected);
  await frames(page);
}

test.describe('Ортогональна проекція', () => {
  test('кнопка «Орто» поруч із X / Y / Z: не менша за 44 × 44, вмикає й вимикає проекцію, плашка з назвою', async ({ page }) => {
    await openRoom(page);
    const button = page.getByTestId('view-ortho');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Орто');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const box = (await button.boundingBox())!;
    const z = (await page.getByTestId('view-z').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // У тому ж рядку, одразу за Z.
    expect(Math.abs(box.y - z.y)).toBeLessThan(1);
    expect(box.x).toBeGreaterThanOrEqual(z.x + z.width - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // Не перекриває інші кнопки.
    for (const id of ['open-scan', 'show-all', 'ruler', 'route', 'route-delete', 'duct']) {
      const other = (await page.getByTestId(id).boundingBox())!;
      const overlap =
        box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height;
      expect(overlap, `«Орто» перекриває ${id}`).toBe(false);
    }
    expect((await state(page)).projection).toBe('perspective');

    await toggleOrtho(page, 'ortho');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('view-toast')).toHaveText('Ортогональна проекція');
    // Увімкнена — суцільна, і напис на ній видно: колір тексту не збігається з тлом.
    const colors = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { text: cs.color, background: cs.backgroundColor };
    });
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.text, 'напис «Орто» зливається з тлом').not.toBe(colors.background);
    expect(await page.evaluate(() => window.__trasa!.viewer.projection)).toBe('ortho');

    await toggleOrtho(page, 'perspective');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('view-toast')).toHaveText('Перспектива');
    expect(await page.evaluate(() => window.__trasa!.viewer.projection)).toBe('perspective');
  });

  test('без перспективи: однакові відрізки на різній відстані від камери — однакової довжини на екрані', async ({ page }) => {
    await openRoom(page, { x: 0, y: 1.2, z: 8 }, { x: 0, y: 1.2, z: 0 });
    const near: [P3, P3] = [{ x: -0.5, y: 0.6, z: 1.4 }, { x: 0.5, y: 0.6, z: 1.4 }];
    const far: [P3, P3] = [{ x: -0.5, y: 1.9, z: -1.4 }, { x: 0.5, y: 1.9, z: -1.4 }];
    // З перспективою ближній відрізок помітно довший (відстані 6,6 м і 9,4 м).
    const perspective = { near: await screenLength(page, ...near), far: await screenLength(page, ...far) };
    expect(perspective.near / perspective.far).toBeGreaterThan(1.3);

    await toggleOrtho(page, 'ortho');
    const ortho = { near: await screenLength(page, ...near), far: await screenLength(page, ...far) };
    expect(Math.abs(ortho.near - ortho.far)).toBeLessThan(0.5);
    // Вертикальні відрізки — так само.
    const up = async (x: number, z: number) => screenLength(page, { x, y: 0.5, z }, { x, y: 1.5, z });
    expect(Math.abs((await up(-1.2, 1.4)) - (await up(1.3, -1.4)))).toBeLessThan(0.5);
    // Масштаб по горизонталі й вертикалі однаковий: 1 м = стільки ж px.
    expect(Math.abs(ortho.near - (await up(0, 0)))).toBeLessThan(0.5);

    // Паралельні лінії лишаються паралельними й після повороту камери.
    await setView(page, { x: 4, y: 3.5, z: 6 }, { x: 0, y: 1.2, z: 0 });
    await frames(page);
    const a = [await project(page, { x: -1.5, y: 0.2, z: 1.2 }), await project(page, { x: 1.5, y: 0.2, z: 1.2 })];
    const b = [await project(page, { x: -1.5, y: 2.4, z: -1.3 }), await project(page, { x: 1.5, y: 2.4, z: -1.3 })];
    expect(Math.abs(a[1]!.x - a[0]!.x - (b[1]!.x - b[0]!.x))).toBeLessThan(0.5);
    expect(Math.abs(a[1]!.y - a[0]!.y - (b[1]!.y - b[0]!.y))).toBeLessThan(0.5);
  });

  test('перемикання не змінює розмір того, на що дивишся (±2 %): стіна в центрі кадру', async ({ page }) => {
    // Дивимось на стіну Z = −1,5 м з відстані 2,7 м; ціль камери — посеред кімнати (1,2 м від камери).
    await openRoom(page, { x: 0.3, y: 1.2, z: 1.2 }, { x: 0.3, y: 1.2, z: 0 });
    const onWall: [P3, P3] = [{ x: 0.1, y: 1.2, z: -1.5 }, { x: 0.5, y: 1.2, z: -1.5 }];
    const before = await screenLength(page, ...onWall);
    const dirBefore = (await view(page)).dir;

    await toggleOrtho(page, 'ortho');
    const ortho = await screenLength(page, ...onWall);
    expect(Math.abs(ortho / before - 1)).toBeLessThan(0.02);
    // Центр стіни лишився в центрі кадру, напрямок погляду той самий.
    const centre = await project(page, { x: 0.3, y: 1.2, z: -1.5 });
    const vp = page.viewportSize()!;
    expect(Math.abs(centre.x - vp.width / 2)).toBeLessThan(1);
    expect(Math.abs(centre.y - vp.height / 2)).toBeLessThan(1);
    const dirOrtho = (await view(page)).dir;
    expect(dirOrtho.x * dirBefore.x + dirOrtho.y * dirBefore.y + dirOrtho.z * dirBefore.z).toBeGreaterThan(0.999999);

    await toggleOrtho(page, 'perspective');
    const back = await screenLength(page, ...onWall);
    expect(Math.abs(back / before - 1)).toBeLessThan(0.02);

    // Наблизили в ортогональній проекції — у перспективі стіна лишається того ж (нового) розміру.
    await toggleOrtho(page, 'ortho');
    await zoomIn(page, vp.width / 2, vp.height / 2);
    const zoomed = await screenLength(page, ...onWall);
    expect(zoomed).toBeGreaterThan(ortho * 1.05);
    await toggleOrtho(page, 'perspective');
    expect(Math.abs((await screenLength(page, ...onWall)) / zoomed - 1)).toBeLessThan(0.02);
  });

  test('зсередини кімнати: в «Орто» видно те саме, що з перспективою — те, що за камерою, у кадр не потрапляє', async ({ page }) => {
    // Камера в кімнаті (Z від −1,5 до 1,5 м) дивиться на стіну Z = −1,5; стіна Z = +1,5 — за спиною.
    await openRoom(page, { x: 0.3, y: 1.2, z: 1.2 }, { x: 0.3, y: 1.2, z: 0 });
    const behind = { x: 0.3, y: 1.2, z: 1.45 };
    const ahead = { x: 0.3, y: 1.2, z: -1.4 };
    expect((await project(page, behind)).visible).toBe(false);
    await toggleOrtho(page, 'ortho');
    expect((await project(page, behind)).visible, 'точка за камерою').toBe(false);
    expect((await project(page, ahead)).visible, 'точка попереду').toBe(true);
    // Дотик по центру кадру влучає в стіну попереду, а не в ту, що за спиною.
    const vp = page.viewportSize()!;
    const hit = await page.evaluate((c) => window.__trasa!.viewer.raycastScan(c.x, c.y), { x: vp.width / 2, y: vp.height / 2 });
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeCloseTo(-1.5, 3);
    // Лінія траси, що йде за камеру, обрізається так само, як з перспективою.
    const path = await page.evaluate(
      ([a, b]) => window.__trasa!.viewer.projectPath([a!, b!]),
      [ahead, behind] as const,
    );
    expect(path.nodes.map((n) => n.visible)).toEqual([true, false]);
    expect(path.segments).toHaveLength(1);
  });

  test('перемикання під час побудови траси: точка, яку тягнуть, лишається того ж розміру й на місці', async ({ page }) => {
    await openRoom(page, { x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 });
    await page.getByTestId('route').click();
    const first = await project(page, { x: -0.5, y: 0, z: 0.4 });
    await page.mouse.click(Math.round(first.x), Math.round(first.y));
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    // Піднімаємо точку повзунком — вона в повітрі, далеко від поверхні скану за нею.
    const slider = (await page.getByTestId('stick-y').filter({ visible: true }).boundingBox())!;
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 - 58, { steps: 3 });
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await frames(page, 5);
    const point: P3 = (await state(page)).routes.editor.point;
    expect(point.y).toBeGreaterThan(0.2);
    // Короткий відрізок біля точки, поперек погляду.
    const v = await view(page);
    const rl = Math.hypot(v.dir.z, v.dir.x);
    const right = { x: -v.dir.z / rl, y: 0, z: v.dir.x / rl };
    const ends: [P3, P3] = [
      { x: point.x - right.x * 0.1, y: point.y, z: point.z - right.z * 0.1 },
      { x: point.x + right.x * 0.1, y: point.y, z: point.z + right.z * 0.1 },
    ];
    const before = { length: await screenLength(page, ...ends), at: await project(page, point) };

    await toggleOrtho(page, 'ortho');
    const ortho = { length: await screenLength(page, ...ends), at: await project(page, point) };
    expect(Math.abs(ortho.length / before.length - 1)).toBeLessThan(0.02);
    expect(Math.hypot(ortho.at.x - before.at.x, ortho.at.y - before.at.y)).toBeLessThan(1.5);

    await toggleOrtho(page, 'perspective');
    const back = { length: await screenLength(page, ...ends), at: await project(page, point) };
    expect(Math.abs(back.length / before.length - 1)).toBeLessThan(0.02);
    expect(Math.hypot(back.at.x - before.at.x, back.at.y - before.at.y)).toBeLessThan(1.5);
    // Точка не зрушила, редактор відкритий.
    expect((await state(page)).routes.editor.point).toEqual(point);
    await expect(page.getByTestId('point-editor').filter({ visible: true })).toBeVisible();
  });

  test('«Орто» + X / Y / Z — справжні вид збоку, план і вид спереду', async ({ page }) => {
    await openRoom(page);
    await toggleOrtho(page, 'ortho');
    const same = async (a: P3, b: P3) => {
      const [pa, pb] = [await project(page, a), await project(page, b)];
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };

    await page.getByTestId('view-x').click();
    await frames(page);
    // Уздовж X: точки, що різняться лише координатою X, зливаються в одну.
    expect(await same({ x: -1.8, y: 0.4, z: 1.1 }, { x: 1.8, y: 0.4, z: 1.1 })).toBeLessThan(0.5);
    expect(await same({ x: -1.8, y: 2.3, z: -1.2 }, { x: 1.8, y: 2.3, z: -1.2 })).toBeLessThan(0.5);
    // Вертикаль лишається вертикальною, 1 м по Y і по Z — однаково на екрані.
    const bottom = await project(page, { x: 0, y: 0.2, z: 0.8 });
    const top = await project(page, { x: 0, y: 2.2, z: 0.8 });
    expect(Math.abs(bottom.x - top.x)).toBeLessThan(0.5);
    expect(Math.abs((await screenLength(page, { x: 0, y: 1, z: -1 }, { x: 0, y: 1, z: 1 })) - Math.abs(bottom.y - top.y))).toBeLessThan(0.5);
    await expect(page.getByTestId('view-x')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('view-ortho')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('view-y').click();
    await frames(page);
    // План: підлога й стеля зливаються; X — праворуч, −Z — вгору.
    expect(await same({ x: 1.3, y: 0, z: 0.7 }, { x: 1.3, y: 2.7, z: 0.7 })).toBeLessThan(0.5);
    const o = await project(page, { x: 0, y: 0, z: 0 });
    const px = await project(page, { x: 1, y: 0, z: 0 });
    const pz = await project(page, { x: 0, y: 0, z: -1 });
    expect(px.x - o.x).toBeGreaterThan(10);
    expect(Math.abs(px.y - o.y)).toBeLessThan(0.5);
    expect(o.y - pz.y).toBeGreaterThan(10);
    expect(Math.abs(px.x - o.x - (o.y - pz.y))).toBeLessThan(0.5);

    await page.getByTestId('view-z').click();
    await frames(page);
    expect(await same({ x: -0.9, y: 1.7, z: -1.4 }, { x: -0.9, y: 1.7, z: 1.4 })).toBeLessThan(0.5);
    // Проекція лишилась ортогональною після зміни виду.
    expect((await state(page)).projection).toBe('ortho');
  });

  test('в ортогональній проекції працюють рулетка, траса й вибір труби дотиком', async ({ page }) => {
    await openRoom(page, { x: 2.2, y: 5, z: 6.5 }, { x: 0, y: 0.5, z: 0 });
    await toggleOrtho(page, 'ortho');

    // Рулетка: дві точки на підлозі за 1500 мм одна від одної.
    await page.getByTestId('ruler').click();
    const a = { x: -0.9, y: 0, z: 0.3 };
    const b = { x: 0.6, y: 0, z: 0.3 };
    const pa = await project(page, a);
    await page.mouse.click(pa.x, pa.y);
    await confirmPoint(page);
    const pb = await project(page, b);
    await page.mouse.click(pb.x, pb.y);
    await confirmPoint(page);
    const ruler = (await state(page)).ruler;
    expect(ruler.points).toHaveLength(2);
    // Клік — у цілі пікселі, тож допуск кілька мм; точки саме на підлозі.
    expect(Math.abs(ruler.distanceMm - 1500)).toBeLessThan(8);
    for (const p of ruler.points as P3[]) expect(Math.abs(p.y)).toBeLessThan(0.001);
    await page.getByTestId('ruler').click();

    // Траса: перша точка дотиком, друга — джойстиком по X.
    await page.getByTestId('route').click();
    const start = { x: -0.5, y: 0, z: 0.4 };
    const ps = await project(page, start);
    await page.mouse.click(ps.x, ps.y);
    let editor = (await state(page)).routes.editor;
    expect(Math.hypot(editor.point.x - start.x, editor.point.z - start.z)).toBeLessThan(0.01);
    expect(Math.abs(editor.point.y)).toBeLessThan(0.001);
    await confirmPoint(page);
    const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), editor.point as P3);
    const len = Math.hypot(axes.X.x, axes.X.y);
    expect(len).toBeGreaterThan(1);
    const stick = (await page.getByTestId('stick-xz').filter({ visible: true }).boundingBox())!;
    const cx = stick.x + stick.width / 2;
    const cy = stick.y + stick.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + (axes.X.x / len) * 58, cy + (axes.X.y / len) * 58, { steps: 3 });
    await page.waitForTimeout(700);
    await page.mouse.up();
    await frames(page, 4);
    editor = (await state(page)).routes.editor;
    expect(editor.segment.axis).toBe('X');
    expect(editor.point.x).toBeGreaterThan(editor.segment.anchor.x + 0.05);
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    await page.getByTestId('route-finish').click();
    expect((await state(page)).routes.set.routes).toHaveLength(1);

    // Повітропровід: дотик по трубі вибирає відрізок.
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({
        routes: [
          {
            id: 1,
            nodes: [
              { x: -1500, y: 1200, z: -600 },
              { x: 500, y: 1200, z: -600 },
              { x: 500, y: 1200, z: 900 },
            ],
          },
        ],
        nextId: 2,
      }),
    );
    await page.getByTestId('duct').click();
    await page.getByTestId('duct-diameter').selectOption('250');
    await frames(page, 4);
    const mid = await project(page, { x: 0.5, y: 1.2, z: 0.2 });
    await page.mouse.click(Math.round(mid.x), Math.round(mid.y));
    expect((await state(page)).ducts.selection).toEqual({ routeId: 1, segment: 1 });
  });

  test('зум, обертання й зсув в ортогональній проекції; «Показати все» вміщає скан', async ({ page }) => {
    await openRoom(page);
    await toggleOrtho(page, 'ortho');
    const segment: [P3, P3] = [{ x: -1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }];
    const vp = page.viewportSize()!;
    const cx = vp.width / 2;
    const cy = vp.height / 2;

    // Зум колесом: усе більшає; точка під курсором майже не зсувається.
    const cursor = { x: cx + 60, y: cy - 40 };
    const under = await page.evaluate((c) => window.__trasa!.viewer.raycastScan(c.x, c.y), cursor);
    expect(under).not.toBeNull();
    const before = await screenLength(page, ...segment);
    await zoomIn(page, cursor.x, cursor.y);
    const zoomed = await screenLength(page, ...segment);
    expect(zoomed).toBeGreaterThan(before * 1.05);
    const underAfter = await project(page, under!);
    expect(Math.hypot(underAfter.x - cursor.x, underAfter.y - cursor.y)).toBeLessThan(12);

    // Обертання перетягуванням: напрямок погляду змінюється, проекція лишається без перспективи.
    const dir0 = (await view(page)).dir;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 30, { steps: 6 });
    await page.mouse.up();
    await frames(page, 30);
    const dir1 = (await view(page)).dir;
    expect(dir0.x * dir1.x + dir0.y * dir1.y + dir0.z * dir1.z).toBeLessThan(0.99);
    const near = await screenLength(page, { x: -0.5, y: 0.3, z: 1.4 }, { x: 0.5, y: 0.3, z: 1.4 });
    const far = await screenLength(page, { x: -0.5, y: 2.5, z: -1.4 }, { x: 0.5, y: 2.5, z: -1.4 });
    expect(Math.abs(near - far)).toBeLessThan(0.5);

    // «Показати все»: увесь скан у кадрі.
    await page.getByTestId('show-all').click();
    await frames(page, 5);
    for (const x of [-2, 2]) {
      for (const y of [0, 2.7]) {
        for (const z of [-1.5, 1.5]) {
          const p = await project(page, { x, y, z });
          expect(p.x, `кут ${x};${y};${z}`).toBeGreaterThan(0);
          expect(p.x).toBeLessThan(vp.width);
          expect(p.y).toBeGreaterThan(0);
          expect(p.y).toBeLessThan(vp.height);
        }
      }
    }
    expect((await state(page)).projection).toBe('ortho');
  });

  test('точку показують зсувом, а не поворотом: вид уздовж осі не збивається', async ({ page }) => {
    await openRoom(page);
    await toggleOrtho(page, 'ortho');
    await page.getByTestId('view-x').click();
    await frames(page);
    const before = await view(page);
    const point = { x: 0.4, y: 2.3, z: 1.1 };
    await page.evaluate((p) => window.__trasa!.viewer.centerOn(p), point);
    await frames(page);
    const after = await view(page);
    expect(after.dir.x * before.dir.x + after.dir.y * before.dir.y + after.dir.z * before.dir.z).toBeGreaterThan(0.9999999);
    expect(after.distance).toBeCloseTo(before.distance, 6);
    const vp = page.viewportSize()!;
    const s = await project(page, point);
    expect(Math.abs(s.x - vp.width / 2)).toBeLessThan(1);
    expect(Math.abs(s.y - vp.height / 2)).toBeLessThan(1);
  });
});

test.describe('Скріншоти: ортогональна проекція', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('вид збоку й план із повітропроводом', async ({ page }, testInfo) => {
        const shot = (name: string) =>
          page.screenshot({ path: `test-results/screenshots/stage41-${testInfo.project.name.replace(/\s+/g, '-')}-${colorScheme}-${name}.png` });
        await openRoom(page);
        await page.evaluate(() =>
          window.__trasa!.app!.loadRoutes({
            routes: [
              {
                id: 1,
                nodes: [
                  { x: -1500, y: 2200, z: -1000 },
                  { x: 0, y: 2200, z: -1000 },
                  { x: 1000, y: 2200, z: 0 },
                  { x: 1000, y: 2200, z: 800 },
                  { x: 1000, y: 1200, z: 800 },
                ],
                duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [] },
              },
            ],
            nextId: 2,
          }),
        );
        await toggleOrtho(page, 'ortho');
        await page.getByTestId('view-y').click();
        await frames(page, 5);
        await shot('ortho-plan');
        await page.getByTestId('view-x').click();
        await frames(page, 5);
        await shot('ortho-side');
        await expect(page.getByTestId('view-ortho')).toHaveAttribute('aria-pressed', 'true');
      });
    });
  }
});
