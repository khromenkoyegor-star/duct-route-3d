import { expect, type Page, test } from '@playwright/test';

/** Довжина стрілки Y на екрані (px): від початку координат до підпису Y. */
async function yArrowPx(page: Page): Promise<number> {
  const axes = await page.evaluate(() => window.__trasa!.viewer.projectAxes());
  return axes.origin.y - axes.Y.y;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
}

test('після повороту пристрою масштаб сцени не стрибає', async ({ page, browser }) => {
  await open(page);
  const size = page.viewportSize()!;
  const rotated = { width: size.height, height: size.width };

  // Повертаємо «пристрій»: ширина ↔ висота.
  await page.setViewportSize(rotated);
  await page.waitForFunction(
    ({ w, h }) => {
      const canvas = document.querySelector('canvas.viewport') as HTMLCanvasElement | null;
      return !!canvas && Math.abs(canvas.clientWidth - w) < 2 && Math.abs(canvas.clientHeight - h) < 2;
    },
    { w: rotated.width, h: rotated.height },
  );
  await page.waitForTimeout(200);
  const afterRotation = await yArrowPx(page);

  // Еталон: той самий екран, але додаток одразу відкрито в новій орієнтації.
  const { baseURL } = test.info().project.use;
  const context = await browser.newContext({ viewport: rotated, ...(baseURL ? { baseURL } : {}) });
  const fresh = await context.newPage();
  await open(fresh);
  const openedRotated = await yArrowPx(fresh);
  await context.close();

  expect(afterRotation).toBeGreaterThan(20);
  expect(Math.abs(afterRotation - openedRotated) / openedRotated).toBeLessThan(0.05);
});
