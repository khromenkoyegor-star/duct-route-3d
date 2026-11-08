import { mkdir } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

/** Скріншоти для людини (Єгор, ux-reviewer) — у test-results/screenshots/, у CI — в артефактах. */
const SCREENSHOT_DIR = 'test-results/screenshots';

interface Point {
  x: number;
  y: number;
}
type AxesOnScreen = Record<'origin' | 'X' | 'Y' | 'Z', Point>;

/** Відкрити додаток і дочекатися першого намальованого кадру. Повертає зібрані помилки консолі. */
async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return errors;
}

const projectAxes = (page: Page) => page.evaluate(() => window.__trasa!.viewer.projectAxes()) as Promise<AxesOnScreen>;

/**
 * Скільки пікселів потрібного кольору навколо точки на скріншоті.
 * Скріншот декодуємо в самій сторінці (canvas 2D), щоб не тягнути бібліотеку для PNG.
 */
async function countColoredPixels(
  page: Page,
  png: Buffer,
  around: Point,
  channel: 'red' | 'green' | 'blue',
  radius = 12,
): Promise<number> {
  return page.evaluate(
    async ({ base64, around, channel, radius }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const x0 = Math.max(0, Math.round(around.x - radius));
      const y0 = Math.max(0, Math.round(around.y - radius));
      const { data } = ctx.getImageData(x0, y0, radius * 2, radius * 2);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const hit =
          channel === 'red'
            ? r > 180 && r > g + 80 && r > b + 80
            : channel === 'green'
              ? g > 150 && g > r + 60 && g > b + 30
              : b > 180 && b > r + 80 && b > g + 20;
        if (hit) count++;
      }
      return count;
    },
    { base64: png.toString('base64'), around, channel, radius },
  );
}

test.describe('Етап 0: порожня 3D-сцена', () => {
  test('відкривається без помилок і малює сцену', async ({ page }) => {
    const errors = await openApp(page);
    await expect(page).toHaveTitle('Траса 3D');
    await expect(page.locator('canvas.viewport')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('вісь Y дивиться вгору, X і Z лежать у площині підлоги', async ({ page }) => {
    await openApp(page);
    const axes = await projectAxes(page);
    // Підпис Y — над початком координат і строго на одній вертикалі з ним.
    expect(axes.Y.y).toBeLessThan(axes.origin.y - 40);
    expect(Math.abs(axes.Y.x - axes.origin.x)).toBeLessThan(1);
    // X і Z — нижче за Y (горизонтальні осі).
    expect(axes.X.y).toBeGreaterThan(axes.Y.y);
    expect(axes.Z.y).toBeGreaterThan(axes.Y.y);
  });

  test('на екрані справді намальовані осі: X червона, Y зелена, Z синя', async ({ page }) => {
    await openApp(page);
    const axes = await projectAxes(page);
    const png = await page.screenshot({ scale: 'css' });
    expect(await countColoredPixels(page, png, axes.X, 'red')).toBeGreaterThan(20);
    expect(await countColoredPixels(page, png, axes.Y, 'green')).toBeGreaterThan(20);
    expect(await countColoredPixels(page, png, axes.Z, 'blue')).toBeGreaterThan(20);
  });

  test('сцену можна обертати, і Y лишається вертикаллю', async ({ page }) => {
    await openApp(page);
    const before = await projectAxes(page);
    const box = (await page.locator('canvas.viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 0.2, cy, { steps: 10 });
    await page.mouse.up();
    // Дочекатися, поки інерція (damping) зупиниться.
    await page.waitForTimeout(800);
    const after = await projectAxes(page);
    expect(Math.abs(after.X.x - before.X.x) + Math.abs(after.Z.x - before.Z.x)).toBeGreaterThan(20);
    expect(after.Y.y).toBeLessThan(after.origin.y - 40);
    expect(Math.abs(after.Y.x - after.origin.x)).toBeLessThan(1);
  });

  test('у спокої сцена не перемальовується (економія батареї)', async ({ page }) => {
    await openApp(page);
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => window.__trasa!.viewer.frameCount);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.__trasa!.viewer.frameCount)).toBe(frames);
  });

  test('панелі: назва, версія, масштаб сітки; усе в межах екрана', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('title')).toContainText('Траса 3D');
    await expect(page.getByTestId('version')).toHaveText(/^версія \S+ · \d{2}\.\d{2}\.\d{4}/);
    await expect(page.getByTestId('legend')).toContainText(/Клітинка сітки — 1\s000 мм/);
    await expect(page.getByTestId('legend')).toContainText('Y — вгору');

    const viewport = page.viewportSize()!;
    for (const id of ['title', 'legend']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.y, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(viewport.height);
    }
    // Панелі не перекривають одна одну.
    const title = (await page.getByTestId('title').boundingBox())!;
    const legend = (await page.getByTestId('legend').boundingBox())!;
    expect(title.y + title.height).toBeLessThan(legend.y);
    // Сторінка не прокручується.
    const scroll = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    expect(scroll.w).toBeLessThanOrEqual(viewport.width);
    expect(scroll.h).toBeLessThanOrEqual(viewport.height);
  });
});

test.describe('Етап 0: PWA («На початковий екран»)', () => {
  test('manifest: назва, повноекранний режим, іконки', async ({ page, request }) => {
    await openApp(page);
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const manifestUrl = new URL(href!, page.url());
    const response = await request.get(manifestUrl.href);
    expect(response.ok()).toBe(true);
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    expect(manifest.name).toBe('Траса 3D');
    expect(manifest.short_name).toBe('Траса 3D');
    expect(manifest.display).toBe('standalone');
    // start_url і scope — це саме адреса додатка (з урахуванням /duct-route-3d/).
    expect(new URL(manifest.start_url, manifestUrl).href).toBe(page.url());
    expect(new URL(manifest.scope, manifestUrl).href).toBe(page.url());

    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of manifest.icons) {
      const iconResponse = await request.get(new URL(icon.src, manifestUrl).href);
      expect(iconResponse.ok(), icon.src).toBe(true);
      expect(iconResponse.headers()['content-type'], icon.src).toContain(icon.type);
    }
  });

  test('iOS: apple-touch-icon 180×180, повноекранні meta, viewport-fit=cover', async ({ page }) => {
    await openApp(page);
    const head = page.locator('head');
    await expect(head.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
    await expect(head.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Траса 3D');
    await expect(head.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);

    const iconHref = await head.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    const size = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return { w: image.naturalWidth, h: image.naturalHeight };
    }, iconHref!);
    expect(size).toEqual({ w: 180, h: 180 });
  });
});

test.describe('Скріншоти', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('знімок екрана', async ({ page }, testInfo) => {
        const errors = await openApp(page);
        await page.waitForTimeout(300);
        const safeName = testInfo.project.name.replace(/\s+/g, '-');
        await mkdir(SCREENSHOT_DIR, { recursive: true });
        const path = `${SCREENSHOT_DIR}/${safeName}-${colorScheme}.png`;
        const png = await page.screenshot({ path });
        await testInfo.attach(`${safeName}-${colorScheme}`, { body: png, contentType: 'image/png' });
        expect(errors).toEqual([]);
      });
    });
  }
});
