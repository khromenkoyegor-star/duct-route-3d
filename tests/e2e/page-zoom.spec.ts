/**
 * Етап 4.1: масштаб сторінки Safari не має змінюватись (помилка з фото Єгора: сторінка збільшилась
 * у 1,6 раза — джойстик більший, панелі не вміщаються), і камера їде за точкою, яку тягнуть.
 *
 * Справжній «щипок» сторінки емуляція не вміє, тож перевіряємо захист: touch-action на елементах
 * і те, що програма відхиляє жести збільшення (preventDefault).
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };

async function startPull(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
  await page.getByTestId('route').click();
  const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await page.getByTestId('confirm-point').click();
  await expect(page.getByTestId('point-editor')).toBeVisible();
}

/** Подія дотику з потрібною кількістю пальців (працює в будь-якому рушії, без конструктора TouchEvent). */
const dispatchTouch = (page: Page, selector: string, type: string, fingers: number, at = { x: 100, y: 100 }) =>
  page.evaluate(
    ({ selector, type, fingers, at }) => {
      const target = document.querySelector(selector)!;
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: at.x, clientY: at.y, identifier: 1, target };
      Object.defineProperty(event, 'touches', { value: Array.from({ length: fingers }, () => touch) });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { selector, type, fingers, at },
  );

test.describe('Масштаб сторінки', () => {
  test('жести не дістаються Safari: touch-action на всіх елементах програми — none або лише прокрутка', async ({ page }) => {
    await startPull(page);
    const actions = await page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const el of document.querySelectorAll('#app, #app *')) {
        if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
        const value = getComputedStyle(el).touchAction;
        out[value] = (out[value] ?? 0) + 1;
      }
      return out;
    });
    expect(Object.keys(actions).sort()).toEqual(expect.arrayContaining(['none']));
    for (const value of Object.keys(actions)) expect(['none', 'pan-y'], `touch-action: ${value}`).toContain(value);
    // Саме ті місця, де був другий палець: панель редактора, її текст, кнопка, панель траси.
    for (const testid of ['point-editor', 'point-coords', 'confirm-point', 'stick-xz', 'stick-y']) {
      expect(await page.getByTestId(testid).evaluate((el) => getComputedStyle(el).touchAction), testid).toBe('none');
    }
    expect(await page.locator('canvas.viewport').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  });

  test('два пальці (один на джойстику, другий на панелі чи сцені) — жест відхилено; один палець — ні', async ({ page }) => {
    await startPull(page);
    for (const selector of ['[data-testid="point-editor"]', '[data-testid="point-coords"]', '[data-testid="route-panel"]', 'canvas.viewport']) {
      expect(await dispatchTouch(page, selector, 'touchstart', 2), `${selector} touchstart`).toBe(true);
      expect(await dispatchTouch(page, selector, 'touchmove', 2), `${selector} touchmove`).toBe(true);
    }
    // Кнопку можна натиснути другим пальцем (поки перший тримає джойстик): саме натискання не відхиляємо,
    // а рух двома пальцями («щипок») по кнопці — відхиляємо.
    for (const testid of ['confirm-point', 'segment-45', 'route-finish']) {
      const selector = `[data-testid="${testid}"]`;
      expect(await dispatchTouch(page, selector, 'touchstart', 2), `${selector} touchstart`).toBe(false);
      expect(await dispatchTouch(page, selector, 'touchmove', 2), `${selector} touchmove`).toBe(true);
    }
    // Один палець програма не чіпає (кнопки, прокрутка списків).
    expect(await dispatchTouch(page, '[data-testid="route-panel"]', 'touchstart', 1)).toBe(false);
    expect(await dispatchTouch(page, '[data-testid="route-panel"]', 'touchmove', 1)).toBe(false);
    // Жести Safari (gesture*) — теж відхилено.
    const gesture = await page.evaluate(() => {
      const event = new Event('gesturestart', { bubbles: true, cancelable: true });
      document.querySelector('[data-testid="point-editor"]')!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(gesture).toBe(true);
  });

  test('подвійний дотик по тлу панелі відхилено; на кнопці — це два натискання', async ({ page }) => {
    await startPull(page);
    const tap = (selector: string) => dispatchTouch(page, selector, 'touchend', 0, { x: 60, y: 60 });
    expect(await tap('[data-testid="point-coords"]')).toBe(false);
    expect(await tap('[data-testid="point-coords"]')).toBe(true);
    await page.waitForTimeout(450);
    expect(await tap('[data-testid="confirm-point"]')).toBe(false);
    expect(await tap('[data-testid="confirm-point"]')).toBe(false);
  });

  test('масштаб сторінки 1, плашки «сторінку збільшено» немає', async ({ page }) => {
    await startPull(page);
    const zoom = await page.evaluate(() => ({ scale: window.__trasa!.pageZoom!.scale, zoomed: window.__trasa!.pageZoom!.zoomed }));
    expect(zoom).toEqual({ scale: 1, zoomed: false });
    await expect(page.getByTestId('zoom-banner')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.classList.contains('page-zoomed'))).toBe(false);
  });
});

test.describe('Камера їде за точкою', () => {
  test('точку тягнуть далеко за скан: вона лишається у видимій частині, камера не повертається й не робить ривка', async ({ page }) => {
    test.setTimeout(90_000);
    await startPull(page);
    // Камера ближче — щоб і на великому екрані iPad точка швидко дійшла до краю видимої частини.
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 1.2, y: 2.6, z: 4.6 }, { x: -0.3, y: 0.3, z: 0.3 }));
    const view = () =>
      page.evaluate(() => {
        const v = window.__trasa!.viewer.snapshotView();
        const d = { x: v.position.x - v.target.x, y: v.position.y - v.target.y, z: v.position.z - v.target.z };
        const l = Math.hypot(d.x, d.y, d.z);
        return { dir: { x: d.x / l, y: d.y / l, z: d.z / l }, distance: l, position: { x: v.position.x, y: v.position.y, z: v.position.z } };
      });
    const before = await view();
    const point = (): Promise<P3> => page.evaluate(() => window.__trasa!.app!.state.routes.editor.point!);
    const start = await point();
    const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), start);
    const len = Math.hypot(axes.X.x, axes.X.y);
    const box = (await page.getByTestId('stick-xz').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + (axes.X.x / len) * 64, cy + (axes.X.y / len) * 64, { steps: 3 });
    // Тримаємо, доки точка не відійде на 2,7 м (за стіну) і камера не поїде за нею — не довше 45 с:
    // у CI (WebKit без відеокарти) частота кадрів дуже різна, і хід за той самий час теж.
    const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      await page.waitForTimeout(1000);
      const p = await point();
      const v = await view();
      if (p.x - start.x > 2.7 && Math.hypot(v.position.x - before.position.x, v.position.z - before.position.z) > 0.35) break;
    }
    // Під час утримання: точка далеко за сканом, але на екрані й не під панелями.
    const onScreen = async () => {
      const p = await point();
      const s = await page.evaluate((pt) => window.__trasa!.viewer.projectPoint(pt), p);
      const vp = page.viewportSize()!;
      expect(s.visible).toBe(true);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(vp.width);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(vp.height);
      for (const id of ['point-editor', 'route-panel']) {
        const r = (await page.getByTestId(id).boundingBox())!;
        const inside = s.x > r.x && s.x < r.x + r.width && s.y > r.y && s.y < r.y + r.height;
        expect(inside, `точку закриває ${id}`).toBe(false);
      }
      return p;
    };
    const held = await onScreen();
    // Далеко за скан: початок x = −0,5 м, стіна кімнати — x = 2 м.
    expect(held.x - start.x).toBeGreaterThan(2.6);
    const during = await view();
    await page.mouse.up();
    const released = await view();
    await page.waitForTimeout(400);
    await onScreen();
    const after = await view();
    // Напрямок погляду й відстань до цілі ті самі (паралельний зсув): без повороту й зміни масштабу.
    for (const v of [during, after]) {
      expect(v.dir.x * before.dir.x + v.dir.y * before.dir.y + v.dir.z * before.dir.z).toBeGreaterThan(0.99999);
      expect(v.distance).toBeCloseTo(before.distance, 6);
    }
    // Після відпускання камера не рушила (ривка немає).
    expect(
      Math.hypot(after.position.x - released.position.x, after.position.y - released.position.y, after.position.z - released.position.z),
    ).toBeLessThan(0.02);
    // Камера справді їхала за точкою.
    expect(Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z)).toBeGreaterThan(0.3);
  });
});
