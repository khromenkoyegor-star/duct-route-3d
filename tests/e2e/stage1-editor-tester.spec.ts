/**
 * Етап 1, доробки (від tester): редактор точки в «Рулетці» та «низ скану на Y = 0».
 * Крайні випадки за вимогами Єгора:
 *  - вісь «як на екрані» з будь-якого боку: згори, знизу (камера під точкою), уздовж осі, з кута, точка за камерою;
 *  - швидкість: мертва зона, ≈ 5 мм/с одразу за нею, ≤ 0,5 м/с; великий крок часу (вкладка у фоні);
 *  - фіксація осі до відпускання; відпускання за межами джойстика; pointercancel; втрата фокусу;
 *  - джойстик + камера пальцями одночасно; дотик по скану під час утримання; повзунок + джойстик;
 *  - швидке подвійне «Підтвердити»; «Підтвердити»/«Закрити»/новий скан під час руху;
 *  - довге утримання — дві інші координати рівно ті самі; підписи в мм;
 *  - низ скану на Y = 0: «опущено», «сміття» під підлогою, пошкоджена вершина (NaN).
 *
 * Утримання джойстика — синтетичними дотиками (Pointer Events просто на елемент): однаково в Chromium і WebKit (CI),
 * без залежності від того, коли браузер оновить розкладку. Мишка — лише там, де важливе справжнє влучання
 * (подвійний клік) або захоплення вказівника (відпускання за межами джойстика). Координати — цілі px.
 * Швидкість рахуємо за часом кадрів (requestAnimationFrame), а не за годинником: у CI кадрів буває мало.
 */
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { joystickDirections, NUDGE_DEAD_ZONE, NUDGE_MAX_DT_S, NUDGE_MAX_MM_S, nudgeSpeed } from '../../src/core/nudge.ts';
import { STICK_TRAVEL_PX } from '../../src/ui/joystick.ts';
import { boxRoom, buildGlb, type MeshInput } from '../fixtures/gltf-builder.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const ROOM_ZIP = fixture('room-4000x2700x3000.zip');
const ROOM_GLB = fixture('room-4000x2700x3000.glb');

type P3 = { x: number; y: number; z: number };
type V2 = { x: number; y: number };
type Axis3 = 'x' | 'y' | 'z';

interface EditorJson {
  active: boolean;
  label: string | null;
  point: P3 | null;
  origin: P3 | null;
  axis: string | null;
}
interface RulerJson {
  active: boolean;
  phase: string;
  points: P3[];
  distanceMm: number | null;
  editor: EditorJson;
}
interface StateJson {
  status: string;
  error: string | null;
  scanName: string | null;
  scanInfo: { offsetYMm: number; sizeMm: P3 } | null;
  ruler: RulerJson;
}

interface Sample {
  t: number;
  p: P3 | null;
}
interface Kit {
  fire(target: string, type: string, id: number, x: number, y: number): void;
  center(testid: string): V2;
  /** Натиснути елемент у центрі й відвести палець на offset (не відпускати). */
  press(testid: string, id: number, offset: V2): void;
  /** Відпустити палець id там, де він зараз. */
  release(id: number, type?: 'pointerup' | 'pointercancel'): void;
  startSampling(): void;
  stopSampling(): Sample[];
  sleep(ms: number): Promise<void>;
  frames(n: number): Promise<void>;
}
interface KitWindow {
  __kit: Kit;
  __rafOffset: number;
}

/** Ставиться до запуску додатка: синтетичні дотики, запис точки щокадру, зсув часу кадрів (для «великого dt»). */
function installKit(): void {
  const w = window as unknown as KitWindow;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  w.__rafOffset = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => nativeRaf((t: number) => cb(t + w.__rafOffset));
  let samples: Sample[] = [];
  let sampling = false;
  const sample = (t: number) => {
    if (!sampling) return;
    const p = window.__trasa?.app?.state.ruler.editor.point ?? null;
    samples.push({ t, p: p ? { x: p.x, y: p.y, z: p.z } : null });
    window.requestAnimationFrame(sample);
  };
  const el = (id: string): HTMLElement => {
    if (id === 'canvas') {
      const canvas = window.__trasa!.viewer.canvas;
      // Синтетичний вказівник не можна «захопити» — заглушка (як у stage1-tester.spec.ts).
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      return canvas;
    }
    const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!found) throw new Error(`немає елемента ${id}`);
    return found;
  };
  const fire = (id: string, type: string, pointerId: number, x: number, y: number) => {
    el(id).dispatchEvent(
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
  const center = (id: string) => {
    const r = el(id).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const held = new Map<number, { id: string; x: number; y: number }>();
  w.__kit = {
    fire,
    center,
    press(id, pointerId, offset) {
      const c = center(id);
      fire(id, 'pointerdown', pointerId, c.x, c.y);
      fire(id, 'pointermove', pointerId, c.x + offset.x, c.y + offset.y);
      held.set(pointerId, { id, x: c.x + offset.x, y: c.y + offset.y });
    },
    release(pointerId, type = 'pointerup') {
      const h = held.get(pointerId);
      if (!h) return;
      // Як при захопленні вказівника: відпускання приходить тому ж елементу, навіть якщо його вже сховали.
      const target = h.id === 'canvas' ? window.__trasa!.viewer.canvas : document.querySelector(`[data-testid="${h.id}"]`)!;
      target.dispatchEvent(
        new PointerEvent(type, { pointerId, pointerType: 'touch', clientX: h.x, clientY: h.y, button: 0, buttons: 0, bubbles: true, cancelable: true, composed: true }),
      );
      held.delete(pointerId);
    },
    startSampling() {
      samples = [];
      sampling = true;
      window.requestAnimationFrame(sample);
    },
    stopSampling() {
      sampling = false;
      return samples;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    frames: (n) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(tick));
        window.requestAnimationFrame(tick);
      }),
  };
}

// ───────────── допоміжне ─────────────

const TRAVEL = STICK_TRAVEL_PX;
/** Відхилення в px: трохи всередині мертвої зони і перший піксель за нею. */
const INSIDE_DEAD_PX = Math.floor(NUDGE_DEAD_ZONE * TRAVEL - 0.01);
const JUST_PAST_DEAD_PX = Math.ceil(NUDGE_DEAD_ZONE * TRAVEL + 0.01);
/** Камера збоку-згори (як у point-editor.spec.ts). */
const OBLIQUE = { from: { x: 2.5, y: 4, z: 9 }, to: { x: 0, y: 0.8, z: 0 } };
/** Камера всередині кімнати, дивиться на підлогу згори: увесь екран — скан. */
const TOP_INSIDE = { from: { x: 0, y: 2.5, z: 0.01 }, to: { x: 0, y: 0, z: 0 } };

const kit = (page: Page) => ({
  center: (id: string) => page.evaluate((i) => (window as unknown as KitWindow).__kit.center(i), id),
  press: (id: string, pointerId: number, offset: V2) =>
    page.evaluate(([i, p, o]) => (window as unknown as KitWindow).__kit.press(i as string, p as number, o as V2), [id, pointerId, offset] as const),
  release: (pointerId: number) => page.evaluate((p) => (window as unknown as KitWindow).__kit.release(p), pointerId),
  frames: (n = 2) => page.evaluate((k) => (window as unknown as KitWindow).__kit.frames(k), n),
});

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)) as StateJson);
const editorPoint = async (page: Page): Promise<P3> => (await state(page)).ruler.editor.point!;
const project = (page: Page, p: P3) => page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), p);
const setView = (page: Page, from: P3, to: P3) =>
  page.evaluate(([f, t]) => window.__trasa!.viewer.setView(f!, t!), [from, to] as const);
const camera = (page: Page) =>
  page.evaluate(() => {
    const v = window.__trasa!.viewer.snapshotView();
    return [...v.position.toArray(), ...v.target.toArray()];
  });
const cameraShift = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const changed = (a: P3, b: P3): Axis3[] => (['x', 'y', 'z'] as const).filter((k) => a[k] !== b[k]);
const along = (d: V2, px: number): V2 => ({ x: Math.round(d.x * px), y: Math.round(d.y * px) });
const knob = (page: Page, id = 'stick-xz') => page.locator(`[data-testid="${id}"] .stick-knob`);

/** Напрямки X і Z на джойстику для точки (так само, як рахує редактор). */
async function stickDirs(page: Page, p: P3) {
  const s = await page.evaluate((point) => window.__trasa!.viewer.screenAxes(point), p);
  return joystickDirections({ X: s.X, Z: s.Z });
}

/**
 * Скільки проїхала координата k і за скільки «часу кадрів» (кожен кадр — не довше NUDGE_MAX_DT_S, як у редакторі).
 * Вікно — від кадру перед першою зміною до останньої зміни.
 */
function motion(samples: Sample[], k: Axis3) {
  const pts = samples.filter((s): s is { t: number; p: P3 } => s.p !== null);
  let first = -1;
  let last = -1;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.p[k] !== pts[i - 1]!.p[k]) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { mm: 0, timeS: 0, maxDtS: 0, frames: 0 };
  let timeS = 0;
  let maxDtS = 0;
  for (let i = first; i <= last; i++) {
    const dt = Math.min((pts[i]!.t - pts[i - 1]!.t) / 1000, NUDGE_MAX_DT_S);
    timeS += dt;
    maxDtS = Math.max(maxDtS, dt);
  }
  return { mm: Math.abs(pts[last]!.p[k] - pts[first - 1]!.p[k]) * 1000, timeS, maxDtS, frames: last - first + 1 };
}

async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installKit);
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return errors;
}

async function openScan(page: Page, files: Parameters<Page['setInputFiles']>[1]): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(files);
  await page.waitForFunction(() => window.__trasa?.app?.state.status !== 'loading', undefined, { timeout: 15_000 });
}

/** Відкрити кімнату й увімкнути рулетку. */
async function openRoomRuler(page: Page): Promise<string[]> {
  const errors = await openApp(page);
  await openScan(page, ROOM_ZIP);
  expect((await state(page)).status).toBe('ready');
  await page.getByTestId('ruler').click();
  return errors;
}

/** Торкнутися точки сцени (мишкою, цілі px) — після того, як розкладка встоялась. */
async function tapWorld(page: Page, p: P3): Promise<void> {
  await kit(page).frames(2);
  const s = await project(page, p);
  await page.mouse.click(Math.round(s.x), Math.round(s.y));
}

/** Поставити точку А на підлозі. */
async function placeA(page: Page, view = OBLIQUE, at: P3 = { x: 0.5, y: 0, z: 0.4 }): Promise<P3> {
  await setView(page, view.from, view.to);
  await tapWorld(page, at);
  await expect(page.getByTestId('point-editor')).toBeVisible();
  await kit(page).frames(2);
  return editorPoint(page);
}

/** Місце на скані, не закрите панелями (сюди можна «торкнутися пальцем»). */
async function freeSpot(page: Page): Promise<V2> {
  await kit(page).frames(2);
  const spot = await page.evaluate(() => {
    const v = window.__trasa!.viewer;
    for (const fy of [0.45, 0.38, 0.52, 0.3, 0.6, 0.25]) {
      for (const fx of [0.62, 0.5, 0.72, 0.4, 0.82, 0.3]) {
        const x = Math.round(innerWidth * fx);
        const y = Math.round(innerHeight * fy);
        if (document.elementFromPoint(x, y) === v.canvas && v.raycastScan(x, y)) return { x, y };
      }
    }
    return null;
  });
  expect(spot, 'знайшлося вільне місце на скані').not.toBeNull();
  return spot!;
}

/** Пальцем (синтетично): натиснути, відвести на offset, тримати ms, відпустити. Повертає кадри (час і точка). */
async function touchHold(page: Page, testid: string, offset: V2, ms: number, id = 41): Promise<Sample[]> {
  const samples = await page.evaluate(
    async ({ testid, offset, ms, id }) => {
      const k = (window as unknown as KitWindow).__kit;
      k.startSampling();
      k.press(testid, id, offset);
      await k.sleep(ms);
      k.release(id);
      await k.frames(2);
      return k.stopSampling();
    },
    { testid, offset, ms, id },
  );
  await kit(page).frames(2);
  return samples;
}

/** Число з підпису інтерфейсу: «−1 234,5» → −1234.5. */
const num = (s: string) => Number(s.replace(/[\s  ]/g, '').replace(/[−‒–]/g, '-').replace(',', '.'));

// ───────────────────────────── вісь «як на екрані» ─────────────────────────────

test.describe('Редактор точки (tester): вісь «як на екрані» з будь-якого боку', () => {
  test('згори, знизу (камера під точкою), уздовж осей, з кута, з протилежного боку: змінюється лише одна координата й у бік стрілки', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const errors = await openRoomRuler(page);
    await placeA(page);
    const views: Array<{ name: string; eye: P3 }> = [
      { name: 'збоку-згори', eye: { x: 2, y: 4, z: 8.6 } },
      { name: 'строго згори', eye: { x: 0, y: 6, z: 0.01 } },
      { name: 'знизу, камера під точкою', eye: { x: 1.2, y: -4, z: 1.8 } },
      { name: 'на рівні точки вздовж −Z (Z «у камеру»)', eye: { x: 0, y: 0, z: 6 } },
      { name: 'на рівні точки вздовж −X (X «у камеру»)', eye: { x: 6, y: 0, z: 0 } },
      { name: 'на рівні точки з кута 45° (X і Z на одній лінії)', eye: { x: 4, y: 0, z: 4 } },
      { name: 'з протилежного боку', eye: { x: -3, y: 2.5, z: -7 } },
    ];
    let id = 200;
    for (const view of views) {
      const p = await editorPoint(page);
      await setView(page, { x: p.x + view.eye.x, y: p.y + view.eye.y, z: p.z + view.eye.z }, p);
      for (const axis of ['X', 'Z'] as const) {
        const before = await editorPoint(page);
        const dirs = await stickDirs(page, before);
        const push = along(dirs[axis], TRAVEL * 0.8);
        await touchHold(page, 'stick-xz', push, 400, id++);
        const after = await editorPoint(page);
        const k = axis.toLowerCase() as Axis3;
        const label = `${view.name}: тягну за стрілкою ${axis} на джойстику`;
        expect(changed(before, after), label).toEqual([k]);
        expect(after[k] - before[k], label).toBeGreaterThan(0);
        // На екрані точка не поїхала проти пальця (обидві проєкції — в одному кадрі).
        const [sb, sa] = [await project(page, before), await project(page, after)];
        const l = Math.hypot(push.x, push.y);
        expect(((sa.x - sb.x) * push.x + (sa.y - sb.y) * push.y) / l, label).toBeGreaterThanOrEqual(-0.5);
      }
    }
    expect(errors).toEqual([]);
  });

  test('точка за камерою: лише одна вісь, без NaN; після відпускання камера показує точку', async ({ page }) => {
    const errors = await openRoomRuler(page);
    const a = await placeA(page);
    await setView(page, { x: a.x, y: 1, z: a.z - 3 }, { x: a.x, y: 1, z: a.z - 10 });
    expect((await project(page, a)).visible, 'умова тесту: точка за камерою').toBe(false);
    await touchHold(page, 'stick-xz', { x: Math.round(TRAVEL * 0.8), y: 0 }, 300);
    const after = await editorPoint(page);
    expect(changed(a, after).length).toBeLessThanOrEqual(1);
    expect(changed(a, after)).not.toContain('y');
    expect([after.x, after.y, after.z].every(Number.isFinite)).toBe(true);
    expect((await project(page, after)).visible, 'після відпускання точку видно').toBe(true);
    expect(errors).toEqual([]);
  });
});

// ───────────────────────────── швидкість ─────────────────────────────

test.describe('Редактор точки (tester): швидкість (за часом кадрів)', () => {
  test('до краю й далі за край — 0,5 м/с і не більше', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const samples = await touchHold(page, 'stick-xz', { x: TRAVEL * 3, y: 0 }, 1000);
    const p1 = await editorPoint(page);
    const moved = changed(p0, p1);
    expect(moved).toHaveLength(1);
    const m = motion(samples, moved[0]!);
    const slack = NUDGE_MAX_MM_S * m.maxDtS; // зсув на один кадр між записом і кроком редактора
    const info = `${m.mm.toFixed(1)} мм за ${m.timeS.toFixed(3)} с кадрів (${m.frames} кадрів)`;
    expect(m.frames, info).toBeGreaterThan(2);
    expect(m.mm, info).toBeLessThanOrEqual(NUDGE_MAX_MM_S * m.timeS + slack + 0.01);
    expect(m.mm, info).toBeGreaterThanOrEqual(NUDGE_MAX_MM_S * m.timeS * 0.9 - slack);
  });

  test('ледь відхилив (перший піксель за мертвою зоною) — ≈ 5 мм/с; у мертвій зоні — рівно нуль (джойстик і повзунок)', async ({
    page,
  }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    // Мертва зона: точка не зрушує ні на долю міліметра.
    await touchHold(page, 'stick-xz', { x: INSIDE_DEAD_PX, y: 0 }, 700, 42);
    await touchHold(page, 'stick-xz', { x: 0, y: -INSIDE_DEAD_PX }, 400, 43);
    await touchHold(page, 'stick-y', { x: 0, y: -INSIDE_DEAD_PX }, 700, 44);
    expect(await editorPoint(page), `${INSIDE_DEAD_PX} px від місця дотику`).toEqual(p0);
    // Одразу за мертвою зоною — повільно, ≈ 5 мм/с.
    const expected = nudgeSpeed(JUST_PAST_DEAD_PX / TRAVEL);
    expect(expected).toBeLessThan(5.5);
    const s1 = await touchHold(page, 'stick-xz', { x: JUST_PAST_DEAD_PX, y: 0 }, 1500, 45);
    const p1 = await editorPoint(page);
    const k1 = changed(p0, p1);
    expect(k1).toHaveLength(1);
    const m1 = motion(s1, k1[0]!);
    const v1 = m1.mm / m1.timeS;
    expect(v1, `джойстик ${JUST_PAST_DEAD_PX} px: ${v1.toFixed(2)} мм/с, ${m1.frames} кадрів`).toBeGreaterThan(3.5);
    expect(v1, `джойстик ${JUST_PAST_DEAD_PX} px: ${v1.toFixed(2)} мм/с, ${m1.frames} кадрів`).toBeLessThan(7);
    const s2 = await touchHold(page, 'stick-y', { x: 0, y: -JUST_PAST_DEAD_PX }, 1500, 46);
    const p2 = await editorPoint(page);
    expect(changed(p1, p2)).toEqual(['y']);
    expect(p2.y).toBeGreaterThan(p1.y);
    const m2 = motion(s2, 'y');
    const v2 = m2.mm / m2.timeS;
    expect(v2, `повзунок ${JUST_PAST_DEAD_PX} px: ${v2.toFixed(2)} мм/с, ${m2.frames} кадрів`).toBeGreaterThan(3.5);
    expect(v2, `повзунок ${JUST_PAST_DEAD_PX} px: ${v2.toFixed(2)} мм/с, ${m2.frames} кадрів`).toBeLessThan(7);
  });

  test('пауза кадрів 10 с під час утримання (вкладка у фоні) — стрибок не більше 0,1 с руху (50 мм)', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const samples = await page.evaluate(async () => {
      const w = window as unknown as KitWindow;
      w.__kit.startSampling();
      w.__kit.press('stick-xz', 51, { x: 300, y: 0 });
      await w.__kit.sleep(300);
      w.__rafOffset += 10_000; // наступний кадр «через 10 с»
      await w.__kit.sleep(300);
      w.__kit.release(51);
      await w.__kit.frames(2);
      return w.__kit.stopSampling();
    });
    const p1 = await editorPoint(page);
    const moved = changed(p0, p1);
    expect(moved).toHaveLength(1);
    // motion() рахує кожен кадр не довше 0,1 с — так само, як має робити редактор.
    const m = motion(samples, moved[0]!);
    const limit = NUDGE_MAX_MM_S * m.timeS + NUDGE_MAX_MM_S * m.maxDtS + 0.01;
    expect(m.mm, `межа ${limit.toFixed(0)} мм (без обмеження кроку було б ≈ 5 000 мм більше)`).toBeLessThanOrEqual(limit);
  });
});

// ───────────────────────────── фіксація, відпускання, скасування ─────────────────────────────

test.describe('Редактор точки (tester): фіксація осі, відпускання, скасування', () => {
  test('вісь фіксується до відпускання: повів палець до іншої осі — та сама вісь; відпустив і натиснув знову — нова', async ({
    page,
  }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const dirs = await stickDirs(page, p0);
    const r = await page.evaluate(
      async ({ toX, toZ }) => {
        const k = (window as unknown as KitWindow).__kit;
        const editor = () => JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor)) as EditorJson;
        const c = k.center('stick-xz');
        k.fire('stick-xz', 'pointerdown', 61, c.x, c.y);
        k.fire('stick-xz', 'pointermove', 61, c.x + toX.x, c.y + toX.y);
        await k.sleep(250);
        // Не відпускаючи, повели палець туди, де стрілка Z.
        for (let i = 1; i <= 5; i++) {
          k.fire('stick-xz', 'pointermove', 61, Math.round(c.x + toX.x + ((toZ.x - toX.x) * i) / 5), Math.round(c.y + toX.y + ((toZ.y - toX.y) * i) / 5));
          await k.sleep(30);
        }
        await k.sleep(250);
        const held = editor();
        k.fire('stick-xz', 'pointerup', 61, c.x + toZ.x, c.y + toZ.y);
        await k.frames(3);
        return { held };
      },
      { toX: along(dirs.X, TRAVEL * 0.7), toZ: along(dirs.Z, TRAVEL * 0.9) },
    );
    expect(r.held.axis, 'вісь під час утримання').toBe('X');
    const mid = await editorPoint(page);
    expect(changed(p0, mid)).toEqual(['x']);
    const dirs2 = await stickDirs(page, mid);
    await touchHold(page, 'stick-xz', along(dirs2.Z, TRAVEL * 0.7), 300, 62);
    const end = await editorPoint(page);
    expect(changed(mid, end)).toEqual(['z']);
    // Після відпускання «кулька» не показує вісь.
    await expect(knob(page)).toHaveText('');
  });

  test('мишкою: відпустив далеко за межами джойстика — рух лише по одній осі, камера стоїть, нова точка не ставиться, рух зупиняється', async ({
    page,
  }) => {
    // Тут потрібне справжнє захоплення вказівника, тому мишка (а не синтетичні події).
    const errors = await openRoomRuler(page);
    const p0 = await placeA(page);
    const dirs = await stickDirs(page, p0);
    const vp = page.viewportSize()!;
    const c = await kit(page).center('stick-xz');
    const far = along(dirs.X, 250);
    const target = {
      x: Math.min(vp.width - 5, Math.max(5, c.x + far.x)),
      y: Math.min(vp.height - 5, Math.max(5, c.y + far.y)),
    };
    const cam0 = await camera(page);
    await page.mouse.move(c.x, c.y);
    await kit(page).frames(2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.waitForTimeout(400);
    const cam1 = await camera(page);
    const during = await editorPoint(page);
    await page.mouse.up();
    await kit(page).frames(3);
    const after = await editorPoint(page);
    expect(changed(p0, during), 'мишка тягнула джойстик — точка мала поїхати').toHaveLength(1);
    expect(changed(p0, after)).toHaveLength(1);
    expect(cameraShift(cam0, cam1), 'камера не крутилась, поки мишка йшла по скану').toBeLessThan(1e-9);
    const s = await state(page);
    expect(s.ruler.editor.origin, 'нова точка не ставилась').toEqual(p0);
    await expect(knob(page)).toHaveText('');
    await page.waitForTimeout(300);
    expect(await editorPoint(page), 'після відпускання точка стоїть').toEqual(after);
    await expect(page.getByTestId('stick-xz')).not.toHaveClass(/stick--active/);
    expect(errors).toEqual([]);
  });

  test('pointercancel (система перехопила дотик): точка зупиняється, джойстик знову працює', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page);
    const r = await page.evaluate(async () => {
      const k = (window as unknown as KitWindow).__kit;
      k.press('stick-xz', 63, { x: 50, y: 0 });
      await k.sleep(250);
      k.release(63, 'pointercancel');
      await k.frames(2);
      const at = JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor.point));
      await k.sleep(400);
      const later = JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor.point));
      const stick = document.querySelector('[data-testid="stick-xz"]')!;
      return { at, later, active: stick.classList.contains('stick--active'), knob: stick.querySelector('.stick-knob')!.textContent };
    });
    expect(r.later).toEqual(r.at);
    expect(r.knob, 'на «кульці» не лишилась вісь').toBe('');
    expect(r.active).toBe(false);
    const before = await editorPoint(page);
    await touchHold(page, 'stick-xz', { x: 50, y: 0 }, 300, 64);
    expect(changed(before, await editorPoint(page))).toHaveLength(1);
  });

  test('втрата фокусу / вкладка у фоні під час утримання: точка не «їде сама» далі', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page);
    const r = await page.evaluate(async () => {
      const k = (window as unknown as KitWindow).__kit;
      const point = () => JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor.point));
      k.press('stick-xz', 71, { x: 40, y: 0 });
      await k.sleep(250);
      // Додаток пішов у фон (дзвінок, Пункт керування): blur + visibilitychange, а відпускання не прийшло.
      window.dispatchEvent(new Event('blur'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      await k.frames(2);
      const p1 = point();
      await k.sleep(400);
      const p2 = point();
      delete (document as unknown as Record<string, unknown>).visibilityState;
      delete (document as unknown as Record<string, unknown>).hidden;
      k.release(71);
      return { p1, p2 };
    });
    expect(r.p2, 'після blur/visibilitychange джойстик мав би «відпуститись»').toEqual(r.p1);
  });
});

// ───────────────────────────── одночасно ─────────────────────────────

test.describe('Редактор точки (tester): джойстик і камера одночасно', () => {
  test('палець лежить на скані, другий рухає джойстик: камера не крутиться від руху джойстика', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const spot = await freeSpot(page);
    const cam0 = await camera(page);
    const r = await page.evaluate(async (spot) => {
      const k = (window as unknown as KitWindow).__kit;
      k.fire('canvas', 'pointerdown', 81, spot.x, spot.y); // палець на скані, нерухомо
      const c = k.center('stick-xz');
      k.fire('stick-xz', 'pointerdown', 82, c.x, c.y);
      for (let i = 1; i <= 24; i++) {
        k.fire('stick-xz', 'pointermove', 82, c.x + 30 + (i % 3), c.y - (i % 2));
        await k.sleep(16);
      }
      k.fire('stick-xz', 'pointerup', 82, c.x + 30, c.y);
      await k.sleep(200);
      const v = window.__trasa!.viewer.snapshotView();
      const cam = [...v.position.toArray(), ...v.target.toArray()];
      k.fire('canvas', 'pointercancel', 81, spot.x, spot.y);
      return { cam, editor: JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor)) as EditorJson };
    }, spot);
    expect(changed(p0, r.editor.point!)).toHaveLength(1);
    expect(r.editor.origin, 'точку не переставлено').toEqual(p0);
    expect(cameraShift(cam0, r.cam), 'камера зрушила, хоча палець на скані не рухався').toBeLessThan(1e-6);
  });

  test('те саме справжніми дотиками (Chromium, два пальці через CDP): камера не крутиться від руху джойстика', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'багатопальцевий дотик через CDP є лише в Chromium (у CI — WebKit, там синтетичний тест вище)');
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const spot = await freeSpot(page);
    const c = await kit(page).center('stick-xz');
    const cam0 = await camera(page);
    const cdp = await page.context().newCDPSession(page);
    const rest = { x: spot.x, y: spot.y, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rest] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rest, { x: c.x, y: c.y, id: 2 }] });
    let stick = { x: c.x, y: c.y, id: 2 };
    for (let i = 1; i <= 20; i++) {
      stick = { x: c.x + 30 + (i % 3), y: c.y - (i % 2), id: 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [rest, stick] });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(200);
    // Обидва пальці ще на екрані: палець на скані за весь час не рухався.
    const cam1 = await camera(page);
    const editor = (await state(page)).ruler.editor;
    // У CDP touchEnd перелічує пальці, які відпускають: спершу джойстик, потім скасувати палець на скані.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [stick] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(changed(p0, editor.point!), 'джойстик справжнім дотиком рухав точку').toHaveLength(1);
    expect(cameraShift(cam0, cam1), 'камера зрушила, хоча палець на скані не рухався').toBeLessThan(1e-6);
  });

  test('два пальці лежать на скані (щипок), третій рухає джойстик: камера не зумиться й не зсувається', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page);
    const spot = await freeSpot(page);
    const cam0 = await camera(page);
    const cam = await page.evaluate(async (spot) => {
      const k = (window as unknown as KitWindow).__kit;
      k.fire('canvas', 'pointerdown', 83, spot.x - 40, spot.y);
      k.fire('canvas', 'pointerdown', 84, spot.x + 40, spot.y);
      const c = k.center('stick-xz');
      k.fire('stick-xz', 'pointerdown', 85, c.x, c.y);
      for (let i = 1; i <= 24; i++) {
        k.fire('stick-xz', 'pointermove', 85, c.x + 30 + (i % 3), c.y - (i % 2));
        await k.sleep(16);
      }
      k.fire('stick-xz', 'pointerup', 85, c.x + 30, c.y);
      await k.sleep(200);
      const v = window.__trasa!.viewer.snapshotView();
      k.fire('canvas', 'pointercancel', 83, spot.x - 40, spot.y);
      k.fire('canvas', 'pointercancel', 84, spot.x + 40, spot.y);
      return [...v.position.toArray(), ...v.target.toArray()];
    }, spot);
    expect(cameraShift(cam0, cam), 'камера зрушила від руху джойстика').toBeLessThan(1e-6);
  });

  test('крутіння камери пальцем під час утримання джойстика: змінюється лише одна координата, точка не переставляється', async ({
    page,
  }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const spot = await freeSpot(page);
    const r = await page.evaluate(async (spot) => {
      const k = (window as unknown as KitWindow).__kit;
      k.press('stick-xz', 86, { x: 40, y: 0 });
      k.fire('canvas', 'pointerdown', 87, spot.x, spot.y);
      for (let i = 1; i <= 20; i++) {
        k.fire('canvas', 'pointermove', 87, spot.x + i * 4, spot.y + i);
        await k.sleep(16);
      }
      k.fire('canvas', 'pointerup', 87, spot.x + 80, spot.y + 20);
      await k.sleep(100);
      k.release(86);
      await k.frames(2);
      return JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler)) as RulerJson;
    }, spot);
    expect(r.phase).toBe('editA');
    expect(r.points).toHaveLength(1);
    expect(r.editor.origin).toEqual(p0);
    expect(changed(p0, r.editor.point!)).toHaveLength(1);
    expect(changed(p0, r.editor.point!)).not.toContain('y');
  });

  test('дотик по скану під час утримання джойстика (точку вже підсунуто): точка не переноситься, є підказка', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const spot = await freeSpot(page);
    const r = await page.evaluate(async (spot) => {
      const k = (window as unknown as KitWindow).__kit;
      k.press('stick-xz', 91, { x: 45, y: 0 });
      await k.sleep(300);
      k.fire('canvas', 'pointerdown', 92, spot.x, spot.y);
      await k.sleep(60);
      k.fire('canvas', 'pointerup', 92, spot.x, spot.y);
      await k.sleep(200);
      k.release(91);
      await k.frames(2);
      return JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler)) as RulerJson;
    }, spot);
    expect(r.phase).toBe('editA');
    expect(r.points).toHaveLength(1);
    expect(r.editor.origin, 'точку не перенесено одним дотиком').toEqual(p0);
    expect(changed(p0, r.editor.point!)).toHaveLength(1);
    await expect(page.getByTestId('ruler-sub')).toContainText('ще раз');
  });

  test('повзунок і джойстик разом: за кадр змінюється не більше однієї координати', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const dirs = await stickDirs(page, p0);
    const samples = await page.evaluate(
      async ({ toX, up }) => {
        const k = (window as unknown as KitWindow).__kit;
        k.startSampling();
        k.press('stick-y', 101, { x: 0, y: -up });
        await k.sleep(200);
        k.press('stick-xz', 102, toX);
        await k.sleep(400);
        k.release(102);
        await k.sleep(200);
        k.release(101);
        await k.frames(2);
        return k.stopSampling();
      },
      { toX: along(dirs.X, TRAVEL * 0.8), up: Math.round(TRAVEL * 0.8) },
    );
    const pts = samples.map((s) => s.p).filter((p): p is P3 => p !== null);
    expect(pts.length).toBeGreaterThan(5);
    for (let i = 1; i < pts.length; i++) {
      expect(changed(pts[i - 1]!, pts[i]!).length, `кадр ${i}`).toBeLessThanOrEqual(1);
    }
    expect((await editorPoint(page)).z, 'Z не чіпали').toBe(p0.z);
  });

  test('повзунок тримають, джойстик відпустили й натиснули знову в бік Z — рухається Z (вісь знято при відпусканні)', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const dirs = await stickDirs(page, p0);
    const r = await page.evaluate(
      async ({ toX, toZ }) => {
        const k = (window as unknown as KitWindow).__kit;
        const editor = () => JSON.parse(JSON.stringify(window.__trasa!.app!.state.ruler.editor)) as EditorJson;
        // Палець просто лежить на повзунку (у мертвій зоні).
        k.press('stick-y', 111, { x: 0, y: -2 });
        k.press('stick-xz', 112, toX);
        await k.sleep(300);
        k.release(112);
        await k.frames(3);
        const mid = editor();
        k.press('stick-xz', 113, toZ);
        await k.sleep(300);
        const during = editor();
        k.release(113);
        await k.frames(2);
        k.release(111);
        return { mid, during };
      },
      { toX: along(dirs.X, TRAVEL * 0.8), toZ: along(dirs.Z, TRAVEL * 0.8) },
    );
    expect(changed(p0, r.mid.point!)).toEqual(['x']);
    expect(r.during.axis, 'другий раз тягну до Z, а рухається').toBe('Z');
    expect(changed(r.mid.point!, r.during.point!)).toEqual(['z']);
  });
});

// ───────────────────────────── «Підтвердити», «Закрити», новий скан ─────────────────────────────

/** Центр кнопки «Підтвердити точку» (цілі px) + перевірка, що під нею — скан (інакше тест нічого не доводить). */
async function confirmCenterOverScan(page: Page): Promise<V2> {
  await kit(page).frames(2);
  const box = (await page.getByTestId('confirm-point').boundingBox())!;
  const c = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const under = await page.evaluate((p) => !!window.__trasa!.viewer.raycastScan(p.x, p.y), c);
  expect(under, 'умова тесту: під кнопкою — скан').toBe(true);
  return c;
}

test.describe('Редактор точки (tester): «Підтвердити», «Закрити», новий скан', () => {
  test('подвійний клік по «Підтвердити точку А»: друге натискання не ставить точку Б', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page, TOP_INSIDE, { x: 0.3, y: 0, z: -0.3 });
    const c = await confirmCenterOverScan(page);
    await page.mouse.dblclick(c.x, c.y);
    await kit(page).frames(3);
    const s = await state(page);
    const hit = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
      return el?.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? el?.tagName ?? null;
    }, c);
    expect(s.ruler.phase, `після подвійного кліку (на місці кнопки тепер: ${hit})`).toBe('pickB');
    expect(s.ruler.points).toHaveLength(1);
  });

  test('подвійний клік по «Підтвердити точку Б»: вимір лишається, новий не починається', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page, TOP_INSIDE, { x: 0.3, y: 0, z: -0.3 });
    await page.getByTestId('confirm-point').click();
    await page.waitForTimeout(400); // захист від подвійного натискання (0,35 с)
    const spot = await freeSpot(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId('point-editor')).toBeVisible();
    expect((await state(page)).ruler.phase).toBe('editB');
    const c = await confirmCenterOverScan(page);
    await page.mouse.dblclick(c.x, c.y);
    await kit(page).frames(3);
    const s = await state(page);
    expect(s.ruler.phase, 'після подвійного кліку').toBe('done');
    expect(s.ruler.points).toHaveLength(2);
    expect(s.ruler.distanceMm).not.toBeNull();
  });

  test('«Підтвердити» другим пальцем, поки джойстик тримають: А фіксується як є; Б не їде сама; джойстик не «заклинює»', async ({
    page,
  }) => {
    const errors = await openRoomRuler(page);
    await placeA(page);
    await kit(page).press('stick-xz', 121, { x: 45, y: 0 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const app = window.__trasa!.app!;
      const before = { ...app.state.ruler.editor.point! };
      document.querySelector<HTMLElement>('[data-testid="confirm-point"]')!.click();
      return { before, after: JSON.parse(JSON.stringify(app.state.ruler)) as RulerJson };
    });
    expect(r.after.phase).toBe('pickB');
    expect(r.after.points[0]).toEqual(r.before);
    await page.waitForTimeout(400); // і заодно минає захист від подвійного натискання
    expect((await state(page)).ruler.points[0], 'А після підтвердження не «доїжджає»').toEqual(r.before);
    // Б ставлять третім пальцем, поки перший ще тримає джойстик.
    const spot = await freeSpot(page);
    await page.evaluate(async (s) => {
      const k = (window as unknown as KitWindow).__kit;
      k.fire('canvas', 'pointerdown', 122, s.x, s.y);
      await k.sleep(50);
      k.fire('canvas', 'pointerup', 122, s.x, s.y);
      await k.frames(2);
    }, spot);
    const b = await state(page);
    expect(b.ruler.phase).toBe('editB');
    const b0 = b.ruler.editor.point!;
    await page.waitForTimeout(300);
    expect((await state(page)).ruler.editor.point, 'Б не їде від «старого» утримання').toEqual(b0);
    await kit(page).release(121);
    await kit(page).frames(2);
    await touchHold(page, 'stick-xz', { x: 45, y: 0 }, 300, 123);
    const end = await state(page);
    expect(changed(b0, end.ruler.editor.point!), 'джойстик після цього працює').toHaveLength(1);
    expect(end.ruler.points[0]).toEqual(r.before);
    expect(errors).toEqual([]);
  });

  test('«Закрити» під час руху: рулетка й редактор закриваються, точка не рухається; потім усе працює знову', async ({ page }) => {
    const errors = await openRoomRuler(page);
    await placeA(page);
    await kit(page).press('stick-xz', 131, { x: 45, y: 0 });
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="ruler-done"]')!.click());
    let s = await state(page);
    expect(s.ruler.active).toBe(false);
    expect(s.ruler.editor.active).toBe(false);
    expect(s.ruler.points).toEqual([]);
    expect(await page.evaluate(() => document.querySelector('#app')!.classList.contains('is-editing-point'))).toBe(false);
    await expect(page.getByTestId('point-editor')).toBeHidden();
    await page.waitForTimeout(300);
    await kit(page).release(131);
    await page.getByTestId('ruler').click();
    const a = await placeA(page);
    await page.waitForTimeout(300);
    expect(await editorPoint(page), 'нова точка не їде сама').toEqual(a);
    await touchHold(page, 'stick-xz', { x: 45, y: 0 }, 300, 132);
    s = await state(page);
    expect(changed(a, s.ruler.editor.point!)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('новий скан під час руху точки: редактор закривається, скан відкривається, далі все працює', async ({ page }) => {
    const errors = await openRoomRuler(page);
    await placeA(page);
    await kit(page).press('stick-xz', 141, { x: 45, y: 0 });
    await page.waitForTimeout(200);
    await openScan(page, ROOM_GLB);
    let s = await state(page);
    expect(s.status).toBe('ready');
    expect(s.scanName).toBe('room-4000x2700x3000.glb');
    expect(s.ruler.active).toBe(false);
    expect(s.ruler.editor.active).toBe(false);
    expect(s.ruler.points).toEqual([]);
    await page.waitForTimeout(200);
    await kit(page).release(141);
    await page.getByTestId('ruler').click();
    const a = await placeA(page);
    await touchHold(page, 'stick-xz', { x: 45, y: 0 }, 300, 142);
    s = await state(page);
    expect(changed(a, s.ruler.editor.point!)).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

// ───────────────────────────── точність ─────────────────────────────

test.describe('Редактор точки (tester): точність', () => {
  test('довге утримання (3 с): дві інші координати бітово ті самі в кожному кадрі; підписи в мм збігаються з даними', async ({ page }) => {
    await openRoomRuler(page);
    const p0 = await placeA(page);
    const dirs = await stickDirs(page, p0);
    const samples = await touchHold(page, 'stick-xz', along(dirs.Z, TRAVEL * 0.5), 3000);
    const pts = samples.map((s) => s.p).filter((p): p is P3 => p !== null);
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) {
      expect(p.x).toBe(p0.x);
      expect(p.y).toBe(p0.y);
    }
    const end = await editorPoint(page);
    const dzMm = (end.z - p0.z) * 1000;
    expect(Math.abs(dzMm)).toBeGreaterThan(5);
    // Монотонно, без «відкатів».
    for (let i = 1; i < pts.length; i++) expect(Math.sign(pts[i]!.z - pts[i - 1]!.z) * Math.sign(dzMm)).toBeGreaterThanOrEqual(0);
    // «Зсув: Z +52,3 мм» — число = справжній зсув (±0,05 мм), інших осей немає.
    const shift = (await page.getByTestId('point-shift').textContent())!;
    const m = shift.match(/^Зсув: Z\s*\+?([−\-]?[\d\s  ]+(?:,\d)?)\s*мм$/);
    expect(m, shift).not.toBeNull();
    expect(Math.abs(num(m![1]!) - dzMm)).toBeLessThanOrEqual(0.051);
    // Координати: «X … · Y … · Z … мм» = дані точки (±0,05 мм).
    const coords = (await page.getByTestId('point-coords').textContent())!;
    const c = coords.match(/^X\s*(.+?)\s*·\s*Y\s*(.+?)\s*·\s*Z\s*(.+?)\s*мм$/);
    expect(c, coords).not.toBeNull();
    expect(Math.abs(num(c![1]!) - end.x * 1000)).toBeLessThanOrEqual(0.051);
    expect(Math.abs(num(c![2]!) - end.y * 1000)).toBeLessThanOrEqual(0.051);
    expect(Math.abs(num(c![3]!) - end.z * 1000)).toBeLessThanOrEqual(0.051);
  });

  test('вимір після доведення: відстань = |А − Б| підтверджених точок (±0,001 мм), підпис — те саме число', async ({ page }) => {
    await openRoomRuler(page);
    await placeA(page);
    await touchHold(page, 'stick-y', { x: 0, y: -Math.round(TRAVEL * 0.6) }, 400);
    await page.getByTestId('confirm-point').click();
    await page.waitForTimeout(400); // захист від подвійного натискання (0,35 с)
    const spot = await freeSpot(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId('point-editor')).toBeVisible();
    const b0 = await editorPoint(page);
    const dirs = await stickDirs(page, b0);
    await touchHold(page, 'stick-xz', along(dirs.X, TRAVEL * 0.6), 400, 43);
    await page.getByTestId('confirm-point').click();
    await page.waitForTimeout(400); // захист від подвійного натискання (0,35 с)
    const s = await state(page);
    expect(s.ruler.phase).toBe('done');
    const [a, b] = s.ruler.points as [P3, P3];
    expect(a.y).toBeGreaterThan(0.001);
    const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000;
    expect(Math.abs(s.ruler.distanceMm! - dist)).toBeLessThan(0.001);
    const text = (await page.getByTestId('ruler-text').textContent())!;
    expect(Math.abs(num(text.replace(/\s*мм$/, '')) - s.ruler.distanceMm!)).toBeLessThanOrEqual(0.051);
  });

  test('стан для тестів (app.state.ruler.editor) актуальний після відпускання: axis = null', async ({ page }) => {
    // Цей стан — «вікно» в редактор для автотестів і для етапів 2–3; він має збігатися з тим, що на екрані.
    await openRoomRuler(page);
    await placeA(page);
    await touchHold(page, 'stick-xz', { x: 45, y: 0 }, 300);
    await expect(knob(page)).toHaveText('');
    expect((await state(page)).ruler.editor.axis, 'джойстик відпущено, а в стані досі вісь').toBeNull();
  });

  test('підсунуту точку переносять другим дотиком: якщо підказка «торкніться ще раз» ще на екрані — другий дотик спрацьовує', async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await openRoomRuler(page);
    const p0 = await placeA(page);
    await touchHold(page, 'stick-xz', { x: 45, y: 0 }, 300);
    const moved = await editorPoint(page);
    expect(moved).not.toEqual(p0);
    const spot = await freeSpot(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId('ruler-sub')).toContainText('ще раз');
    expect(await editorPoint(page), 'перший дотик не переносить').toEqual(moved);
    // Людина повагалась кілька секунд.
    await page.waitForTimeout(4300);
    const hintStillShown =
      (await page.getByTestId('ruler-sub').isVisible()) && ((await page.getByTestId('ruler-sub').textContent()) ?? '').includes('ще раз');
    if (!hintStillShown) return; // підказка зникла — тоді все чесно
    await page.mouse.click(spot.x, spot.y);
    const s = await state(page);
    expect(s.ruler.editor.origin, 'підказка просить торкнутися ще раз, але другий дотик точку не переніс').not.toEqual(p0);
  });
});

// ───────────────────────────── низ скану на Y = 0 ─────────────────────────────

/** Камера всередині кімнати над підлогою (y — висота підлоги в сцені), торкнутися підлоги, повернути точку. */
async function tapFloor(page: Page, floorY: number): Promise<P3> {
  await setView(page, { x: 0, y: floorY + 2.2, z: 0.01 }, { x: 0, y: floorY, z: 0 });
  await tapWorld(page, { x: 0.3, y: floorY, z: -0.2 });
  await expect(page.getByTestId('point-editor')).toBeVisible();
  return editorPoint(page);
}

function shard(at: [number, number, number]): MeshInput {
  const [x, y, z] = at;
  return { name: 'shard', positions: new Float32Array([x, y, z, x + 0.05, y, z, x, y, z + 0.05]), indices: new Uint16Array([0, 1, 2]) };
}

test.describe('Низ скану на Y = 0 (tester)', () => {
  test('скан вище нуля → «скан опущено на 500 мм»; торкнувся підлоги — Y = 0 (±0,1 мм)', async ({ page }) => {
    const errors = await openApp(page);
    const glb = buildGlb({ meshes: [boxRoom([-2, 0.5, -1.5], [2, 3.2, 1.5])] });
    await openScan(page, { name: 'high.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glb) });
    const s = await state(page);
    expect(s.status).toBe('ready');
    expect(Math.abs(s.scanInfo!.offsetYMm - -500)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo!.sizeMm.y - 2700)).toBeLessThan(0.1);
    await expect(page.getByTestId('scan-offset')).toHaveText(/^Низ скану на Y = 0 · скан опущено на 500 мм$/);
    const minY = await page.evaluate(() => window.__trasa!.viewer.scanBox()!.min.y);
    expect(Math.abs(minY)).toBeLessThan(1e-4);
    await page.getByTestId('ruler').click();
    const p = await tapFloor(page, 0);
    expect(Math.abs(p.y * 1000), `Y підлоги = ${p.y * 1000} мм`).toBeLessThanOrEqual(0.1);
    await expect(page.getByTestId('point-coords')).toHaveText(/·\s*Y\s*0\s*·/);
    expect(errors).toEqual([]);
  });

  test('«сміття» на 350 мм нижче підлоги: на Y = 0 — уламок, підлога на +350 мм (так за вимогою — варто показати Єгору)', async ({
    page,
  }) => {
    await openApp(page);
    const glb = buildGlb({ meshes: [boxRoom([-2, -1.4, -1.5], [2, 1.3, 1.5]), shard([0.7, -1.75, 0.2])] });
    await openScan(page, { name: 'garbage.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glb) });
    const s = await state(page);
    expect(Math.abs(s.scanInfo!.offsetYMm - 1750)).toBeLessThan(0.1);
    await expect(page.getByTestId('scan-offset')).toHaveText(/^Низ скану на Y = 0 · скан піднято на 1\s750 мм$/);
    await page.getByTestId('ruler').click();
    const p = await tapFloor(page, 0.35);
    expect(Math.abs(p.y * 1000 - 350)).toBeLessThanOrEqual(0.1);
  });

  test('пошкоджена вершина (NaN) у першому ж скані: додаток не «зависає» у відкритті, потім відкривається нормальний скан', async ({
    page,
  }) => {
    await openApp(page);
    const broken = boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]);
    broken.positions[4] = Number.NaN;
    await page
      .getByTestId('file-input')
      .setInputFiles({ name: 'nan.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(buildGlb({ meshes: [broken] })) });
    // Не чекаємо вічно: якщо стан так і лишився «loading» — це і є помилка.
    await page
      .waitForFunction(() => window.__trasa?.app?.state.status !== 'loading', undefined, { timeout: 5_000 })
      .catch(() => {});
    const s = await state(page);
    expect(s.status, 'стан після відкриття пошкодженого скану').not.toBe('loading');
    const cam = await camera(page);
    expect(cam.every(Number.isFinite), 'камера без NaN').toBe(true);
    await openScan(page, ROOM_ZIP);
    const ok = await state(page);
    expect(ok.status, 'нормальний скан після пошкодженого').toBe('ready');
    expect(ok.scanName).toBe('room-4000x2700x3000.zip');
  });
});
