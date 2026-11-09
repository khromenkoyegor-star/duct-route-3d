/**
 * Етап 2 (tester): «Траса» — перевірка за «Критеріями готовності» і крайові випадки.
 * Тестова кімната 4000 × 2700 × 3000 мм. Не дублює route.spec.ts: тут — точність на різних видах камери
 * після довгих утримань, відповідність намальованого даним, підписи довжин, межа 0,1 мм, перехід через початок,
 * «Видалити останню точку» під час утримання, повзунок + джойстик разом, точка/траса за камерою,
 * інший скан і перемикання інструментів під час побудови, подвійні натискання, 500+ точок, номери трас.
 *
 * Утримання джойстика/повзунка — синтетичними дотиками (Pointer Events прямо на видимий елемент):
 * однаково в Chromium і WebKit. Для «дуже короткого відрізка» час (performance.now) зупиняється й
 * рухається вручну — довжина відрізка тоді точно відома.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { joystickLayout, nudgeSpeed } from '../../src/core/nudge.ts';
import { distance, isValidRoute, toM, type P3 } from '../../src/core/route.ts';
import type { Viewer } from '../../src/scene/viewer.ts';
import { STICK_TRAVEL_PX } from '../../src/ui/joystick.ts';

const ROOM_ZIP = fileURLToPath(new URL('../fixtures/room-4000x2700x3000.zip', import.meta.url));

type V2 = { x: number; y: number };
type Axis = 'X' | 'Y' | 'Z';
type Key = 'x' | 'y' | 'z';
const KEY: Record<Axis, Key> = { X: 'x', Y: 'y', Z: 'z' };

interface EditorJson {
  active: boolean;
  point: P3 | null;
  axis: string | null;
  segment: { anchor: P3; axis: Axis | null; lengthMm: number } | null;
  canConfirm: boolean;
}
interface RoutesJson {
  active: boolean;
  phase: string;
  set: { routes: Array<{ id: number; nodes: P3[] }>; nextId: number };
  building: { id: number; nodes: P3[] } | null;
  highlight: number | null;
  editor: EditorJson;
}
interface StateJson {
  status: string;
  tool: string;
  error: string | null;
  routes: RoutesJson;
  ruler: { active: boolean; phase: string; editor: { active: boolean } };
}

interface Sample {
  t: number;
  p: P3 | null;
  anchor: P3 | null;
}
interface Kit {
  el(id: string): HTMLElement;
  press(id: string, pointerId: number, offset: V2): void;
  move(pointerId: number, offset: V2): void;
  release(pointerId: number): void;
  frames(n: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  startSampling(): void;
  stopSampling(): Sample[];
  /** Зупинити «час» (performance.now) — далі він іде лише через advance. */
  freeze(): void;
  advance(ms: number): void;
  unfreeze(): void;
  /** Сумарний час обробників кадрів від запуску сторінки, мс. */
  busyMs(): number;
}
interface KitWindow {
  __kit: Kit;
}

/** Ставиться до запуску додатка. */
function installKit(): void {
  const w = window as unknown as KitWindow;
  const realNow = performance.now.bind(performance);
  let frozen: number | null = null;
  performance.now = () => frozen ?? realNow();
  // Скільки часу забирають обробники кадрів (requestAnimationFrame): сцена, шар трас, редактор точки.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let busy = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    nativeRaf((t: number) => {
      const start = realNow();
      try {
        cb(t);
      } finally {
        busy += realNow() - start;
      }
    });
  /** Видимий елемент з таким testid (редакторів точки два — рулетки й траси). */
  const el = (id: string): HTMLElement => {
    if (id === 'canvas') {
      const canvas = window.__trasa!.viewer.canvas;
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      return canvas;
    }
    const all = [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
    const found = all.find((e) => e.getClientRects().length > 0) ?? all[0];
    if (!found) throw new Error(`немає елемента ${id}`);
    return found;
  };
  const fire = (target: HTMLElement, type: string, pointerId: number, x: number, y: number) => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId,
        pointerType: 'touch',
        isPrimary: false,
        clientX: x,
        clientY: y,
        button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  };
  const held = new Map<number, { target: HTMLElement; cx: number; cy: number; x: number; y: number }>();
  let samples: Sample[] = [];
  let sampling = false;
  const sample = (t: number) => {
    if (!sampling) return;
    const ed = window.__trasa?.app?.state.routes.editor;
    const p = ed?.point ?? null;
    const a = ed?.segment?.anchor ?? null;
    samples.push({ t, p: p ? { x: p.x, y: p.y, z: p.z } : null, anchor: a ? { x: a.x, y: a.y, z: a.z } : null });
    window.requestAnimationFrame(sample);
  };
  w.__kit = {
    el,
    press(id, pointerId, offset) {
      const target = el(id);
      const r = target.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      fire(target, 'pointerdown', pointerId, cx, cy);
      fire(target, 'pointermove', pointerId, cx + offset.x, cy + offset.y);
      held.set(pointerId, { target, cx, cy, x: cx + offset.x, y: cy + offset.y });
    },
    move(pointerId, offset) {
      const h = held.get(pointerId);
      if (!h) return;
      h.x = h.cx + offset.x;
      h.y = h.cy + offset.y;
      fire(h.target, 'pointermove', pointerId, h.x, h.y);
    },
    release(pointerId) {
      const h = held.get(pointerId);
      if (!h) return;
      fire(h.target, 'pointerup', pointerId, h.x, h.y);
      held.delete(pointerId);
    },
    frames: (n) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(tick));
        window.requestAnimationFrame(tick);
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    startSampling() {
      samples = [];
      sampling = true;
      window.requestAnimationFrame(sample);
    },
    stopSampling() {
      sampling = false;
      return samples;
    },
    freeze() {
      frozen = realNow();
    },
    advance(ms) {
      if (frozen !== null) frozen += ms;
    },
    unfreeze() {
      frozen = null;
    },
    busyMs: () => busy,
  };
}

// ───────────── допоміжне ─────────────

const kit = (page: Page) => ({
  press: (id: string, pointerId: number, offset: V2) =>
    page.evaluate(([i, p, o]) => (window as unknown as KitWindow).__kit.press(i as string, p as number, o as V2), [id, pointerId, offset] as const),
  move: (pointerId: number, offset: V2) =>
    page.evaluate(([p, o]) => (window as unknown as KitWindow).__kit.move(p as number, o as V2), [pointerId, offset] as const),
  release: (pointerId: number) => page.evaluate((p) => (window as unknown as KitWindow).__kit.release(p), pointerId),
  frames: (n = 2) => page.evaluate((k) => (window as unknown as KitWindow).__kit.frames(k), n),
  startSampling: () => page.evaluate(() => (window as unknown as KitWindow).__kit.startSampling()),
  stopSampling: () => page.evaluate(() => (window as unknown as KitWindow).__kit.stopSampling()),
  freeze: () => page.evaluate(() => (window as unknown as KitWindow).__kit.freeze()),
  advance: (ms: number) => page.evaluate((m) => (window as unknown as KitWindow).__kit.advance(m), ms),
  unfreeze: () => page.evaluate(() => (window as unknown as KitWindow).__kit.unfreeze()),
});

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)) as StateJson);
const routes = async (page: Page) => (await state(page)).routes;
const setView = (page: Page, from: P3, to: P3) =>
  page.evaluate(([f, t]) => window.__trasa!.viewer.setView(f!, t!), [from, to] as const);
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const mmOf = (p: P3): P3 => ({ x: p.x * 1000, y: p.y * 1000, z: p.z * 1000 });
/** «1 234,5 мм» / «−0,3 мм» → число. */
const parseMm = (text: string) => Number(text.replace(/мм/g, '').replace(/\s/g, '').replace(',', '.').replace('−', '-'));

const CORNER = { from: { x: 2.5, y: 4, z: 9 }, to: { x: 0, y: 0.8, z: 0 } };

async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installKit);
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return errors;
}

async function openRoom(page: Page): Promise<string[]> {
  const errors = await openApp(page);
  await page.getByTestId('file-input').setInputFiles(ROOM_ZIP);
  await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready', undefined, { timeout: 15_000 });
  await setView(page, CORNER.from, CORNER.to);
  return errors;
}

/** Увімкнути «Трасу» й поставити першу точку дотиком по підлозі; true — підтвердити її. */
async function startRoute(page: Page, at: P3 = { x: -0.5, y: 0, z: 0.4 }, confirmFirst = true) {
  await visible(page, 'route').click();
  await expect(page.getByTestId('route-panel')).toBeVisible();
  await kit(page).frames(2);
  const p = await page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), at);
  await page.mouse.click(Math.round(p.x), Math.round(p.y));
  await expect(visible(page, 'point-editor')).toBeVisible();
  if (confirmFirst) await confirm(page);
}

async function confirm(page: Page) {
  await visible(page, 'confirm-point').click();
  await kit(page).frames(2);
}

/** Відхилення джойстика (px) для руху по осі X/Z у бік sign — як рахує редактор на початку утримання. */
async function stickOffset(page: Page, axis: 'X' | 'Z', sign: 1 | -1, px: number): Promise<V2> {
  const p = (await routes(page)).editor.point!;
  const s = await page.evaluate((pt) => window.__trasa!.viewer.screenAxes(pt), p);
  const d = joystickLayout({ X: s.X, Z: s.Z }).dirs[axis];
  const len = Math.hypot(d.x, d.y) || 1;
  return { x: Math.round((sign * d.x * px) / len), y: Math.round((sign * d.y * px) / len) };
}

const controlFor = (axis: Axis) => (axis === 'Y' ? 'stick-y' : 'stick-xz');

/** Відхилення для осі (частка ходу 0…1). */
async function offsetFor(page: Page, axis: Axis, sign: 1 | -1, deflection: number): Promise<V2> {
  const px = Math.round(deflection * STICK_TRAVEL_PX);
  return axis === 'Y' ? { x: 0, y: -sign * px } : stickOffset(page, axis, sign, px);
}

/** Довге утримання зі зміною сили: [відхилення, мс]… Повертає записи точки щокадру. */
async function holdProfile(page: Page, axis: Axis, sign: 1 | -1, profile: Array<[number, number]>, pointerId = 5) {
  const k = kit(page);
  const dir = await offsetFor(page, axis, sign, 1);
  const scale = (d: number): V2 => ({ x: Math.round(dir.x * d), y: Math.round(dir.y * d) });
  await k.startSampling();
  await k.press(controlFor(axis), pointerId, scale(profile[0]![0]));
  for (const [i, [d, ms]] of profile.entries()) {
    if (i > 0) await k.move(pointerId, scale(d));
    await page.waitForTimeout(ms);
  }
  await k.release(pointerId);
  await k.frames(2);
  return (await k.stopSampling()) as Sample[];
}

/** Інші дві координати точки (у кожному записаному кадрі) — рівно як у початку відрізка. */
function expectOnAxis(samples: Sample[], axis: Axis) {
  for (const s of samples) {
    if (!s.p || !s.anchor) continue;
    for (const k of ['x', 'y', 'z'] as const) if (k !== KEY[axis]) expect(s.p[k], `кадр ${s.t.toFixed(0)}: ${k}`).toBe(s.anchor[k]);
  }
}

/** Відрізки траси: рівно одна координата змінюється, інші дві — однакові (±0,1 мм; очікуємо рівно). */
function expectAxisAligned(nodes: P3[]) {
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const changed = (['x', 'y', 'z'] as const).filter((k) => Math.abs(a[k] - b[k]) > 0.1);
    expect(changed, `відрізок ${i}`).toHaveLength(1);
    for (const k of ['x', 'y', 'z'] as const) {
      if (k === changed[0]) continue;
      expect(Math.abs(a[k] - b[k]), `відрізок ${i}: ${k}`).toBeLessThanOrEqual(1e-9);
    }
  }
}

interface Drawn {
  line: string;
  pending: string;
  nodes: string;
  labels: Array<{ text: string; x: number; y: number; live: boolean }>;
  tags: Array<{ text: string; x: number; y: number }>;
  html: string;
}

/** Що намальовано на шарі трас: лінії траси, яку будують, підписи довжин, номери. */
async function drawn(page: Page): Promise<Drawn> {
  return (await drawnWith(page, [])).d;
}

/**
 * Шар трас і проєкція точок `pts` (м) — у ТОМУ САМОМУ кадрі, одразу після того, як шар намалювали
 * (viewer.onFrame; наш обробник — після обробника шару). Так камера, що ще ледь дрейфує після жесту,
 * не дає хибних розбіжностей.
 */
async function drawnWith(page: Page, pts: P3[]): Promise<{ d: Drawn; proj: ReturnType<Viewer['projectPath']> }> {
  await kit(page).frames(2);
  return page.evaluate(
    (points) =>
      new Promise((resolve) => {
        const viewer = window.__trasa!.viewer;
        const off = viewer.onFrame(() => {
          off();
          const layer = document.querySelector('[data-testid="route-layer"]')!;
          const g = layer.querySelector('g.route--draft');
          const attr = (sel: string) => g?.querySelector(sel)?.getAttribute('d') ?? '';
          const translate = (el: HTMLElement) => {
            const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
            return { x: Number(m?.[1]), y: Number(m?.[2]) };
          };
          resolve({
            d: {
              line: attr('path.route-line:not(.route-line--pending)'),
              pending: attr('path.route-line--pending'),
              nodes: attr('path.route-nodes:not(.route-nodes--pending)'),
              labels: [...layer.querySelectorAll<HTMLElement>('.route-length')]
                .filter((l) => !l.hidden)
                .map((l) => ({ text: l.textContent ?? '', ...translate(l), live: l.classList.contains('route-length--live') })),
              tags: [...layer.querySelectorAll<HTMLElement>('.route-tag')]
                .filter((l) => !l.hidden)
                .map((l) => ({ text: l.textContent ?? '', ...translate(l) })),
              html: layer.innerHTML,
            },
            proj: viewer.projectPath(points),
          });
        });
        viewer.requestRender();
      }),
    pts,
  );
}

/** Вершини «M x y L x y …» по порядку. */
function pathVertices(d: string): V2[] {
  const out: V2[] = [];
  for (const m of d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}

/**
 * Намальоване = дані: лінія траси, яку будують, проходить через вузли building.nodes (±0,5 px),
 * кружечки — на вузлах (злиті на екрані не малюються), підпис довжини кожного видимого відрізка = відстань між вузлами (±0,1 мм),
 * номер траси — біля першої точки.
 */
async function expectDrawingMatchesData(page: Page, where = '') {
  const r = await routes(page);
  const nodesMm = r.building!.nodes;
  const metres = nodesMm.map((n) => toM(n));
  const pending = r.editor.active && r.editor.point ? r.editor.point : null;
  const all = pending ? [...metres, pending] : metres;
  const { d, proj } = await drawnWith(page, all);
  expect(d.html).not.toMatch(/NaN|Infinity/);
  if (nodesMm.length >= 2 && proj.nodes.every((n) => n.visible)) {
    const v = pathVertices(d.line);
    expect(v).toHaveLength(nodesMm.length);
    v.forEach((p, i) => {
      expect(Math.abs(p.x - proj.nodes[i]!.x), `${where} вузол ${i} x`).toBeLessThan(0.5);
      expect(Math.abs(p.y - proj.nodes[i]!.y), `${where} вузол ${i} y`).toBeLessThan(0.5);
    });
  }
  // Кружечки (кожен — «M x y» і дві дуги «a»): кожен стоїть рівно на якомусь видимому вузлі;
  // вузли, що на екрані ближчі за 10 px до вже намальованого, не малюються (route-layer.ts);
  // останній видимий вузол — завжди.
  const visible = proj.nodes.slice(0, nodesMm.length).filter((n) => n.visible);
  const centres = [...d.nodes.matchAll(/M(-?[\d.]+) (-?[\d.]+)a/g)].map((m) => ({ x: Number(m[1]) + 6, y: Number(m[2]) }));
  expect(centres.length).toBeLessThanOrEqual(visible.length);
  if (visible.length > 0) expect(centres.length).toBeGreaterThan(0);
  for (const c of centres) {
    const nearest = Math.min(...visible.map((n) => Math.hypot(n.x - c.x, n.y - c.y)));
    expect(nearest, `${where} кружечок не на вузлі`).toBeLessThan(0.5);
  }
  const last = visible.at(-1);
  if (last) expect(centres.some((c) => Math.hypot(c.x - last.x, c.y - last.y) < 0.5), `${where} останній вузол`).toBe(true);
  // Підписи довжин: кожен — посередині якогось відрізка, текст = відстань між його вузлами.
  for (const label of d.labels) {
    let best = -1;
    let bestDist = Infinity;
    proj.segments.forEach((seg, i) => {
      if (!seg) return;
      const mx = (seg[0].x + seg[1].x) / 2;
      const my = (seg[0].y + seg[1].y) / 2;
      const dd = Math.hypot(mx - label.x, my - label.y);
      if (dd < bestDist) {
        bestDist = dd;
        best = i;
      }
    });
    expect(bestDist, `підпис «${label.text}» не на відрізку`).toBeLessThan(1);
    const a = best < nodesMm.length - 1 ? nodesMm[best]! : nodesMm[best]!;
    const b = best + 1 < nodesMm.length ? nodesMm[best + 1]! : mmOf(pending!);
    const trueMm = distance(a, b);
    expect(Math.abs(parseMm(label.text) - trueMm), `підпис ${label.text} vs ${trueMm}`).toBeLessThanOrEqual(0.1);
    expect(label.live).toBe(best === nodesMm.length - 1 && !!pending);
  }
  // Відрізки, довші за 200 px на екрані, мають підпис (підпис ховається лише на коротких).
  const longOnScreen = proj.segments.filter((s) => s && Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) > 200).length;
  expect(d.labels.length).toBeGreaterThanOrEqual(longOnScreen);
  // Номер траси — біля першої точки.
  if (proj.nodes[0]?.visible) {
    const tag = d.tags.find((t) => t.text === String(r.building!.id));
    expect(tag, 'номер траси біля першої точки').toBeTruthy();
    expect(Math.hypot(tag!.x - proj.nodes[0]!.x, tag!.y - proj.nodes[0]!.y)).toBeLessThan(40);
  }
}

/** «Відрізок: X +1 250 мм» = зсув точки від початку по осі відрізка (±0,1 мм). */
async function expectSegmentText(page: Page) {
  const r = await routes(page);
  const seg = r.editor.segment!;
  const text = (await visible(page, 'point-shift').textContent()) ?? '';
  const m = /^Відрізок: ([XYZ]) ([+−])(.+)$/.exec(text);
  expect(m, `текст «${text}»`).toBeTruthy();
  const axis = m![1] as Axis;
  expect(axis).toBe(seg.axis);
  const value = (m![2] === '−' ? -1 : 1) * parseMm(m![3]!);
  const trueMm = (r.editor.point![KEY[axis]] - seg.anchor[KEY[axis]]) * 1000;
  expect(Math.abs(value - trueMm)).toBeLessThanOrEqual(0.1);
  expect(Math.abs(Math.abs(trueMm) - seg.lengthMm)).toBeLessThan(1e-6);
}

// ───────────── тести ─────────────

test.describe('Етап 2 (tester): критерії готовності', () => {
  test('порожня сцена: «Траса» й «Видалити траєкторію» неактивні, поки скан не відкрито', async ({ page }) => {
    const errors = await openApp(page);
    await expect(visible(page, 'route')).toBeDisabled();
    await expect(visible(page, 'route-delete')).toBeDisabled();
    expect((await state(page)).routes.building).toBeNull();
    expect(errors).toEqual([]);
  });

  test('перша точка: перетягування обертає камеру й точки не ставить; дотик — ставить точку на скані', async ({ page }) => {
    const errors = await openRoom(page);
    await visible(page, 'route').click();
    await kit(page).frames(2);
    const vp = page.viewportSize()!;
    const before = await page.evaluate(() => window.__trasa!.viewer.snapshotView().position.toArray());
    const x0 = Math.round(vp.width * 0.45);
    const y0 = Math.round(vp.height * 0.55);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 140, y0 + 20, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__trasa!.viewer.snapshotView().position.toArray());
    expect(Math.max(...before.map((v, i) => Math.abs(v - after[i]!)))).toBeGreaterThan(0.05);
    let r = await routes(page);
    expect(r.phase).toBe('first');
    expect(r.building!.nodes).toHaveLength(0);
    expect(r.editor.active).toBe(false);
    await expect(visible(page, 'point-editor')).toHaveCount(0);

    // Дотик — точка там, де скан (підлога, Y = 0). Спершу зупиняємо інерцію після жесту.
    await page.evaluate(() => window.__trasa!.viewer.restoreView(window.__trasa!.viewer.snapshotView()));
    await setView(page, CORNER.from, CORNER.to);
    await kit(page).frames(2);
    const target = { x: 0.7, y: 0, z: -0.3 };
    const s = await page.evaluate((p) => window.__trasa!.viewer.projectPoint(p), target);
    const px = { x: Math.round(s.x), y: Math.round(s.y) };
    const hit = await page.evaluate((c) => window.__trasa!.viewer.raycastScan(c.x, c.y), px);
    await page.mouse.click(px.x, px.y);
    r = await routes(page);
    expect(r.phase).toBe('editFirst');
    expect(Math.abs(r.editor.point!.y)).toBeLessThan(1e-6);
    // Точка — рівно там, куди торкнулись (перетин променя з поверхнею скану).
    for (const c of ['x', 'y', 'z'] as const) expect(Math.abs(r.editor.point![c] - hit![c])).toBeLessThan(1e-9);
    expect(Math.hypot(r.editor.point!.x - target.x, r.editor.point!.z - target.z)).toBeLessThan(0.05);
    expect(errors).toEqual([]);
  });

  test('довгі утримання на видах з кута, згори, збоку й знизу: дві інші координати сусідніх точок рівно однакові; підписи = відстань', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = await openRoom(page);
    await startRoute(page);
    const plan: Array<{ view: 'corner' | 'y' | 'x' | 'below'; axis: Axis; sign: 1 | -1; profile: Array<[number, number]> }> = [
      { view: 'corner', axis: 'X', sign: 1, profile: [[0.4, 400], [0.95, 1600], [0.6, 600]] },
      { view: 'corner', axis: 'Y', sign: 1, profile: [[0.3, 500], [0.8, 900], [0.5, 500]] },
      { view: 'y', axis: 'Z', sign: 1, profile: [[0.5, 500], [0.85, 900], [0.3, 500]] },
      { view: 'y', axis: 'X', sign: -1, profile: [[0.7, 800], [0.4, 800]] },
      { view: 'x', axis: 'Y', sign: -1, profile: [[0.6, 600], [0.35, 600]] },
      { view: 'x', axis: 'Z', sign: -1, profile: [[0.9, 700], [0.5, 500]] },
      { view: 'below', axis: 'X', sign: 1, profile: [[0.8, 700], [0.4, 500]] },
      { view: 'below', axis: 'Z', sign: 1, profile: [[0.7, 800], [0.3, 400]] },
    ];
    let lastView = '';
    for (const step of plan) {
      const point = (await routes(page)).editor.point!;
      if (step.view !== lastView) {
        if (step.view === 'corner') await setView(page, CORNER.from, CORNER.to);
        else if (step.view === 'below') await setView(page, { x: point.x + 0.9, y: point.y - 2.6, z: point.z + 1.4 }, point);
        else await visible(page, `view-${step.view}`).click();
        lastView = step.view;
        await kit(page).frames(3);
      }
      const nodesBefore = (await routes(page)).building!.nodes;
      const samples = await holdProfile(page, step.axis, step.sign, step.profile);
      expect(samples.length).toBeGreaterThan(5);
      expectOnAxis(samples, step.axis);
      const r = await routes(page);
      expect(r.editor.segment!.axis, `${step.view}: вісь відрізка`).toBe(step.axis);
      const moved = r.editor.point![KEY[step.axis]] - r.editor.segment!.anchor[KEY[step.axis]];
      expect(Math.sign(moved), `${step.view}: у бік ${step.sign}`).toBe(step.sign);
      // Камера не рухалась під час утримання — підпис і лінія мають збігатися з даними.
      await expectSegmentText(page);
      await expectDrawingMatchesData(page, `${step.view} ${step.sign > 0 ? '+' : '−'}${step.axis}:`);
      await confirm(page);
      const after = (await routes(page)).building!.nodes;
      expect(after).toHaveLength(nodesBefore.length + 1);
      // Вузол = точка, яку підтвердили (у мм).
      const confirmed = mmOf(r.editor.point!);
      for (const k of ['x', 'y', 'z'] as const) expect(Math.abs(after.at(-1)![k] - confirmed[k])).toBeLessThan(1e-6);
      expectAxisAligned(after);
    }
    const r = await routes(page);
    const nodes = r.building!.nodes;
    expect(nodes).toHaveLength(plan.length + 1);
    expect(isValidRoute(nodes)).toBe(true);
    // Обертання камери й кнопки видів вузлів не зсувають.
    for (const v of ['x', 'y', 'z', 'y'] as const) await visible(page, `view-${v}`).click();
    const vp = page.viewportSize()!;
    await page.mouse.move(Math.round(vp.width * 0.5), Math.round(vp.height * 0.45));
    await page.mouse.down();
    await page.mouse.move(Math.round(vp.width * 0.5) + 160, Math.round(vp.height * 0.45) + 60, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect((await routes(page)).building!.nodes).toEqual(nodes);
    await expectDrawingMatchesData(page);
    // «Завершити» зберігає саме ці вузли; у списку — кількість і довжина (±0,1 мм).
    await visible(page, 'route-finish').click();
    const s = await state(page);
    expect(s.routes.set.routes[0]!.nodes).toEqual(nodes);
    await visible(page, 'route-delete').click();
    const meta = (await page.getByTestId('route-row-1').locator('.route-row-meta').textContent()) ?? '';
    const [count, length] = meta.split(' · ');
    expect(count).toBe(`${nodes.length} точок`);
    let total = 0;
    for (let i = 1; i < nodes.length; i++) total += distance(nodes[i - 1]!, nodes[i]!);
    expect(Math.abs(parseMm(length!) - total)).toBeLessThanOrEqual(0.1);
    expect(errors).toEqual([]);
  });

  test('«Завершити» неактивна, поки підтверджених точок < 2 (точка, яку тягнуть, не рахується)', async ({ page }) => {
    await openRoom(page);
    await visible(page, 'route').click();
    const finish = page.getByTestId('route-finish');
    await expect(finish).toBeDisabled();
    // Перша точка дотиком (ще не підтверджена) — «Завершити» неактивна.
    await kit(page).frames(2);
    const first = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
    await page.mouse.click(Math.round(first.x), Math.round(first.y));
    expect((await routes(page)).phase).toBe('editFirst');
    await expect(finish).toBeDisabled();
    await confirm(page);
    await expect(finish).toBeDisabled();
    await holdProfile(page, 'X', 1, [[0.6, 400]]);
    expect((await routes(page)).editor.segment!.lengthMm).toBeGreaterThan(1);
    await expect(finish).toBeDisabled();
    // Навіть «натиснути» неактивну кнопку програмно — траса не зберігається.
    await page.evaluate(() => (document.querySelector('[data-testid="route-finish"]') as HTMLButtonElement).click());
    expect((await routes(page)).set.routes).toHaveLength(0);
    await confirm(page);
    await expect(finish).toBeEnabled();
    await visible(page, 'route-remove-last').click();
    await expect(finish).toBeDisabled();
  });

  test('номери трас: видалили останню — нова отримує наступний номер; видалили всі — нумерація не з 1', async ({ page }) => {
    await openRoom(page);
    const L = (y: number) => [
      { x: 0, y, z: 0 },
      { x: 3000, y, z: 0 },
      { x: 3000, y, z: 2000 },
      { x: 3000, y: y + 2350, z: 2000 },
    ];
    await page.evaluate(
      (n) => window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: n[0]! }, { id: 2, nodes: n[1]! }, { id: 3, nodes: n[2]! }], nextId: 4 }),
      [L(100), L(200), L(300)],
    );
    await expect(page.locator('.route-tag:not([hidden])')).toHaveText(['1', '2', '3']);
    await visible(page, 'route-delete').click();
    await expect(page.getByTestId('route-row-1')).toHaveText(/Траса 1\s*4 точки · 7\s350 мм/);
    await page.getByTestId('route-row-3').click();
    await expect(page.getByTestId('route-delete-confirm')).toHaveText('Видалити Трасу 3');
    await page.getByTestId('route-delete-confirm').click();
    expect((await routes(page)).set.routes.map((r) => r.id)).toEqual([1, 2]);
    await page.getByTestId('route-delete-close').click();
    await startRoute(page);
    await expect(page.getByTestId('route-title')).toHaveText('Траса 4');
    await holdProfile(page, 'X', 1, [[0.6, 300]]);
    await confirm(page);
    await visible(page, 'route-finish').click();
    expect((await routes(page)).set.routes.map((r) => r.id)).toEqual([1, 2, 4]);
    // Видалити всі.
    await visible(page, 'route-delete').click();
    for (const id of [1, 2, 4]) {
      await page.getByTestId(`route-row-${id}`).click();
      await page.getByTestId('route-delete-confirm').click();
    }
    const s = await state(page);
    expect(s.routes.set.routes).toHaveLength(0);
    expect(s.tool).toBe('none');
    await expect(visible(page, 'route-delete')).toBeDisabled();
    await startRoute(page);
    await expect(page.getByTestId('route-title')).toHaveText('Траса 5');
  });
});

test.describe('Етап 2 (tester): крайові випадки побудови', () => {
  test('дуже короткий відрізок (< 0,1 мм) не підтверджується; трохи довший — підтверджується', async ({ page }, testInfo) => {
    await openRoom(page);
    await startRoute(page);
    const k = kit(page);
    const deflection = 0.3;
    const off = await offsetFor(page, 'X', 1, deflection);
    const speed = nudgeSpeed(Math.hypot(off.x, off.y) / STICK_TRAVEL_PX); // мм/с
    await k.freeze();
    try {
      await k.press('stick-xz', 3, off);
      await k.frames(2);
      // Рівно стільки часу, щоб відрізок був 0,06 мм.
      await k.advance((0.06 / speed) * 1000);
      await k.frames(2);
      let r = await routes(page);
      expect(r.editor.segment!.axis).toBe('X');
      expect(r.editor.segment!.lengthMm).toBeGreaterThan(0.03);
      expect(r.editor.segment!.lengthMm).toBeLessThan(0.1);
      expect(r.editor.canConfirm).toBe(false);
      await expect(visible(page, 'confirm-point')).toBeDisabled();
      const shownShort = (await visible(page, 'point-shift').textContent()) ?? '';
      testInfo.annotations.push({ type: 'відрізок 0,06 мм', description: `напис: «${shownShort}», кнопка неактивна` });
      await page.evaluate(() => {
        const b = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="confirm-point"]')].find((e) => e.getClientRects().length);
        b?.click();
      });
      expect((await routes(page)).building!.nodes).toHaveLength(1);
      // Ще 0,09 мм — разом 0,15 мм: можна.
      await k.advance((0.09 / speed) * 1000);
      await k.frames(2);
      r = await routes(page);
      expect(r.editor.segment!.lengthMm).toBeGreaterThan(0.1);
      expect(r.editor.canConfirm).toBe(true);
      await k.release(3);
    } finally {
      await k.unfreeze();
    }
    await confirm(page);
    const nodes = (await routes(page)).building!.nodes;
    expect(nodes).toHaveLength(2);
    expect(Math.abs(distance(nodes[0]!, nodes[1]!) - 0.15)).toBeLessThan(0.01);
    expectAxisAligned(nodes);
    // «Завершити» з таким коротким відрізком — траса зберігається (за правилами).
    await visible(page, 'route-finish').click();
    expect((await routes(page)).set.routes).toHaveLength(1);
  });

  test('перехід через початок: точка зупиняється рівно на початку (~0,4 с), потім іде на інший бік; назад по попередньому — стоїть з підказкою', async ({
    page,
  }) => {
    await openRoom(page);
    await startRoute(page);
    // Перший відрізок (назад — немає куди): +X, потім довго −X.
    await holdProfile(page, 'X', 1, [[0.6, 400]]);
    const anchor = (await routes(page)).editor.segment!.anchor;
    let samples = await holdProfile(page, 'X', -1, [[0.7, 2500]]);
    expectOnAxis(samples, 'X');
    const xs = samples.filter((s) => s.p).map((s) => ({ t: s.t, dx: s.p!.x - anchor.x }));
    const atStart = xs.filter((s) => s.dx === 0);
    expect(atStart.length, 'точка побула рівно на початку').toBeGreaterThan(0);
    const stay = atStart.at(-1)!.t - atStart[0]!.t;
    expect(stay, 'пауза на початку').toBeGreaterThan(250);
    expect(stay).toBeLessThan(900);
    // Ніколи не «перестрибує» з + на − без зупинки рівно на початку.
    const firstNeg = xs.findIndex((s) => s.dx < 0);
    expect(firstNeg).toBeGreaterThan(0);
    expect(xs.slice(0, firstNeg).some((s) => s.dx === 0)).toBe(true);
    let r = await routes(page);
    expect(r.editor.point!.x).toBeLessThan(anchor.x);
    await confirm(page);

    // Другий відрізок: попередній ішов по −X → по +X не можна, точка стоїть, є підказка.
    samples = await holdProfile(page, 'X', 1, [[0.8, 600]]);
    r = await routes(page);
    expect(r.editor.point).toEqual(r.editor.segment!.anchor);
    expect(samples.every((s) => !s.p || (s.p.x === s.anchor!.x && s.p.y === s.anchor!.y && s.p.z === s.anchor!.z))).toBe(true);
    // Підказка видна, поки тримають.
    const k = kit(page);
    await k.press('stick-xz', 4, await offsetFor(page, 'X', 1, 0.8));
    await page.waitForTimeout(300);
    await expect(visible(page, 'point-shift')).toHaveText('Назад по попередньому відрізку не можна');
    await k.release(4);
    // По Z — через початок на інший бік можна (попередній відрізок — по X).
    await holdProfile(page, 'Z', 1, [[0.6, 300]]);
    const a2 = (await routes(page)).editor.segment!.anchor;
    samples = await holdProfile(page, 'Z', -1, [[0.7, 2200]]);
    expectOnAxis(samples, 'Z');
    expect((await routes(page)).editor.point!.z).toBeLessThan(a2.z);
  });

  test('«Видалити останню точку» під час утримання джойстика: заборонений напрямок перераховується, точка від нового початку', async ({
    page,
  }) => {
    const errors = await openRoom(page);
    await startRoute(page);
    await holdProfile(page, 'X', 1, [[0.7, 500]]);
    await confirm(page); // A → B по +X
    await holdProfile(page, 'Z', 1, [[0.7, 500]]);
    await confirm(page); // B → C по +Z
    let r = await routes(page);
    const [A, B] = r.building!.nodes;
    // Від C тягнемо −X (можна: попередній відрізок по Z) і, не відпускаючи, «Видалити останню точку».
    const k = kit(page);
    await k.press('stick-xz', 6, await offsetFor(page, 'X', -1, 0.7));
    await page.waitForTimeout(400);
    expect((await routes(page)).editor.point!.x).toBeLessThan(B!.x / 1000);
    await k.startSampling();
    await page.evaluate(() => (document.querySelector('[data-testid="route-remove-last"]') as HTMLButtonElement).click());
    await page.waitForTimeout(600);
    const samples = (await k.stopSampling()) as Sample[];
    r = await routes(page);
    expect(r.building!.nodes).toEqual([A, B]);
    // Новий початок — B; попередній відрізок A → B ішов по +X, тож −X тепер заборонено: точка стоїть у B.
    expect(mmOf(r.editor.segment!.anchor).x).toBeCloseTo(B!.x, 6);
    expect(r.editor.point).toEqual(r.editor.segment!.anchor);
    // У кожному кадрі після «Видалити» (початок — B) точка стоїть рівно в B.
    const atB = samples.filter((x) => x.anchor && (['x', 'y', 'z'] as const).every((c) => Math.abs(x.anchor![c] * 1000 - B![c]) < 1e-6));
    expect(atB.length).toBeGreaterThan(3);
    for (const s of atB) expect(s.p).toEqual(s.anchor);
    await k.release(6);
    await k.frames(2);
    // Після відпускання: −X — так само не можна, +Z — можна, а без B (лише A) — −X знову можна.
    await holdProfile(page, 'X', -1, [[0.8, 400]]);
    r = await routes(page);
    expect(r.editor.point).toEqual(r.editor.segment!.anchor);
    await visible(page, 'route-remove-last').click();
    r = await routes(page);
    expect(r.building!.nodes).toEqual([A]);
    await holdProfile(page, 'X', -1, [[0.7, 400]]);
    r = await routes(page);
    expect(r.editor.point!.x).toBeLessThan(r.editor.segment!.anchor.x);
    expect(errors).toEqual([]);
  });

  test('повзунок і джойстик одночасно в режимі відрізка: рух лише по одній осі; друга керувалка не «підхоплює»', async ({ page }) => {
    const errors = await openRoom(page);
    await startRoute(page);
    const k = kit(page);
    // 1) Спершу повзунок (вгору), потім ще й джойстик (X).
    await k.startSampling();
    await k.press('stick-y', 11, { x: 0, y: -40 });
    await page.waitForTimeout(400);
    await k.press('stick-xz', 12, await offsetFor(page, 'X', 1, 0.8));
    await page.waitForTimeout(500);
    let r = await routes(page);
    expect(r.editor.segment!.axis).toBe('Y');
    await expect(visible(page, 'stick-xz')).toHaveAttribute('aria-disabled', 'true');
    // Відпустили повзунок — джойстик, який ще тримають, точку по X не рухає (відрізок уже по Y).
    await k.release(11);
    await page.waitForTimeout(400);
    await k.release(12);
    let samples = (await k.stopSampling()) as Sample[];
    expectOnAxis(samples, 'Y');
    r = await routes(page);
    expect(r.editor.point!.y).toBeGreaterThan(r.editor.segment!.anchor.y);
    await confirm(page);

    // 2) Спершу джойстик (Z), потім ще й повзунок.
    await k.startSampling();
    await k.press('stick-xz', 13, await offsetFor(page, 'Z', 1, 0.8));
    await page.waitForTimeout(400);
    await k.press('stick-y', 14, { x: 0, y: -50 });
    await page.waitForTimeout(400);
    await expect(visible(page, 'stick-y')).toHaveAttribute('aria-disabled', 'true');
    await k.release(13);
    await page.waitForTimeout(400);
    await k.release(14);
    samples = (await k.stopSampling()) as Sample[];
    expectOnAxis(samples, 'Z');
    r = await routes(page);
    expect(r.editor.segment!.axis).toBe('Z');
    await confirm(page);
    expectAxisAligned((await routes(page)).building!.nodes);
    expect(errors).toEqual([]);
  });

  test('подвійне натискання «Підтвердити точку» і «Завершити»: рівно один вузол / одна траса, режим вимкнено', async ({ page }) => {
    const errors = await openRoom(page);
    await visible(page, 'route').click();
    await kit(page).frames(2);
    const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
    await page.mouse.click(Math.round(p.x), Math.round(p.y));
    await visible(page, 'confirm-point').dblclick();
    await kit(page).frames(2);
    let r = await routes(page);
    expect(r.building!.nodes).toHaveLength(1);
    expect(r.editor.point).toEqual(r.editor.segment!.anchor);
    await holdProfile(page, 'X', 1, [[0.7, 400]]);
    await visible(page, 'confirm-point').dblclick();
    await kit(page).frames(2);
    r = await routes(page);
    expect(r.building!.nodes).toHaveLength(2);
    expect(r.editor.point).toEqual(r.editor.segment!.anchor);
    await visible(page, 'route-finish').dblclick();
    await page.waitForTimeout(300);
    const s = await state(page);
    expect(s.routes.set.routes).toHaveLength(1);
    expect(s.tool).toBe('none');
    expect(s.routes.active).toBe(false);
    await expect(page.getByTestId('route-panel')).toBeHidden();
    await expect(page.getByTestId('route-delete-panel')).toBeHidden();
    await expect(page.getByTestId('choice')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('«Підтвердити точку» другим пальцем, поки тримають джойстик: наступна точка від цього утримання не їде', async ({ page }) => {
    await openRoom(page);
    await startRoute(page);
    const k = kit(page);
    await k.press('stick-xz', 21, await offsetFor(page, 'X', 1, 0.7));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="confirm-point"]')].find((e) => e.getClientRects().length);
      b!.click();
    });
    await page.waitForTimeout(500);
    const r = await routes(page);
    await k.release(21);
    expect(r.building!.nodes).toHaveLength(2);
    // Як у рулетці: підтвердили — наступна точка стоїть у новому початку, поки не почнуть нове утримання.
    expect(r.editor.segment!.lengthMm, 'точка поїхала далі від того ж утримання').toBe(0);
  });

  test('точка й траса за камерою: без NaN, без ліній «через екран», номер за камерою схований', async ({ page }) => {
    const errors = await openRoom(page);
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({
        routes: [
          { id: 1, nodes: [{ x: -1500, y: 1200, z: -1000 }, { x: 1500, y: 1200, z: -1000 }, { x: 1500, y: 1200, z: 1000 }] },
          { id: 2, nodes: [{ x: -1800, y: 600, z: 1200 }, { x: -1800, y: 600, z: -1200 }] },
        ],
        nextId: 3,
      }),
    );
    // Камера між вузлами Траси 1, дивиться на +X: перший вузол за камерою, відрізок перетинає площину камери.
    await setView(page, { x: 0, y: 1.3, z: -1.1 }, { x: 3, y: 1.3, z: -1.1 });
    let d = await drawn(page);
    expect(d.html).not.toMatch(/NaN|Infinity/);
    const tagTexts = await page.locator('.route-tag:not([hidden])').allTextContents();
    expect(tagTexts).not.toContain('1');
    const lineD = await page.locator('g.route').first().locator('path.route-line').first().getAttribute('d');
    const v = pathVertices(lineD ?? '');
    expect(v.length).toBeGreaterThanOrEqual(2);
    // Напрямок обрізаного відрізка = напрямок до точки на ньому трохи перед камерою (без «перевороту»).
    const ref = await page.evaluate(() => {
      const viewer = window.__trasa!.viewer;
      return {
        n2: viewer.projectPoint({ x: 1.5, y: 1.2, z: -1 }),
        near: viewer.projectPoint({ x: 0.3, y: 1.2, z: -1 }),
      };
    });
    expect(ref.near.visible).toBe(true);
    const cut = v[0]!;
    const n2 = v[1]!;
    expect(Math.hypot(n2.x - ref.n2.x, n2.y - ref.n2.y)).toBeLessThan(0.5);
    const a1 = Math.atan2(cut.y - n2.y, cut.x - n2.x);
    const a2 = Math.atan2(ref.near.y - n2.y, ref.near.x - n2.x);
    const diff = Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2)));
    expect(diff, 'обрізаний відрізок іде в той самий бік').toBeLessThan(0.02);

    // Камера рівно у вузлі траси — теж без NaN.
    await setView(page, { x: 1.5, y: 1.2, z: -1 }, { x: 1.5, y: 1.2, z: 1 });
    d = await drawn(page);
    expect(d.html).not.toMatch(/NaN|Infinity/);

    // Точка, яку тягнуть, за камерою: стрілки сховані, джойстик рухає без NaN.
    await setView(page, CORNER.from, CORNER.to);
    await startRoute(page);
    const pt = (await routes(page)).editor.point!;
    await setView(page, { x: pt.x + 0.3, y: pt.y + 0.5, z: pt.z - 0.3 }, { x: pt.x + 3, y: pt.y + 1, z: pt.z - 3 });
    await kit(page).frames(3);
    expect((await page.evaluate((p) => window.__trasa!.viewer.projectPoint(p), pt)).visible).toBe(false);
    const overlayHtml = await page.evaluate(() => [...document.querySelectorAll('.axis-overlay')].map((e) => e.innerHTML).join(''));
    expect(overlayHtml).not.toMatch(/NaN|Infinity/);
    const k = kit(page);
    await k.press('stick-xz', 31, { x: 45, y: 0 });
    await page.waitForTimeout(400);
    await k.release(31);
    const r = await routes(page);
    for (const c of ['x', 'y', 'z'] as const) expect(Number.isFinite(r.editor.point![c])).toBe(true);
    d = await drawn(page);
    expect(d.html).not.toMatch(/NaN|Infinity/);
    expect(errors).toEqual([]);
  });

  test('інший скан під час побудови: питання; «Відкрити» — усі траси й незавершена прибрані, номери з 1', async ({ page }) => {
    const errors = await openRoom(page);
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: [{ x: 0, y: 500, z: 0 }, { x: 1000, y: 500, z: 0 }] }], nextId: 2 }),
    );
    await startRoute(page);
    await holdProfile(page, 'X', 1, [[0.7, 300]]);
    await confirm(page);
    await holdProfile(page, 'Z', 1, [[0.7, 300]]);
    // На iPhone вертикально кнопки внизу сховані під час побудови — «Відкрити скан» недоступна, це нормально.
    const open = page.getByTestId('open-scan');
    test.skip(!(await open.isVisible()), 'кнопка «Відкрити скан» схована під час побудови (iPhone вертикально)');
    await open.click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await page.getByTestId('choice-cancel').click();
    let r = await routes(page);
    expect(r.building!.nodes).toHaveLength(2);
    expect(r.editor.active).toBe(true);
    await open.click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('choice-open').click();
    await (await chooser).setFiles(ROOM_ZIP);
    await page.waitForFunction(() => window.__trasa?.app?.state.status === 'ready' && window.__trasa.app.state.routes.set.routes.length === 0);
    const s = await state(page);
    expect(s.routes.set.nextId).toBe(1);
    expect(s.routes.building).toBeNull();
    expect(s.tool).toBe('none');
    await expect(visible(page, 'point-editor')).toHaveCount(0);
    const d = await drawn(page);
    expect(d.tags).toHaveLength(0);
    expect(await page.locator('[data-testid="route-layer"] path[d]:not([d=""])').count()).toBe(0);
    expect(await page.evaluate(() => document.querySelector('.is-editing-point'))).toBeNull();
    expect(errors).toEqual([]);
  });

  test('інший скан — пошкоджений файл: скан, готові траси й незавершена траса лишаються', async ({ page }) => {
    await openRoom(page);
    await page.evaluate(() =>
      window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: [{ x: 0, y: 500, z: 0 }, { x: 1000, y: 500, z: 0 }] }], nextId: 2 }),
    );
    await startRoute(page);
    await holdProfile(page, 'X', 1, [[0.7, 300]]);
    await confirm(page);
    const open = page.getByTestId('open-scan');
    test.skip(!(await open.isVisible()), 'кнопка «Відкрити скан» схована під час побудови (iPhone вертикально)');
    const building = (await routes(page)).building!;
    await open.click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('choice-open').click();
    await (await chooser).setFiles({ name: 'broken.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('glTF це не модель') });
    await page.waitForFunction(() => window.__trasa?.app?.state.status !== 'loading' && !!window.__trasa?.app?.state.error);
    const s = await state(page);
    expect(s.status).toBe('ready');
    expect(s.routes.set.routes.map((r) => r.id)).toEqual([1]);
    expect(s.routes.set.nextId).toBe(2);
    // Невдалий файл нічого не скидає: незавершена траса й режим побудови лишаються.
    expect(s.tool).toBe('route');
    expect(s.routes.building?.nodes).toEqual(building.nodes);
  });

  test('Рулетка ↔ Траса: одночасно один інструмент; 1 точка — без питання; ≥ 2 — питання; номер не «з’їдається»', async ({ page }) => {
    const errors = await openRoom(page);
    await startRoute(page); // 1 точка
    const ruler = page.getByTestId('ruler');
    const portraitHidden = !(await ruler.isVisible());
    if (!portraitHidden) {
      await ruler.click();
      let s = await state(page);
      expect(s.tool).toBe('ruler');
      expect(s.routes.active).toBe(false);
      expect(s.routes.building).toBeNull();
      await expect(page.getByTestId('choice')).toBeHidden();
      await expect(page.getByTestId('route-panel')).toBeHidden();
      // Рулетка: ставимо точку А (редактор рулетки) — і назад у «Трасу».
      await kit(page).frames(2);
      const a = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: 0.5, y: 0, z: 0.4 }));
      await page.mouse.click(Math.round(a.x), Math.round(a.y));
      await expect(visible(page, 'point-editor')).toHaveCount(1);
      const route = page.getByTestId('route');
      if (await route.isVisible()) {
        await route.click();
        s = await state(page);
        expect(s.tool).toBe('route');
        expect(s.ruler.active).toBe(false);
        expect(s.ruler.editor.active).toBe(false);
        expect(s.routes.phase).toBe('first');
        await expect(visible(page, 'point-editor')).toHaveCount(0);
        await expect(page.getByTestId('route-title')).toHaveText('Траса 1');
      } else {
        await page.getByTestId('ruler-done').filter({ visible: true }).click();
        await visible(page, 'route').click();
      }
      await kit(page).frames(2);
      const p = await page.evaluate(() => window.__trasa!.viewer.projectPoint({ x: -0.5, y: 0, z: 0.4 }));
      await page.mouse.click(Math.round(p.x), Math.round(p.y));
      await confirm(page);
    }
    await holdProfile(page, 'X', 1, [[0.7, 300]]);
    await confirm(page); // 2 точки
    const leave = (await ruler.isVisible()) ? ruler : page.getByTestId('route-close');
    await leave.click();
    await expect(page.getByTestId('choice')).toBeVisible();
    await expect(page.getByTestId('choice-text')).toContainText('2 точки');
    await page.getByTestId('choice-discard').click();
    let s = await state(page);
    expect(s.routes.set.routes).toHaveLength(0);
    expect(s.routes.set.nextId).toBe(1);
    expect(s.tool).toBe(portraitHidden ? 'none' : 'ruler');
    await expect(visible(page, 'point-editor')).toHaveCount(0);
    // Ще раз — тепер «Зберегти трасу».
    if (s.tool === 'ruler') await ruler.click();
    await startRoute(page);
    await holdProfile(page, 'Z', 1, [[0.7, 300]]);
    await confirm(page);
    await ((await ruler.isVisible()) ? ruler : page.getByTestId('route-close')).click();
    await page.getByTestId('choice-save').click();
    s = await state(page);
    expect(s.routes.set.routes.map((r) => r.id)).toEqual([1]);
    expect(s.routes.set.routes[0]!.nodes).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test('траса на 520 точок, побудована джойстиком: кнопки й кадри не гальмують, «Завершити» зберігає всі точки', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors = await openRoom(page);
    await startRoute(page);
    await visible(page, 'view-y').click();
    await kit(page).frames(3);

    /** Середній інтервал кадрів (мс) під час утримання джойстика 1 с. */
    const frameCost = () =>
      page.evaluate(async () => {
        const k = (window as unknown as KitWindow).__kit;
        const p = window.__trasa!.app!.state.routes.editor.point!;
        const s = window.__trasa!.viewer.screenAxes(p);
        const len = Math.hypot(s.X.x, s.X.y) || 1;
        k.press('stick-xz', 41, { x: Math.round((s.X.x / len) * 30), y: Math.round((s.X.y / len) * 30) });
        const times: number[] = [];
        const busy0 = k.busyMs();
        const frames0 = window.__trasa!.viewer.frameCount;
        await new Promise<void>((resolve) => {
          const tick = (t: number) => {
            times.push(t);
            if (times.length < 60) window.requestAnimationFrame(tick);
            else resolve();
          };
          window.requestAnimationFrame(tick);
        });
        const rendered = window.__trasa!.viewer.frameCount - frames0;
        const busy = k.busyMs() - busy0;
        k.release(41);
        const d = times.slice(1).map((t, i) => t - times[i]!);
        return { interval: d.reduce((a, b) => a + b, 0) / d.length, busy: busy / Math.max(1, rendered), rendered };
      });

    /** Побудувати ще n точок: по черзі +X / +Z, короткі утримання (у сторінці, без зайвих пауз). */
    const build = (n: number) =>
      page.evaluate(async (count) => {
        const k = (window as unknown as KitWindow).__kit;
        const app = window.__trasa!.app!;
        let guard = 0;
        const target = app.state.routes.building!.nodes.length + count;
        while (app.state.routes.building!.nodes.length < target && guard++ < count * 3) {
          const i = app.state.routes.building!.nodes.length;
          const p = app.state.routes.editor.point!;
          const s = window.__trasa!.viewer.screenAxes(p);
          const d = i % 2 ? s.Z : s.X;
          const len = Math.hypot(d.x, d.y) || 1;
          k.press('stick-xz', 42, { x: Math.round((d.x / len) * 40), y: Math.round((d.y / len) * 40) });
          await k.frames(2);
          k.release(42);
          k.el('confirm-point').click();
        }
        return app.state.routes.building!.nodes.length;
      }, n);

    // «До»: невелика траса.
    await build(3);
    const costSmall = await frameCost();
    await confirm(page);
    const count = await build(520);
    expect(count).toBeGreaterThanOrEqual(520);
    const costBig = await frameCost();
    // Час обробників кнопок на великій трасі.
    const clicks = await page.evaluate(async () => {
      const k = (window as unknown as KitWindow).__kit;
      const t0 = performance.now();
      k.el('route-remove-last').click();
      const tRemove = performance.now() - t0;
      const p = window.__trasa!.app!.state.routes.editor.point!;
      const s = window.__trasa!.viewer.screenAxes(p);
      const len = Math.hypot(s.Z.x, s.Z.y) || 1;
      k.press('stick-xz', 43, { x: Math.round((s.Z.x / len) * 40), y: Math.round((s.Z.y / len) * 40) });
      await k.frames(3);
      k.release(43);
      const t1 = performance.now();
      k.el('confirm-point').click();
      const tConfirm = performance.now() - t1;
      return { tRemove, tConfirm };
    });
    testInfo.annotations.push({
      type: 'вимір',
      description:
        `робота за кадр під час утримання: ${costSmall.busy.toFixed(1)} мс (мала траса) → ${costBig.busy.toFixed(1)} мс (${count} точок); ` +
        `інтервал кадрів ${costSmall.interval.toFixed(1)} → ${costBig.interval.toFixed(1)} мс (кадрів сцени ${costSmall.rendered}/${costBig.rendered}); ` +
        `«Видалити останню» ${clicks.tRemove.toFixed(1)} мс, «Підтвердити» ${clicks.tConfirm.toFixed(1)} мс`,
    });
    // Додаткова робота за кадр через 500+ точок (проєкція, лінія, підписи, панель) — не більше 8 мс.
    expect(costBig.busy - costSmall.busy).toBeLessThan(8);
    expect(costBig.rendered).toBeGreaterThan(10);
    expect(clicks.tRemove).toBeLessThan(50);
    expect(clicks.tConfirm).toBeLessThan(50);
    const r = await routes(page);
    expect(isValidRoute(r.building!.nodes)).toBe(true);
    expectAxisAligned(r.building!.nodes);
    await expectDrawingMatchesData(page);
    const nodes = r.building!.nodes;
    await visible(page, 'route-finish').click();
    const s = await state(page);
    expect(s.routes.set.routes[0]!.nodes).toEqual(nodes);
    await visible(page, 'route-delete').click();
    await expect(page.getByTestId('route-row-1')).toContainText(`${nodes.length} точ`);
    expect(errors).toEqual([]);
  });

  test('«Видалити траєкторію»: вибрана траса підсвічена й видна цілком (не за панелями й не за краєм); вузли не змінюються', async ({ page }) => {
    const errors = await openRoom(page);
    const long = [
      { x: -1900, y: 2500, z: -1400 },
      { x: 1900, y: 2500, z: -1400 },
      { x: 1900, y: 2500, z: 1400 },
      { x: 1900, y: 200, z: 1400 },
    ];
    const short = [
      { x: -300, y: 100, z: 300 },
      { x: -300, y: 600, z: 300 },
    ];
    await page.evaluate(([a, b]) => window.__trasa!.app!.loadRoutes({ routes: [{ id: 1, nodes: a! }, { id: 2, nodes: b! }], nextId: 3 }), [long, short]);
    // Камера близько до короткої траси: довгої майже не видно.
    await setView(page, { x: 0.2, y: 0.8, z: 1.6 }, { x: -0.3, y: 0.35, z: 0.3 });
    await visible(page, 'route-delete').click();
    for (const [id, nodes] of [[1, long], [2, short]] as const) {
      await page.getByTestId(`route-row-${id}`).click();
      expect((await routes(page)).highlight).toBe(id);
      await kit(page).frames(3);
      const proj = await page.evaluate((pts) => window.__trasa!.viewer.projectPath(pts), nodes.map((n) => toM(n)));
      const vp = page.viewportSize()!;
      const panels = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.panel, .toolbar, .view-bar, .view-area')]
          .filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none')
          .map((e) => e.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }),
      );
      proj.nodes.forEach((n, i) => {
        expect(n.visible, `Траса ${id}, вузол ${i} перед камерою`).toBe(true);
        expect(n.x > 0 && n.x < vp.width && n.y > 0 && n.y < vp.height, `Траса ${id}, вузол ${i} на екрані`).toBe(true);
        for (const r of panels) {
          const inside = n.x > r.left && n.x < r.right && n.y > r.top && n.y < r.bottom;
          expect(inside, `Траса ${id}, вузол ${i} під панеллю`).toBe(false);
        }
      });
      const cls = await page.locator('[data-testid="route-layer"] g.route').evaluateAll((gs) => gs.map((g) => g.getAttribute('class')));
      expect(cls.filter((c) => c?.includes('route--highlight'))).toHaveLength(1);
    }
    expect((await routes(page)).set.routes.map((r) => r.nodes)).toEqual([long, short]);
    expect(errors).toEqual([]);
  });

  test('пошкоджена траса (NaN) через loadRoutes не приймається і не зупиняє малювання сцени', async ({ page }) => {
    await openRoom(page);
    const result = await page.evaluate(() => {
      try {
        window.__trasa!.app!.loadRoutes({
          routes: [{ id: 1, nodes: [{ x: 0, y: 500, z: 0 }, { x: Number.NaN, y: 500, z: 1000 }] }],
          nextId: 2,
        });
        return 'прийнято';
      } catch (error) {
        return `відмова: ${(error as Error).message}`;
      }
    });
    const frames0 = await page.evaluate(() => window.__trasa!.viewer.frameCount);
    await setView(page, { x: 3, y: 3, z: 8 }, { x: 0, y: 1, z: 0 });
    await page.waitForTimeout(300);
    const frames1 = await page.evaluate(() => window.__trasa!.viewer.frameCount);
    const s = await state(page);
    expect(s.routes.set.routes, `loadRoutes: ${result}`).toHaveLength(0);
    expect(frames1, 'сцена перестала перемальовуватись').toBeGreaterThan(frames0);
  });
});
