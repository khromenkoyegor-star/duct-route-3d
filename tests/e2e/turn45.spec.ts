/**
 * Етап 4.1: повороти 45°. Точку тягнуть по основній осі, потім «45°» і вибирають другу вісь —
 * відрізок стає рівно діагональним (зміщення по двох осях однакові). Між сусідніми відрізками —
 * лише пряме продовження, 45° або 90°. Тестова кімната 4000 × 2700 × 3000 мм.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type P3 = { x: number; y: number; z: number };
type Axis = 'X' | 'Y' | 'Z';

/** Допуск 0,1 мм (сцена в метрах). */
const TOL_M = 1e-4;

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const editor = async (page: Page) => (await state(page)).routes.editor;
const shown = (page: Page, testid: string) => page.getByTestId(testid).filter({ visible: true });
const frames = (page: Page, n = 3) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, n);

async function openRoom(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
}

/** «Траса» + перша точка на підлозі, підтверджена: далі тягнемо другу точку. */
async function startPull(page: Page, at: P3 = { x: -0.8, y: 0, z: 0.2 }) {
  await openRoom(page);
  await page.getByTestId('route').click();
  const p = await page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), at);
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await confirm(page);
  expect((await state(page)).routes.phase).toBe('pull');
}

async function hold(page: Page, testid: string, dx: number, dy: number, ms: number) {
  const box = (await shown(page, testid).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx * 64, cy + dy * 64, { steps: 3 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(60);
}

/** Потягнути точку по осі (джойстик для X і Z, повзунок для Y). */
async function pull(page: Page, axis: Axis, sign: 1 | -1, ms = 500) {
  if (axis === 'Y') {
    await hold(page, 'stick-y', 0, -0.9 * sign, ms);
    return;
  }
  const point: P3 = (await editor(page)).point;
  const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), point);
  const dir = axes[axis];
  const len = Math.hypot(dir.x, dir.y);
  await hold(page, 'stick-xz', (sign * 0.9 * dir.x) / len, (sign * 0.9 * dir.y) / len, ms);
}

/**
 * Режим 45°: потягнути джойстик уздовж діагоналі так, як вона йде на екрані
 * (sign 1 — геть від початку відрізка, −1 — до нього).
 */
async function pullDiagonal(page: Page, sign: 1 | -1, ms = 500) {
  const e = await editor(page);
  const [a, p] = await page.evaluate(
    ([anchor, point]) => [window.__trasa!.viewer.projectPoint(anchor!), window.__trasa!.viewer.projectPoint(point!)],
    [e.segment.anchor as P3, e.point as P3] as const,
  );
  const len = Math.hypot(p!.x - a!.x, p!.y - a!.y);
  await hold(page, 'stick-xz', (sign * 0.9 * (p!.x - a!.x)) / len, (sign * 0.9 * (p!.y - a!.y)) / len, ms);
}

/** Потягнути джойстик по осі X чи Z і, не відпускаючи, прочитати підказку біля джойстика. */
async function pullAndRead(page: Page, axis: 'X' | 'Z', sign: 1 | -1, ms = 400): Promise<string> {
  const point: P3 = (await editor(page)).point;
  const axes = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), point);
  const dir = axes[axis];
  const len = Math.hypot(dir.x, dir.y);
  const box = (await shown(page, 'stick-xz').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + ((sign * 0.9 * dir.x) / len) * 64, cy + ((sign * 0.9 * dir.y) / len) * 64, { steps: 3 });
  await page.waitForTimeout(ms);
  const text = (await shown(page, 'point-shift').textContent()) ?? '';
  await page.mouse.up();
  await page.waitForTimeout(60);
  return text;
}

async function confirm(page: Page) {
  await shown(page, 'confirm-point').click();
  await page.waitForTimeout(80);
}

/** Натиснути «45°» і вибрати другу вісь. */
async function choose45(page: Page, option: string) {
  await shown(page, 'segment-45').click();
  await expect(shown(page, 'segment-45-picker')).toBeVisible();
  await shown(page, `segment-45-${option}`).click();
  await expect(shown(page, 'segment-45-picker')).toHaveCount(0);
}

const offset = (a: P3, b: P3) => ({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });

test.describe('Поворот 45° під час побудови траси', () => {
  test('у горизонталі: по X, «45°» → Z+ — зміщення по X і Z однакові (±0,1 мм), Y не змінюється; джойстик веде по діагоналі', async ({
    page,
  }) => {
    await startPull(page);
    // Кнопка «45°» — біля джойстика, не менша за 44 × 44.
    const button = shown(page, 'segment-45');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('45°');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    // Точка ще на початку відрізка — «45°» бліда.
    await expect(button).toHaveClass(/diag-button--idle/);
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    await pull(page, 'X', 1);
    let e = await editor(page);
    const anchor: P3 = e.segment.anchor;
    const straight = offset(anchor, e.point);
    expect(straight.x).toBeGreaterThan(0.05);
    expect(straight.y).toBe(0);
    expect(straight.z).toBe(0);

    await expect(button).not.toHaveClass(/diag-button--idle/);
    // Вибір другої осі: чотири варіанти, кожен не менший за 44 px; порядок сталий — «Y вгору / Y вниз» у кінці.
    await button.click();
    const picker = shown(page, 'segment-45-picker');
    await expect(picker).toBeVisible();
    await frames(page, 2);
    expect(await picker.locator('button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual([
      'segment-45-z-plus',
      'segment-45-z-minus',
      'segment-45-y-plus',
      'segment-45-y-minus',
    ]);
    // Стрілка на варіанті «Z+» — туди, куди діагональ X+Z+ піде на екрані (сума екранних стрілок X+ і Z+ біля точки).
    {
      const p0: P3 = (await editor(page)).point;
      const ax = await page.evaluate((p) => window.__trasa!.viewer.screenAxes(p), p0);
      const want = Math.atan2(ax.X.y + ax.Z.y, ax.X.x + ax.Z.x);
      const got = await shown(page, 'segment-45-z-plus').locator('.diag-option-icon').evaluate((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return Math.atan2(m.b, m.a);
      });
      const diff = Math.atan2(Math.sin(got - want), Math.cos(got - want));
      expect(Math.abs(diff), 'стрілка на «Z+» не туди, куди піде діагональ').toBeLessThan(0.05);
    }
    for (const [id, text] of [
      ['z-plus', 'Z+'],
      ['z-minus', 'Z−'],
      ['y-plus', 'Y вгору'],
      ['y-minus', 'Y вниз'],
    ] as const) {
      const option = shown(page, `segment-45-${id}`);
      await expect(option).toHaveText(text);
      await expect(option).toBeEnabled();
      const b = (await option.boundingBox())!;
      expect(b.width, id).toBeGreaterThanOrEqual(44);
      expect(b.height, id).toBeGreaterThanOrEqual(44);
      const vp = page.viewportSize()!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
      expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
    }
    await shown(page, 'segment-45-z-plus').click();
    await expect(picker).toHaveCount(0);

    e = await editor(page);
    expect(e.segment.diagonal).toEqual({ axis: 'Z', sign: 1 });
    expect(e.segment.axis).toBe('X');
    let d = offset(anchor, e.point);
    // Хід по основній осі зберігся, по другій — такий самий.
    expect(d.x).toBeCloseTo(straight.x, 9);
    expect(Math.abs(d.z - d.x)).toBeLessThan(TOL_M);
    expect(d.y).toBe(0);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // Увімкнена — видно й вибраний бік.
    await expect(button).toHaveText('45° · Z+');
    await expect(shown(page, 'point-shift')).toHaveText(/^Відрізок 45°: X \+[\d\s,]+ · Z \+[\d\s,]+ = [\d\s,]+ мм$/);
    expect(e.segment.lengthMm).toBeCloseTo(d.x * Math.SQRT2 * 1000, 3);
    expect(e.canConfirm).toBe(true);

    // Той самий джойстик (по X) веде точку вздовж діагоналі.
    await pull(page, 'X', 1, 600);
    e = await editor(page);
    const further = offset(anchor, e.point);
    // Поріг невеликий: у CI (WebKit без відеокарти) кадри рідкі, і хід за той самий час менший.
    expect(further.x).toBeGreaterThan(d.x + 0.01);
    expect(Math.abs(further.z - further.x)).toBeLessThan(TOL_M);
    expect(further.y).toBe(0);
    // Джойстик у бік другої осі (Z) теж веде по тій самій діагоналі, а не ламає її.
    await pull(page, 'Z', 1, 300);
    e = await editor(page);
    d = offset(anchor, e.point);
    expect(Math.abs(d.z - d.x)).toBeLessThan(TOL_M);
    expect(d.y).toBe(0);
    expect(e.segment.diagonal).toEqual({ axis: 'Z', sign: 1 });

    await confirm(page);
    // Далі — прямо по X (поворот 45°) і завершити.
    await pull(page, 'X', 1, 400);
    await confirm(page);
    await page.getByTestId('route-finish').click();
    const nodes: P3[] = (await state(page)).routes.set.routes[0].nodes;
    expect(nodes).toHaveLength(3);
    const s1 = offset(nodes[0]!, nodes[1]!);
    expect(Math.abs(s1.x - s1.z)).toBeLessThan(0.1);
    expect(s1.y).toBe(0);
    expect(s1.x).toBeGreaterThan(50);
    const s2 = offset(nodes[1]!, nodes[2]!);
    expect(s2.x).toBeGreaterThan(30);
    expect(s2.y).toBe(0);
    expect(s2.z).toBe(0);
  });

  test('підйом під 45°: по X, «45°» → «Y вгору»; і навпаки — повзунком по Y, «45°» → X+', async ({ page }) => {
    await startPull(page);
    await pull(page, 'X', 1);
    await choose45(page, 'y-plus');
    let e = await editor(page);
    const a1: P3 = e.segment.anchor;
    let d = offset(a1, e.point);
    expect(d.x).toBeGreaterThan(0.05);
    expect(Math.abs(d.y - d.x)).toBeLessThan(TOL_M);
    expect(d.z).toBe(0);
    await expect(shown(page, 'point-shift')).toHaveText(/^Відрізок 45°: X \+[\d\s,]+ · Y \+[\d\s,]+ = /);
    // Підйом під 45° ведуть і джойстик, і повзунок — однаково, з якої осі почали.
    await expect(shown(page, 'stick-y')).not.toHaveClass(/stick--off/);
    await expect(shown(page, 'stick-xz')).not.toHaveClass(/stick--off/);
    const beforeSlider: P3 = e.point;
    await pull(page, 'Y', 1, 400);
    e = await editor(page);
    d = offset(a1, e.point);
    expect(e.point.y, 'повзунок угору — точка вгору').toBeGreaterThan(beforeSlider.y + 0.02);
    expect(Math.abs(d.y - d.x)).toBeLessThan(TOL_M);
    expect(d.z).toBe(0);
    await confirm(page);

    // Основна вісь — Y (повзунок): другу вісь вибираємо з X і Z.
    await pull(page, 'Y', 1, 500);
    await shown(page, 'segment-45').click();
    for (const id of ['x-plus', 'x-minus', 'z-plus', 'z-minus']) await expect(shown(page, `segment-45-${id}`)).toBeVisible();
    await expect(shown(page, 'segment-45-y-plus')).toHaveCount(0);
    // Після підйому X+Y+ продовження Y+X+ — та сама пряма (дозволено); Y+ з X− — це 90° до попереднього (дозволено);
    // Y+ із Z± — 60° до попереднього: таких поворотів немає.
    await expect(shown(page, 'segment-45-x-plus')).toBeEnabled();
    await expect(shown(page, 'segment-45-x-minus')).toBeEnabled();
    await expect(shown(page, 'segment-45-z-plus')).toBeDisabled();
    await expect(shown(page, 'segment-45-z-minus')).toBeDisabled();
    await shown(page, 'segment-45-x-minus').click();
    // Основна вісь Y, друга X: джойстик теж веде вздовж діагоналі (геть від початку).
    await expect(shown(page, 'stick-xz')).not.toHaveClass(/stick--off/);
    {
      const y0 = (await editor(page)).point.y;
      await pullDiagonal(page, 1, 300);
      const p1 = await editor(page);
      expect(p1.point.y, 'джойстик уздовж діагоналі — точка вгору').toBeGreaterThan(y0 + 0.01);
      const o = offset(p1.segment.anchor, p1.point);
      expect(Math.abs(o.x + o.y)).toBeLessThan(TOL_M);
    }
    e = await editor(page);
    const a2: P3 = e.segment.anchor;
    d = offset(a2, e.point);
    expect(d.y).toBeGreaterThan(0.03);
    expect(Math.abs(d.x + d.y)).toBeLessThan(TOL_M);
    expect(d.z).toBe(0);
    // Повзунок веде по діагоналі.
    await pull(page, 'Y', 1, 400);
    e = await editor(page);
    const d2 = offset(a2, e.point);
    expect(d2.y).toBeGreaterThan(d.y + 0.02);
    expect(Math.abs(d2.x + d2.y)).toBeLessThan(TOL_M);
    expect(d2.z).toBe(0);
    await confirm(page);
    await page.getByTestId('route-finish').click();
    expect((await state(page)).routes.set.routes[0].nodes).toHaveLength(3);
  });

  test('ще раз «45°» — відрізок знову прямий; на початку відрізка «45°» просить спершу потягнути точку', async ({ page }) => {
    await startPull(page);
    // Точка ще на початку: вибирати нічого.
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-picker')).toHaveCount(0);
    await expect(shown(page, 'point-shift')).toHaveText('Спершу потягніть точку по основній осі, потім натисніть «45°»');
    expect((await editor(page)).segment.diagonal).toBeNull();

    await pull(page, 'Z', -1);
    const before: P3 = (await editor(page)).point;
    await choose45(page, 'x-plus');
    let e = await editor(page);
    const anchor: P3 = e.segment.anchor;
    expect(Math.abs(offset(anchor, e.point).x + offset(anchor, e.point).z)).toBeLessThan(TOL_M);
    await expect(shown(page, 'point-shift')).toHaveText(/^Відрізок 45°: Z −[\d\s,]+ · X \+[\d\s,]+ = /);

    // Вимкнути: лишається хід по основній осі.
    await shown(page, 'segment-45').click();
    e = await editor(page);
    expect(e.segment.diagonal).toBeNull();
    expect(e.point).toEqual(before);
    await expect(shown(page, 'segment-45')).toHaveAttribute('aria-pressed', 'false');
    await expect(shown(page, 'point-shift')).toHaveText(/^Відрізок: Z −/);

    // Діагональ, потім точку тягнуть джойстиком назад уздовж діагоналі через початок відрізка: там режим 45°
    // скидається, і після короткої зупинки точка може йти далі лише прямо по одній осі (без діагоналі).
    await choose45(page, 'x-minus');
    expect((await editor(page)).segment.diagonal).toEqual({ axis: 'X', sign: -1 });
    await pullDiagonal(page, -1, 2500);
    e = await editor(page);
    expect(e.segment.diagonal).toBeNull();
    const moved = (['x', 'y', 'z'] as const).filter((k) => e.point[k] !== anchor[k]);
    expect(moved.length, `змінились координати: ${moved.join(', ')}`).toBeLessThanOrEqual(1);
    await expect(shown(page, 'segment-45')).toHaveAttribute('aria-pressed', 'false');
    await expect(shown(page, 'point-shift')).not.toHaveText(/45°/);
  });

  test('між відрізками — лише 45° або 90°: заборонені варіанти неактивні, у заборонений бік точка не йде', async ({ page }) => {
    await startPull(page);
    // Відрізок 1 — прямо по X+.
    await pull(page, 'X', 1);
    await confirm(page);

    // Відрізок 2 — по Z+ (поворот 90°). Діагональ Z+X− була б поворотом 135° — не можна.
    await pull(page, 'Z', 1);
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-x-plus')).toBeEnabled();
    await expect(shown(page, 'segment-45-x-minus')).toBeDisabled();
    await expect(shown(page, 'segment-45-y-plus')).toBeEnabled();
    await expect(shown(page, 'segment-45-y-minus')).toBeEnabled();
    // Натискання на неактивний варіант пояснює, чому не можна (без наведення курсору), і нічого не змінює.
    // force: Playwright не клікає елементи з aria-disabled, а палець — натискає.
    await shown(page, 'segment-45-x-minus').click({ force: true });
    expect((await editor(page)).segment.diagonal).toBeNull();
    await expect(shown(page, 'point-shift')).toHaveText('Такий поворот не можна: лише 45° або 90° до попереднього відрізка');
    await expect(shown(page, 'segment-45-picker')).toBeVisible();
    await shown(page, 'segment-45-x-plus').click();
    let e = await editor(page);
    const d = offset(e.segment.anchor, e.point);
    expect(Math.abs(d.x - d.z)).toBeLessThan(TOL_M);
    await confirm(page);

    // Після діагоналі X+Z+: назад (X−Z−) і гострий поворот (X−, 135°) — точка стоїть, є підказка.
    const anchor: P3 = (await editor(page)).segment.anchor;
    expect(await pullAndRead(page, 'X', -1)).toBe('Такий поворот не можна: лише 45° або 90°');
    e = await editor(page);
    expect(e.point).toEqual(anchor);
    expect(await pullAndRead(page, 'Z', -1)).toBe('Такий поворот не можна: лише 45° або 90°');
    expect((await editor(page)).point).toEqual(anchor);
    // Дозволені: прямо по X+ або Z+ (45°), вгору/вниз (90°).
    await pull(page, 'Z', 1, 400);
    e = await editor(page);
    expect(e.point.z).toBeGreaterThan(anchor.z + 0.03);
    expect(e.point.x).toBe(anchor.x);
    // Тут діагональ: Z+X+ — продовження попереднього відрізка (можна), Z+X− — 90° (можна), Z+Y± — 60° (не можна).
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-x-plus')).toBeEnabled();
    await expect(shown(page, 'segment-45-x-minus')).toBeEnabled();
    await expect(shown(page, 'segment-45-y-plus')).toBeDisabled();
    await expect(shown(page, 'segment-45-y-minus')).toBeDisabled();
    await shown(page, 'segment-45').click();
    await expect(shown(page, 'segment-45-picker')).toHaveCount(0);
    await confirm(page);
    await page.getByTestId('route-finish').click();

    // Кожен поворот збереженої траси — 45° або 90°.
    const nodes: P3[] = (await state(page)).routes.set.routes[0].nodes;
    expect(nodes).toHaveLength(4);
    const dirs = nodes.slice(1).map((n, i) => {
      const o = offset(nodes[i]!, n);
      const l = Math.hypot(o.x, o.y, o.z);
      return { x: o.x / l, y: o.y / l, z: o.z / l };
    });
    const turns = dirs.slice(1).map((b, i) => {
      const a = dirs[i]!;
      return Math.round((Math.acos(a.x * b.x + a.y * b.y + a.z * b.z) * 180) / Math.PI);
    });
    expect(turns).toEqual([45, 45]);
  });

  test('«Видалити останню точку» після діагоналі: наступний відрізок знову від попередньої точки, 45° працює', async ({ page }) => {
    await startPull(page);
    await pull(page, 'X', 1);
    await choose45(page, 'z-minus');
    await confirm(page);
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    await page.getByTestId('route-remove-last').click();
    const r = (await state(page)).routes;
    expect(r.building.nodes).toHaveLength(1);
    expect(r.editor.segment.diagonal).toBeNull();
    await expect(shown(page, 'segment-45')).toHaveAttribute('aria-pressed', 'false');
    await pull(page, 'Z', 1);
    await choose45(page, 'y-plus');
    const e = await editor(page);
    const d = offset(e.segment.anchor, e.point);
    expect(Math.abs(d.z - d.y)).toBeLessThan(TOL_M);
    expect(d.x).toBe(0);
  });
});

test.describe('Повітропровід на поворотах 45°', () => {
  /** Оффсет у горизонталі: 1000 по X, діагональ 1000 × 1000, далі 800 по X. */
  const OFFSET: P3[] = [
    { x: -1500, y: 1500, z: -800 },
    { x: -500, y: 1500, z: -800 },
    { x: 500, y: 1500, z: 200 },
    { x: 1300, y: 1500, z: 200 },
  ];

  async function openWith(page: Page, nodes: P3[]) {
    await openRoom(page);
    await page.evaluate((n) => window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: n }], nextId: 2 }), nodes);
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
  }

  test('Ø200 з двома колінами 45°: труба йде по трасі, проблем немає, у панелі — «45°» і довжина діагоналі', async ({ page }) => {
    await openWith(page, OFFSET);
    await page.getByTestId('duct-diameter').selectOption('200');
    await frames(page);
    const d = (await state(page)).ducts;
    expect(d.routes[0].problems).toEqual([]);
    expect(d.routes[0].sections).toEqual(['Ø200', 'Ø200', 'Ø200']);
    await expect(page.getByTestId('duct-problems')).toHaveCount(0);
    await expect(page.getByTestId('duct-segment-0')).toContainText('X +1 000 мм');
    await expect(page.getByTestId('duct-segment-1')).toContainText('45° X+ Z+');
    await expect(page.getByTestId('duct-segment-1')).toContainText('1 414,2 мм (зміщення 1 000 мм)');
    // Габарит: труба Ø200 навколо траси — краї рівно на 100 мм від осі.
    const box = (await page.evaluate(() => window.__trasa!.app!.ductBox(1)))!;
    expect(Math.abs(box.min.x - -1500)).toBeLessThan(0.5);
    expect(Math.abs(box.max.x - 1300)).toBeLessThan(0.5);
    expect(Math.abs(box.min.y - 1400)).toBeLessThan(0.5);
    expect(Math.abs(box.max.y - 1600)).toBeLessThan(0.5);
    expect(Math.abs(box.min.z - -900)).toBeLessThan(0.5);
    expect(Math.abs(box.max.z - 300)).toBeLessThan(0.5);
  });

  test('одне коліно 45° Ø200 наприкінці діагоналі: торець труби — під 45° (габарит ±0,5 мм)', async ({ page }) => {
    await openWith(page, [
      { x: -1000, y: 1500, z: -500 },
      { x: 0, y: 1500, z: -500 },
      { x: 1000, y: 1500, z: 500 },
    ]);
    await page.getByTestId('duct-diameter').selectOption('200');
    await frames(page);
    const box = (await page.evaluate(() => window.__trasa!.app!.ductBox(1)))!;
    const half = 100 * Math.SQRT1_2;
    expect(Math.abs(box.min.x - -1000)).toBeLessThan(0.5);
    expect(Math.abs(box.max.x - (1000 + half))).toBeLessThan(0.5);
    expect(Math.abs(box.min.z - -600)).toBeLessThan(0.5);
    expect(Math.abs(box.max.z - (500 + half))).toBeLessThan(0.5);
    expect(Math.abs(box.min.y - 1400)).toBeLessThan(0.5);
    expect(Math.abs(box.max.y - 1600)).toBeLessThan(0.5);
  });

  test('закоротка діагональ між двома колінами 45° — проблема з підказкою', async ({ page }) => {
    // Діагональ 100 × 100 (141 мм) замала для двох колін Ø315: потрібно 2 · 315 · tg 22,5° ≈ 261 мм.
    await openWith(page, [
      { x: -1500, y: 1500, z: -800 },
      { x: -500, y: 1500, z: -800 },
      { x: -400, y: 1500, z: -700 },
      { x: 600, y: 1500, z: -700 },
    ]);
    await page.getByTestId('duct-diameter').selectOption('315');
    await frames(page);
    const problems = (await state(page)).ducts.routes[0].problems;
    expect(problems).toHaveLength(1);
    expect(problems[0].segment).toBe(1);
    expect(problems[0].needMm).toBeCloseTo(2 * 315 * Math.tan(Math.PI / 8), 0);
    await expect(page.getByTestId('duct-problems')).toContainText('Відрізок 2 закороткий');
    await expect(page.getByTestId('duct-segment-1')).toHaveClass(/duct-segment--problem/);
  });

  test('прямокутний: поворот у площині сторін — без зауважень; не в площині сторін — пояснення', async ({ page }) => {
    await openWith(page, OFFSET);
    await page.getByTestId('duct-shape-rect').click();
    await page.getByTestId('duct-width').fill('400');
    await page.getByTestId('duct-height').fill('250');
    await page.getByTestId('duct-apply-rect').click();
    await frames(page);
    expect((await state(page)).ducts.routes[0].problems).toEqual([]);
    await expect(page.getByTestId('duct-problems')).toHaveCount(0);
    // Висота 250 — вертикально навколо осі траси.
    const box = (await page.evaluate(() => window.__trasa!.app!.ductBox(1)))!;
    expect(Math.abs(box.min.y - 1375)).toBeLessThan(0.5);
    expect(Math.abs(box.max.y - 1625)).toBeLessThan(0.5);

    // По X, потім діагональ Y+Z+: вісь повороту не збігається зі стороною труби.
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({
        routes: [
          {
            id: 1,
            nodes: [
              { x: -1500, y: 600, z: -900 },
              { x: 0, y: 600, z: -900 },
              { x: 0, y: 1800, z: 300 },
            ],
            duct: { section: { shape: 'rect', widthMm: 400, heightMm: 250 }, transitions: [] },
          },
        ],
        nextId: 2,
      }),
    );
    await frames(page);
    await expect(page.getByTestId('duct-problems')).toContainText('не в площині своїх сторін');
    await expect(page.getByTestId('duct-problems')).toContainText('Поворот між відрізками 1 і 2');
    // Для круглої труби це звичайне коліно 90°.
    await page.getByTestId('duct-shape-round').click();
    await page.getByTestId('duct-diameter').selectOption('200');
    await frames(page);
    await expect(page.getByTestId('duct-problems')).toHaveCount(0);
  });
});

test.describe('Скріншоти: повороти 45°', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme === 'light' ? 'світла тема' : 'темна тема', () => {
      test.use({ colorScheme });

      test('вибір другої осі, діагональний відрізок, труба з колінами 45°', async ({ page }, testInfo) => {
        const shot = (name: string) =>
          page.screenshot({ path: `test-results/screenshots/stage41-${testInfo.project.name.replace(/\s+/g, '-')}-${colorScheme}-${name}.png` });
        await startPull(page);
        await pull(page, 'X', 1, 700);
        await shown(page, 'segment-45').click();
        await expect(shown(page, 'segment-45-picker')).toBeVisible();
        await shot('45-picker');
        await shown(page, 'segment-45-z-plus').click();
        await frames(page, 4);
        await shot('45-diagonal');
        await confirm(page);
        // Після діагоналі X+Z+ — прямо по X (45°), далі підйом під 45° (X+, «Y вгору»).
        await pull(page, 'X', 1, 500);
        await confirm(page);
        await pull(page, 'X', 1, 500);
        await choose45(page, 'y-plus');
        await frames(page, 4);
        await shot('45-rise');

        // Труби: завершити трасу, відкрити «Повітропровід», підставити траси з колінами 45°.
        await confirm(page);
        await page.getByTestId('route-finish').click();
        await page.getByTestId('duct').click();
        await expect(page.getByTestId('duct-panel')).toBeVisible();
        await page.evaluate(() =>
          window.__trasa!.app!.loadRoutes({
            routes: [
              {
                id: 1,
                nodes: [
                  { x: -1500, y: 1500, z: -800 },
                  { x: -500, y: 1500, z: -800 },
                  { x: 500, y: 1500, z: 200 },
                  { x: 1300, y: 1500, z: 200 },
                  { x: 1700, y: 1900, z: 200 },
                ],
                duct: { section: { shape: 'round', diameterMm: 250 }, transitions: [] },
              },
              {
                id: 2,
                nodes: [
                  { x: -1500, y: 600, z: 900 },
                  { x: -300, y: 600, z: 900 },
                  { x: 500, y: 600, z: 100 },
                  { x: 1500, y: 600, z: 100 },
                ],
                duct: { section: { shape: 'rect', widthMm: 400, heightMm: 250 }, transitions: [] },
              },
            ],
            nextId: 3,
          }),
        );
        await page.getByTestId('duct-route-2').click();
        await page.evaluate(() => window.__trasa!.viewer.setView({ x: 1.6, y: 3.6, z: 3.6 }, { x: 0, y: 1.1, z: 0 }));
        await frames(page, 6);
        await shot('45-ducts');
      });
    });
  }
});
