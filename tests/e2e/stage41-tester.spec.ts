/**
 * Етап 4.1 (tester): браузерні сценарії, яких немає в page-zoom.spec.ts, turn45.spec.ts і projection.spec.ts.
 * Тестова кімната 4000 × 2700 × 3000 мм: X від −2 до 2 м, Y від 0 до 2,7 м, Z від −1,5 до 1,5 м.
 *
 * - Масштаб сторінки: обчислений touch-action у всіх станах програми (діалоги, панель «Повітропровід»,
 *   список видалення, рулетка, вибір 45°…); справжні дотики (Chromium, CDP): прокрутка списків, кнопки,
 *   «щипок» камери по сцені — масштаб сторінки лишається 1; плашка «Сторінку збільшено».
 * - Камера за точкою: різні напрямки, повзунок, «Орто», діагональ.
 * - 45° в інтерфейсі: рулетка й перша точка без «45°», перемикання туди-назад, повзунок у заборонений бік,
 *   «Видалити останню точку» після діагоналі, напрямок джойстика на діагоналі, діагональ на плані в «Орто».
 * - «Орто»: порожня сцена, зміна розміру вікна, відкриття іншого скану, багаторазове перемикання під час
 *   доведення точки, вибір труби дотиком на діагоналі.
 * - Повітропровід на 45°: габарит підйому під 45°, перебудови й пам'ять.
 */
import { fileURLToPath } from 'node:url';
import { type CDPSession, expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));
const ROOM_GLB = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.glb', import.meta.url));

type P3 = { x: number; y: number; z: number };
type Axis = 'X' | 'Y' | 'Z';
type Section = { shape: 'round'; diameterMm: number } | { shape: 'rect'; widthMm: number; heightMm: number };
type RouteIn = { id: number; nodes: P3[]; duct?: { section: Section; transitions: Array<{ segment: number; to: Section }> } | null };

/** 0,1 мм у метрах сцени. */
const TOL_M = 1e-4;

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const editor = async (page: Page) => (await state(page)).routes.editor;
const shown = (page: Page, testid: string) => page.getByTestId(testid).filter({ visible: true });
const project = (page: Page, p: P3) => page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), p);
const frames = (page: Page, n = 3) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, n);
const offset = (a: P3, b: P3): P3 => ({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });

/** Камера: позиція, ціль, напрямок погляду, відстань до цілі. */
const camera = (page: Page) =>
  page.evaluate(() => {
    const v = window.__trasa!.viewer.snapshotView();
    const d = { x: v.target.x - v.position.x, y: v.target.y - v.position.y, z: v.target.z - v.position.z };
    const l = Math.hypot(d.x, d.y, d.z);
    return {
      position: { x: v.position.x, y: v.position.y, z: v.position.z },
      target: { x: v.target.x, y: v.target.y, z: v.target.z },
      dir: { x: d.x / l, y: d.y / l, z: d.z / l },
      distance: l,
    };
  });

async function screenLength(page: Page, a: P3, b: P3): Promise<number> {
  const [pa, pb] = [await project(page, a), await project(page, b)];
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

async function openApp(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
}

async function openRoom(page: Page, from: P3 = { x: 2.5, y: 4, z: 9 }, to: P3 = { x: 0, y: 0.8, z: 0 }) {
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate(([f, t]) => window.__trasa!.viewer.setView(f!, t!), [from, to] as const);
  await frames(page);
}

async function confirm(page: Page) {
  await shown(page, 'confirm-point').click();
  // Після «Підтвердити» ≈ 0,35 с дотики по скану ігноруються (захист від подвійного натискання).
  await page.waitForTimeout(400);
}

/** «Траса» + перша точка на підлозі, підтверджена: далі тягнемо другу. */
async function startPull(page: Page, at: P3 = { x: -0.8, y: 0, z: 0.2 }, from?: P3, to?: P3) {
  await openRoom(page, from, to);
  await page.getByTestId('route').click();
  const p = await project(page, at);
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await confirm(page);
  expect((await state(page)).routes.phase).toBe('pull');
}

/** Натиснути й тримати елемент (центр), відхилити на (dx, dy) × 64 px; відпустити через ms. */
async function hold(page: Page, testid: string, dx: number, dy: number, ms: number, release = true) {
  const box = (await shown(page, testid).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx * 64, cy + dy * 64, { steps: 3 });
  await page.waitForTimeout(ms);
  if (release) {
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
}

/**
 * Куди тягнути джойстик, щоб точка пішла по осі: стрілка цієї осі НА САМОМУ ДЖОЙСТИКУ (коли X і Z на екрані
 * майже на одній лінії, джойстик їх «розводить» — див. core/nudge.ts → joystickLayout).
 */
async function stickDir(page: Page, axis: 'X' | 'Z'): Promise<{ x: number; y: number }> {
  await frames(page, 2);
  return shown(page, 'stick-xz').evaluate((el, a) => {
    const line = el.querySelector(`.stick-guide--${a.toLowerCase()}`)!;
    const x = Number(line.getAttribute('x2'));
    const y = Number(line.getAttribute('y2'));
    const l = Math.hypot(x, y);
    return { x: x / l, y: y / l };
  }, axis);
}

/** Напрямок осі на екрані біля точки (одиничний) — стрілка біля самої точки. */
async function screenDir(page: Page, axis: Axis): Promise<{ x: number; y: number }> {
  const point: P3 = (await editor(page)).point;
  const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), point);
  const d = axes[axis];
  const l = Math.hypot(d.x, d.y);
  return { x: d.x / l, y: d.y / l };
}

/** Потягнути точку по осі (джойстик для X і Z, повзунок для Y). */
async function pull(page: Page, axis: Axis, sign: 1 | -1, ms = 500, strength = 0.9) {
  if (axis === 'Y') {
    await hold(page, 'stick-y', 0, -strength * sign, ms);
    return;
  }
  const d = await stickDir(page, axis);
  await hold(page, 'stick-xz', sign * strength * d.x, sign * strength * d.y, ms);
}

async function choose45(page: Page, option: string) {
  await shown(page, 'segment-45').click();
  await expect(shown(page, 'segment-45-picker')).toBeVisible();
  await shown(page, `segment-45-${option}`).click();
  await expect(shown(page, 'segment-45-picker')).toHaveCount(0);
}

async function loadRoutes(page: Page, routes: RouteIn[]) {
  await page.evaluate((r) => window.__trasa!.app!.loadRoutes({ routes: r, nextId: Math.max(0, ...r.map((x) => x.id)) + 1 }), routes);
  await frames(page);
}

/** Обчислений touch-action усіх елементів програми (і html, body): що не «none» / «pan-y». */
const touchActions = (page: Page) =>
  page.evaluate(() => {
    const bad: string[] = [];
    const seen: Record<string, number> = {};
    const all = [document.documentElement, document.body, ...document.querySelectorAll('#app, #app *')];
    for (const el of all) {
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
      const value = getComputedStyle(el).touchAction;
      seen[value] = (seen[value] ?? 0) + 1;
      if (value !== 'none' && value !== 'pan-y') {
        const id = (el as HTMLElement).dataset?.testid ?? '';
        bad.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}${id ? ` [${id}]` : ''}: ${value}`);
      }
    }
    // Видимі елементи поза #app (на них захист не діє).
    const outside = [...document.body.children]
      .filter((c) => c.id !== 'app' && c.tagName !== 'SCRIPT')
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(c).visibility !== 'hidden';
      })
      .map((c) => c.outerHTML.slice(0, 100));
    return { bad: bad.slice(0, 15), badCount: bad.length, seen, outside };
  });

async function expectTouchActions(page: Page, where: string) {
  const r = await touchActions(page);
  expect(r.bad, `${where}: touch-action не «none»/«pan-y» (${r.badCount})`).toEqual([]);
  expect(r.outside, `${where}: видимі елементи поза #app`).toEqual([]);
  // Масштаб сторінки — 1, плашки немає.
  expect(await page.evaluate(() => window.__trasa!.pageZoom!.scale), where).toBe(1);
  await expect(page.getByTestId('zoom-banner')).toBeHidden();
}

/** Справжні дотики (лише Chromium — через CDP). */
async function touchSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}
type TP = { x: number; y: number; id: number };
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: TP[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });

/** Одиночний дотик пальцем по центру елемента. */
async function tapTouch(page: Page, cdp: CDPSession, testid: string) {
  const b = (await shown(page, testid).boundingBox())!;
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 7 };
  await touch(cdp, 'touchStart', [p]);
  await page.waitForTimeout(40);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(60);
}

/** Провести одним пальцем від точки на (dx, dy) px за n кроків. */
async function swipe(page: Page, cdp: CDPSession, from: { x: number; y: number }, dx: number, dy: number, n = 12) {
  await touch(cdp, 'touchStart', [{ ...from, id: 3 }]);
  for (let i = 1; i <= n; i++) {
    await touch(cdp, 'touchMove', [{ x: from.x + (dx * i) / n, y: from.y + (dy * i) / n, id: 3 }]);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(300);
}

const pageScale = (page: Page) =>
  page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    guard: window.__trasa!.pageZoom!.scale,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    zoomedClass: document.documentElement.classList.contains('page-zoomed'),
  }));

const ZIGZAG: RouteIn = {
  id: 1,
  nodes: [
    { x: -1500, y: 1500, z: -800 },
    { x: -500, y: 1500, z: -800 },
    { x: 500, y: 1500, z: 200 },
    { x: 1300, y: 1500, z: 200 },
    { x: 1700, y: 1900, z: 200 },
  ],
};

// ───────────────────────── Масштаб сторінки ─────────────────────────

test.describe('Етап 4.1 (tester): масштаб сторінки — touch-action у всіх станах програми', () => {
  test('без скану, помилка відкриття, рулетка, траса з вибором 45°, питання «не завершена», список видалення, панель «Повітропровід»', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openApp(page);
    await expectTouchActions(page, 'без скану');

    // Пошкоджений файл — повідомлення про помилку.
    await page.getByTestId('file-input').setInputFiles({ name: 'broken.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('not a glb at all') });
    await expect(page.getByTestId('alert')).toBeVisible();
    await expectTouchActions(page, 'повідомлення про помилку');
    await page.getByTestId('alert').getByRole('button').click();

    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
    await frames(page);
    await expectTouchActions(page, 'скан відкрито');

    // Рулетка з точкою в редакторі.
    await page.getByTestId('ruler').click();
    const a = await project(page, { x: -0.5, y: 0, z: 0.3 });
    await page.mouse.click(Math.round(a.x), Math.round(a.y));
    await expect(shown(page, 'point-editor')).toBeVisible();
    await expectTouchActions(page, 'рулетка');
    await shown(page, 'ruler-done').click();

    // Траса: відрізок, вибір 45° відкрито.
    await page.getByTestId('route').click();
    const b = await project(page, { x: -0.8, y: 0, z: 0.2 });
    await page.mouse.click(Math.round(b.x), Math.round(b.y));
    await confirm(page);
    await pull(page, 'X', 1, 500);
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-picker')).toBeVisible();
    await expectTouchActions(page, 'траса, вибір 45°');
    await shown(page, 'segment-45-z-plus').click();
    await confirm(page);
    await pull(page, 'X', 1, 400);
    await confirm(page);
    // Питання «Траса не завершена» (≥ 2 точки, закриваємо інструмент).
    await shown(page, 'route-close').click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await expectTouchActions(page, 'питання «не завершена»');
    await page.getByTestId('choice-save').click();

    // Багато трас: список видалення прокручується.
    const routes: RouteIn[] = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      nodes: [
        { x: -1500, y: 300 + i * 90, z: -1000 },
        { x: 500, y: 300 + i * 90, z: -1000 },
        { x: 1200, y: 300 + i * 90, z: -300 },
      ],
    }));
    await loadRoutes(page, routes);
    await page.getByTestId('route-delete').click();
    await expect(page.getByTestId('route-delete-panel')).toBeVisible();
    await expectTouchActions(page, 'список видалення');
    await page.getByTestId('route-delete-close').click();

    // Панель «Повітропровід»: розмір, відрізок з редактором переходу, прямокутні з полями, проблеми.
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
    await page.getByTestId('duct-diameter').selectOption('200');
    await page.getByTestId('duct-segment-1').click();
    await expect(page.getByTestId('duct-transition-editor')).toBeVisible();
    await expectTouchActions(page, 'панель «Повітропровід», перехід');
    await page.getByTestId('duct-shape-rect').click();
    await page.getByTestId('duct-width').fill('3001');
    await page.getByTestId('duct-apply-rect').click();
    await expect(page.getByTestId('duct-message')).toBeVisible();
    await expectTouchActions(page, 'панель «Повітропровід», прямокутні, пояснення');
    // Прокручувані частини — лише вертикальна прокрутка (pan-y), а не «none».
    for (const testid of ['duct-panel', 'duct-segment-0']) {
      expect(await page.getByTestId(testid).evaluate((el) => getComputedStyle(el).touchAction), testid).toBe('pan-y');
    }
  });
});

test.describe('Етап 4.1 (tester): масштаб сторінки — справжні дотики (Chromium)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'справжні дотики через CDP є лише в Chromium (у CI — WebKit)');
  });

  test('список видалення й панель «Повітропровід» прокручуються пальцем; масштаб сторінки 1, сторінка не зсувається', async ({ page }) => {
    await openRoom(page);
    const routes: RouteIn[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      nodes: Array.from({ length: 12 }, (_, k) => ({ x: -1800 + k * 300, y: 300 + i * 70, z: k % 2 === 0 ? -1000 : -700 })),
    }));
    await loadRoutes(page, routes);
    const cdp = await touchSession(page);

    await page.getByTestId('route-delete').click();
    const list = page.getByTestId('route-list');
    await expect(list).toBeVisible();
    const scroller = async (testid: string) =>
      page.getByTestId(testid).evaluate((el) => {
        // Сам елемент або найближчий предок, що прокручується.
        let node: HTMLElement | null = el as HTMLElement;
        while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
        return node ? { top: node.scrollTop, scrollable: node.scrollHeight - node.clientHeight } : null;
      });
    const before = (await scroller('route-list'))!;
    expect(before.scrollable, 'список має бути довшим за видиму частину').toBeGreaterThan(50);
    const lb = (await list.boundingBox())!;
    await swipe(page, cdp, { x: lb.x + lb.width / 2, y: lb.y + lb.height * 0.75 }, 0, -Math.min(200, lb.height * 0.6));
    expect((await scroller('route-list'))!.top, 'список не прокрутився пальцем').toBeGreaterThan(before.top + 20);
    expect(await pageScale(page)).toEqual({ scale: 1, guard: 1, scrollX: 0, scrollY: 0, zoomedClass: false });
    await page.getByTestId('route-delete-close').click();

    await page.getByTestId('duct').click();
    await page.getByTestId('duct-diameter').selectOption('160');
    const panel = page.getByTestId('duct-panel');
    const pb = (await panel.boundingBox())!;
    const panelBefore = (await scroller('duct-panel'))!;
    expect(panelBefore.scrollable).toBeGreaterThan(50);
    await swipe(page, cdp, { x: pb.x + pb.width / 2, y: pb.y + pb.height * 0.8 }, 0, -Math.min(220, pb.height * 0.6));
    expect((await scroller('duct-panel'))!.top, 'панель «Повітропровід» не прокрутилась пальцем').toBeGreaterThan(panelBefore.top + 20);
    expect(await pageScale(page)).toEqual({ scale: 1, guard: 1, scrollX: 0, scrollY: 0, zoomedClass: false });
  });

  test('кнопки натискаються пальцем (і двічі поспіль — два натискання): «Орто», «45°», варіант 45°, «Підтвердити точку»', async ({ page }) => {
    await startPull(page);
    const cdp = await touchSession(page);
    await tapTouch(page, cdp, 'view-ortho');
    expect((await state(page)).projection).toBe('ortho');
    // Подвійний дотик по кнопці — два натискання (проекція вмикається й вимикається), а не збільшення сторінки.
    await tapTouch(page, cdp, 'view-ortho');
    await tapTouch(page, cdp, 'view-ortho');
    expect((await state(page)).projection).toBe('ortho');
    await tapTouch(page, cdp, 'view-ortho');
    expect((await state(page)).projection).toBe('perspective');

    await pull(page, 'X', 1, 500);
    await tapTouch(page, cdp, 'segment-45');
    await expect(shown(page, 'segment-45-picker')).toBeVisible();
    await tapTouch(page, cdp, 'segment-45-z-minus');
    expect((await editor(page)).segment.diagonal).toEqual({ axis: 'Z', sign: -1 });
    await tapTouch(page, cdp, 'confirm-point');
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    expect(await pageScale(page)).toEqual({ scale: 1, guard: 1, scrollX: 0, scrollY: 0, zoomedClass: false });
  });

  for (const projection of ['perspective', 'ortho'] as const) {
    test(`«щипок» двома пальцями по сцені наближає камеру (${projection === 'ortho' ? '«Орто»' : 'перспектива'}); масштаб сторінки 1`, async ({ page }) => {
      await openRoom(page, { x: 3.2, y: 3.4, z: 5.2 }, { x: 0, y: 1.4, z: 0 });
      if (projection === 'ortho') {
        await page.getByTestId('view-ortho').click();
        await frames(page);
      }
      const segment: [P3, P3] = [{ x: -1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }];
      const before = { cam: await camera(page), len: await screenLength(page, ...segment) };
      const cdp = await touchSession(page);
      const vp = page.viewportSize()!;
      const c = { x: vp.width / 2, y: vp.height / 2 };
      await touch(cdp, 'touchStart', [{ x: c.x - 40, y: c.y, id: 1 }]);
      await touch(cdp, 'touchStart', [
        { x: c.x - 40, y: c.y, id: 1 },
        { x: c.x + 40, y: c.y, id: 2 },
      ]);
      for (let i = 1; i <= 15; i++) {
        await touch(cdp, 'touchMove', [
          { x: c.x - 40 - i * 7, y: c.y, id: 1 },
          { x: c.x + 40 + i * 7, y: c.y, id: 2 },
        ]);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', []);
      await frames(page, 30);
      const after = { cam: await camera(page), len: await screenLength(page, ...segment) };
      expect(after.cam.distance, 'камера не наблизилась').toBeLessThan(before.cam.distance * 0.9);
      expect(after.len, 'на екрані нічого не збільшилось').toBeGreaterThan(before.len * 1.1);
      expect((await state(page)).projection).toBe(projection);
      expect(await pageScale(page)).toEqual({ scale: 1, guard: 1, scrollX: 0, scrollY: 0, zoomedClass: false });
    });
  }
});

/**
 * Справжнє збільшення сторінки емуляція не вміє (Chromium тримає масштаб 1 через meta viewport), тож
 * підміняємо window.visualViewport до запуску програми: масштаб і зсув видимої частини задаємо самі.
 */
function installFakeViewport(): void {
  const state = { scale: 1, offsetLeft: 0, offsetTop: 0 };
  const fake = new EventTarget();
  Object.defineProperties(fake, {
    scale: { get: () => state.scale },
    offsetLeft: { get: () => state.offsetLeft },
    offsetTop: { get: () => state.offsetTop },
    pageLeft: { get: () => state.offsetLeft },
    pageTop: { get: () => state.offsetTop },
    width: { get: () => window.innerWidth / state.scale },
    height: { get: () => window.innerHeight / state.scale },
  });
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  (window as unknown as { __fakeZoom: (next: Partial<typeof state>) => void }).__fakeZoom = (next) => {
    Object.assign(state, next);
    fake.dispatchEvent(new Event('resize'));
  };
}

const fakeZoom = (page: Page, next: { scale: number; offsetLeft: number; offsetTop: number }) =>
  page.evaluate((n) => (window as unknown as { __fakeZoom: (x: typeof n) => void }).__fakeZoom(n), next);

/** Плашка й кнопка у видимій частині (CSS px сторінки) і їхній розмір на екрані (× масштаб). */
const bannerGeometry = (page: Page) =>
  page.evaluate(() => {
    const vv = window.visualViewport!;
    const banner = document.querySelector<HTMLElement>('[data-testid="zoom-banner"]')!;
    const rb = banner.getBoundingClientRect();
    const rr = document.querySelector<HTMLElement>('[data-testid="zoom-reset"]')!.getBoundingClientRect();
    return {
      hidden: banner.hidden,
      cls: document.documentElement.classList.contains('page-zoomed'),
      guard: window.__trasa!.pageZoom!.zoomed,
      // Відступи від країв видимої частини, у пікселях екрана.
      left: (rb.left - vv.offsetLeft) * vv.scale,
      top: (rb.top - vv.offsetTop) * vv.scale,
      right: (vv.offsetLeft + vv.width - rb.right) * vv.scale,
      bottom: (vv.offsetTop + vv.height - rb.bottom) * vv.scale,
      button: { w: rr.width * vv.scale, h: rr.height * vv.scale, right: (vv.offsetLeft + vv.width - rr.right) * vv.scale },
      meta: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content,
      canvasAction: getComputedStyle(document.querySelector('canvas.viewport')!).touchAction,
    };
  });

test.describe('Етап 4.1 (tester): сторінку все ж збільшено — плашка й повернення масштабу (імітація visualViewport)', () => {
  for (const zoom of [
    { scale: 1.6, offsetLeft: 40, offsetTop: 90 },
    { scale: 2.5, offsetLeft: 120, offsetTop: 200 },
  ]) {
    test(`масштаб ${zoom.scale}: плашка звичайного розміру цілком у видимій частині, кнопка ≥ 44 px; програма сама пробує повернути масштаб; масштаб 1 — плашки немає`, async ({
      page,
    }) => {
      await page.addInitScript(installFakeViewport);
      await startPull(page);
      const metaBefore = (await bannerGeometry(page)).meta;
      await fakeZoom(page, zoom);
      await page.waitForTimeout(50);
      const g = await bannerGeometry(page);
      expect(g.guard).toBe(true);
      expect(g.hidden).toBe(false);
      expect(g.cls).toBe(true);
      expect(g.left, 'плашка за лівим краєм видимої частини').toBeGreaterThanOrEqual(0);
      expect(g.top, 'плашка за верхнім краєм').toBeGreaterThanOrEqual(0);
      expect(g.right, 'плашка виходить за правий край видимої частини (px екрана)').toBeGreaterThanOrEqual(0);
      expect(g.bottom).toBeGreaterThan(0);
      expect(g.button.w).toBeGreaterThanOrEqual(44);
      expect(g.button.h).toBeGreaterThanOrEqual(44);
      expect(g.button.right, 'кнопка «Повернути» обрізана правим краєм').toBeGreaterThanOrEqual(0);
      // Поки збільшено — жести сторінки дозволені, щоб зменшити її двома пальцями.
      // «pan-x pan-y pinch-zoom» Chromium записує як рівнозначне «manipulation».
      expect(['manipulation', 'pan-x pan-y pinch-zoom'], `touch-action сцени: ${g.canvasAction}`).toContain(g.canvasAction);
      const gesture = await page.evaluate(() => {
        const e = new Event('gesturestart', { bubbles: true, cancelable: true });
        document.querySelector('canvas.viewport')!.dispatchEvent(e);
        return e.defaultPrevented;
      });
      expect(gesture, 'жест Safari відхилено, хоча сторінку треба зменшити').toBe(false);
      // Пальці не на екрані — за ≈ 150 мс програма сама змінює meta viewport (так Safari повертає масштаб).
      await page.waitForTimeout(400);
      const after = await bannerGeometry(page);
      expect(after.meta).not.toBe(metaBefore);
      expect(after.meta).toContain('width=device-width');
      // Кнопка «Повернути» — ще одна спроба.
      await page.getByTestId('zoom-reset').click();
      expect((await bannerGeometry(page)).meta).not.toBe(after.meta);
      await fakeZoom(page, { scale: 1, offsetLeft: 0, offsetTop: 0 });
      await page.waitForTimeout(50);
      const back = await bannerGeometry(page);
      expect(back.hidden).toBe(true);
      expect(back.cls).toBe(false);
      expect(back.guard).toBe(false);
      await expectTouchActions(page, 'після повернення масштабу');
      // Захист знову діє: рух двома пальцями по сцені відхилено.
      const prevented = await page.evaluate(() => {
        const e = new Event('touchmove', { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'touches', { value: [{}, {}] });
        document.querySelector('canvas.viewport')!.dispatchEvent(e);
        return e.defaultPrevented;
      });
      expect(prevented).toBe(true);
    });
  }
});

// ───────────────────────── Камера їде за точкою ─────────────────────────

/** Чи точка у видимій частині екрана: перед камерою, у межах екрана, не під панелями. */
const visibility = (page: Page, point: P3) =>
  page.evaluate((p) => {
    const s = window.__trasa!.viewer.projectPoint(p);
    const covered = [...document.querySelectorAll<HTMLElement>('.panel, .toolbar, .point-editor, .view-bar')]
      .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
      .map((el) => el.getBoundingClientRect())
      .some((r) => r.width > 0 && s.x > r.left && s.x < r.right && s.y > r.top && s.y < r.bottom);
    const onScreen = s.visible && s.x > 0 && s.y > 0 && s.x < window.innerWidth && s.y < window.innerHeight;
    return { ok: onScreen && !covered, s, covered };
  }, point);

/**
 * Тримати джойстик чи повзунок `totalMs`, кожні `sampleMs` перевіряючи, що точку видно.
 * Повертає зразки й камеру до, під час (перед відпусканням), одразу після й через 400 мс після відпускання.
 */
async function holdAndWatch(page: Page, testid: string, dx: number, dy: number, totalMs: number, sampleMs = 1500) {
  const before = await camera(page);
  const start: P3 = (await editor(page)).point;
  const b = (await shown(page, testid).boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx * 66, cy + dy * 66, { steps: 3 });
  const samples: Array<{ t: number; point: P3; ok: boolean; covered: boolean; s: { x: number; y: number; visible: boolean } }> = [];
  for (let t = sampleMs; t <= totalMs; t += sampleMs) {
    await page.waitForTimeout(sampleMs);
    const point: P3 = (await editor(page)).point;
    const v = await visibility(page, point);
    samples.push({ t, point, ...v });
  }
  const during = await camera(page);
  await page.mouse.up();
  const released = await camera(page);
  await page.waitForTimeout(400);
  const after = await camera(page);
  const end: P3 = (await editor(page)).point;
  return { before, during, released, after, start, end, samples, endVisible: await visibility(page, end) };
}

const dotDir = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const moved = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function expectFollowed(r: Awaited<ReturnType<typeof holdAndWatch>>, label: string) {
  for (const s of r.samples) {
    expect(s.ok, `${label}: через ${s.t} мс точка не у видимій частині (${JSON.stringify(s.s)}, під панеллю: ${s.covered})`).toBe(true);
  }
  expect(r.endVisible.ok, `${label}: після відпускання точку не видно`).toBe(true);
  // Камера лише зсувається: напрямок і відстань до цілі ті самі.
  for (const v of [r.during, r.released, r.after]) {
    expect(dotDir(v.dir, r.before.dir), `${label}: камера повернулась`).toBeGreaterThan(0.99999);
    expect(Math.abs(v.distance - r.before.distance), `${label}: змінився масштаб`).toBeLessThan(1e-6);
  }
  // Після відпускання — без ривка (між знімком «під час» і відпусканням точка ще їде, тож порівнюємо з «одразу після»).
  expect(moved(r.after.position, r.released.position), `${label}: ривок після відпускання`).toBeLessThan(0.002);
  expect(dotDir(r.after.dir, r.released.dir), `${label}: поворот після відпускання`).toBeGreaterThan(0.999999);
}

test.describe('Етап 4.1 (tester): камера їде за точкою', () => {
  test('повзунок угору 9 с (точка вище стелі): точка у видимій частині, камера лише зсувається, без ривка', async ({ page }) => {
    test.setTimeout(60_000);
    await startPull(page, undefined, { x: 1.2, y: 2.6, z: 4.6 }, { x: -0.3, y: 0.3, z: 0.3 });
    const r = await holdAndWatch(page, 'stick-y', 0, -1, 9000);
    expect(r.end.y - r.start.y, 'точка мала піднятись > 3 м').toBeGreaterThan(3);
    expectFollowed(r, 'вгору');
    expect(moved(r.after.position, r.before.position), 'камера не їхала за точкою').toBeGreaterThan(0.3);
  });

  test('діагональ X+Z− 8 с: точка у видимій частині, діагональ рівно 45°, без ривка', async ({ page }) => {
    test.setTimeout(60_000);
    await startPull(page, undefined, { x: 1.2, y: 2.6, z: 4.6 }, { x: -0.3, y: 0.3, z: 0.3 });
    await pull(page, 'X', 1, 300);
    await choose45(page, 'z-minus');
    const d = await stickDir(page, 'X');
    const r = await holdAndWatch(page, 'stick-xz', d.x, d.y, 8000);
    const o = offset((await editor(page)).segment.anchor, r.end);
    expect(o.x).toBeGreaterThan(2);
    expect(Math.abs(o.x + o.z)).toBeLessThan(TOL_M);
    expectFollowed(r, 'діагональ');
  });

  test('«Орто»: тягнуть по X 9 с — точка у видимій частині, вид і масштаб ті самі, без ривка', async ({ page }) => {
    test.setTimeout(60_000);
    // Камера ближче: без перспективи точка на екрані не «росте», а на широкому iPad за 9 с має дійти до краю.
    await startPull(page, undefined, { x: 0.4, y: 1.7, z: 2.6 }, { x: -0.5, y: 0.2, z: 0.3 });
    await page.getByTestId('view-ortho').click();
    await frames(page);
    const d = await stickDir(page, 'X');
    const r = await holdAndWatch(page, 'stick-xz', d.x, d.y, 9000);
    // Під навантаженням кадри рідшають і частина ходу губиться, тож поріг — 2 м (усе одно далеко за стіною).
    expect(r.end.x - r.start.x).toBeGreaterThan(2);
    expectFollowed(r, '«Орто»');
    // Скільки камера проїде, залежить від того, наскільки точка вийшла за край (а це — від частоти кадрів):
    // головне, що вона їхала, а точка весь час була у видимій частині (перевірено вище).
    expect(moved(r.after.position, r.before.position), 'камера не їхала за точкою').toBeGreaterThan(0.1);
    expect((await state(page)).projection).toBe('ortho');
  });

  test('точку тягнуть до камери (Z+, камера з боку +Z) 22 с: точка весь час у видимій частині, не опиняється за камерою', async ({ page }) => {
    test.setTimeout(90_000);
    await startPull(page);
    const d = await stickDir(page, 'Z');
    const r = await holdAndWatch(page, 'stick-xz', d.x, d.y, 22_000, 2000);
    expect(r.end.z - r.start.z, 'точка мала пройти повз камеру (z камери ≈ 9 м)').toBeGreaterThan(8);
    expectFollowed(r, 'до камери');
  });
});

// ───────────────────────── 45° в інтерфейсі ─────────────────────────

/** Потримати джойстик чи повзунок і, не відпускаючи, прочитати підказку біля джойстика. */
async function holdAndRead(page: Page, axis: Axis, sign: 1 | -1, ms = 400): Promise<string> {
  if (axis === 'Y') await hold(page, 'stick-y', 0, -0.9 * sign, ms, false);
  else {
    const d = await stickDir(page, axis);
    await hold(page, 'stick-xz', sign * 0.9 * d.x, sign * 0.9 * d.y, ms, false);
  }
  const text = (await shown(page, 'point-shift').textContent()) ?? '';
  await page.mouse.up();
  await page.waitForTimeout(60);
  return text;
}

const FORBIDDEN = 'Такий поворот не можна: лише 45° або 90°';

test.describe('Етап 4.1 (tester): «45°» в інтерфейсі', () => {
  test('рулетка й перша точка траси — без «45°»; з’являється лише для відрізка траси', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('ruler').click();
    const a = await project(page, { x: -0.5, y: 0, z: 0.3 });
    await page.mouse.click(Math.round(a.x), Math.round(a.y));
    await expect(shown(page, 'point-editor')).toBeVisible();
    await expect(shown(page, 'segment-45')).toHaveCount(0);
    await expect(shown(page, 'segment-45-picker')).toHaveCount(0);
    // Повзунок рулетки рухає точку, «45°» так і не з’являється.
    await pull(page, 'Y', 1, 300);
    await expect(shown(page, 'segment-45')).toHaveCount(0);
    await shown(page, 'ruler-done').click();

    await page.getByTestId('route').click();
    const b = await project(page, { x: -0.8, y: 0, z: 0.2 });
    await page.mouse.click(Math.round(b.x), Math.round(b.y));
    await expect(shown(page, 'point-editor')).toBeVisible();
    expect((await state(page)).routes.phase).toBe('editFirst');
    await expect(shown(page, 'segment-45')).toHaveCount(0);
    await confirm(page);
    await expect(shown(page, 'segment-45')).toBeVisible();
  });

  test('«45°» туди-назад з різними варіантами (8 разів): хід по основній осі не змінюється, координати не псуються', async ({ page }) => {
    await startPull(page);
    await pull(page, 'Z', -1, 600);
    const straight: P3 = (await editor(page)).point;
    const anchor: P3 = (await editor(page)).segment.anchor;
    expect(straight.z).toBeLessThan(anchor.z - 0.05);
    const options: Array<[string, 'x' | 'y', 1 | -1]> = [
      ['x-plus', 'x', 1],
      ['y-plus', 'y', 1],
      ['x-minus', 'x', -1],
      ['y-minus', 'y', -1],
    ];
    for (let round = 0; round < 2; round++) {
      for (const [id, key, sign] of options) {
        await choose45(page, id);
        const p: P3 = (await editor(page)).point;
        const d = offset(anchor, p);
        expect(p.z, `${id}: хід по Z`).toBe(straight.z);
        expect(d[key], `${id}: зміщення по другій осі`).toBeCloseTo(sign * Math.abs(d.z), 12);
        const third = key === 'x' ? 'y' : 'x';
        expect(p[third], `${id}: третя координата`).toBe(anchor[third]);
        await expect(shown(page, 'point-shift')).toHaveText(/^Відрізок 45°: Z −/);
        // Вимкнули — рівно та сама точка, що до 45°.
        await shown(page, 'segment-45').click();
        expect((await editor(page)).point, `${id}: після вимкнення`).toEqual(straight);
      }
    }
    await confirm(page);
    await page.getByTestId('route-finish').click();
    const nodes: P3[] = (await state(page)).routes.set.routes[0].nodes;
    expect(nodes[1]!.z).toBeCloseTo(straight.z * 1000, 6);
    expect(nodes[1]!.x).toBe(nodes[0]!.x);
    expect(nodes[1]!.y).toBe(nodes[0]!.y);
  });

  test('підпис діагоналі: обидва зміщення однакові, довжина = зміщення · √2 (±0,1 мм)', async ({ page }) => {
    await startPull(page);
    await pull(page, 'X', 1, 650);
    await choose45(page, 'y-plus');
    const text = (await shown(page, 'point-shift').textContent()) ?? '';
    const m = /^Відрізок 45°: X \+([\d\s,]+) · Y \+([\d\s,]+) = ([\d\s,]+) мм$/.exec(text.replace(/ | /g, ' '));
    expect(m, text).not.toBeNull();
    const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
    const [a, b, c] = [num(m![1]!), num(m![2]!), num(m![3]!)];
    expect(a).toBe(b);
    expect(Math.abs(c - a * Math.SQRT2)).toBeLessThanOrEqual(0.15);
    const e = await editor(page);
    expect(Math.abs(e.segment.lengthMm - c)).toBeLessThanOrEqual(0.05);
  });

  test('після підйому під 45° (X+Y+): повзунок униз і джойстик назад по X — заборонено (135°), точка стоїть; вгору й по Z — можна', async ({ page }) => {
    await startPull(page);
    await pull(page, 'X', 1, 500);
    await choose45(page, 'y-plus');
    await confirm(page);
    const anchor: P3 = (await editor(page)).segment.anchor;
    expect(await holdAndRead(page, 'Y', -1)).toBe(FORBIDDEN);
    expect((await editor(page)).point).toEqual(anchor);
    expect(await holdAndRead(page, 'X', -1)).toBe(FORBIDDEN);
    expect((await editor(page)).point).toEqual(anchor);
    // Підтвердити точку на початку не можна.
    await expect(shown(page, 'confirm-point')).toBeDisabled();
    await pull(page, 'Y', 1, 400);
    const up: P3 = (await editor(page)).point;
    expect(up.y).toBeGreaterThan(anchor.y + 0.02);
    expect(up.x).toBe(anchor.x);
    expect(up.z).toBe(anchor.z);
    // Повернути на початок і спробувати Z (90° до підйому) — можна.
    await pull(page, 'Y', -1, 1500);
    expect((await editor(page)).point).toEqual(anchor);
    await page.waitForTimeout(500);
    await pull(page, 'Z', 1, 400);
    expect((await editor(page)).point.z).toBeGreaterThan(anchor.z + 0.02);
  });

  test('«Видалити останню точку» після «діагональ → прямо»: напрямок попереднього відрізка — знову діагональ (X− і Z− заборонені, Y± у 45° — неактивні)', async ({
    page,
  }) => {
    await startPull(page, { x: -1.2, y: 0, z: -0.6 });
    await pull(page, 'X', 1, 400);
    await choose45(page, 'z-plus');
    await confirm(page);
    await pull(page, 'X', 1, 400);
    await confirm(page);
    expect((await state(page)).routes.building.nodes).toHaveLength(3);
    await page.getByTestId('route-remove-last').click();
    const e = await editor(page);
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    const anchor: P3 = e.segment.anchor;
    expect(await holdAndRead(page, 'X', -1)).toBe(FORBIDDEN);
    expect(await holdAndRead(page, 'Z', -1)).toBe(FORBIDDEN);
    expect((await editor(page)).point).toEqual(anchor);
    await pull(page, 'X', 1, 400);
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-z-plus')).toBeEnabled();
    await expect(shown(page, 'segment-45-z-minus')).toBeEnabled();
    await expect(shown(page, 'segment-45-y-plus')).toBeDisabled();
    await expect(shown(page, 'segment-45-y-minus')).toBeDisabled();
  });

  test('точка одразу над редактором: відкрили вибір 45° (панель вища) — точку не закрито, камера лише зсунулась', async ({ page }) => {
    await startPull(page);
    await pull(page, 'X', 1, 400);
    const point: P3 = (await editor(page)).point;
    // Ставимо точку на 12 px вище верхнього краю редактора (камера повертається «головою» — так робить і програма).
    const top = (await shown(page, 'point-editor').boundingBox())!;
    const vp = page.viewportSize()!;
    const at = { x: top.x + top.width + 30 < vp.width ? top.x + top.width + 30 : vp.width / 2, y: top.y - 12 };
    if (top.y < vp.height / 2) at.y = vp.height / 2; // редактор збоку (iPhone горизонтально) — середина екрана
    await page.evaluate(([p, a]) => window.__trasa!.viewer.centerOn(p!, a!), [point, at] as const);
    await frames(page);
    const before = await camera(page);
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-picker')).toBeVisible();
    await frames(page);
    const v = await visibility(page, point);
    expect(v.ok, `точку закрито після відкриття вибору 45° (${JSON.stringify(v.s)})`).toBe(true);
    const after = await camera(page);
    expect(dotDir(after.dir, before.dir)).toBeGreaterThan(0.99999);
    expect(Math.abs(after.distance - before.distance)).toBeLessThan(1e-6);
  });

  test('«Орто», вид згори: діагональ X+Z+ на екрані рівно під 45° (зміщення в пікселях однакові)', async ({ page }) => {
    await startPull(page);
    await page.getByTestId('view-ortho').click();
    await page.getByTestId('view-y').click();
    await frames(page);
    await pull(page, 'X', 1, 1200);
    await choose45(page, 'z-plus');
    await frames(page);
    const e = await editor(page);
    const a = await project(page, e.segment.anchor);
    const p = await project(page, e.point);
    expect(Math.abs(p.x - a.x)).toBeGreaterThan(5);
    expect(Math.abs(Math.abs(p.x - a.x) - Math.abs(p.y - a.y))).toBeLessThan(0.5);
  });

  // Була помилка програми (UX): у режимі 45° джойстик рахував хід лише за стрілкою ОСНОВНОЇ осі, а не за напрямком
  // діагоналі на екрані. Виправлено: джойстик веде вздовж діагоналі, біля точки — одна стрілка «45°».
  test('на діагоналі джойстик у бік діагоналі на екрані веде точку не повільніше, ніж по осі (≥ 50 %)', async ({ page }) => {
    // Камера з кута +X+Z: стрілки X+ і Z+ на екрані — під тупим кутом.
    await startPull(page, { x: -1.2, y: 0, z: -0.8 }, { x: 6, y: 4, z: 6 }, { x: 0, y: 0.6, z: 0 });
    const s0: P3 = (await editor(page)).point;
    await pull(page, 'X', 1, 500);
    const s1: P3 = (await editor(page)).point;
    const axisTravel = Math.abs(s1.x - s0.x);
    expect(axisTravel).toBeGreaterThan(0.03);
    await choose45(page, 'z-plus');
    const e0 = await editor(page);
    const a = await project(page, e0.point);
    const b = await project(page, { x: e0.point.x + 0.3, y: e0.point.y, z: e0.point.z + 0.3 });
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    await hold(page, 'stick-xz', (0.9 * (b.x - a.x)) / l, (0.9 * (b.y - a.y)) / l, 500);
    const e1 = await editor(page);
    const diagTravel = Math.hypot(e1.point.x - e0.point.x, e1.point.y - e0.point.y, e1.point.z - e0.point.z);
    expect(Math.abs(offset(e1.segment.anchor, e1.point).x - offset(e1.segment.anchor, e1.point).z)).toBeLessThan(TOL_M);
    expect(e1.point.x, 'точка пішла назад').toBeGreaterThanOrEqual(e0.point.x);
    expect(diagTravel / axisTravel, `по діагоналі ${(diagTravel * 1000).toFixed(1)} мм, по осі ${(axisTravel * 1000).toFixed(1)} мм за той самий час`).toBeGreaterThan(0.5);
  });

  test('на діагоналі X+Z+ біля точки — одна стрілка «45°» уздовж діагоналі; джойстик у її бік веде вперед, у бік блідої Z+ — не назад', async ({
    page,
  }) => {
    await startPull(page, { x: -1.2, y: 0, z: -0.8 }, { x: 6, y: 4, z: 6 }, { x: 0, y: 0.6, z: 0 });
    await pull(page, 'X', 1, 500);
    await choose45(page, 'z-plus');
    await frames(page, 2);
    const e0 = await editor(page);
    // Сценарій: стрілки X+ і Z+ на екрані під тупим кутом (камера з кута +X+Z).
    const dz = await screenDir(page, 'Z');
    const dx = await screenDir(page, 'X');
    expect(dx.x * dz.x + dx.y * dz.y, 'стрілки X+ і Z+ мали бути під тупим кутом').toBeLessThan(-0.3);
    // Напрямок діагоналі на екрані: від точки до точки +0,3 м по X і по Z.
    const a = await project(page, e0.point);
    const b = await project(page, { x: e0.point.x + 0.3, y: e0.point.y, z: e0.point.z + 0.3 });
    const dl = Math.hypot(b.x - a.x, b.y - a.y);
    const diag = { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl };
    // Стрілка «45°» видна й показує саме туди; стрілки осей бліді; лінія на джойстику — так само.
    const arrow = await page.getByTestId('axis-arrow-45').evaluate((g) => {
      const l = g.querySelector('line')!;
      const n = (k: string) => Number(l.getAttribute(k));
      return { display: (g as SVGGElement).style.display, x: n('x2') - n('x1'), y: n('y2') - n('y1') };
    });
    expect(arrow.display).toBe('');
    const al = Math.hypot(arrow.x, arrow.y);
    expect((arrow.x / al) * diag.x + (arrow.y / al) * diag.y, 'стрілка «45°» не вздовж діагоналі').toBeGreaterThan(0.999);
    for (const name of ['x', 'z']) {
      await expect(page.locator(`.axis-arrow--${name}`)).toHaveClass(/axis-arrow--dim/);
    }
    const guide = await stickDir(page, 'X');
    expect(guide.x * diag.x + guide.y * diag.y, 'лінія на джойстику не вздовж діагоналі').toBeGreaterThan(0.999);
    // Джойстик у бік стрілки «45°» — точка вперед по діагоналі (X і Z ростуть однаково).
    await hold(page, 'stick-xz', 0.9 * diag.x, 0.9 * diag.y, 500);
    const e1 = await editor(page);
    expect(e1.point.z - e0.point.z, 'Z мала збільшитись').toBeGreaterThan(0.02);
    expect(Math.abs(offset(e1.segment.anchor, e1.point).x - offset(e1.segment.anchor, e1.point).z)).toBeLessThan(TOL_M);
    // У бік блідої стрілки Z+ — точка точно не йде назад.
    await hold(page, 'stick-xz', 0.9 * dz.x, 0.9 * dz.y, 500);
    const e2 = await editor(page);
    expect(e2.point.z, 'у бік стрілки Z+ точка пішла назад').toBeGreaterThanOrEqual(e1.point.z);
  });
});

// ───────────────────────── Ортогональна проекція ─────────────────────────

test.describe('Етап 4.1 (tester): ортогональна проекція в різних станах', () => {
  test('порожня сцена без скану: «Орто» вмикається, розмір того, що в центрі (ціль камери), ±2 %; назад — так само', async ({ page }) => {
    await openApp(page);
    const cam = await camera(page);
    // Відрізок 1 м поперек погляду через ціль камери.
    const right = { x: -cam.dir.z, y: 0, z: cam.dir.x };
    const rl = Math.hypot(right.x, right.z);
    const seg: [P3, P3] = [
      { x: cam.target.x - (0.5 * right.x) / rl, y: cam.target.y, z: cam.target.z - (0.5 * right.z) / rl },
      { x: cam.target.x + (0.5 * right.x) / rl, y: cam.target.y, z: cam.target.z + (0.5 * right.z) / rl },
    ];
    const before = await screenLength(page, ...seg);
    await page.getByTestId('view-ortho').click();
    await frames(page);
    expect(await page.evaluate(() => window.__trasa!.viewer.projection)).toBe('ortho');
    expect((await state(page)).projection).toBe('ortho');
    await expect(page.getByTestId('view-ortho')).toHaveAttribute('aria-pressed', 'true');
    expect(Math.abs((await screenLength(page, ...seg)) / before - 1)).toBeLessThan(0.02);
    const c = await camera(page);
    expect(dotDir(c.dir, cam.dir)).toBeGreaterThan(0.999999);
    // Сітка підлоги: однакові клітинки на різній відстані — однакові на екрані.
    const near = await screenLength(page, { x: -1, y: 0, z: 3 }, { x: 1, y: 0, z: 3 });
    const far = await screenLength(page, { x: -1, y: 0, z: -3 }, { x: 1, y: 0, z: -3 });
    expect(Math.abs(near - far)).toBeLessThan(0.5);
    // «Показати все» без скану — стартовий вигляд, проекція лишається.
    await page.getByTestId('show-all').click({ trial: false }).catch(() => undefined);
    await frames(page);
    expect((await state(page)).projection).toBe('ortho');
    await page.getByTestId('view-ortho').click();
    await frames(page);
    expect(Math.abs((await screenLength(page, ...seg)) / before - 1)).toBeLessThan(0.02);
  });

  test('зміна розміру вікна (поворот пристрою) в «Орто»: пропорції правильні (1 м по X = 1 м по Y), масштаб змінюється так само, як із перспективою', async ({
    page,
  }) => {
    const vp = page.viewportSize()!;
    const ratios: Record<string, number> = {};
    for (const projection of ['perspective', 'ortho'] as const) {
      await page.setViewportSize(vp);
      await openRoom(page, { x: 0, y: 1.35, z: 7 }, { x: 0, y: 1.35, z: 0 });
      if (projection === 'ortho') {
        await page.getByTestId('view-ortho').click();
        await frames(page);
      }
      const seg: [P3, P3] = [{ x: -0.5, y: 1.35, z: 0 }, { x: 0.5, y: 1.35, z: 0 }];
      const before = await screenLength(page, ...seg);
      await page.setViewportSize({ width: vp.height, height: vp.width });
      await page.waitForTimeout(300);
      await frames(page, 5);
      const after = await screenLength(page, ...seg);
      ratios[projection] = after / before;
      if (projection === 'ortho') {
        const vertical = await screenLength(page, { x: 0, y: 0.85, z: 0 }, { x: 0, y: 1.85, z: 0 });
        expect(Math.abs(vertical - after), 'по вертикалі й по горизонталі 1 м — різна довжина на екрані').toBeLessThan(0.5);
        // Однакові відрізки на різній глибині — однакові.
        const deep = await screenLength(page, { x: -0.5, y: 1.35, z: -1.4 }, { x: 0.5, y: 1.35, z: -1.4 });
        expect(Math.abs(deep - after)).toBeLessThan(0.5);
        expect((await state(page)).projection).toBe('ortho');
      }
    }
    expect(Math.abs(ratios.ortho! / ratios.perspective! - 1)).toBeLessThan(0.02);
  });

  test('відкриття іншого скану в «Орто»: проекція лишається (стан, кнопка, камера), скан у кадрі, рулетка міряє 1500 мм', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('view-ortho').click();
    await frames(page);
    await page.getByTestId('file-input').setInputFiles(ROOM_GLB);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready' && window.__trasa?.app?.state.scanName?.endsWith('.glb'));
    await frames(page, 5);
    expect((await state(page)).projection).toBe('ortho');
    expect(await page.evaluate(() => window.__trasa!.viewer.projection)).toBe('ortho');
    await expect(page.getByTestId('view-ortho')).toHaveAttribute('aria-pressed', 'true');
    const vp = page.viewportSize()!;
    for (const x of [-2, 2]) {
      for (const y of [0, 2.7]) {
        for (const z of [-1.5, 1.5]) {
          const p = await project(page, { x, y, z });
          expect(p.x > 0 && p.x < vp.width && p.y > 0 && p.y < vp.height, `кут ${x};${y};${z}`).toBe(true);
        }
      }
    }
    // Без перспективи: паралельні ребра кімнати на екрані — однакові вектори.
    const e1 = [await project(page, { x: -2, y: 0, z: 1.5 }), await project(page, { x: 2, y: 0, z: 1.5 })];
    const e2 = [await project(page, { x: -2, y: 2.7, z: -1.5 }), await project(page, { x: 2, y: 2.7, z: -1.5 })];
    expect(Math.abs(e1[1]!.x - e1[0]!.x - (e2[1]!.x - e2[0]!.x))).toBeLessThan(0.5);
    expect(Math.abs(e1[1]!.y - e1[0]!.y - (e2[1]!.y - e2[0]!.y))).toBeLessThan(0.5);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.2, y: 5, z: 6.5 }, { x: 0, y: 0.5, z: 0 }));
    await frames(page);
    await page.getByTestId('ruler').click();
    for (const p of [{ x: -0.9, y: 0, z: 0.3 }, { x: 0.6, y: 0, z: 0.3 }]) {
      const s = await project(page, p);
      await page.mouse.click(s.x, s.y);
      await confirm(page);
    }
    expect(Math.abs((await state(page)).ruler.distanceMm - 1500)).toBeLessThan(8);
  });

  test('«Орто» вмикають і вимикають 6 разів під час доведення точки: точка й її розмір на екрані не «пливуть» (±2 %)', async ({ page }) => {
    await startPull(page);
    await pull(page, 'Y', 1, 1500);
    const point: P3 = (await editor(page)).point;
    expect(point.y).toBeGreaterThan(0.2);
    const cam = await camera(page);
    const rl = Math.hypot(cam.dir.x, cam.dir.z);
    const right = { x: -cam.dir.z / rl, y: 0, z: cam.dir.x / rl };
    const ends: [P3, P3] = [
      { x: point.x - right.x * 0.1, y: point.y, z: point.z - right.z * 0.1 },
      { x: point.x + right.x * 0.1, y: point.y, z: point.z + right.z * 0.1 },
    ];
    const first = { len: await screenLength(page, ...ends), at: await project(page, point) };
    for (let i = 0; i < 6; i++) {
      await page.getByTestId('view-ortho').click();
      await frames(page);
      const now = { len: await screenLength(page, ...ends), at: await project(page, point) };
      expect(Math.abs(now.len / first.len - 1), `перемикання ${i + 1}`).toBeLessThan(0.02);
      expect(Math.hypot(now.at.x - first.at.x, now.at.y - first.at.y), `перемикання ${i + 1}`).toBeLessThan(2);
    }
    expect((await state(page)).projection).toBe('perspective');
    expect((await editor(page)).point).toEqual(point);
  });

  test('«Орто», вид згори: дотик по діагональній трубі вибирає діагональний відрізок', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, [{ ...ZIGZAG, duct: { section: { shape: 'round', diameterMm: 250 }, transitions: [] } }]);
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
    await page.getByTestId('view-ortho').click();
    await page.getByTestId('view-y').click();
    await frames(page);
    const mid = { x: 0, y: 1.5, z: -0.3 };
    // Точка труби має бути у вільній від панелей частині: шукаємо вільне місце й зсуваємо туди камеру.
    const free = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.viewport');
      for (let y = window.innerHeight * 0.9; y > window.innerHeight * 0.1; y -= 20) {
        for (let x = window.innerWidth * 0.2; x < window.innerWidth * 0.8; x += 20) {
          const ok = [-30, 0, 30].every((dx) => [-30, 0, 30].every((dy) => document.elementFromPoint(x + dx, y + dy) === canvas));
          if (ok) return { x, y };
        }
      }
      return null;
    });
    expect(free).not.toBeNull();
    await page.evaluate(([p, at]) => window.__trasa!.viewer.centerOn(p!, at!), [mid, free!] as const);
    await frames(page);
    const s = await project(page, mid);
    await page.mouse.click(Math.round(s.x), Math.round(s.y));
    expect((await state(page)).ducts.selection).toEqual({ routeId: 1, segment: 1 });
    await expect(page.getByTestId('duct-segment-1')).toHaveAttribute('aria-pressed', 'true');
  });
});

// ───────────────────────── Повітропровід на 45° ─────────────────────────

test.describe('Етап 4.1 (tester): повітропровід на поворотах 45°', () => {
  test('підйом під 45° (X → X+Y+ → X) Ø200: габарит 3D рівно траса ± 100 мм (±0,5 мм); у панелі «45° X+ Y+»', async ({ page }) => {
    await openRoom(page);
    await loadRoutes(page, [
      {
        id: 1,
        nodes: [
          { x: -1500, y: 600, z: -900 },
          { x: -300, y: 600, z: -900 },
          { x: 700, y: 1600, z: -900 },
          { x: 1700, y: 1600, z: -900 },
        ],
        duct: { section: { shape: 'round', diameterMm: 200 }, transitions: [] },
      },
    ]);
    const box = (await page.evaluate(() => window.__trasa!.app!.ductBox(1)))!;
    const want = { min: { x: -1500, y: 500, z: -1000 }, max: { x: 1700, y: 1700, z: -800 } };
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(box.min[k] - want.min[k]), `min.${k} = ${box.min[k]}`).toBeLessThan(0.5);
      expect(Math.abs(box.max[k] - want.max[k]), `max.${k} = ${box.max[k]}`).toBeLessThan(0.5);
    }
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('duct-segment-1')).toContainText('45° X+ Y+');
    await expect(page.getByTestId('duct-segment-1')).toContainText('1 414,2');
    expect((await state(page)).ducts.routes[0].problems).toEqual([]);
  });

  test('перебудови й пам’ять: вибір відрізка, режими, «Орто» не перебудовують трубу; трикутників рівно стільки, скільки деталей; видалення — 0', async ({
    page,
  }) => {
    await openRoom(page);
    await loadRoutes(page, [{ ...ZIGZAG, duct: { section: { shape: 'round', diameterMm: 250 }, transitions: [] } }]);
    const d0 = (await state(page)).ducts;
    // 4 прямі × 64 + 3 коліна 45° × 3 сегменти × 64 + 2 торці × 32.
    expect(d0.triangles).toBe(4 * 64 + 3 * 3 * 64 + 2 * 32);
    const builds = d0.builds;
    await page.getByTestId('duct').click();
    await page.getByTestId('duct-segment-1').click();
    await page.getByTestId('duct-segment-2').click();
    await page.getByTestId('view-mode-duct').click();
    await page.getByTestId('view-mode-both').click();
    await page.getByTestId('view-ortho').click();
    await page.getByTestId('view-ortho').click();
    await page.getByTestId('duct-close').click();
    await frames(page);
    const d1 = (await state(page)).ducts;
    expect(d1.builds, 'труба перебудовувалась без змін').toBe(builds);
    expect(d1.triangles).toBe(d0.triangles);
    expect(d1.meshes).toBe(1);
    await page.getByTestId('duct').click();
    await page.getByTestId('duct-diameter').selectOption('315');
    await frames(page);
    const d2 = (await state(page)).ducts;
    expect(d2.builds).toBe(builds + 1);
    expect(d2.triangles).toBe(d0.triangles);
    await page.getByTestId('duct-close').click();
    await page.getByTestId('route-delete').click();
    await page.getByTestId('route-list').getByRole('button').first().click();
    await page.getByTestId('route-delete-confirm').click();
    await frames(page);
    const d3 = (await state(page)).ducts;
    expect(d3.triangles).toBe(0);
    expect(d3.meshes).toBe(0);
  });
});
