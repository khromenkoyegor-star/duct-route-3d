/**
 * Етап 4 (tester): повітропровід у браузері — за «Критеріями готовності» і крайові випадки.
 * Тестова кімната 4000 × 2700 × 3000 мм; траси — через app.loadRoutes (мм) або інструментом «Траса».
 * Не дублює duct.spec.ts: тут габарит ±0,1 мм уздовж X/Y/Z, вісь на трасі на поворотах X→Z, X→Y (вгору/вниз),
 * Y→Z, переходи на першому/останньому/кількох відрізках, зміна розміру після переходів, неправильні Ш × В
 * (і для переходу), «потрібно / є» з переходом, режими показу (зокрема під час побудови траси),
 * прозорість скану після відкриття іншого скану, звільнення геометрій, перекриття труб при виборі дотиком,
 * видалення траси з вибраним відрізком, питання «не завершена», NaN/поза правилами в loadRoutes, 600 точок.
 *
 * Сцену Three.js бачимо через стандартний хук __THREE_DEVTOOLS__ (Three.js сам повідомляє про Scene і
 * WebGLRenderer): матеріали скану, меші повітропроводів, dispose геометрій. Код додатка не змінюється.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { BufferGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, WebGLRenderer } from 'three';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));
const ROOM_GLB = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.glb', import.meta.url));

type P3 = { x: number; y: number; z: number };
type Section = { shape: 'round'; diameterMm: number } | { shape: 'rect'; widthMm: number; heightMm: number };
type Spec = { section: Section; transitions: Array<{ segment: number; to: Section }> };
type RouteIn = { id: number; nodes: P3[]; duct?: Spec | null };

interface Hooked {
  __scenes: Scene[];
  __renderer?: WebGLRenderer;
  __disposed?: Set<string>;
}

const TOL = 0.1;
const round = (d: number): Section => ({ shape: 'round', diameterMm: d });
const rect = (w: number, h: number): Section => ({ shape: 'rect', widthMm: w, heightMm: h });

/** Ставиться до запуску додатка: Three.js сам віддає Scene і WebGLRenderer у __THREE_DEVTOOLS__. */
function installHook(): void {
  const w = window as unknown as Hooked & { __THREE_DEVTOOLS__: EventTarget };
  w.__scenes = [];
  const hub = new EventTarget();
  hub.addEventListener('observe', (e) => {
    const d = (e as CustomEvent).detail as { isScene?: boolean; isWebGLRenderer?: boolean };
    if (d?.isScene) w.__scenes.push(d as unknown as Scene);
    if (d?.isWebGLRenderer) w.__renderer = d as unknown as WebGLRenderer;
  });
  w.__THREE_DEVTOOLS__ = hub;
}

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const ducts = async (page: Page) => (await state(page)).ducts;
const box = (page: Page, id: number) => page.evaluate((i) => window.__trasa!.app!.ductBox(i), id);

/** Матеріали скану (усі меші під «scan-group»). */
const scanMaterials = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Hooked;
    const scene = w.__scenes.find((s) => s.getObjectByName('scan-group'))!;
    const out: Array<{ uuid: string; type: string; transparent: boolean; opacity: number; depthWrite: boolean; envMap: boolean }> = [];
    scene.getObjectByName('scan-group')!.traverse((o: Object3D) => {
      const m = (o as Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        out.push({
          uuid: x.uuid,
          type: x.type,
          transparent: x.transparent,
          opacity: x.opacity,
          depthWrite: x.depthWrite,
          envMap: !!(x as MeshBasicMaterial).envMap,
        });
      }
    });
    return out;
  });

/** Меші повітропроводів у групі «ducts». */
const ductMeshes = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Hooked;
    const scene = w.__scenes.find((s) => s.getObjectByName('ducts'));
    const group = scene?.getObjectByName('ducts');
    return {
      visible: group?.visible ?? null,
      meshes: (group?.children ?? []).map((c) => {
        const m = c as Mesh;
        return {
          name: m.name,
          uuid: (m.geometry as BufferGeometry).uuid,
          triangles: m.geometry.getAttribute('position').count / 3,
          color: (m.material as MeshBasicMaterial).color.getHex(),
        };
      }),
      gpuGeometries: w.__renderer?.info.memory.geometries ?? null,
    };
  });

/** Почати стежити за dispose усіх теперішніх геометрій повітропроводів. */
const trackDispose = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Hooked;
    w.__disposed ??= new Set();
    const group = w.__scenes.find((s) => s.getObjectByName('ducts'))!.getObjectByName('ducts')!;
    const ids: string[] = [];
    for (const c of group.children) {
      const g = (c as Mesh).geometry as BufferGeometry;
      ids.push(g.uuid);
      g.addEventListener('dispose', () => w.__disposed!.add(g.uuid));
    }
    return ids;
  });
const disposed = (page: Page) => page.evaluate(() => [...((window as unknown as Hooked).__disposed ?? [])]);

async function openRoom(page: Page, routes: RouteIn[] = []) {
  await page.addInitScript(installHook);
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready');
  await page.evaluate(() => window.__trasa!.viewer.setView({ x: 3.2, y: 3.4, z: 5.2 }, { x: 0, y: 1.4, z: 0 }));
  if (routes.length > 0) await load(page, routes);
}

const load = (page: Page, routes: RouteIn[]) =>
  page.evaluate((r) => window.__trasa!.app!.loadRoutes({ routes: r, nextId: Math.max(0, ...r.map((x) => x.id)) + 1 }), routes);

/** loadRoutes, що має бути відхилений: повертає текст помилки або null (не відхилено). */
const tryLoad = (page: Page, payload: unknown) =>
  page.evaluate((p) => {
    try {
      window.__trasa!.app!.loadRoutes(p as Parameters<NonNullable<NonNullable<typeof window.__trasa>['app']>['loadRoutes']>[0]);
      return null;
    } catch (error) {
      return String(error);
    }
  }, payload);

async function openPanel(page: Page) {
  await page.getByTestId('duct').click();
  await expect(page.getByTestId('duct-panel')).toBeVisible();
}

const setDiameter = (page: Page, d: number) => page.getByTestId('duct-diameter').selectOption(String(d));

/** Чи намальовано лінію i-ї завершеної траси (порядок — як у наборі трас) і лінію траси, яку будують. */
const lines = (page: Page) =>
  page.evaluate(async () => {
    // Шар трас малюється щокадру — чекаємо два кадри.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shown = (g: Element | undefined) => {
      const line = g?.querySelector('.route-line:not(.route-line--pending):not(.route-line--segment)');
      return !!line && getComputedStyle(line).display !== 'none' && (line.getAttribute('d') ?? '').length > 4;
    };
    const layer = document.querySelector<HTMLElement>('[data-testid="route-layer"]')!;
    const visible = !layer.hidden && getComputedStyle(layer).display !== 'none';
    const groups = [...layer.querySelectorAll('svg > g.route')];
    return {
      visible,
      routes: groups.filter((g) => !g.classList.contains('route--draft')).map((g) => visible && shown(g)),
      draft: visible && shown(groups.find((g) => g.classList.contains('route--draft'))),
    };
  });

async function setRect(page: Page, w: string, h: string) {
  await page.getByTestId('duct-shape-rect').click();
  await page.getByTestId('duct-width').fill(w);
  await page.getByTestId('duct-height').fill(h);
  await page.getByTestId('duct-apply-rect').click();
}

async function roundTransition(page: Page, segment: number, d: number) {
  await page.getByTestId(`duct-segment-${segment}`).click();
  await page.getByTestId('duct-transition-diameter').selectOption(String(d));
  await page.getByTestId('duct-transition-here').click();
}

function build(start: P3, legs: Array<[keyof P3, number]>): P3[] {
  const out = [start];
  for (const [k, l] of legs) {
    const p = { ...out.at(-1)! };
    p[k] += l;
    out.push(p);
  }
  return out;
}

function expectBox(actual: { min: P3; max: P3 } | null, min: P3, max: P3, tag: string) {
  expect(actual, tag).not.toBeNull();
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(actual!.min[k] - min[k]), `${tag}: min.${k} = ${actual!.min[k]}, очікувалось ${min[k]}`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(actual!.max[k] - max[k]), `${tag}: max.${k} = ${actual!.max[k]}, очікувалось ${max[k]}`).toBeLessThanOrEqual(TOL);
  }
}

/** Траса під стелею: 2500 по +X → 1800 по +Z → 1000 вниз (як у duct.spec.ts). */
const ROUTE: P3[] = [
  { x: -1500, y: 2200, z: -1000 },
  { x: 1000, y: 2200, z: -1000 },
  { x: 1000, y: 2200, z: 800 },
  { x: 1000, y: 1200, z: 800 },
];

test.describe('Етап 4 (tester): критерії готовності', () => {
  test('Ø200, відрізок 1000 мм уздовж X, Y і Z (через панель) → габарит 1000 × 200 × 200 ±0,1 мм, вісь на трасі', async ({ page }) => {
    const routes: RouteIn[] = [
      { id: 1, nodes: build({ x: -500, y: 1500, z: 0 }, [['x', 1000]]) },
      { id: 2, nodes: build({ x: 1500, y: 500, z: -500 }, [['y', 1000]]) },
      { id: 3, nodes: build({ x: -1500, y: 1000, z: 700 }, [['z', -1000]]) },
    ];
    await openRoom(page, routes);
    await openPanel(page);
    for (const r of routes) {
      await page.getByTestId(`duct-route-${r.id}`).click();
      await setDiameter(page, 200);
      const [a, b] = r.nodes as [P3, P3];
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
      for (const k of ['x', 'y', 'z'] as const) {
        if (a[k] === b[k]) {
          lo[k] -= 100;
          hi[k] += 100;
        }
      }
      expectBox(await box(page, r.id), lo, hi, `траса ${r.id}`);
    }
    expect((await ducts(page)).routes.map((r: { sections: string[] }) => r.sections)).toEqual([['Ø200'], ['Ø200'], ['Ø200']]);
  });

  test('вісь повітропроводу на трасі: X→Z, X→Y вгору, X→Y вниз, Y→Z — габарит ±0,1 мм (Ø100, Ø250, Ø450)', async ({ page }) => {
    const P0 = { x: -1200, y: 1500, z: -600 };
    const L = 1400;
    const cases: Array<[string, Array<[keyof P3, number]>]> = [
      ['X→Z', [['x', L], ['z', L]]],
      ['X→Y вгору', [['x', L], ['y', L]]],
      ['X→Y вниз', [['x', L], ['y', -L]]],
      ['Y→Z', [['y', L], ['z', L]]],
    ];
    await openRoom(page);
    for (const D of [100, 250, 450]) {
      const routes: RouteIn[] = cases.map(([, legs], i) => ({ id: i + 1, nodes: build(P0, legs), duct: { section: round(D), transitions: [] } }));
      await load(page, routes);
      for (const [i, [tag, legs]] of cases.entries()) {
        const nodes = routes[i]!.nodes;
        const r = D / 2;
        const [k1, s1] = [legs[0]![0], Math.sign(legs[0]![1])];
        const [k2] = [legs[1]![0]];
        const corners: P3[] = [nodes[0]!, nodes[2]!];
        const c1 = { ...nodes[1]! };
        c1[k1] += s1 * r; // коліно не виходить за зовнішню стінку другої прямої
        corners.push(c1);
        const c2 = { ...nodes[1]! };
        c2[k2] -= Math.sign(legs[1]![1]) * r; // і за зовнішню стінку першої
        corners.push(c2);
        const k3 = (['x', 'y', 'z'] as const).find((k) => k !== k1 && k !== k2)!;
        const lo = { x: Infinity, y: Infinity, z: Infinity };
        const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const p of corners) {
          for (const k of ['x', 'y', 'z'] as const) {
            lo[k] = Math.min(lo[k], p[k]);
            hi[k] = Math.max(hi[k], p[k]);
          }
        }
        lo[k3] -= r;
        hi[k3] += r;
        expectBox(await box(page, i + 1), lo, hi, `Ø${D} ${tag}`);
      }
      const d = await ducts(page);
      expect(d.routes.every((x: { problems: unknown[] }) => x.problems.length === 0)).toBe(true);
    }
  });

  test('прямокутні 600×200 на поворотах X→Z, X→Y, Y→Z: габарит з урахуванням повороту перерізу (±0,1 мм)', async ({ page }) => {
    const P0 = { x: -1200, y: 1200, z: -600 };
    const W = 600;
    const H = 200;
    const routes: RouteIn[] = [
      { id: 1, nodes: build(P0, [['x', 2000], ['z', 2000]]), duct: { section: rect(W, H), transitions: [] } },
      { id: 2, nodes: build(P0, [['x', 2000], ['y', 2000]]), duct: { section: rect(W, H), transitions: [] } },
      { id: 3, nodes: build(P0, [['y', 2000], ['z', 2000]]), duct: { section: rect(W, H), transitions: [] } },
    ];
    await openRoom(page, routes);
    const n = (i: number) => routes[i]!.nodes;
    // X→Z: Ш (600) горизонтально, В (200) вертикально; повертає Ш.
    expectBox(
      await box(page, 1),
      { x: n(0)[0]!.x, y: P0.y - H / 2, z: P0.z - W / 2 },
      { x: n(0)[1]!.x + W / 2, y: P0.y + H / 2, z: n(0)[2]!.z },
      'X→Z',
    );
    // X→Y: повертає В; після підйому В уздовж X, Ш — по Z.
    expectBox(
      await box(page, 2),
      { x: n(1)[0]!.x, y: P0.y - H / 2, z: P0.z - W / 2 },
      { x: n(1)[1]!.x + H / 2, y: n(1)[2]!.y, z: P0.z + W / 2 },
      'X→Y',
    );
    // Y→Z (траса починається вертикально): Ш уздовж X, В уздовж Z; повертає В; далі В вертикально.
    expectBox(
      await box(page, 3),
      { x: P0.x - W / 2, y: P0.y, z: P0.z - H / 2 },
      { x: P0.x + W / 2, y: n(2)[1]!.y + H / 2, z: n(2)[2]!.z },
      'Y→Z',
    );
  });

  test('прямокутні через панель: 400×250 уздовж Z → Ш по X, В по Y; межі 50 і 3000 приймаються', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: build({ x: 0, y: 1300, z: -1000 }, [['z', 2000]]) }]);
    await openPanel(page);
    await setRect(page, '400', '250');
    expect((await ducts(page)).routes[0].duct.section).toEqual(rect(400, 250));
    expectBox(await box(page, 1), { x: -200, y: 1175, z: -1000 }, { x: 200, y: 1425, z: 1000 }, '400×250');
    await setRect(page, '50', '3000');
    expect((await ducts(page)).routes[0].duct.section).toEqual(rect(50, 3000));
    await expect(page.getByTestId('duct-message')).toHaveCount(0);
  });

  test('перехід: на єдиному відрізку траси з 2 точок і на останньому відрізку; торці — свого розміру', async ({ page }) => {
    await openRoom(page, [
      { id: 1, nodes: build({ x: -1500, y: 1500, z: 0 }, [['x', 2500]]) },
      { id: 2, nodes: ROUTE },
    ]);
    await openPanel(page);
    await setDiameter(page, 200);
    await roundTransition(page, 0, 400);
    let d = await ducts(page);
    expect(d.routes[0].duct.transitions).toEqual([{ segment: 0, to: round(400) }]);
    expect(d.routes[0].sections).toEqual(['Ø400']);
    await expect(page.getByTestId('duct-segment-0')).toContainText('перехід Ø200 → Ø400');
    // Від першої точки до останньої; найбільший переріз — новий (Ø400).
    expectBox(await box(page, 1), { x: -1500, y: 1300, z: -200 }, { x: 1000, y: 1700, z: 200 }, '2 точки, перехід');

    await page.getByTestId('duct-route-2').click();
    await setDiameter(page, 200);
    await roundTransition(page, 2, 100);
    d = await ducts(page);
    expect(d.routes[1].sections).toEqual(['Ø200', 'Ø200', 'Ø100']);
    expect(d.routes[1].problems).toEqual([]);
    await expect(page.getByTestId('duct-transitions')).toContainText('Перехід на відрізку 3: Ø200 → Ø100');
  });

  test('кілька переходів поспіль, потім зміна розміру траси (та сама форма — лишаються, інша — зникають)', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: ROUTE }]);
    await openPanel(page);
    await setDiameter(page, 200);
    await roundTransition(page, 1, 250);
    await roundTransition(page, 2, 315);
    let d = await ducts(page);
    expect(d.routes[0].sections).toEqual(['Ø200', 'Ø250', 'Ø315']);
    expect(d.routes[0].duct.transitions).toEqual([
      { segment: 1, to: round(250) },
      { segment: 2, to: round(315) },
    ]);
    // Розмір траси (від початку) інший, тієї самої форми — переходи лишаються.
    await setDiameter(page, 160);
    d = await ducts(page);
    expect(d.routes[0].sections).toEqual(['Ø160', 'Ø250', 'Ø315']);
    // Розмір траси = розміру після першого переходу — цей перехід зникає (він «на той самий»); спершу питання.
    await setDiameter(page, 250);
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-cancel').click();
    d = await ducts(page);
    expect(d.routes[0].sections, '«Скасувати» — нічого не змінилось').toEqual(['Ø160', 'Ø250', 'Ø315']);
    await setDiameter(page, 250);
    await page.getByTestId('choice-ok').click();
    d = await ducts(page);
    expect(d.routes[0].sections).toEqual(['Ø250', 'Ø250', 'Ø315']);
    expect(d.routes[0].duct.transitions).toEqual([{ segment: 2, to: round(315) }]);
    // Інша форма — переходи прибираються (теж після питання).
    await setRect(page, '500', '300');
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-ok').click();
    d = await ducts(page);
    expect(d.routes[0].duct).toEqual({ section: rect(500, 300), transitions: [] });
    await expect(page.getByTestId('duct-transitions')).toHaveCount(0);
    // І назад на круглі — переходи не «повертаються».
    await page.getByTestId('duct-shape-round').click();
    await setDiameter(page, 200);
    d = await ducts(page);
    expect(d.routes[0].duct).toEqual({ section: round(200), transitions: [] });
  });

  test('неправильні Ш × В (0, 10, 3001, abc, 1.5, порожньо, −500, 1e3, 49) — пояснення, розмір не змінюється', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: ROUTE }]);
    await openPanel(page);
    await setRect(page, '500', '300');
    for (const bad of ['0', '10', '3001', 'abc', '1.5', '', '-500', '1e3', '49']) {
      for (const which of ['w', 'h'] as const) {
        await setRect(page, which === 'w' ? bad : '400', which === 'h' ? bad : '400');
        await expect(page.getByTestId('duct-message'), `«${bad}» у полі ${which}`).toContainText('від 50 до 3000 мм');
        expect((await ducts(page)).routes[0].duct.section, `«${bad}»`).toEqual(rect(500, 300));
      }
    }
  });

  test('перехід у прямокутних: неправильні розміри і «на той самий розмір» — зрозуміле пояснення, без помилок сторінки', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoom(page, [{ id: 1, nodes: ROUTE }]);
    await openPanel(page);
    await setRect(page, '500', '300');
    await page.getByTestId('duct-segment-1').click();
    for (const [w, h] of [
      ['abc', '300'],
      ['500', '3001'],
      ['1.5', '300'],
    ]) {
      await page.getByTestId('duct-transition-width').fill(w!);
      await page.getByTestId('duct-transition-height').fill(h!);
      await page.getByTestId('duct-transition-here').click();
      await expect(page.getByTestId('duct-message')).toContainText('від 50 до 3000 мм');
    }
    // Той самий розмір, що й до переходу (поля підставляють поточний 500 × 300 — достатньо натиснути «Перехід тут»).
    await page.getByTestId('duct-transition-width').fill('500');
    await page.getByTestId('duct-transition-height').fill('300');
    await page.getByTestId('duct-transition-here').click();
    await page.waitForTimeout(100);
    expect(errors, 'необроблені помилки сторінки').toEqual([]);
    await expect(page.getByTestId('duct-message'), 'має бути пояснення «на інший розмір»').toBeVisible();
    expect((await ducts(page)).routes[0].duct.transitions).toEqual([]);
    // А на інший — ставиться.
    await page.getByTestId('duct-transition-width').fill('400');
    await page.getByTestId('duct-transition-height').fill('300');
    await page.getByTestId('duct-transition-here').click();
    expect((await ducts(page)).routes[0].sections).toEqual(['500×300', '400×300', '400×300']);
  });

  test('закороткий відрізок через перехід: червоний рядок, «потрібно R + L + R / є», червона підсвітка на сцені', async ({ page }) => {
    await openRoom(page, [
      {
        id: 1,
        nodes: [
          { x: -1500, y: 2000, z: -400 },
          { x: 0, y: 2000, z: -400 },
          { x: 0, y: 2000, z: 400 },
          { x: 1500, y: 2000, z: 400 },
        ],
      },
    ]);
    await openPanel(page);
    await setDiameter(page, 200);
    expect((await ducts(page)).routes[0].problems).toEqual([]);
    expect((await ductMeshes(page)).meshes.filter((m) => m.color === 0xff3b30)).toHaveLength(0);
    await roundTransition(page, 1, 450);
    const L = 250 / (2 * Math.tan(Math.PI / 12));
    const p = (await ducts(page)).routes[0].problems;
    expect(p).toHaveLength(1);
    expect(p[0].segment).toBe(1);
    expect(Math.abs(p[0].needMm - (200 + L + 450))).toBeLessThanOrEqual(TOL);
    expect(p[0].haveMm).toBe(800);
    await expect(page.getByTestId('duct-problems')).toContainText(/Відрізок 2 закороткий.*потрібно щонайменше 1\s116,5\sмм, є 800\sмм/);
    await expect(page.getByTestId('duct-segment-1')).toContainText(/треба 1\s116,5\sмм, є 800\sмм/);
    await expect(page.getByTestId('duct-segment-1')).toHaveClass(/duct-segment--problem/);
    const red = (await ductMeshes(page)).meshes.filter((m) => m.color === 0xff3b30);
    expect(red, 'червона підсвітка закороткого відрізка').toHaveLength(1);
    await trackDispose(page);
    await page.getByTestId('duct-transition-1-remove').click();
    expect((await ducts(page)).routes[0].problems).toEqual([]);
    expect((await ductMeshes(page)).meshes.filter((m) => m.color === 0xff3b30)).toHaveLength(0);
    expect(await disposed(page)).toContain(red[0]!.uuid);
  });

  test('режими «Траса / Повітропровід / Обидва»: лінії й 3D як вибрано (траса без труби — лінією); режим лишається після закриття панелі', async ({ page }) => {
    await openRoom(page, [
      { id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } },
      { id: 2, nodes: build({ x: -1700, y: 1000, z: 1200 }, [['x', 1400]]) },
    ]);
    await openPanel(page);
    const check = async (mode: string, line1: boolean, duct: boolean) => {
      await page.getByTestId(`view-mode-${mode}`).click();
      expect((await ducts(page)).mode).toBe(mode);
      await expect(page.getByTestId(`view-mode-${mode}`)).toHaveAttribute('aria-pressed', 'true');
      const l = await lines(page);
      expect(l.routes, `${mode}: лінії трас (Траса 1 з трубою, Траса 2 без)`).toEqual([line1, true]);
      expect((await ductMeshes(page)).visible, `${mode}: 3D`).toBe(duct);
    };
    await check('route', true, false);
    await check('duct', false, true);
    await check('both', true, true);
    await check('duct', false, true);
    await page.getByTestId('duct-close').click();
    expect((await ducts(page)).mode).toBe('duct');
    expect((await lines(page)).routes).toEqual([false, true]);
    expect((await ductMeshes(page)).visible).toBe(true);
    // Знову відкрита панель показує той самий режим.
    await openPanel(page);
    await expect(page.getByTestId('view-mode-duct')).toHaveAttribute('aria-pressed', 'true');
  });

  test('режим «Повітропровід» під час побудови траси: лінію траси, яку будують, видно; нова траса (без труби) — лінією', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } }]);
    await openPanel(page);
    await page.getByTestId('view-mode-duct').click();
    await page.getByTestId('duct-close').click();
    expect((await lines(page)).routes).toEqual([false]);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
    await page.getByTestId('route').click();
    await expect(page.getByTestId('route-panel')).toBeVisible();
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    await expect(page.getByTestId('point-editor').filter({ visible: true })).toBeVisible();
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    // Тягнемо точку повзунком (вгору) і підтверджуємо — є відрізок.
    const stick = (await page.getByTestId('stick-y').filter({ visible: true }).boundingBox())!;
    await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
    await page.mouse.down();
    await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2 - 58, { steps: 3 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    expect((await lines(page)).draft, 'лінія траси, яку будують').toBe(true);
    await page.getByTestId('route-finish').click();
    expect((await state(page)).routes.set.routes).toHaveLength(2);
    expect((await lines(page)).routes, 'Траса 1 (з трубою) — без лінії; нова Траса 2 (без труби) — лінією').toEqual([false, true]);
  });

  test('прозорість скану: матеріали скану; лишається після відкриття іншого скану; 0 — знову непрозорий', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } }]);
    let mats = await scanMaterials(page);
    expect(mats.length).toBeGreaterThan(0);
    // Скан — MeshBasicMaterial без envMap (освітлення металу на нього не впливає).
    for (const m of mats) {
      expect(m.type).toBe('MeshBasicMaterial');
      expect(m.envMap).toBe(false);
      expect(m.transparent).toBe(false);
      expect(m.depthWrite).toBe(true);
    }
    await openPanel(page);
    await page.getByTestId('scan-opacity').fill('60');
    await expect(page.getByTestId('duct-panel')).toContainText(/Прозорість скану:?\s*60\s*%/);
    for (const m of await scanMaterials(page)) {
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBeCloseTo(0.4, 6);
      expect(m.depthWrite).toBe(false);
    }
    const before = new Set(mats.map((m) => m.uuid));
    // Інший скан (GLB) — без панелі, як після «Відкрити».
    await page.getByTestId('file-input').setInputFiles(ROOM_GLB);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready' && window.__trasa.app.state.scanName?.endsWith('.glb'));
    mats = await scanMaterials(page);
    expect(mats.some((m) => before.has(m.uuid)), 'це матеріали нового скану').toBe(false);
    for (const m of mats) {
      expect(m.transparent, 'новий скан — теж прозорий').toBe(true);
      expect(m.opacity).toBeCloseTo(0.4, 6);
      expect(m.depthWrite).toBe(false);
    }
    expect((await ducts(page)).transparency).toBeCloseTo(0.6, 6);
    // Панель показує ту саму прозорість; 0 — скан знову непрозорий.
    await load(page, [{ id: 1, nodes: ROUTE }]);
    await openPanel(page);
    await expect(page.getByTestId('scan-opacity')).toHaveValue('60');
    await page.getByTestId('scan-opacity').fill('0');
    for (const m of await scanMaterials(page)) {
      expect(m.transparent).toBe(false);
      expect(m.opacity).toBe(1);
      expect(m.depthWrite).toBe(true);
    }
    // 90 % — максимум.
    await page.getByTestId('scan-opacity').fill('90');
    for (const m of await scanMaterials(page)) expect(m.opacity).toBeCloseTo(0.1, 6);
  });

  test('пам’ять: видалення траси з вибраним відрізком і відкриття іншого скану — меші прибрані, геометрії dispose, triangles → 0', async ({ page }) => {
    await openRoom(page);
    const gpu0 = (await ductMeshes(page)).gpuGeometries;
    await load(page, [
      { id: 1, nodes: ROUTE, duct: { section: round(250), transitions: [{ segment: 1, to: round(160) }] } },
      { id: 2, nodes: build({ x: -1700, y: 1000, z: 1200 }, [['x', 1400], ['y', 1300]]), duct: { section: rect(400, 250), transitions: [] } },
    ]);
    const t2 = (await ductMeshes(page)).meshes.find((m) => m.name === 'duct-2')!.triangles;
    await openPanel(page);
    await page.getByTestId('duct-segment-1').click();
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 1 });
    // Є синя підсвітка вибраного відрізка.
    expect((await ductMeshes(page)).meshes.some((m) => m.color === 0x0a84ff)).toBe(true);
    const tracked = await trackDispose(page);
    expect(tracked.length).toBeGreaterThanOrEqual(3);
    // Видалити Трасу 1 (вибраний відрізок — її).
    await page.getByTestId('route-delete').click();
    await page.getByTestId('route-row-1').click();
    await page.getByTestId('route-delete-confirm').click();
    let d = await ducts(page);
    expect(d.routes.map((r: { id: number }) => r.id)).toEqual([2]);
    expect(d.triangles).toBe(t2);
    let meshes = await ductMeshes(page);
    expect(meshes.meshes.map((m) => m.name)).toEqual(['duct-2']);
    const gone = tracked.filter((id) => !meshes.meshes.some((m) => m.uuid === id));
    expect(gone.length).toBeGreaterThanOrEqual(2);
    expect(new Set(await disposed(page))).toEqual(new Set(gone));
    // Панель знову: вибрана Траса 2, без «завислого» вибору відрізка Траси 1.
    await page.getByTestId('route-delete-close').click();
    await openPanel(page);
    expect((await ducts(page)).selection).toEqual({ routeId: 2, segment: null });
    // Інший скан — усе прибрано.
    await trackDispose(page);
    await page.getByTestId('file-input').setInputFiles(ROOM_GLB);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready' && window.__trasa.app.state.scanName?.endsWith('.glb'));
    d = await ducts(page);
    expect(d.triangles).toBe(0);
    expect(d.routes).toEqual([]);
    meshes = await ductMeshes(page);
    expect(meshes.meshes).toEqual([]);
    const all = await disposed(page);
    for (const id of tracked) expect(all, 'кожна геометрія повітропроводу звільнена (dispose)').toContain(id);
    // Відеопам'ять (для звіту): геометрій на GPU до повітропроводів і після іншого скану.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const gpu1 = (await ductMeshes(page)).gpuGeometries;
    test.info().annotations.push({ type: 'GPU-геометрії', description: `до повітропроводів: ${gpu0}, після іншого скану: ${gpu1}` });
  });

  test('траса з 600 точками: розмір, вибір відрізка, перехід — робота програми на дію в панелі < 1 с (перша < 1,5 с)', async ({ page }) => {
    const nodes: P3[] = [];
    for (let i = 0; i < 600; i++) {
      const step = Math.floor(i / 2);
      nodes.push({ x: -1500 + (step + (i % 2)) * 600, y: 2000, z: -1000 + step * 600 });
    }
    await openRoom(page, [{ id: 1, nodes }]);
    await openPanel(page);
    // Час обробника (JS) — синхронно в сторінці; «до 2-го кадру» — разом з малюванням (у headless — програмний WebGL).
    const timed = (label: string, action: string) =>
      page.evaluate(
        async ([l, a]) => {
          const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
          const pick = (id: string, v: string) => {
            const s = q(id) as HTMLSelectElement;
            s.value = v;
            s.dispatchEvent(new Event('change'));
          };
          const actions: Record<string, () => void> = {
            diameter: () => pick('duct-diameter', '200'),
            resize: () => pick('duct-diameter', '250'),
            segment: () => q('duct-segment-300').click(),
            transition: () => {
              pick('duct-transition-diameter', '160');
              q('duct-transition-here').click();
            },
            remove: () => q('duct-transition-300-remove').click(),
          };
          const t0 = performance.now();
          actions[a!]!();
          const js = performance.now() - t0;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { label: l!, js, frame: performance.now() - t0 };
        },
        [label, action] as const,
      );
    const results = [];
    results.push(await timed('Ø200 на всю трасу (перший раз)', 'diameter'));
    expect((await ducts(page)).triangles).toBeGreaterThan(100_000);
    results.push(await timed('Ø250 на всю трасу', 'resize'));
    results.push(await timed('вибір відрізка 301', 'segment'));
    results.push(await timed('перехід на Ø160', 'transition'));
    let d = await ducts(page);
    expect(d.routes[0].sections[299]).toBe('Ø250');
    expect(d.routes[0].sections[300]).toBe('Ø160');
    expect(d.routes[0].sections[598]).toBe('Ø160');
    expect(d.routes[0].problems).toEqual([]);
    results.push(await timed('прибрати перехід', 'remove'));
    d = await ducts(page);
    expect(d.routes[0].duct.transitions).toEqual([]);
    for (const r of results) {
      const text = `${r.label}: JS ${r.js.toFixed(0)} мс, до 2-го кадру ${r.frame.toFixed(0)} мс`;
      test.info().annotations.push({ type: 'час', description: text });
      console.log(`[${test.info().project.name}] ${text}`);
    }
    // Межі з запасом на завантажену машину (паралельні тести): перший раз — ще й освітлення металу (PMREM).
    // Без навантаження (Chromium, ноутбук): перший раз ≈ 0,35–0,4 с, далі ≈ 0,1–0,3 с.
    expect(results[0]!.js, results[0]!.label).toBeLessThan(1500);
    for (const r of results.slice(1)) expect(r.js, r.label).toBeLessThan(1000);
  });
});

test.describe('Етап 4 (tester): крайові випадки', () => {
  test('вибір дотиком, коли труби на екрані перекриваються: ближча до камери; повз тонку — товста за нею; промах вибору не знімає', async ({ page }) => {
    // Камера C, вісь тонкої ближньої труби N і товстої дальньої F — на одній прямій: на екрані труби одна на одній.
    const C = { x: 0, y: 2.6, z: 1.25 };
    const F = { x: 0, y: 1.8, z: -0.25 };
    const nearY = 2600 - (800 * 1) / 1.5; // на z = 0,25 м
    await openRoom(page, [
      { id: 1, nodes: build({ x: -1200, y: nearY, z: 250 }, [['x', 2400]]), duct: { section: round(100), transitions: [] } },
      { id: 2, nodes: build({ x: -1200, y: 1800, z: -250 }, [['x', 2400]]), duct: { section: round(450), transitions: [] } },
    ]);
    await openPanel(page); // вибрана Траса 1
    const geo = await page.evaluate(
      ([c, f, ny]) => {
        const viewer = window.__trasa!.viewer;
        viewer.setView(c!, f!);
        const panels = [...document.querySelectorAll<HTMLElement>('.panel, .toolbar, .view-bar')]
          .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0);
        const vw = innerWidth;
        const vh = innerHeight;
        const panel = document.querySelector<HTMLElement>('[data-testid="duct-panel"]')!.getBoundingClientRect();
        const area =
          panel.width > vw * 0.6
            ? { left: 0, right: vw, top: panel.bottom, bottom: Math.min(vh, ...panels.filter((r) => r.top > panel.bottom).map((r) => r.top)) }
            : { left: 0, right: panel.left, top: 60, bottom: vh - 60 };
        viewer.centerOn(f!, { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 });
        // Напрямок ⟂ погляду в площині YZ (на екрані — «вгору/вниз» від труб).
        const d = { y: f!.y - c!.y, z: f!.z - c!.z };
        const l = Math.hypot(d.y, d.z);
        const w = { x: 0, y: -d.z / l, z: d.y / l };
        const at = (p: { x: number; y: number; z: number }) => viewer.projectPoint(p);
        const N = { x: 0, y: ny! / 1000, z: 0.25 };
        const pF = at(f!);
        const pN = at(N);
        const farR = Math.hypot(at({ x: 0, y: f!.y + w.y * 0.225, z: f!.z + w.z * 0.225 }).x - pF.x, at({ x: 0, y: f!.y + w.y * 0.225, z: f!.z + w.z * 0.225 }).y - pF.y);
        const nearEdge = at({ x: 0, y: N.y + w.y * 0.05, z: N.z + w.z * 0.05 });
        const nearR = Math.hypot(nearEdge.x - pN.x, nearEdge.y - pN.y);
        const ux = (nearEdge.x - pN.x) / nearR;
        const uy = (nearEdge.y - pN.y) / nearR;
        return { pF, pN, farR, nearR, ux, uy };
      },
      [C, F, nearY] as const,
    );
    const onCanvas = (x: number, y: number) =>
      page.evaluate(([px, py]) => document.elementFromPoint(px!, py!) === window.__trasa!.viewer.canvas, [x, y]);
    expect(Math.hypot(geo.pF.x - geo.pN.x, geo.pF.y - geo.pN.y), 'на екрані осі труб збігаються').toBeLessThan(1);
    test.info().annotations.push({ type: 'радіуси на екрані', description: `Ø100: ${geo.nearR.toFixed(1)} px, Ø450: ${geo.farR.toFixed(1)} px` });
    // 1) На осі обох — ближча (Траса 1).
    expect(await onCanvas(geo.pF.x, geo.pF.y)).toBe(true);
    await page.mouse.click(Math.round(geo.pF.x), Math.round(geo.pF.y));
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 0 });
    // 2) Повз тонку (далі за її радіус + 22 px цілі для пальця), але всередині товстої — Траса 2.
    const offset = (geo.nearR + 22 + geo.farR) / 2;
    expect(geo.nearR + 22 + 4, 'товста труба на екрані ширша за ціль тонкої').toBeLessThan(geo.farR - 4);
    const t2 = { x: geo.pF.x + geo.ux * offset, y: geo.pF.y + geo.uy * offset };
    expect(await onCanvas(t2.x, t2.y)).toBe(true);
    await page.mouse.click(Math.round(t2.x), Math.round(t2.y));
    expect((await ducts(page)).selection).toEqual({ routeId: 2, segment: 0 });
    // 3) Повз обидві — вибір лишається.
    const miss = { x: geo.pF.x + geo.ux * (geo.farR + 60), y: geo.pF.y + geo.uy * (geo.farR + 60) };
    if (await onCanvas(miss.x, miss.y)) {
      await page.mouse.click(Math.round(miss.x), Math.round(miss.y));
      expect((await ducts(page)).selection).toEqual({ routeId: 2, segment: 0 });
    }
  });

  test('видалення траси, коли вибраний її відрізок (траси підмінили, панель відкрита) — вибір знімається, підсвітка прибрана', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoom(page, [
      { id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } },
      { id: 2, nodes: build({ x: -1700, y: 1000, z: 1200 }, [['x', 1400]]), duct: { section: round(160), transitions: [] } },
    ]);
    await openPanel(page);
    await page.getByTestId('duct-segment-2').click();
    expect((await ducts(page)).selection).toEqual({ routeId: 1, segment: 2 });
    await page.evaluate(() => {
      const app = window.__trasa!.app!;
      app.loadRoutes({ routes: app.state.routes.set.routes.filter((r) => r.id !== 1), nextId: 3 });
    });
    expect(errors).toEqual([]);
    const d = await ducts(page);
    expect(d.selection === null || d.selection.routeId !== 1).toBe(true);
    expect(d.routes.map((r: { id: number }) => r.id)).toEqual([2]);
    await expect(page.getByTestId('duct-route-1')).toHaveCount(0);
    const meshes = (await ductMeshes(page)).meshes;
    expect(meshes.map((m) => m.name)).toEqual(['duct-2']);
    // Відрізок з номером 2 у Трасі 2 не існує — нічого «не перескочило» на чужу трасу.
    await expect(page.getByTestId('duct-segment-2')).toHaveCount(0);
  });

  test('відкриття панелі під час побудови траси (≥ 2 точки) — питання «не завершена»: Скасувати / Зберегти / Видалити', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === 'iPhone 15 Pro Max',
      'iPhone вертикально: під час доведення точки нижні кнопки сховані (за задумом етапу 2) — кнопки «Труба» немає',
    );
    await openRoom(page, [{ id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } }]);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 2.5, y: 4, z: 9 }, { x: 0, y: 0.8, z: 0 }));
    const twoPoints = async () => {
      await page.getByTestId('route').click();
      const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
      await page.mouse.click(Math.round(p.x), Math.round(p.y));
      await page.getByTestId('confirm-point').filter({ visible: true }).click();
      const stick = (await page.getByTestId('stick-y').filter({ visible: true }).boundingBox())!;
      await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
      await page.mouse.down();
      await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2 - 58, { steps: 3 });
      await page.waitForTimeout(400);
      await page.mouse.up();
      await page.getByTestId('confirm-point').filter({ visible: true }).click();
      expect((await state(page)).routes.building.nodes).toHaveLength(2);
    };
    await twoPoints();
    await page.getByTestId('duct').click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await expect(page.getByTestId('choice')).toContainText('Траса 2 не завершена');
    await page.getByTestId('choice-cancel').click();
    expect((await state(page)).tool).toBe('route');
    expect((await state(page)).routes.building.nodes).toHaveLength(2);
    await expect(page.getByTestId('duct-panel')).toBeHidden();

    await page.getByTestId('duct').click();
    await page.getByTestId('choice-save').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
    let s = await state(page);
    expect(s.tool).toBe('duct');
    expect(s.routes.set.routes.map((r: { id: number }) => r.id)).toEqual([1, 2]);
    await expect(page.getByTestId('duct-route-2')).toBeVisible();
    await page.getByTestId('duct-route-2').click();
    await setDiameter(page, 125);
    expect((await ducts(page)).routes[1].sections).toEqual(['Ø125']);

    await page.getByTestId('duct-close').click();
    await twoPoints();
    await page.getByTestId('duct').click();
    await page.getByTestId('choice-discard').click();
    await expect(page.getByTestId('duct-panel')).toBeVisible();
    s = await state(page);
    expect(s.routes.set.routes.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });

  test('loadRoutes з NaN чи поза правилами (з duct) — відмова, траси й 3D не змінюються', async ({ page }) => {
    await openRoom(page, [{ id: 1, nodes: ROUTE, duct: { section: round(200), transitions: [] } }]);
    const before = await ducts(page);
    const nodes2 = build({ x: 0, y: 1000, z: 0 }, [['x', 1000], ['z', 1000]]);
    const bad: Array<[string, unknown]> = [
      ['NaN у вузлі', { routes: [{ id: 1, nodes: [{ x: 0, y: Number.NaN, z: 0 }, { x: 1000, y: 0, z: 0 }], duct: { section: round(200), transitions: [] } }], nextId: 2 }],
      ['NaN у діаметрі', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(Number.NaN), transitions: [] } }], nextId: 2 }],
      ['NaN у ширині', { routes: [{ id: 1, nodes: nodes2, duct: { section: rect(Number.NaN, 300), transitions: [] } }], nextId: 2 }],
      ['діаметр не зі списку', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(210), transitions: [] } }], nextId: 2 }],
      ['сторона 10 мм', { routes: [{ id: 1, nodes: nodes2, duct: { section: rect(10, 300), transitions: [] } }], nextId: 2 }],
      ['перехід на відрізку NaN', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(200), transitions: [{ segment: Number.NaN, to: round(250) }] } }], nextId: 2 }],
      ['перехід поза трасою', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(200), transitions: [{ segment: 2, to: round(250) }] } }], nextId: 2 }],
      ['перехід іншої форми', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(200), transitions: [{ segment: 1, to: rect(200, 200) }] } }], nextId: 2 }],
      ['перехід на той самий', { routes: [{ id: 1, nodes: nodes2, duct: { section: round(200), transitions: [{ segment: 1, to: round(200) }] } }], nextId: 2 }],
      ['форма «трикутна»', { routes: [{ id: 1, nodes: nodes2, duct: { section: { shape: 'triangle', diameterMm: 200 }, transitions: [] } }], nextId: 2 }],
      ['сторона рядком «500»', { routes: [{ id: 1, nodes: nodes2, duct: { section: { shape: 'rect', widthMm: '500', heightMm: 300 }, transitions: [] } }], nextId: 2 }],
      ['нульовий відрізок', { routes: [{ id: 1, nodes: [nodes2[0], nodes2[0]], duct: { section: round(200), transitions: [] } }], nextId: 2 }],
    ];
    for (const [tag, payload] of bad) {
      const error = await tryLoad(page, payload);
      expect(error, tag).not.toBeNull();
      const after = await ducts(page);
      expect(after.routes, tag).toEqual(before.routes);
      expect(after.triangles, tag).toBe(before.triangles);
      expect((await state(page)).routes.set.routes[0].nodes, tag).toEqual(ROUTE);
    }
    // Додаток і далі працює.
    await openPanel(page);
    await setDiameter(page, 315);
    expect((await ducts(page)).routes[0].sections).toEqual(['Ø315', 'Ø315', 'Ø315']);
  });

  test('loadRoutes: відхилення вузла 0,05 мм (у межах допуску траси ±0,1 мм) — або прийнято й побудовано, або відхилено без змін', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoom(page, [{ id: 1, nodes: ROUTE }]);
    const drift = [
      { x: 0, y: 1500, z: 0 },
      { x: 1000, y: 1500.05, z: 0 },
      { x: 1000, y: 1500.05, z: 1000 },
    ];
    const error = await tryLoad(page, { routes: [{ id: 1, nodes: drift, duct: { section: round(200), transitions: [] } }], nextId: 2 });
    const s = await state(page);
    if (error === null) {
      expect(s.ducts.routes[0].sections).toEqual(['Ø200', 'Ø200']);
      expect(s.ducts.triangles).toBeGreaterThan(0);
    } else {
      // Відхилено — тоді стан має лишитися попереднім (Траса 1 = ROUTE, без повітропроводу).
      expect(s.routes.set.routes[0].nodes, `відхилено (${error}), але траси вже підмінено`).toEqual(ROUTE);
      expect(s.ducts.routes[0].duct).toBeNull();
    }
    // Панель відкривається й працює без помилок.
    await openPanel(page);
    await setDiameter(page, 160);
    expect(errors).toEqual([]);
  });

  test('вузол без повороту, побудований інструментом «Траса» (X, далі знову X, потім Z) — повітропровід суцільний', async ({ page }, testInfo) => {
    await openRoom(page);
    await page.evaluate(() => window.__trasa!.viewer.setView({ x: 0.5, y: 6, z: 3 }, { x: 0, y: 0.3, z: 0 }));
    await page.getByTestId('route').click();
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -1.2, y: 0, z: -0.8 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    await page.getByTestId('confirm-point').filter({ visible: true }).click();
    const pull = async (axis: 'X' | 'Z', ms: number) => {
      const point = (await state(page)).routes.editor.point as P3;
      const axes = await page.evaluate((q) => window.__trasa!.viewer.screenAxes(q), point);
      const dir = axes[axis];
      const len = Math.hypot(dir.x, dir.y);
      const stick = (await page.getByTestId('stick-xz').filter({ visible: true }).boundingBox())!;
      const cx = stick.x + stick.width / 2;
      const cy = stick.y + stick.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + (64 * dir.x) / len, cy + (64 * dir.y) / len, { steps: 3 });
      await page.waitForTimeout(ms);
      await page.mouse.up();
      await page.waitForTimeout(60);
      await page.getByTestId('confirm-point').filter({ visible: true }).click();
      await page.waitForTimeout(60);
    };
    await pull('X', 1200);
    await pull('X', 1200);
    await pull('Z', 1200);
    const nodes = (await state(page)).routes.building.nodes as P3[];
    expect(nodes).toHaveLength(4);
    // Відрізки 1 і 2 — обидва по +X (вузол 2 — без повороту).
    expect(nodes[1]!.x).toBeGreaterThan(nodes[0]!.x + 150);
    expect(nodes[2]!.x).toBeGreaterThan(nodes[1]!.x + 150);
    expect(Math.abs(nodes[3]!.z - nodes[2]!.z)).toBeGreaterThan(150);
    await page.getByTestId('route-finish').click();
    expect((await state(page)).routes.set.routes).toHaveLength(1);
    await openPanel(page);
    await setDiameter(page, 100);
    const [n0, , n2, n3] = nodes as [P3, P3, P3, P3];
    testInfo.annotations.push({ type: 'вузли', description: JSON.stringify(nodes) });
    expectBox(
      await box(page, 1),
      { x: n0.x, y: n0.y - 50, z: Math.min(n0.z - 50, n3.z) },
      { x: n2.x + 50, y: n0.y + 50, z: Math.max(n0.z + 50, n3.z) },
      'X, X, Z (Ø100)',
    );
  });
});
