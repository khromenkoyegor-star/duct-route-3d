/**
 * Етап 1: відкриття скану, «Показати все», інформація про скан, «Рулетка».
 * Тестова кімната 4000 × 2700 × 3000 мм — у вигляді ZIP «як з Polycam» і GLB.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { readZipEntries, extractZipEntry } from '../../src/core/zip.ts';
import { basename } from '../../src/core/scan-files.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const ROOM_ZIP = fixture('room-4000x2700x3000.zip');
const ROOM_GLB = fixture('room-4000x2700x3000.glb');

interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return errors;
}

/** Вибрати файли так, як це робить «Файли» на iPad/iPhone, і дочекатися результату. */
async function chooseFiles(page: Page, files: string | string[] | FilePayload | FilePayload[]): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(files as Parameters<Page['setInputFiles']>[1]);
  await page.waitForFunction(() => window.__trasa?.app?.state.status !== 'loading', undefined, { timeout: 15_000 });
}

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));

/** Камера всередині/перед кімнатою так, щоб обидві бічні стіни було видно зсередини (на будь-якому екрані). */
async function lookIntoRoom(page: Page): Promise<void> {
  // Камера на осі кімнати, трохи згори: обидві бічні стіни видно зсередини, а точки на висоті 1,2 м —
  // у верхній половині кадру, тож панель джойстика їх не закриває (на всіх пристроях).
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 0, y: 1.5, z: 10 }, { x: 0, y: 0, z: 0 }));
  await page.waitForTimeout(100);
}

/** Натиснути «Підтвердити точку». */
async function confirmPoint(page: Page): Promise<void> {
  await page.getByTestId('confirm-point').click();
}

const project = (page: Page, p: { x: number; y: number; z: number }) =>
  page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), p);

test.describe('Етап 1: відкриття скану', () => {
  test('ZIP з Polycam: габарит 4000 × 2700 × 3000 мм, трикутники, розмір файлу', async ({ page }) => {
    const errors = await openApp(page);
    await expect(page.getByTestId('show-all')).toBeEnabled();
    await expect(page.getByTestId('ruler')).toBeDisabled();
    await chooseFiles(page, ROOM_ZIP);

    const s = await state(page);
    expect(s.error).toBeNull();
    expect(s.status).toBe('ready');
    expect(Math.abs(s.scanInfo.sizeMm.x - 4000)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.y - 2700)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.z - 3000)).toBeLessThan(0.1);

    await expect(page.getByTestId('scan-name')).toHaveText('room-4000x2700x3000.zip');
    await expect(page.getByTestId('scan-size')).toHaveText(/^Габарит: X 4\s000 · Y 2\s700 · Z 3\s000 мм$/);
    await expect(page.getByTestId('scan-stats')).toContainText('12 трикутників');
    await expect(page.getByTestId('scan-offset')).toHaveText('Низ скану на Y = 0');
    await expect(page.getByTestId('scan-warnings')).toBeHidden();
    await expect(page.getByTestId('ruler')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('скан не масштабується й не зсувається: межі в сцені = межі у файлі', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    const box = await page.evaluate(() => {
      const b = window.__trasa!.viewer.scanBox()!;
      return { min: b.min.toArray(), max: b.max.toArray() };
    });
    const expected = { min: [-2, 0, -1.5], max: [2, 2.7, 1.5] };
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(box.min[i]! - expected.min[i]!)).toBeLessThan(1e-4);
      expect(Math.abs(box.max[i]! - expected.max[i]!)).toBeLessThan(1e-4);
    }
  });

  test('низ скану стає на Y = 0: підлога на −1 400 мм → піднято на 1 400 мм, габарит той самий', async ({ page }) => {
    const { buildGlb, boxRoom } = await import('../fixtures/gltf-builder.ts');
    const glb = buildGlb({ meshes: [boxRoom([-2, 0, -1.5], [2, 2.7, 1.5])], root: { translation: [0.3, -1.4, -0.2] } });
    await openApp(page);
    await chooseFiles(page, { name: 'polycam-like.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glb) });
    const s = await state(page);
    expect(s.error).toBeNull();
    expect(Math.abs(s.scanInfo.offsetYMm - 1400)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.y - 2700)).toBeLessThan(0.1);
    await expect(page.getByTestId('scan-offset')).toHaveText(/^Низ скану на Y = 0 · скан піднято на 1\s400 мм$/);
    const box = await page.evaluate(() => {
      const b = window.__trasa!.viewer.scanBox()!;
      return { min: b.min.toArray(), max: b.max.toArray() };
    });
    // X і Z — як у файлі; по висоті — від 0.
    const expected = { min: [-1.7, 0, -1.7], max: [2.3, 2.7, 1.3] };
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(box.min[i]! - expected.min[i]!)).toBeLessThan(1e-4);
      expect(Math.abs(box.max[i]! - expected.max[i]!)).toBeLessThan(1e-4);
    }
  });

  test('GLB відкривається так само; новий скан замінює попередній', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    await chooseFiles(page, ROOM_GLB);
    const s = await state(page);
    expect(s.status).toBe('ready');
    expect(s.scanName).toBe('room-4000x2700x3000.glb');
    expect(Math.abs(s.scanInfo.sizeMm.x - 4000)).toBeLessThan(0.1);
    // У сцені рівно один скан (старий прибрано).
    const scans = await page.evaluate(() => {
      const box = window.__trasa!.viewer.scanBox()!;
      return box.max.x - box.min.x;
    });
    expect(Math.abs(scans - 4)).toBeLessThan(1e-4);
  });

  test('кілька файлів замість ZIP (.gltf + .bin + текстура, без папок)', async ({ page }) => {
    await openApp(page);
    const zip = new Uint8Array(await readFile(ROOM_ZIP));
    const files: FilePayload[] = [];
    for (const entry of readZipEntries(zip)) {
      if (entry.isDirectory || entry.name.startsWith('__MACOSX')) continue;
      files.push({
        name: basename(entry.name),
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(await extractZipEntry(zip, entry)),
      });
    }
    await chooseFiles(page, files);
    const s = await state(page);
    expect(s.error).toBeNull();
    expect(Math.abs(s.scanInfo.sizeMm.z - 3000)).toBeLessThan(0.1);
  });
});

test.describe('Етап 1: зрозумілі помилки', () => {
  const cases: Array<[string, () => Promise<FilePayload | FilePayload[]>, RegExp]> = [
    [
      'обрізаний (недокачаний) ZIP',
      async () => {
        const zip = await readFile(ROOM_ZIP);
        return { name: 'scan.zip', mimeType: 'application/zip', buffer: zip.subarray(0, zip.length - 40) };
      },
      /обрізаний|пошкоджений/i,
    ],
    [
      'фото замість скану',
      async () => ({
        name: 'IMG_0001.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      }),
      /не схоже на скан/,
    ],
    [
      'ZIP без моделі',
      async () => {
        const { writeZip } = await import('../fixtures/zip-writer.ts');
        const bytes = writeZip([{ name: 'photo.jpg', data: new Uint8Array([1, 2, 3]) }]);
        return { name: 'photos.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) };
      },
      /немає 3D-моделі/,
    ],
    [
      'тільки .gltf без .bin і текстур',
      async () => {
        const zip = new Uint8Array(await readFile(ROOM_ZIP));
        const entry = readZipEntries(zip).find((e) => e.name.endsWith('room.gltf'))!;
        return { name: 'room.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(await extractZipEntry(zip, entry)) };
      },
      /Бракує файлів моделі: room\.bin, floor tile\.png/,
    ],
  ];

  for (const [name, make, message] of cases) {
    test(name, async ({ page }) => {
      const errors = await openApp(page);
      await chooseFiles(page, await make());
      const alert = page.getByTestId('alert');
      await expect(alert).toBeVisible();
      await expect(page.getByTestId('alert-text')).toHaveText(message);
      const s = await state(page);
      expect(s.status).toBe('idle');
      // Після помилки можна працювати далі.
      await alert.getByRole('button', { name: 'Зрозуміло' }).click();
      await expect(alert).toBeHidden();
      await expect(page.getByTestId('open-scan')).toBeEnabled();
      await chooseFiles(page, ROOM_ZIP);
      expect((await state(page)).status).toBe('ready');
      expect(errors).toEqual([]);
    });
  }
});

test.describe('Етап 1: помилка не закриває відкритий скан', () => {
  test('вибрали фото після кімнати — кімната лишається на екрані', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    await chooseFiles(page, { name: 'IMG_0002.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not a scan at all') });
    await expect(page.getByTestId('alert')).toBeVisible();
    await expect(page.getByTestId('alert-text')).not.toHaveText(/Попередній скан закрито/);
    const s = await state(page);
    expect(s.status).toBe('ready');
    expect(s.scanName).toBe('room-4000x2700x3000.zip');
    expect(await page.evaluate(() => window.__trasa!.viewer.scanBox() !== null)).toBe(true);
    await expect(page.getByTestId('ruler')).toBeEnabled();
  });

  test('USDZ/OBJ замість GLTF — конкретна підказка', async ({ page }) => {
    await openApp(page);
    // USDZ насправді теж ZIP (усередині .usdc) — підказка має бути про USDZ.
    const { writeZip } = await import('../fixtures/zip-writer.ts');
    const usdz = writeZip([{ name: 'Room.usdc', data: new Uint8Array([80, 88, 82, 45, 85, 83, 68, 67]), method: 0 }]);
    await chooseFiles(page, { name: 'Room.usdz', mimeType: 'model/vnd.usdz+zip', buffer: Buffer.from(usdz) });
    await expect(page.getByTestId('alert-text')).toHaveText(/Це файл USDZ.*виберіть експорт GLTF/);
    await page.getByRole('button', { name: 'Зрозуміло' }).click();
    await chooseFiles(page, { name: 'Room.obj', mimeType: 'text/plain', buffer: Buffer.from('v 0 0 0') });
    await expect(page.getByTestId('alert-text')).toHaveText(/Це файл OBJ/);
  });
});

test.describe('Етап 1: «Показати все»', () => {
  test('після відкриття і після кнопки весь скан у кадрі', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    const corners = [-2, 2].flatMap((x) => [0, 2.7].flatMap((y) => [-1.5, 1.5].map((z) => ({ x, y, z }))));
    const allInView = async () => {
      const viewport = page.viewportSize()!;
      for (const corner of corners) {
        const p = await project(page, corner);
        if (!p.visible || p.x < 0 || p.y < 0 || p.x > viewport.width || p.y > viewport.height) return false;
      }
      return true;
    };
    expect(await allInView()).toBe(true);

    // Відлетіли далеко вбік — «Показати все» повертає скан у кадр.
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 40, y: 30, z: -50 }, { x: 30, y: 0, z: -30 }));
    expect(await allInView()).toBe(false);
    await page.getByTestId('show-all').click();
    await page.waitForTimeout(300);
    expect(await allInView()).toBe(true);
  });
});

test.describe('Етап 1: «Рулетка»', () => {
  async function startRuler(page: Page) {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    await lookIntoRoom(page);
    await page.getByTestId('ruler').click();
    await expect(page.getByTestId('ruler-panel')).toBeVisible();
    await expect(page.getByTestId('ruler-text')).toHaveText('Торкніться першої точки (А) на скані');
  }

  test('між протилежними стінами — 4000 мм (±1 мм): А → підтвердити → Б → підтвердити', async ({ page }) => {
    await startRuler(page);
    // WebKit округлює координати кліку до цілих пікселів, а стіни видно під кутом —
    // тож клікаємо в цілі пікселі строго симетрично відносно центру (камера на осі кімнати).
    const a = await project(page, { x: -2, y: 1.2, z: 0 });
    const cx = page.viewportSize()!.width / 2;
    const ax = Math.round(a.x);
    const y = Math.round(a.y);
    await page.mouse.click(ax, y);
    await expect(page.getByTestId('point-editor')).toBeVisible();
    await expect(page.getByTestId('ruler-text')).toHaveText(/^Точка А:/);
    await confirmPoint(page);
    await expect(page.getByTestId('point-editor')).toBeHidden();
    await expect(page.getByTestId('ruler-text')).toHaveText('Тепер торкніться другої точки (Б)');
    await page.mouse.click(2 * cx - ax, y);
    // Поки Б доводять — відстань уже видно.
    expect(Math.abs((await state(page)).ruler.distanceMm - 4000)).toBeLessThanOrEqual(1);
    await confirmPoint(page);
    const s = await state(page);
    expect(s.ruler.phase).toBe('done');
    expect(s.ruler.points).toHaveLength(2);
    expect(Math.abs(s.ruler.distanceMm - 4000)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('ruler-text')).toHaveText(/^4\s000 мм$/);
    await expect(page.getByTestId('ruler-sub')).toHaveText('Торкніться скану, щоб почати новий вимір');
  });

  test('підлога — стеля: 2700 мм (±1 мм), дотиком пальця на сенсорних пристроях', async ({ page }, testInfo) => {
    await startRuler(page);
    // Камера на одній вертикалі з точками: підлогу й стелю видно не надто навскіс,
    // і округлення кліку до пікселя (WebKit) не дає помітної похибки.
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 0.5, y: 1.35, z: 6 }, { x: 0.5, y: 1.35, z: -1 }));
    const tap = async (p: { x: number; y: number }) => {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      return testInfo.project.use.hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
    };
    await tap(await project(page, { x: 0.5, y: 0, z: -1 }));
    await confirmPoint(page);
    // Якщо панель закривала точку, камера повернулась до неї — повертаємо погляд, як зробила б людина.
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 0.5, y: 1.35, z: 6 }, { x: 0.5, y: 1.35, z: -1 }));
    await tap(await project(page, { x: 0.5, y: 2.7, z: -1 }));
    await confirmPoint(page);
    const s = await state(page);
    expect(s.ruler.points).toHaveLength(2);
    // Обидві точки на одній вертикалі — відстань = висота кімнати.
    expect(Math.abs(s.ruler.distanceMm - 2700)).toBeLessThanOrEqual(1);
  });

  test('перетягування обертає камеру й точку не ставить', async ({ page }) => {
    await startRuler(page);
    const before = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 2, y: 0, z: 0 }));
    const a = await project(page, { x: -2, y: 1.2, z: 0 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + 10, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(s.ruler.points).toHaveLength(0);
    const after = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 2, y: 0, z: 0 }));
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(5);
  });

  test('промах — підказка; дотик до підтвердження переставляє точку; після виміру — новий вимір; вихід скидає', async ({
    page,
  }) => {
    await startRuler(page);
    const sky = await project(page, { x: 0, y: 3.5, z: 0 }); // над стелею — поверхні немає
    await page.mouse.click(sky.x, sky.y);
    await expect(page.getByTestId('ruler-sub')).toHaveText(/немає поверхні скану/);
    expect((await state(page)).ruler.points).toHaveLength(0);

    const click = async (p: { x: number; y: number; z: number }) => {
      const s = await project(page, p);
      await page.mouse.click(Math.round(s.x), Math.round(s.y));
    };
    // А поставили, передумали — новий дотик переставляє А (а не ставить Б).
    await click({ x: -2, y: 1.2, z: 0 });
    await click({ x: -2, y: 0.8, z: 0.4 });
    let s = await state(page);
    expect(s.ruler.phase).toBe('editA');
    expect(s.ruler.points).toHaveLength(1);
    expect(s.ruler.points[0].y).toBeCloseTo(0.8, 1);
    await confirmPoint(page);
    // Камера могла повернутись до точки А (якщо її закрила панель) — дивимось на кімнату знову.
    await lookIntoRoom(page);
    await click({ x: 2, y: 1.2, z: 0 });
    await confirmPoint(page);
    expect((await state(page)).ruler.phase).toBe('done');
    await lookIntoRoom(page);
    // Після виміру дотик починає новий вимір.
    await click({ x: 0, y: 0, z: 0.5 });
    s = await state(page);
    expect(s.ruler.phase).toBe('editA');
    expect(s.ruler.points).toHaveLength(1);
    expect(s.ruler.distanceMm).toBeNull();

    await page.getByTestId('ruler-done').click();
    await expect(page.getByTestId('ruler-panel')).toBeHidden();
    await expect(page.getByTestId('point-editor')).toBeHidden();
    expect((await state(page)).ruler).toMatchObject({ active: false, points: [], phase: 'pickA' });
    await expect(page.getByTestId('ruler')).toHaveAttribute('aria-pressed', 'false');
  });

  test('точка ставиться там, де натиснули: тремтіння не зсуває ні точку, ні камеру', async ({ page }) => {
    await startRuler(page);
    const target = { x: -2, y: 1.2, z: 0.3 };
    // Дивимось на стіну прямо (не навскіс): 1 px ≈ 6 мм, похибку дає лише тремтіння, якщо його не прибрати.
    await page.evaluate((t) => window.__trasa!.viewer.setView({ x: 3, y: t.y, z: t.z }, t), target);
    const view = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    const projected = await project(page, target);
    const p = { x: Math.round(projected.x), y: Math.round(projected.y) };
    // Натиснули точно в ціль, рука здригнулась на 4 px, відпустили.
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 3, p.y + 2.5, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const s = await state(page);
    expect(s.ruler.points).toHaveLength(1);
    const hit = s.ruler.points[0];
    const errorMm = Math.hypot(hit.x - target.x, hit.y - target.y, hit.z - target.z) * 1000;
    expect(errorMm).toBeLessThan(10); // у межах округлення до пікселя; без виправлення було б ≈ 20+ мм
    // Камера там само, де була до натискання (інерції від тремтіння немає).
    const after = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    expect(Math.hypot(after.position.x - view.position.x, after.position.y - view.position.y, after.position.z - view.position.z)).toBeLessThan(1e-6);
  });
});

test.describe('Етап 1: кнопки', () => {
  test('кнопки не менші за 44 × 44 px і в межах екрана', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    const viewport = page.viewportSize()!;
    for (const id of ['open-scan', 'show-all', 'ruler']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('панель інформації не перекриває кнопки', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    const title = (await page.getByTestId('title').boundingBox())!;
    for (const id of ['open-scan', 'show-all', 'ruler']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      const overlap = title.x < b.x + b.width && b.x < title.x + title.width && title.y < b.y + b.height && b.y < title.y + title.height;
      expect(overlap, id).toBe(false);
    }
  });
});

test.describe('Скріншоти етапу 1', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('скан і рулетка', async ({ page }, testInfo) => {
        await openApp(page);
        await chooseFiles(page, ROOM_ZIP);
        const safeName = testInfo.project.name.replace(/\s+/g, '-');
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/screenshots/stage1-${safeName}-${colorScheme}-scan.png` });
        await lookIntoRoom(page);
        await page.getByTestId('ruler').click();
        for (const p of [
          { x: -2, y: 1.2, z: 0 },
          { x: 2, y: 1.2, z: 0 },
        ]) {
          const s = await project(page, p);
          await page.mouse.click(s.x, s.y);
          await page.waitForTimeout(150);
          if (p.x > 0) {
            await page.screenshot({ path: `test-results/screenshots/stage1-${safeName}-${colorScheme}-editing.png` });
          }
          await confirmPoint(page);
        }
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/screenshots/stage1-${safeName}-${colorScheme}-ruler.png` });
      });
    });
  }
});
