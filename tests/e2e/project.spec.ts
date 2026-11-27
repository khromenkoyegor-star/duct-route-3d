/**
 * Етап 6: збереження проєкту. Меню «Файл» (дві кнопки), збереження у файл («Поділитися» або
 * «Завантаження»), відкриття проєкту до чи після скану або разом із ним, чужий скан, пошкоджений файл,
 * заміна трас, недобудована траса, чернетка в браузері після перезавантаження сторінки.
 * Тестова кімната 4000 × 2700 × 3000 мм; траси підставляються через app.loadRoutes (мм).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const frames = (page: Page, n = 3) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, n);

/** Траса 1 — з діагоналлю 45° і повітропроводом з переходом; траса 2 — підйом без труби. */
const ROUTES = {
  routes: [
    {
      id: 1,
      nodes: [
        { x: -1500, y: 2200, z: -1000 },
        { x: -500, y: 2200, z: -1000 },
        { x: 500, y: 2200, z: 0 },
        { x: 1300, y: 2200, z: 0 },
      ],
      duct: { section: { shape: 'round' as const, diameterMm: 250 }, transitions: [{ segment: 2, to: { shape: 'round' as const, diameterMm: 200 } }] },
    },
    {
      id: 2,
      nodes: [
        { x: 1000, y: 300, z: 900 },
        { x: 1000, y: 1500, z: 900 },
      ],
      duct: null,
    },
  ],
  nextId: 3,
};

async function openApp(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
}

async function openRoom(page: Page) {
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
}

/** Підмінити «Поділитися»: файл, який програма віддала б iOS, лишається в window.__shared. */
async function stubShare(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: { name: string; type: string; text: string; title?: string } | null };
    w.__shared = null;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => !!data.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[]; title?: string }) => {
        const file = data.files[0]!;
        w.__shared = { name: file.name, type: file.type, text: await file.text(), title: data.title };
      },
    });
  });
}

/** Файл, переданий у «Поділитися» (підміна читає його асинхронно — чекаємо, поки він з'явиться). */
async function shared(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __shared: unknown }).__shared !== null);
  return page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; text: string; title?: string } }).__shared);
}
const sharedNow = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown }).__shared);

/** «Файл» → «Зберегти проєкт» → назва (як підставлено або своя) → «Зберегти». */
async function saveViaMenu(page: Page, name?: string) {
  await page.getByTestId('open-scan').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByTestId('prompt')).toBeVisible();
  if (name !== undefined) await page.getByTestId('prompt-input').fill(name);
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId('prompt')).toBeHidden();
}

const projectFile = (text: string, name = 'Проєкт.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });

/** Траси однакові: номери, точки (±0,1 мм), повітропроводи. */
function expectSameRoutes(actual: { routes: Array<{ id: number; nodes: P3[]; duct: unknown }>; nextId: number }) {
  expect(actual.nextId).toBe(ROUTES.nextId);
  expect(actual.routes.map((r) => r.id)).toEqual(ROUTES.routes.map((r) => r.id));
  ROUTES.routes.forEach((r, i) => {
    const got = actual.routes[i]!;
    expect(got.nodes).toHaveLength(r.nodes.length);
    r.nodes.forEach((n, k) => {
      for (const key of ['x', 'y', 'z'] as const) expect(Math.abs(got.nodes[k]![key] - n[key])).toBeLessThanOrEqual(0.1);
    });
    expect(got.duct ?? null).toEqual(r.duct ?? null);
  });
}

test.describe('Етап 6: меню «Файл»', () => {
  test('лише дві кнопки: «Відкрити скан або проєкт» і «Зберегти проєкт» (≥ 44 px); дотик поза меню — лише закриває', async ({ page }) => {
    await openRoom(page);
    const file = page.getByTestId('open-scan');
    await expect(file).toContainText('Файл');
    await file.click();
    const menu = page.getByTestId('menu');
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['Відкрити скан або проєкт', 'Зберегти проєкт']);
    const vp = page.viewportSize()!;
    const fileBox = (await file.boundingBox())!;
    for (const item of await items.all()) {
      const b = (await item.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
      // Меню не закриває саму кнопку «Файл».
      const overlap = b.x < fileBox.x + fileBox.width && fileBox.x < b.x + b.width && b.y < fileBox.y + fileBox.height && fileBox.y < b.y + b.height;
      expect(overlap).toBe(false);
    }
    // Дотик посередині сцени поза меню — меню закрито, нічого не ввімкнулось і не ставилось.
    const mb = (await menu.getByRole('menu').boundingBox())!;
    const outside = { x: mb.x + mb.width / 2 < vp.width / 2 ? vp.width - 30 : 30, y: vp.height / 2 };
    await page.mouse.click(outside.x, outside.y);
    await expect(menu).toBeHidden();
    const s = await state(page);
    expect(s.tool).toBe('none');
    expect(s.ruler.points).toHaveLength(0);
  });

  test('«Відкрити скан або проєкт» без трас — одразу «Файли»', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('open-scan').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('menu-open').click();
    await (await chooser).setFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  });
});

test.describe('Етап 6: збереження проєкту', () => {
  test('назва за замовчуванням — скан і дата; через «Поділитися» йде .json з трасами, сканом, видом і режимом показу', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    const input = page.getByTestId('prompt-input');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const scanName: string = (await state(page)).scanName;
    await expect(input).toHaveValue(`${scanName.replace(/\.(zip|glb|gltf)$/i, '')} · ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`);
    // Поле 17 px — Safari на iPhone не збільшує сторінку при дотику до нього.
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('17px');
    // Порожня назва — «Зберегти» неактивна.
    await input.fill('   ');
    await expect(page.getByTestId('prompt-ok')).toBeDisabled();
    await input.fill('Цех 2: вентиляція');
    await input.press('Enter');
    await expect(page.getByTestId('prompt')).toBeHidden();
    const file = (await shared(page))!;
    expect(file.name).toBe('Цех 2- вентиляція.json');
    expect(file.type).toBe('application/json');
    const raw = JSON.parse(file.text);
    expect(raw.format).toBe('trasa-3d-project');
    expect(raw.name).toBe('Цех 2: вентиляція');
    expect(raw.scan.name).toBe(scanName);
    expect(raw.scan.triangles).toBeGreaterThan(0);
    expectSameRoutes({ routes: raw.routes, nextId: raw.nextId });
    expect(raw.view.projection).toBe('perspective');
    expect(raw.display).toEqual({ mode: 'both', transparency: 0 });
    // Наступного разу підставляється та сама назва.
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('prompt-input')).toHaveValue('Цех 2: вентиляція');
    await page.getByTestId('prompt-cancel').click();
    await expect(page.getByTestId('prompt')).toBeHidden();
  });

  test('без «Поділитися» — файл іде в «Завантаження»', async ({ page }) => {
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      // Яке ім'я програма дає файлу (Chromium без вікна кириличну назву в атрибуті download підміняє на
      // «download»; Safari — ні), — записуємо прямо з посилання.
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        (window as unknown as { __downloadName: string }).__downloadName = this.download;
        click.call(this);
      };
    });
    const downloading = page.waitForEvent('download');
    await saveViaMenu(page, 'Офіс');
    const download = await downloading;
    expect(await page.evaluate(() => (window as unknown as { __downloadName: string }).__downloadName)).toBe('Офіс.json');
    const raw = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expectSameRoutes({ routes: raw.routes, nextId: raw.nextId });
  });

  test('без трас — пояснення, нічого не зберігається', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await page.getByTestId('open-scan').click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('alert')).toBeVisible();
    await expect(page.getByTestId('alert-text')).toContainText('намалюйте хоча б одну трасу');
    expect(await sharedNow(page)).toBeNull();
  });

  test('недобудована траса — спершу питання; «Зберегти трасу» — вона потрапляє у файл', async ({ page }) => {
    await stubShare(page);
    await openRoom(page);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
    await page.getByTestId('route').click();
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    // Друга точка — повзунком угору, підтвердити.
    const slider = (await page.getByTestId('stick-y').filter({ visible: true }).boundingBox())!;
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 - 50, { steps: 3 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    // На iPhone вертикально під час побудови нижня панель схована — «Файл» недоступна, це нормально.
    const file = page.getByTestId('open-scan');
    test.skip(!(await file.isVisible()), 'кнопка «Файл» схована під час побудови (iPhone вертикально)');
    await file.click();
    await page.getByTestId('menu-save').click();
    await expect(page.getByTestId('choice-text')).toContainText('Зберегти її в проєкт?');
    await page.getByTestId('choice-save').click();
    await page.getByTestId('prompt-ok').click();
    const raw = JSON.parse((await shared(page))!.text);
    expect(raw.routes).toHaveLength(1);
    expect(raw.routes[0].nodes).toHaveLength(2);
  });
});

test.describe('Етап 6: відкриття проєкту', () => {
  /** Проєкт з ROUTES, «Орто», режимом «Повітропровід» і вглядом камери — як збереже програма. */
  async function makeProject(page: Page): Promise<{ text: string; view: { position: P3; target: P3 } }> {
    await stubShare(page);
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    await page.getByTestId('view-ortho').click();
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.1, y: 3.3, z: 4.9 }, { x: 0.2, y: 1.2, z: -0.1 }));
    await page.getByTestId('duct').click();
    await page.getByTestId('view-mode-duct').click();
    await page.getByTestId('duct-close').click();
    const view = await page.evaluate(() => {
      const v = window.__trasa!.viewer.snapshotView();
      return { position: { x: v.position.x, y: v.position.y, z: v.position.z }, target: { x: v.target.x, y: v.target.y, z: v.target.z } };
    });
    await saveViaMenu(page, 'Цех 2');
    return { text: (await shared(page))!.text, view };
  }

  async function expectRestored(page: Page, view: { position: P3; target: P3 }) {
    await page.waitForFunction(() => window.__trasa!.app!.state.routes.set.routes.length === 2);
    const s = await state(page);
    expectSameRoutes(s.routes.set);
    expect(s.projection).toBe('ortho');
    expect(s.ducts.mode).toBe('duct');
    expect(s.project.name).toBe('Цех 2');
    const v = await page.evaluate(() => window.__trasa!.viewer.snapshotView());
    for (const key of ['x', 'y', 'z'] as const) {
      expect(Math.abs(v.position[key] - view.position[key])).toBeLessThan(1e-4);
      expect(Math.abs(v.target[key] - view.target[key])).toBeLessThan(1e-4);
    }
    // Повітропровід побудовано: габарит труби траси 1 — є.
    expect(await page.evaluate(() => window.__trasa!.app!.ductBox(1))).not.toBeNull();
  }

  test('збережено → перезавантажено → відкрито скан, потім проєкт: ті самі траси, труби, «Орто», камера', async ({ page }) => {
    const { text, view } = await makeProject(page);
    await page.reload();
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    expect((await state(page)).projection).toBe('perspective');
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    // Чернетка цього скану є — пропонує повернути; тут — почати заново й відкрити файл проєкту.
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
    await page.getByTestId('choice-fresh').click();
    expect((await state(page)).routes.set.routes).toHaveLength(0);
    await page.getByTestId('file-input').setInputFiles(projectFile(text, 'Цех 2.json'));
    await expectRestored(page, view);
  });

  test('спершу проєкт, потім його скан: просить відкрити скан — траси з\'являються на ньому', async ({ page }) => {
    const { text, view } = await makeProject(page);
    await page.reload();
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    // Чернетки цього скану немає (її дописують і під час перезавантаження — тому чистимо вже після нього).
    await page.evaluate(() => localStorage.clear());
    await page.getByTestId('file-input').setInputFiles(projectFile(text, 'Цех 2.json'));
    await expect(page.getByTestId('choice')).toBeVisible();
    await expect(page.getByTestId('choice-text')).toContainText('Відкрийте скан «room-4000x2700x3000');
    expect((await state(page)).project.pending).toBe('Цех 2');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('choice-open-scan').click();
    await (await chooser).setFiles(ROOM_ZIP);
    await expectRestored(page, view);
    expect((await state(page)).project.pending).toBeNull();
  });

  test('скан і проєкт разом в одному виборі — відкрито обидва, без зайвих питань', async ({ page }) => {
    const { text, view } = await makeProject(page);
    await page.reload();
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    // Чернетки цього скану немає (її дописують і під час перезавантаження — тому чистимо вже після нього).
    await page.evaluate(() => localStorage.clear());
    // Скан і проєкт одним вибором (обидва — з пам'яті: Playwright не змішує шляхи й буфери).
    await page.getByTestId('file-input').setInputFiles([
      { name: 'room-4000x2700x3000.zip', mimeType: 'application/zip', buffer: readFileSync(ROOM_ZIP) },
      projectFile(text, 'Цех 2.json'),
    ]);
    await expectRestored(page, view);
    await expect(page.getByTestId('choice')).toBeHidden();
  });

  test('проєкт для іншого скану — попередження; «Показати» — траси на екрані', async ({ page }) => {
    const { text, view } = await makeProject(page);
    const raw = JSON.parse(text);
    raw.scan.triangles += 1000;
    raw.scan.name = 'Склад.zip';
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), { routes: [], nextId: 1 });
    await page.getByTestId('file-input').setInputFiles(projectFile(JSON.stringify(raw)));
    await expect(page.getByTestId('choice-text')).toContainText('зроблено для скану «Склад.zip»');
    await page.getByTestId('choice-cancel').click();
    expect((await state(page)).routes.set.routes).toHaveLength(0);
    await page.getByTestId('file-input').setInputFiles(projectFile(JSON.stringify(raw)));
    await page.getByTestId('choice-show').click();
    await expectRestored(page, view);
  });

  test('на екрані вже є траси — спершу «Замінити траси?»', async ({ page }) => {
    const { text } = await makeProject(page);
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({ routes: [{ id: 5, nodes: [{ x: 0, y: 500, z: 0 }, { x: 1000, y: 500, z: 0 }], duct: null }], nextId: 6 }),
    );
    await page.getByTestId('file-input').setInputFiles(projectFile(text));
    await expect(page.getByTestId('choice-text')).toContainText('замінять трасами з проєкту «Цех 2» (2 траси)');
    await page.getByTestId('choice-cancel').click();
    expect((await state(page)).routes.set.routes.map((r: { id: number }) => r.id)).toEqual([5]);
    await page.getByTestId('file-input').setInputFiles(projectFile(text));
    await page.getByTestId('choice-replace').click();
    expectSameRoutes((await state(page)).routes.set);
  });

  test('пошкоджений, чужий чи новіший файл — зрозуміле повідомлення; траси й скан на місці', async ({ page }) => {
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    for (const [text, message] of [
      ['{не json', 'не файл проєкту'],
      ['{"name":"щось інше"}', 'не файл проєкту'],
      ['{"format":"trasa-3d-project","version":99,"routes":[]}', 'новішою версією'],
    ] as const) {
      await page.getByTestId('file-input').setInputFiles(projectFile(text, 'файл.json'));
      await expect(page.getByTestId('alert')).toBeVisible();
      await expect(page.getByTestId('alert-text')).toContainText(message);
      await page.getByTestId('alert').getByRole('button').click();
      const s = await state(page);
      expect(s.status).toBe('ready');
      expectSameRoutes(s.routes.set);
    }
  });
});

test.describe('Етап 6: чернетка в браузері', () => {
  test('траси без збереження → перезавантаження → той самий скан пропонує повернути їх', async ({ page }) => {
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    // Чернетка пишеться трохи згодом після змін.
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await expect(page.getByTestId('choice')).toBeVisible();
    await expect(page.getByTestId('choice-text')).toContainText(/^2 траси · \d\d\.\d\d о \d\d:\d\d$/);
    await page.getByTestId('choice-restore').click();
    expectSameRoutes((await state(page)).routes.set);
  });

  test('інший скан відкривається — траси попереднього лишаються в його чернетці', async ({ page }) => {
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    // Одразу (без очікування) відкрили той самий файл ще раз: чернетку дописано перед зміною скану.
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready' && window.__trasa.app.state.routes.set.routes.length === 0);
    await expect(page.getByTestId('choice-text')).toContainText('2 траси');
    await page.getByTestId('choice-restore').click();
    expectSameRoutes((await state(page)).routes.set);
  });

  test('усі траси видалено — чернетки немає, питання не з\'являється', async ({ page }) => {
    await openRoom(page);
    await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__trasa!.app!.loadRoutes({ routes: [], nextId: 3 }));
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
    await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
    await frames(page, 5);
    await expect(page.getByTestId('choice')).toBeHidden();
  });
});

test.describe('Скріншоти етапу 6', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('меню «Файл», назва проєкту, повернення чернетки', async ({ page }, testInfo) => {
        const shot = (name: string) =>
          page.screenshot({ path: `test-results/screenshots/stage6-${testInfo.project.name.replace(/\s+/g, '-')}-${colorScheme}-${name}.png` });
        await stubShare(page);
        await openRoom(page);
        await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.2, y: 3.4, z: 5.2 }, { x: 0, y: 1.4, z: 0 }));
        await page.evaluate((set) => window.__trasa!.app!.loadRoutes(set), ROUTES);
        await page.getByTestId('open-scan').click();
        await frames(page, 3);
        await shot('menu');
        await page.getByTestId('menu-save').click();
        await frames(page, 3);
        await shot('prompt');
        await page.getByTestId('prompt-ok').click();
        await page.waitForTimeout(700);
        await page.reload();
        await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
        await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
        await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
        await expect(page.getByTestId('choice')).toBeVisible();
        await frames(page, 3);
        await shot('restore');
      });
    });
  }
});
