/**
 * Етап 1 (від tester): перевірки, яких немає в scan.spec.ts.
 *  - важкий скан ≈ 38 МБ / 1 млн трикутників / текстура 8192² — відкривається без вильоту;
 *  - заміна скану звільняє пам'ять відеокарти (WebGL-буфери й текстури), blob: адреси прибрано;
 *  - зменшення текстур: на iPhone жодна текстура не більша за 4096, на iPad — за 8192;
 *  - скан нікуди не відправляється (жодного запиту в мережу під час відкриття);
 *  - камера: права кнопка — зсув, колесо — зум до курсора, два пальці — зсув і щипок;
 *  - рулетка: дотиком, під кутом, клік vs перетягування, правий клік, два пальці;
 *  - «Показати все» для скану далеко від нуля, дуже великого й дуже малого.
 *
 * Великий архів генерується під час тесту в test-results/generated/ (у .gitignore), у репозиторій не потрапляє.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import {
  boxRoom,
  buildGlb,
  buildGltf,
  heavyRoomMesh,
  makePng,
  toGlb,
  type Vec3,
} from '../fixtures/gltf-builder.ts';
import { writeZip } from '../fixtures/zip-writer.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const ROOM_ZIP = fixture('room-4000x2700x3000.zip');
const ROOM_GLB = fixture('room-4000x2700x3000.glb');

const GENERATED = fileURLToPath(new URL('../../test-results/generated/', import.meta.url));
const BIG_ZIP = `${GENERATED}big-scan-1M-8192.zip`;
const BIG_TRIANGLES = 1_001_160;

interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface Probe {
  buffers: number;
  textures: number;
  blobUrls: number;
  uploads: Array<[number, number]>;
}

/** Лічильники WebGL-ресурсів і blob: адрес — ставляться до запуску додатка. */
function installProbe() {
  const buffers = new Set<unknown>();
  const textures = new Set<unknown>();
  const uploads: Array<[number, number]> = [];
  const urls = new Set<string>();
  type Fn = (...args: unknown[]) => unknown;
  const protos = [
    (window as unknown as { WebGLRenderingContext?: { prototype: Record<string, Fn> } }).WebGLRenderingContext?.prototype,
    (window as unknown as { WebGL2RenderingContext?: { prototype: Record<string, Fn> } }).WebGL2RenderingContext?.prototype,
  ];
  for (const proto of protos) {
    if (!proto) continue;
    const wrap = (name: string, after: (args: unknown[], result: unknown) => void) => {
      const original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        after(args, result);
        return result;
      };
    };
    wrap('createBuffer', (_a, r) => r && buffers.add(r));
    wrap('deleteBuffer', (a) => buffers.delete(a[0]));
    wrap('createTexture', (_a, r) => r && textures.add(r));
    wrap('deleteTexture', (a) => textures.delete(a[0]));
    wrap('texStorage2D', (a) => uploads.push([a[3] as number, a[4] as number]));
    wrap('texImage2D', (a) => {
      if (a[1] !== 0) return;
      if (a.length === 6) {
        const source = a[5] as { width?: number; height?: number } | null;
        uploads.push([source?.width ?? 0, source?.height ?? 0]);
      } else {
        uploads.push([a[3] as number, a[4] as number]);
      }
    });
  }
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object);
    urls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    urls.delete(url);
    revoke(url);
  };
  (window as unknown as { __probe: () => unknown }).__probe = () => ({
    buffers: buffers.size,
    textures: textures.size,
    blobUrls: urls.size,
    uploads: uploads.slice(),
  });
}

async function openApp(page: Page): Promise<{ errors: string[]; consoleErrors: string[] }> {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(installProbe);
  await page.goto('./');
  await page.waitForFunction(() => (window.__trasa?.viewer.frameCount ?? 0) > 0, undefined, { timeout: 15_000 });
  return { errors, consoleErrors };
}

async function chooseFiles(page: Page, files: string | FilePayload | FilePayload[], timeout = 15_000): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(files as Parameters<Page['setInputFiles']>[1]);
  // Дочекатися, поки почнеться й закінчиться завантаження.
  await page.waitForFunction(() => window.__trasa?.app?.state.status !== 'loading', undefined, { timeout });
}

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__trasa!.app!.state)));
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __probe: () => Probe }).__probe());
const project = (page: Page, p: { x: number; y: number; z: number }) =>
  page.evaluate((point) => window.__trasa!.viewer.projectPoint(point), p);
const frames = (page: Page) => page.evaluate(() => window.__trasa!.viewer.frameCount);

/** Чекати, поки камера зупиниться (кадри перестануть малюватися). */
async function waitForIdle(page: Page, timeout = 5_000): Promise<void> {
  const start = Date.now();
  let last = await frames(page);
  let still = 0;
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(100);
    const now = await frames(page);
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3) return;
  }
}

/** Дочекатися, що свіжий кадр намальовано (щоб WebGL-ресурси створено або звільнено). */
async function nextFrames(page: Page, count = 3): Promise<void> {
  const start = await frames(page);
  await page.evaluate(() => window.__trasa!.viewer.requestRender());
  await page.waitForFunction(
    ([s, c]) => {
      window.__trasa!.viewer.requestRender();
      return window.__trasa!.viewer.frameCount >= s! + c!;
    },
    [start, count],
    { timeout: 10_000, polling: 50 },
  );
}

async function deviceMaxTexture(page: Page): Promise<number> {
  // Те саме правило, що й у додатку: сенсорний екран і коротка сторона < 600 px — iPhone.
  const phone = await page.evaluate(() => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
  return phone ? 4096 : 8192;
}

/** Згенерувати важкий скан один раз (детерміновано; кілька процесів можуть писати — пишемо через rename). */
async function ensureBigZip(): Promise<string> {
  if (existsSync(BIG_ZIP) && (await stat(BIG_ZIP)).size > 30 * 1024 * 1024) return BIG_ZIP;
  await mkdir(GENERATED, { recursive: true });
  const mesh = heavyRoomMesh();
  const { json, bin } = buildGltf({
    meshes: [mesh],
    materials: [{ name: 'scan', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987 }],
    images: [{ uri: 'textures/texture%200.png', mimeType: 'image/png' }],
  });
  json.buffers[0] = { byteLength: bin.byteLength, uri: 'scene.bin' };
  const zip = writeZip([
    { name: 'Big Scan/', data: new Uint8Array(0), method: 0 },
    { name: 'Big Scan/scene.gltf', data: new TextEncoder().encode(JSON.stringify(json)) },
    { name: 'Big Scan/scene.bin', data: bin, dataDescriptor: true },
    { name: 'Big Scan/textures/', data: new Uint8Array(0), method: 0 },
    { name: 'Big Scan/textures/texture 0.png', data: makePng(8192, 8192, { noiseEvery: 10 }), method: 0 },
    { name: '__MACOSX/Big Scan/._scene.gltf', data: new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]), method: 0 },
  ]);
  const tmp = `${BIG_ZIP}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, zip);
  await rename(tmp, BIG_ZIP);
  return BIG_ZIP;
}

const glbPayload = (name: string, bytes: Uint8Array): FilePayload => ({
  name,
  mimeType: 'model/gltf-binary',
  buffer: Buffer.from(bytes),
});

const corners = (min: Vec3, max: Vec3) =>
  [min[0], max[0]].flatMap((x) => [min[1], max[1]].flatMap((y) => [min[2], max[2]].map((z) => ({ x, y, z }))));

async function allInView(page: Page, points: Array<{ x: number; y: number; z: number }>): Promise<boolean> {
  const viewport = page.viewportSize()!;
  for (const point of points) {
    const p = await project(page, point);
    if (!p.visible || p.x < 0 || p.y < 0 || p.x > viewport.width || p.y > viewport.height) return false;
  }
  return true;
}

/** Синтетичні дотики (Pointer Events) — працюють і в Chromium, і в WebKit. */
async function touchGesture(page: Page, tracks: Array<Array<{ x: number; y: number }>>): Promise<void> {
  await page.evaluate(async (paths) => {
    const canvas = window.__trasa!.viewer.canvas;
    // Синтетичні вказівники не можна «захопити» — заглушка лише для цього тесту.
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const fire = (type: string, id: number, p: { x: number; y: number }) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 100 + id,
          pointerType: 'touch',
          isPrimary: id === 0,
          clientX: p.x,
          clientY: p.y,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    const steps = paths[0]!.length;
    paths.forEach((path, id) => fire('pointerdown', id, path[0]!));
    for (let i = 1; i < steps; i++) {
      paths.forEach((path, id) => fire('pointermove', id, path[i]!));
      await new Promise((r) => setTimeout(r, 16));
    }
    paths.forEach((path, id) => fire('pointerup', id, path[steps - 1]!));
  }, tracks);
}

const line = (from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));

/** Точка «нескінченно далеко» в напрямку d: її положення на екрані залежить лише від повороту камери. */
const FAR = 1e6;
async function vanishing(page: Page) {
  return Promise.all([
    project(page, { x: FAR, y: 0, z: 0 }),
    project(page, { x: 0, y: 0, z: -FAR }),
    project(page, { x: 0, y: FAR, z: 0 }),
  ]);
}
const moved = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Камера перед кімнатою: обидві бічні стіни видно зсередини. */
async function lookIntoRoom(page: Page, from = { x: 0, y: 1.5, z: 14 }, to = { x: 0, y: 1.2, z: 0 }) {
  await page.evaluate(([f, t]) => window.__trasa!.viewer.setView(f!, t!), [from, to]);
  await waitForIdle(page);
}

/**
 * Торкнутися стіни «в лоб»: камера зсередини кімнати за 1 м від точки, дивиться перпендикулярно на стіну.
 * Так похибка влучання — частки міліметра (під гострим кутом 1 px = десятки мм уздовж стіни).
 */
async function tapWall(page: Page, point: Vec3, inward: Vec3, tap: (p: { x: number; y: number }) => Promise<void>) {
  const eye = { x: point[0] + inward[0], y: point[1] + inward[1], z: point[2] + inward[2] };
  const target = { x: point[0], y: point[1], z: point[2] };
  // Для погляду строго вгору/вниз — трохи нахилити, щоб камера не «перевернулась».
  if (inward[1] !== 0) eye.z += 0.05;
  await lookIntoRoom(page, eye, target);
  // Цілі пікселі — як у WebKit (Safari), де координати дотику округлюються.
  const p = await project(page, target);
  await tap({ x: Math.round(p.x), y: Math.round(p.y) });
}

function note(testInfo: TestInfo, text: string) {
  testInfo.annotations.push({ type: 'вимір', description: text });
  console.log(`[${testInfo.project.name}] ${text}`);
}

// ───────────────────────────── важкий скан ─────────────────────────────

test.describe('Етап 1 (tester): важкий скан ≈ 38 МБ, 1 млн трикутників, текстура 8192²', () => {
  test.setTimeout(240_000);

  test('відкривається без вильоту; габарит точний; текстури в межах для пристрою; рулетка 4000 мм', async ({ page }, testInfo) => {
    const path = await ensureBigZip();
    const size = (await stat(path)).size;
    expect(size).toBeGreaterThan(30 * 1024 * 1024);
    const { errors, consoleErrors } = await openApp(page);
    const maxSide = await deviceMaxTexture(page);

    const t0 = Date.now();
    await page.getByTestId('file-input').setInputFiles(path);
    // Під час завантаження: індикатор і заблокована кнопка (подвійне відкриття неможливе).
    await expect(page.getByTestId('progress')).toBeVisible();
    await expect(page.getByTestId('open-scan')).toBeDisabled();
    await page.waitForFunction(() => window.__trasa?.app?.state.status !== 'loading', undefined, { timeout: 200_000 });
    const loadMs = Date.now() - t0;
    await nextFrames(page);

    const s = await state(page);
    expect(s.error).toBeNull();
    expect(s.status).toBe('ready');
    expect(s.scanInfo.triangles).toBe(BIG_TRIANGLES);
    expect(s.scanInfo.fileBytes).toBe(size);
    expect(Math.abs(s.scanInfo.sizeMm.x - 4000)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.y - 2700)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.z - 3000)).toBeLessThan(0.1);
    await expect(page.getByTestId('scan-stats')).toContainText(/1\s001\s160 трикутників/);
    await expect(page.getByTestId('scan-stats')).toContainText(/МБ/);
    if (maxSide === 4096) {
      expect(s.scanInfo.warnings.join(' ')).toMatch(/Текстури зменшено/);
    }

    const uploads = (await probe(page)).uploads;
    const biggest = Math.max(...uploads.map(([w, h]) => Math.max(w, h)));
    expect(biggest, `найбільша текстура у відеопам'яті: ${biggest}px`).toBeLessThanOrEqual(maxSide);
    expect(uploads.some(([w, h]) => Math.max(w, h) >= 4096), 'велика текстура скану завантажилась').toBe(true);

    // Рулетка на важкому меші — і скільки триває пошук точки.
    await page.getByTestId('ruler').click();
    const click = (p: { x: number; y: number }) => page.mouse.click(p.x, p.y);
    await tapWall(page, [-2, 1.2, -0.5], [1, 0, 0], click);
    await tapWall(page, [2, 1.2, -0.5], [-1, 0, 0], click);
    await lookIntoRoom(page);
    const r = await state(page);
    expect(r.ruler.points).toHaveLength(2);
    expect(Math.abs(r.ruler.distanceMm - 4000)).toBeLessThanOrEqual(1);
    const rayMs = await page.evaluate(() => {
      const viewer = window.__trasa!.viewer;
      const rect = viewer.canvas.getBoundingClientRect();
      const t = performance.now();
      for (let i = 0; i < 5; i++) viewer.raycastScan(rect.left + rect.width * (0.3 + i * 0.1), rect.top + rect.height * 0.5);
      return (performance.now() - t) / 5;
    });
    note(testInfo, `важкий скан: ${(size / 1024 / 1024).toFixed(1)} МБ відкрито за ${loadMs} мс; пошук точки рулетки ≈ ${rayMs.toFixed(0)} мс`);

    expect(errors).toEqual([]);
    expect(consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });

  test('заміна скану звільняє відеопам\'ять: після важкого → маленький стільки ж ресурсів, як до важкого', async ({ page, browserName }, testInfo) => {
    const path = await ensureBigZip();
    const { errors } = await openApp(page);
    await nextFrames(page);
    const empty = await probe(page);

    await chooseFiles(page, ROOM_ZIP);
    await nextFrames(page);
    const room1 = await probe(page);
    expect(room1.buffers).toBeGreaterThan(empty.buffers);

    await chooseFiles(page, path, 200_000);
    expect((await state(page)).status).toBe('ready');
    await nextFrames(page);
    // Пам'ять JS разом із буферами (ArrayBuffer) — лише в Chromium (CDP).
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    const heap = async (): Promise<number | null> => {
      if (!cdp) return null;
      await cdp.send('HeapProfiler.collectGarbage');
      const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
      return usage.backingStorageSize === undefined ? null : usage.usedSize + usage.backingStorageSize;
    };
    const heapBig = await heap();

    await chooseFiles(page, ROOM_ZIP);
    await nextFrames(page, 5);
    const room2 = await probe(page);
    expect(room2.buffers, 'WebGL-буфери важкого скану звільнено').toBe(room1.buffers);
    expect(room2.textures, 'WebGL-текстури важкого скану звільнено').toBe(room1.textures);
    expect(room2.blobUrls, 'тимчасові blob: адреси прибрано').toBe(0);

    const heapRoom = await heap();
    if (heapBig !== null && heapRoom !== null) {
      note(testInfo, `пам'ять JS + буфери: з важким сканом ${(heapBig / 2 ** 20).toFixed(0)} МБ → після заміни ${(heapRoom / 2 ** 20).toFixed(0)} МБ`);
      // Геометрія важкого скану ≈ 27 МБ; після заміни пам'ять має звільнитись.
      expect(heapBig - heapRoom, `пам'ять JS: ${heapBig} → ${heapRoom} байт`).toBeGreaterThan(15 * 1024 * 1024);
    }

    // П'ять замін поспіль — ресурси не накопичуються.
    for (let i = 0; i < 5; i++) {
      await chooseFiles(page, i % 2 ? ROOM_ZIP : ROOM_GLB);
      await nextFrames(page);
    }
    await chooseFiles(page, ROOM_ZIP);
    await nextFrames(page, 5);
    const after = await probe(page);
    expect(after.buffers).toBe(room1.buffers);
    expect(after.textures).toBe(room1.textures);
    expect(errors).toEqual([]);
  });
});

// ───────────────────────────── інформація про скан ─────────────────────────────

test.describe('Етап 1 (tester): інформація про скан', () => {
  test('GLB тестової кімнати: на екрані габарит X 4 000 · Y 2 700 · Z 3 000 мм (саме в такому порядку)', async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_GLB);
    const size = page.getByTestId('scan-size');
    await expect(size).toBeVisible();
    const text = (await size.textContent()) ?? '';
    expect(text.replace(/\s+/g, ' ')).toMatch(/4 000\D+2 700\D+3 000\s*мм/);
    // Порядок осей: X — ширина 4000, Y — висота 2700, Z — глибина 3000.
    expect(text.indexOf('X')).toBeLessThan(text.indexOf('Y'));
    expect(text.indexOf('Y')).toBeLessThan(text.indexOf('Z'));
  });

  test('скан повернутий у файлі на 90° навколо Y: габарит X ↔ Z міняються (скан не «вирівнюється»)', async ({ page }) => {
    await openApp(page);
    const glb = buildGlb({ meshes: [{ ...boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]), rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }] });
    await chooseFiles(page, glbPayload('rotated.glb', glb));
    const s = await state(page);
    expect(Math.abs(s.scanInfo.sizeMm.x - 3000)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.y - 2700)).toBeLessThan(0.1);
    expect(Math.abs(s.scanInfo.sizeMm.z - 4000)).toBeLessThan(0.1);
  });
});

// ───────────────────────────── приватність ─────────────────────────────

test.describe('Етап 1 (tester): скан нікуди не відправляється', () => {
  test('під час відкриття ZIP, GLB і кількох файлів — жодного мережевого запиту', async ({ page }) => {
    await openApp(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) requests.push(`${request.method()} ${request.url()}`);
    });
    await chooseFiles(page, ROOM_ZIP);
    expect((await state(page)).status).toBe('ready');
    await chooseFiles(page, ROOM_GLB);
    await nextFrames(page);
    expect(requests).toEqual([]);
  });

  test('GLB з посиланням на зовнішню текстуру — не звертається до сервера', async ({ page }) => {
    await openApp(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) requests.push(request.url());
    });
    const room = boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]);
    const { json, bin } = buildGltf({
      meshes: [{ ...room, uvs: new Float32Array(16), material: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: 'my-private-scan-texture.jpg' }],
    });
    const zip = writeZip([
      { name: 'Scan/scan.glb', data: toGlb(json, bin) },
      { name: 'Scan/my-private-scan-texture.jpg', data: makePng(8, 8), method: 0 },
    ]);
    await chooseFiles(page, { name: 'scan.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
    await nextFrames(page);
    expect(requests, 'назва файлу зі скану пішла на сервер').toEqual([]);
  });
});

// ───────────────────────────── «Показати все» ─────────────────────────────

test.describe('Етап 1 (tester): «Показати все» для незвичних сканів', () => {
  const cases: Array<[string, Vec3, Vec3]> = [
    ['скан далеко від нуля (50 м по X, −30 м по Z)', [48, 0, -31.5], [52, 2.7, -28.5]],
    ['цех 120 × 12 × 80 м', [-60, 0, -40], [60, 12, 40]],
    ['маленька деталь 100 × 100 × 100 мм', [-0.05, 0, -0.05], [0.05, 0.1, 0.05]],
  ];
  for (const [name, min, max] of cases) {
    test(name, async ({ page }) => {
      const { errors } = await openApp(page);
      await chooseFiles(page, glbPayload('scan.glb', buildGlb({ meshes: [boxRoom(min, max)] })));
      const s = await state(page);
      expect(s.status).toBe('ready');
      expect(Math.abs(s.scanInfo.sizeMm.x - (max[0] - min[0]) * 1000)).toBeLessThan(0.1);
      // Межі в сцені — як у файлі (без центрування й масштабу).
      const box = await page.evaluate(() => {
        const b = window.__trasa!.viewer.scanBox()!;
        return { min: b.min.toArray(), max: b.max.toArray() };
      });
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(box.min[i]! - min[i]!)).toBeLessThan(1e-4);
        expect(Math.abs(box.max[i]! - max[i]!)).toBeLessThan(1e-4);
      }
      await waitForIdle(page);
      expect(await allInView(page, corners(min, max)), 'після відкриття весь скан у кадрі').toBe(true);
      // Скан займає помітну частину кадру, а не крапку.
      const viewport = page.viewportSize()!;
      const pts = await Promise.all(corners(min, max).map((c) => project(page, c)));
      const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
      const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      expect(Math.max(w / viewport.width, h / viewport.height)).toBeGreaterThan(0.4);

      await page.evaluate(() => window.__trasa!.viewer.setView({ x: -300, y: 200, z: 400 }, { x: -250, y: 0, z: 380 }));
      await page.getByTestId('show-all').click();
      await waitForIdle(page);
      expect(await allInView(page, corners(min, max)), 'після кнопки весь скан у кадрі').toBe(true);
      expect(errors).toEqual([]);
    });
  }
});

// ───────────────────────────── камера ─────────────────────────────

test.describe('Етап 1 (tester): камера — мишка', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    await waitForIdle(page);
  });

  test('ліва кнопка — обертання (напрямки на екрані змінюються)', async ({ page }) => {
    const before = await vanishing(page);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.5, vp.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.5 + 120, vp.height * 0.55, { steps: 8 });
    await page.mouse.up();
    await waitForIdle(page);
    const after = await vanishing(page);
    expect(moved(before[0], after[0]) + moved(before[1], after[1])).toBeGreaterThan(30);
  });

  test('права кнопка — зсув: напрямки не змінюються, сцена зсувається', async ({ page }) => {
    const vBefore = await vanishing(page);
    const oBefore = await project(page, { x: 0, y: 0, z: 0 });
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.5, vp.height * 0.55);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(vp.width * 0.5 + 100, vp.height * 0.55 + 40, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await waitForIdle(page);
    const vAfter = await vanishing(page);
    const oAfter = await project(page, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 3; i++) expect(moved(vBefore[i]!, vAfter[i]!), `напрямок ${i}`).toBeLessThan(1.5);
    expect(moved(oBefore, oAfter)).toBeGreaterThan(40);
    expect(oAfter.x).toBeGreaterThan(oBefore.x); // тягнули вправо — сцена вправо
  });

  test('правий клік не відкриває системне меню', async ({ page }) => {
    const prevented = await page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      window.__trasa!.viewer.canvas.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test('колесо — зум до курсора: точка під курсором лишається під ним', async ({ page }, testInfo) => {
    await lookIntoRoom(page, { x: 0, y: 1.6, z: 9 }, { x: 0, y: 1.3, z: 0 });
    // Точка на дальній стіні праворуч від центру.
    const target = { x: 1.3, y: 2.0, z: -1.5 };
    const cursor = await project(page, target);
    const centerPoint = await project(page, { x: 0, y: 1.3, z: -1.5 });
    const before = await Promise.all([project(page, { x: -2, y: 0, z: -1.5 }), project(page, { x: 2, y: 0, z: -1.5 })]);
    await page.mouse.move(cursor.x, cursor.y);
    // Playwright не вміє page.mouse.wheel у мобільному WebKit (профілі iPad/iPhone у CI),
    // тому подію колеса (як від мишки чи трекпада iPad) надсилаємо прямо в полотно.
    for (let i = 0; i < 6; i++) {
      await page.evaluate(({ x, y }) => {
        const canvas = window.__trasa!.viewer.canvas;
        canvas.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -250, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }),
        );
      }, cursor);
      await page.waitForTimeout(50);
    }
    await waitForIdle(page);
    const after = await Promise.all([project(page, { x: -2, y: 0, z: -1.5 }), project(page, { x: 2, y: 0, z: -1.5 })]);
    const scale = moved(after[0], after[1]) / moved(before[0], before[1]);
    expect(scale, 'наблизилось').toBeGreaterThan(1.2);
    const drift = moved(await project(page, target), cursor);
    note(testInfo, `зум колесом: масштаб ×${scale.toFixed(2)}, точка під курсором зсунулась на ${drift.toFixed(1)} px`);
    // Якби зум був до центру, точка відійшла б від курсора на (scale − 1) × відстань до центру.
    const centerZoomDrift = (scale - 1) * moved(cursor, centerPoint);
    expect(drift, `зсув точки під курсором ${drift.toFixed(1)} px`).toBeLessThan(Math.max(8, centerZoomDrift * 0.25));
  });
});

test.describe('Етап 1 (tester): камера — дотик (синтетичні Pointer Events)', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await chooseFiles(page, ROOM_ZIP);
    await waitForIdle(page);
  });

  test('один палець — обертання', async ({ page }) => {
    const before = await vanishing(page);
    const vp = page.viewportSize()!;
    const c = { x: vp.width / 2, y: vp.height / 2 };
    await touchGesture(page, [line(c, { x: c.x + 120, y: c.y })]);
    await waitForIdle(page);
    const after = await vanishing(page);
    expect(moved(before[0], after[0]) + moved(before[1], after[1])).toBeGreaterThan(30);
    expect((await state(page)).ruler.points).toHaveLength(0);
  });

  test('два пальці разом — зсув (без обертання)', async ({ page }) => {
    const vBefore = await vanishing(page);
    const oBefore = await project(page, { x: 0, y: 0, z: 0 });
    const vp = page.viewportSize()!;
    const a = { x: vp.width / 2 - 60, y: vp.height / 2 };
    const b = { x: vp.width / 2 + 60, y: vp.height / 2 };
    await touchGesture(page, [line(a, { x: a.x + 90, y: a.y + 30 }), line(b, { x: b.x + 90, y: b.y + 30 })]);
    await waitForIdle(page);
    const vAfter = await vanishing(page);
    const oAfter = await project(page, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 3; i++) expect(moved(vBefore[i]!, vAfter[i]!), `напрямок ${i}`).toBeLessThan(2);
    expect(moved(oBefore, oAfter)).toBeGreaterThan(40);
  });

  test('щипок — зум (розвести пальці → ближче, звести → далі)', async ({ page }) => {
    const span = async () => {
      const [l, r] = await Promise.all([project(page, { x: -2, y: 0, z: 0 }), project(page, { x: 2, y: 0, z: 0 })]);
      return moved(l, r);
    };
    const s0 = await span();
    const vp = page.viewportSize()!;
    const c = { x: vp.width / 2, y: vp.height / 2 };
    const d = Math.min(vp.width, vp.height) * 0.1;
    await touchGesture(page, [line({ x: c.x - d, y: c.y }, { x: c.x - 3 * d, y: c.y }), line({ x: c.x + d, y: c.y }, { x: c.x + 3 * d, y: c.y })]);
    await waitForIdle(page);
    const s1 = await span();
    expect(s1 / s0, 'розвели пальці — наблизилось').toBeGreaterThan(1.2);
    await touchGesture(page, [line({ x: c.x - 3 * d, y: c.y }, { x: c.x - d, y: c.y }), line({ x: c.x + 3 * d, y: c.y }, { x: c.x + d, y: c.y })]);
    await waitForIdle(page);
    const s2 = await span();
    expect(s2 / s1, 'звели пальці — віддалилось').toBeLessThan(0.85);
  });
});

// ───────────────────────────── рулетка ─────────────────────────────

test.describe('Етап 1 (tester): рулетка', () => {
  async function startRuler(page: Page, file: string = ROOM_ZIP) {
    const opened = await openApp(page);
    await chooseFiles(page, file);
    await lookIntoRoom(page);
    await page.getByTestId('ruler').click();
    await expect(page.getByTestId('ruler-panel')).toBeVisible();
    return opened;
  }

  test('пальцем між стінами зсередини кімнати: 4000 мм і 3000 мм (±1 мм)', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'профіль без сенсорного екрана');
    const { errors } = await startRuler(page);
    const tap = (p: { x: number; y: number }) => page.touchscreen.tap(p.x, p.y);
    await tapWall(page, [-2, 1.0, -0.8], [1, 0, 0], tap);
    await tapWall(page, [2, 1.0, -0.8], [-1, 0, 0], tap);
    const across = (await state(page)).ruler;
    expect(across.points).toHaveLength(2);
    expect(Math.abs(across.distanceMm - 4000)).toBeLessThanOrEqual(1);
    await tapWall(page, [-1.2, 1.0, -1.5], [0, 0, 1], tap);
    await tapWall(page, [-1.2, 1.0, 1.5], [0, 0, -1], tap);
    const depth = (await state(page)).ruler;
    expect(depth.points).toHaveLength(2);
    expect(Math.abs(depth.distanceMm - 3000)).toBeLessThanOrEqual(1);
    await tapWall(page, [0.7, 0, 0.4], [0, 1, 0], tap);
    await tapWall(page, [0.7, 2.7, 0.4], [0, -1, 0], tap);
    const height = (await state(page)).ruler;
    expect(Math.abs(height.distanceMm - 2700)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('камера під кутом згори (GLB): між стінами 4000 мм (±1 мм)', async ({ page }) => {
    await startRuler(page, ROOM_GLB);
    await lookIntoRoom(page, { x: 0.3, y: 7, z: 12 }, { x: 0, y: 1, z: -0.3 });
    for (const p of [
      { x: -2, y: 1.6, z: -1.1 },
      { x: 2, y: 0.4, z: -0.2 },
    ]) {
      const sp = await project(page, p);
      await page.mouse.click(Math.round(sp.x), Math.round(sp.y));
    }
    const r = (await state(page)).ruler;
    expect(r.points).toHaveLength(2);
    // Точки на стінах x = −2 і x = +2 (±1 мм).
    expect(Math.abs(r.points[0].x + 2)).toBeLessThan(0.001);
    expect(Math.abs(r.points[1].x - 2)).toBeLessThan(0.001);
    // Відстань між точками — справжня 3D-відстань, а не лише по X.
    const dx = r.points[1].x - r.points[0].x;
    const dy = r.points[1].y - r.points[0].y;
    const dz = r.points[1].z - r.points[0].z;
    expect(Math.abs(r.distanceMm - Math.hypot(dx, dy, dz) * 1000)).toBeLessThan(0.1);
    expect(r.distanceMm).toBeGreaterThan(4000);
  });

  test('клік з легким тремтінням мишки (3 px) — точка ставиться там, де натиснули', async ({ page }) => {
    await startRuler(page);
    const exact = await project(page, { x: -2, y: 1.2, z: 0 });
    const target = { x: Math.round(exact.x), y: Math.round(exact.y) };
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 2, target.y + 2, { steps: 2 });
    await page.mouse.up();
    const r = (await state(page)).ruler;
    expect(r.points).toHaveLength(1);
    expect(Math.abs(r.points[0].x + 2)).toBeLessThan(0.001);
    expect(Math.abs(r.points[0].y - 1.2)).toBeLessThan(0.02);
  });

  test('перетягування пальцем обертає камеру й точку не ставить', async ({ page }) => {
    await startRuler(page);
    const before = await vanishing(page);
    const a = await project(page, { x: -2, y: 1.2, z: 0 });
    await touchGesture(page, [line(a, { x: a.x + 60, y: a.y + 10 }, 6)]);
    await waitForIdle(page);
    expect((await state(page)).ruler.points).toHaveLength(0);
    const after = await vanishing(page);
    expect(moved(before[0], after[0]) + moved(before[1], after[1])).toBeGreaterThan(10);
  });

  test('короткий дотик пальцем з тремтінням 6 px — це дотик, точка ставиться', async ({ page }) => {
    await startRuler(page);
    const a = await project(page, { x: 2, y: 1.2, z: 0 });
    await touchGesture(page, [line(a, { x: a.x + 4, y: a.y + 4 }, 3)]);
    const r = (await state(page)).ruler;
    expect(r.points).toHaveLength(1);
    expect(Math.abs(r.points[0].x - 2)).toBeLessThan(0.001);
  });

  test('дотик двома пальцями точку не ставить', async ({ page }) => {
    await startRuler(page);
    const a = await project(page, { x: -2, y: 1.2, z: 0 });
    const b = await project(page, { x: 2, y: 1.2, z: 0 });
    await touchGesture(page, [
      [a, a],
      [b, b],
    ]);
    expect((await state(page)).ruler.points).toHaveLength(0);
  });

  test('правий клік точку не ставить', async ({ page }) => {
    await startRuler(page);
    const a = await project(page, { x: -2, y: 1.2, z: 0 });
    await page.mouse.click(a.x, a.y, { button: 'right' });
    await page.mouse.click(a.x, a.y, { button: 'middle' });
    expect((await state(page)).ruler.points).toHaveLength(0);
  });

  test('після обертання камери точки лишаються на тих самих місцях скану', async ({ page }) => {
    await startRuler(page);
    const click = (p: { x: number; y: number }) => page.mouse.click(p.x, p.y);
    await tapWall(page, [-2, 1.2, 0], [1, 0, 0], click);
    await tapWall(page, [2, 1.2, 0], [-1, 0, 0], click);
    await lookIntoRoom(page);
    const before = (await state(page)).ruler;
    expect(Math.abs(before.distanceMm - 4000)).toBeLessThanOrEqual(1);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.5, vp.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.5 + 80, vp.height * 0.6 - 30, { steps: 8 });
    await page.mouse.up();
    await waitForIdle(page);
    const after = (await state(page)).ruler;
    expect(after.points).toEqual(before.points);
    expect(after.distanceMm).toBe(before.distanceMm);
    await expect(page.getByTestId('ruler-text')).toContainText(/4\s000\s*мм/);
  });

  test('відкриття іншого скану скидає рулетку', async ({ page }) => {
    await startRuler(page);
    const sp = await project(page, { x: -2, y: 1.2, z: 0 });
    await page.mouse.click(sp.x, sp.y);
    expect((await state(page)).ruler.points).toHaveLength(1);
    await chooseFiles(page, ROOM_GLB);
    const s = await state(page);
    expect(s.ruler).toMatchObject({ active: false, points: [], distanceMm: null });
    await expect(page.getByTestId('ruler-panel')).toBeHidden();
  });
});

// ───────────────────────────── помилки ─────────────────────────────

test.describe('Етап 1 (tester): помилки не ламають відкритий скан', () => {
  const bad: Array<[string, () => FilePayload]> = [
    ['фото замість скану', () => ({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) })],
    ['порожній файл', () => ({ name: 'scan.zip', mimeType: 'application/zip', buffer: Buffer.alloc(0) })],
    ['порожній архів', () => ({ name: 'scan.zip', mimeType: 'application/zip', buffer: Buffer.from(writeZip([])) })],
  ];
  for (const [name, make] of bad) {
    test(`${name}: повідомлення, а відкритий скан лишається`, async ({ page }) => {
      const { errors } = await openApp(page);
      await chooseFiles(page, ROOM_ZIP);
      await chooseFiles(page, make());
      await expect(page.getByTestId('alert')).toBeVisible();
      const s = await state(page);
      expect(s.status).toBe('ready');
      expect(s.scanName).toBe('room-4000x2700x3000.zip');
      expect(await page.evaluate(() => window.__trasa!.viewer.scanBox() !== null)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  for (const withNormals of [false, true]) {
    const title = withNormals
      ? 'одна картинка для кольору й нормалей — текстура кольору доходить до відеокарти, без помилок'
      : 'контроль: та сама модель без нормалей — текстура кольору доходить до відеокарти';
    test(title, async ({ page }) => {
      const { errors, consoleErrors } = await openApp(page);
      const room = boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]);
      const { json, bin } = buildGltf({
        meshes: [{ ...room, uvs: new Float32Array(16), material: 0 }],
        materials: [
          withNormals
            ? { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }
            : { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        textures: [
          { source: 0, sampler: 0 },
          { source: 0, sampler: 1 },
        ],
        samplers: [{ magFilter: 9729, minFilter: 9987 }, { magFilter: 9728, minFilter: 9728 }],
        images: [{ uri: 'atlas.png' }],
      });
      json.buffers[0] = { byteLength: bin.byteLength, uri: 'scene.bin' };
      const zip = writeZip([
        { name: 'scene.gltf', data: new TextEncoder().encode(JSON.stringify(json)) },
        { name: 'scene.bin', data: bin },
        { name: 'atlas.png', data: makePng(64, 64), method: 0 },
      ]);
      await chooseFiles(page, { name: 'scan.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
      expect((await state(page)).status).toBe('ready');
      await nextFrames(page, 5);
      expect(errors).toEqual([]);
      expect(consoleErrors, 'помилки в консолі після показу скану').toEqual([]);
      const uploads = (await probe(page)).uploads;
      expect(uploads, 'текстура 64 × 64 завантажена у відеопам\'ять (інакше скан без кольору)').toContainEqual([64, 64]);
    });
  }
});
