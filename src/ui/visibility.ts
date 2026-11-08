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

/**
 * Центр вільної від панелей частини екрана: смуга між верхніми й нижніми панелями
 * або місце праворуч від редактора точки (iPhone горизонтально). null — вільного місця замало.
 */
export function freeAreaCenter(): ScreenPoint | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const obstacles = obstacleRects();
  const free = (left: number, right: number) => {
    const overlapping = obstacles.filter((r) => r.right > left && r.left < right);
    const top = Math.max(0, ...overlapping.filter((r) => r.top < vh / 2).map((r) => r.bottom));
    const bottom = Math.min(vh, ...overlapping.filter((r) => r.top >= vh / 2).map((r) => r.top));
    return { left, right, top, bottom };
  };
  const candidates = [free(0, vw)];
  const editor = [...document.querySelectorAll<HTMLElement>('.point-editor')].find((el) => !el.hidden);
  const editorRect = editor?.getBoundingClientRect();
  if (editorRect && editorRect.width > 0 && editorRect.right < vw * 0.75) candidates.push(free(editorRect.right, vw));
  const score = (c: { left: number; right: number; top: number; bottom: number }) =>
    Math.min(c.right - c.left, c.bottom - c.top);
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  if (score(best) < 60) return null;
  return { x: (best.left + best.right) / 2, y: (best.top + best.bottom) / 2 };
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
