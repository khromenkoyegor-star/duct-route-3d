/**
 * Точку, яку доводять, має бути видно: її не закривають панелі (джойстик, кнопки, підказки)
 * і вона не за краєм екрана. Спільне для «Рулетки» й «Траси».
 */
import type { ScreenPoint, Vec3Like, Viewer } from '../scene/viewer';

/** Панелі й кнопки, що закривають сцену (видимі). */
export function obstacleRects(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>('.panel, .toolbar, .point-editor, .view-bar')]
    .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
}

export interface ScreenRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Висока бічна панель (частка висоти екрана): поруч із нею теж може бути вільне місце. */
const TALL_PANEL = 0.4;

/**
 * Найбільша вільна від панелей частина екрана: смуга між верхніми й нижніми панелями
 * або місце між високими бічними панелями (редактор точки зліва, панель траси справа на iPhone
 * горизонтально). null — вільного місця замало.
 */
export function freeAreaRect(): ScreenRect | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const obstacles = obstacleRects();
  // Виріз і «острівець» iPhone (safe areas) — теж не вільне місце.
  const safe = safeInsets();
  const free = (left: number, right: number): ScreenRect => {
    const overlapping = obstacles.filter((r) => r.right > left && r.left < right);
    const top = Math.max(safe.top, ...overlapping.filter((r) => r.top < vh / 2).map((r) => r.bottom));
    const bottom = Math.min(vh - safe.bottom, ...overlapping.filter((r) => r.top >= vh / 2).map((r) => r.top));
    return { left: Math.max(left, safe.left), right: Math.min(right, vw - safe.right), top, bottom };
  };
  // Межі, по яких можна «розрізати» екран: краї редактора точки й високих бічних панелей.
  const editor = [...document.querySelectorAll<HTMLElement>('.point-editor')].find((el) => !el.hidden);
  const editorRect = editor?.getBoundingClientRect();
  const sides = obstacles.filter((r) => r.height > vh * TALL_PANEL && r.width < vw * 0.6);
  if (editorRect && editorRect.width > 0 && editorRect.right < vw * 0.75) sides.push(editorRect);
  const lefts = [0, ...sides.map((r) => r.right)];
  const rights = [vw, ...sides.map((r) => r.left)];
  const score = (c: ScreenRect) => Math.min(c.right - c.left, c.bottom - c.top);
  let best: ScreenRect | null = null;
  for (const a of lefts) {
    for (const b of rights) {
      if (b - a < 60) continue;
      const c = free(a, b);
      if (!best || score(c) > score(best)) best = c;
    }
  }
  if (!best || score(best) < 60) return null;
  return best;
}

let probe: HTMLElement | null = null;
/** Відступи safe areas (px): невидимий елемент з padding: env(safe-area-inset-*). */
function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(probe);
  }
  const s = getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
}

/** Центр вільної від панелей частини екрана (див. freeAreaRect) або null. */
export function freeAreaCenter(): ScreenPoint | null {
  const rect = freeAreaRect();
  return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
}

/**
 * Якщо точку закрила панель або вона за краєм екрана, камера повертається на місці так,
 * щоб точка опинилась посередині вільної від панелей частини екрана.
 */
export function keepVisible(viewer: Viewer, world: Vec3Like): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 28;
  const screen = viewer.projectPoint(world);
  const covered = obstacleRects().some(
    (r) => screen.x > r.left - margin && screen.x < r.right + margin && screen.y > r.top - margin && screen.y < r.bottom + margin,
  );
  const outside = !screen.visible || screen.x < margin || screen.y < margin || screen.x > vw - margin || screen.y > vh - margin;
  if (!covered && !outside) return;
  viewer.centerOn(world, freeAreaCenter() ?? undefined);
}
