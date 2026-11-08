/**
 * Етап 0 — додаткові перевірки тестувальника (чорна скринька, зібрана версія як на GitHub Pages):
 * адреса /duct-route-3d/, приватність (нічого не вантажиться ззовні), PWA-іконки, тема, жести,
 * поведінка без WebGL.
 */
import { expect, type Page, test } from '@playwright/test';

const BASE_PATH = '/duct-route-3d/';

interface Point {
  x: number;
  y: number;
}
type AxesOnScreen = Record<'origin' | 'X' | 'Y' | 'Z', Point>;

async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return errors;
}

const projectAxes = (page: Page) => page.evaluate(() => window.__trasa!.viewer.projectAxes()) as Promise<AxesOnScreen>;
const frameCount = (page: Page) => page.evaluate(() => window.__trasa!.viewer.frameCount);

/** Дочекатися, поки сцена перестане перемальовуватись (інерція камери згасла). */
async function waitForIdle(page: Page, timeout = 5_000): Promise<void> {
  const start = Date.now();
  let last = await frameCount(page);
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(300);
    const now = await frameCount(page);
    if (now === last) return;
    last = now;
  }
  throw new Error(`сцена не заспокоїлась за ${timeout} мс (кадрів: ${last})`);
}

/** Найчастіший колір у квадраті навколо точки (тобто фон, а не тонкі лінії). */
async function dominantColor(page: Page, around: Point, half = 20): Promise<[number, number, number]> {
  const png = await page.screenshot({ scale: 'css' });
  return page.evaluate(
    async ({ base64, around, half }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(Math.round(around.x - half), Math.round(around.y - half), half * 2, half * 2);
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      return best.split(',').map(Number) as [number, number, number];
    },
    { base64: png.toString('base64'), around, half },
  );
}

const near = (actual: number[], expected: number[], tol = 8) =>
  actual.every((v, i) => Math.abs(v - (expected[i] ?? 0)) <= tol);

test.describe('Етап 0: зібрана версія під адресою GitHub Pages', () => {
  test('усі файли беруться з /duct-route-3d/ на тому ж сервері; жодних помилок 404', async ({ page }) => {
    const requests: string[] = [];
    const failed: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('requestfailed', (request) => failed.push(`${request.url()} — ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) failed.push(`${response.url()} — HTTP ${response.status()}`);
    });
    await openApp(page);
    // Іконки й manifest браузер може не запитати сам — запитаємо їх явно, як Safari при «На початковий екран».
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>('link[href], script[src]')].map((el) =>
        el instanceof HTMLLinkElement ? el.getAttribute('href')! : el.getAttribute('src')!,
      ),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      // Абсолютні шляхи без /duct-route-3d/ на GitHub Pages ведуть на чужий сайт (404).
      expect(href.startsWith(BASE_PATH) || !href.startsWith('/'), href).toBe(true);
      const response = await page.request.get(new URL(href, page.url()).href);
      expect(response.ok(), href).toBe(true);
    }

    const origin = new URL(page.url()).origin;
    for (const url of requests) {
      if (url.startsWith('data:') || url.startsWith('blob:')) continue;
      const parsed = new URL(url);
      // Деякі браузери самі питають /favicon.ico з кореня — це не запит додатка.
      if (parsed.origin === origin && parsed.pathname === '/favicon.ico') continue;
      // Приватність: додаток нічого не вантажить і не відправляє на сторонні сервери.
      expect(parsed.origin, url).toBe(origin);
      expect(parsed.pathname.startsWith(BASE_PATH), url).toBe(true);
    }
    expect(failed).toEqual([]);
  });
});

test.describe('Етап 0: PWA — іконки й ідентичність додатка', () => {
  test('розміри іконок у manifest відповідають справжнім розмірам PNG', async ({ page }) => {
    await openApp(page);
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifestUrl = new URL(href!, page.url());
    const manifest = (await (await page.request.get(manifestUrl.href)).json()) as {
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    for (const icon of manifest.icons) {
      if (icon.sizes === 'any') continue;
      const [w, h] = icon.sizes.split('x').map(Number);
      const url = new URL(icon.src, manifestUrl).href;
      const size = await page.evaluate(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return { w: image.naturalWidth, h: image.naturalHeight };
      }, url);
      expect(size, icon.src).toEqual({ w, h });
    }
  });

  test('apple-touch-icon непрозорий (iOS заливає прозорі кути чорним)', async ({ page }) => {
    await openApp(page);
    const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    const alphas = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let min = 255;
      for (let i = 3; i < data.length; i += 4) min = Math.min(min, data[i]!);
      return min;
    }, new URL(href!, page.url()).href);
    expect(alphas).toBe(255);
  });

  test('ідентифікатор додатка (manifest id) лежить у межах /duct-route-3d/, а не всього домену github.io', async ({
    page,
  }) => {
    await openApp(page);
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifestUrl = new URL(href!, page.url());
    const manifest = (await (await page.request.get(manifestUrl.href)).json()) as {
      id?: string;
      start_url: string;
    };
    const startUrl = new URL(manifest.start_url, manifestUrl);
    // За специфікацією Web App Manifest id розбирається відносно ORIGIN start_url (не відносно файлу manifest).
    const id = manifest.id === undefined ? startUrl : new URL(manifest.id, startUrl.origin);
    expect(id.pathname.startsWith(BASE_PATH), `id = ${id.href}`).toBe(true);
  });

  test('панель Safari: колір рядка стану (theme-color) є і для світлої, і для темної теми', async ({ page }) => {
    await openApp(page);
    const metas = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((els) => els.map((el) => ({ media: el.getAttribute('media'), content: el.getAttribute('content') })));
    expect(metas.some((m) => m.media?.includes('light') && m.content)).toBe(true);
    expect(metas.some((m) => m.media?.includes('dark') && m.content)).toBe(true);
  });
});

test.describe('Етап 0: сцена — поведінка', () => {
  test('полотно чітке: буфер малювання не менший за розмір на екрані', async ({ page }) => {
    await openApp(page);
    const info = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.viewport')!;
      return {
        w: canvas.width,
        h: canvas.height,
        cw: canvas.clientWidth,
        ch: canvas.clientHeight,
        dpr: window.devicePixelRatio,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    // Сцена на весь екран.
    expect(Math.abs(info.cw - info.vw)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.ch - info.vh)).toBeLessThanOrEqual(1);
    expect(info.w).toBeGreaterThanOrEqual(info.cw);
    expect(info.h).toBeGreaterThanOrEqual(info.ch);
    expect(info.w).toBeLessThanOrEqual(Math.ceil(info.cw * info.dpr) + 1);
  });

  test('жести належать сцені: touch-action: none на полотні (без прокрутки й зуму сторінки)', async ({ page }) => {
    await openApp(page);
    const touchAction = await page.locator('canvas.viewport').evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe('none');
  });

  test('короткий клік по сцені не зсуває камеру', async ({ page }) => {
    await openApp(page);
    const before = await projectAxes(page);
    const box = (await page.locator('canvas.viewport').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.waitForTimeout(400);
    const after = await projectAxes(page);
    for (const key of ['origin', 'X', 'Y', 'Z'] as const) {
      expect(Math.abs(after[key].x - before[key].x), key).toBeLessThan(0.5);
      expect(Math.abs(after[key].y - before[key].y), key).toBeLessThan(0.5);
    }
  });

  test('нахил камери (тягнути вгору/вниз): Y лишається вертикаллю й дивиться вгору', async ({ page }) => {
    await openApp(page);
    const box = (await page.locator('canvas.viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const dy of [box.height * 0.08, -box.height * 0.08]) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy + dy, { steps: 8 });
      await page.mouse.up();
      await waitForIdle(page);
      const axes = await projectAxes(page);
      expect(axes.Y.y).toBeLessThan(axes.origin.y - 8);
      expect(Math.abs(axes.Y.x - axes.origin.x)).toBeLessThan(1);
    }
  });

  test('після обертання інерція згасає й сцена перестає перемальовуватись', async ({ page }) => {
    await openApp(page);
    const box = (await page.locator('canvas.viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 0.3, cy, { steps: 4 }); // швидкий «кидок»
    await page.mouse.up();
    // Інерція згасає за кадрами; у CI (WebKit без відеокарти) ≈ 10 кадрів/с — даємо більше часу.
    // На iPad/iPhone (60–120 кадрів/с) це частки секунди.
    await waitForIdle(page, 10_000);
    const frames = await frameCount(page);
    await page.waitForTimeout(1_000);
    expect(await frameCount(page)).toBe(frames);
  });

  test('обертання одним пальцем (дотик)', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'дотик імітується через CDP — тільки в Chromium');
    test.skip(!testInfo.project.use.hasTouch, 'профіль без сенсорного екрана');
    await openApp(page);
    const before = await projectAxes(page);
    const box = (await page.locator('canvas.viewport').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx + (box.width * 0.25 * i) / 10, y: cy, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitForIdle(page);
    const after = await projectAxes(page);
    expect(Math.abs(after.X.x - before.X.x) + Math.abs(after.Z.x - before.Z.x)).toBeGreaterThan(20);
    expect(after.Y.y).toBeLessThan(after.origin.y - 8);
    expect(Math.abs(after.Y.x - after.origin.x)).toBeLessThan(1);
  });

  test('перемикання світлої/темної теми на ходу: фон змінюється, кадр перемальовано', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openApp(page);
    await waitForIdle(page);
    const axes = await projectAxes(page);
    const probe = { x: axes.origin.x + 70, y: axes.Y.y };
    const light = await dominantColor(page, probe);
    expect(near(light, [242, 242, 247]), `світлий фон: ${light}`).toBe(true);

    const frames = await frameCount(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction((f) => window.__trasa!.viewer.frameCount > f, frames, { timeout: 5_000 });
    const dark = await dominantColor(page, probe);
    expect(near(dark, [0, 0, 0]), `темний фон: ${dark}`).toBe(true);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    expect(near(await dominantColor(page, probe), [242, 242, 247])).toBe(true);
  });

  test('dispose(): полотно прибрано, кадри більше не малюються', async ({ page }) => {
    await openApp(page);
    const result = await page.evaluate(async () => {
      const viewer = window.__trasa!.viewer;
      viewer.dispose();
      const frames = viewer.frameCount;
      viewer.requestRender();
      await new Promise((r) => setTimeout(r, 300));
      return {
        canvasInDom: !!document.querySelector('canvas.viewport'),
        framesBefore: frames,
        framesAfter: viewer.frameCount,
      };
    });
    expect(result.canvasInDom).toBe(false);
    expect(result.framesAfter).toBe(result.framesBefore);
  });
});

test.describe('Етап 0: якщо 3D не запускається', () => {
  test('без WebGL — зрозуміле повідомлення українською, без «білого екрана» і без збою скрипта', async ({ page }) => {
    await page.addInitScript(() => {
      // Підміна для тесту: WebGL недоступний (старий пристрій, вимкнено в налаштуваннях).
      type GetContext = (this: HTMLCanvasElement, type: string, ...rest: unknown[]) => unknown;
      const proto = HTMLCanvasElement.prototype as unknown as { getContext: GetContext };
      const original = proto.getContext;
      proto.getContext = function (type, ...rest) {
        if (/webgl/i.test(type)) return null;
        return original.call(this, type, ...rest);
      };
    });
    const uncaught: string[] = [];
    page.on('pageerror', (error) => uncaught.push(error.message));
    await page.goto('./');
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Не вдалося запустити 3D-сцену');
    await expect(page.getByTestId('version')).toBeVisible();
    expect(uncaught).toEqual([]);
  });
});
