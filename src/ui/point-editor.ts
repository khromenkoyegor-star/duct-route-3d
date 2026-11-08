/**
 * Редактор точки: точне доведення поставленої точки перед підтвердженням.
 * Використовується в «Рулетці», а далі — для точок траси (етапи 2–3).
 *
 * - Джойстик рухає точку по X або Z (вісь — за напрямком стрілок біля точки на екрані,
 *   фіксується до відпускання; по діагоналі точка не їде ніколи).
 * - Повзунок рухає точку тільки по Y.
 * - Біля точки — стрілки осей X (червона), Y (зелена), Z (синя); активна підсвічується.
 * - Координати точки й зсув від місця, де її поставили, — у мм.
 * - «Підтвердити точку» завершує редагування.
 * Камеру можна вільно крутити: точка від цього не зсувається.
 *
 * Режим «відрізок від точки» (наступна точка траси): точка стартує в попередньому вузлі (`anchor`)
 * і тягнеться лише по одній осі (core/route.ts → stepAlongSegment). Вісь вибирає перший рух;
 * повернувши точку на початок, вісь можна змінити. Назад по попередньому відрізку — не можна.
 * Замість «Зсув» — довжина відрізка; відрізок нульової довжини не підтверджується.
 */
import {
  createStickController,
  joystickLayout,
  movePoint,
  type NudgeAxis,
  type PointM,
  sliderStep,
  type Vec2,
} from '../core/nudge';
import { distance, lockedAxis, NODE_TOLERANCE_MM, type SegmentDir, stepAlongSegment } from '../core/route';
import { formatMm, mmToM, mToMm } from '../core/units';
import type { Viewer } from '../scene/viewer';
import { createStick } from './joystick';

export interface PointEditorState {
  active: boolean;
  /** Підпис точки («А», «Б», «1»…). */
  label: string | null;
  point: PointM | null;
  /** Де точку поставили (до доведення). */
  origin: PointM | null;
  /** Вісь, по якій точка рухається просто зараз. */
  axis: NudgeAxis | null;
  /** Чи точку вже підсували після постановки. */
  moved: boolean;
  /** Режим «відрізок від точки»: початок, вісь відрізка (null — точка ще на початку), довжина в мм. */
  segment: { anchor: PointM; axis: NudgeAxis | null; lengthMm: number } | null;
  /** Чи можна зараз підтвердити точку (відрізок нульової довжини — не можна). */
  canConfirm: boolean;
}

/** Стан закритого редактора. */
export function closedEditorState(): PointEditorState {
  return { active: false, label: null, point: null, origin: null, axis: null, moved: false, segment: null, canConfirm: false };
}

/** Наступна точка траси: тягнеться від попереднього вузла лише по одній осі. */
export interface SegmentOptions {
  /** Попередній вузол (м сцени). */
  anchor: PointM;
  /** Напрямок попереднього відрізка — назад по ньому траса не йде (null — це перший відрізок). */
  back: SegmentDir | null;
}

export interface EditOptions {
  /** Заголовок над координатами (інакше «Точка {label}»). */
  title?: string;
  segment?: SegmentOptions;
}

export interface PointEditor {
  /** Кнопки: джойстик, повзунок Y, «Підтвердити точку», координати. */
  element: HTMLElement;
  /** Стрілки осей біля точки. */
  overlay: HTMLElement;
  readonly state: PointEditorState;
  /** Почати доведення точки (або замінити точку, якщо редагування вже йде). */
  edit(point: PointM, label: string, options?: EditOptions): void;
  close(): void;
  dispose(): void;
}

export interface PointEditorHandlers {
  onChange(point: PointM): void;
  onConfirm(point: PointM): void;
  /** Джойстик/повзунок відпустили (можна перевірити, чи точку видно). */
  onSettle?(point: PointM): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_PX = 64;
const ARROW_GAP_PX = 16;
/** Мілісекунди в секунді (час кадрів) — не плутати з мм ↔ м, ті лише в units.ts. */
const MS_PER_SECOND = 1_000;
const AXES: NudgeAxis[] = ['X', 'Y', 'Z'];
/**
 * Точка повернулась на початок відрізка — коротка зупинка («клацання»): можна відпустити
 * й вибрати іншу вісь. Тримаєш далі — точка йде на інший бік по тій самій осі.
 */
const ANCHOR_DETENT_MS = 400;

const samePoint = (a: PointM, b: PointM) => a.x === b.x && a.y === b.y && a.z === b.z;

/** «X 1 234,5 · Y 1 200 · Z −300 мм» з кольоровими літерами. */
function coordinates(point: PointM): Array<string | HTMLElement> {
  const parts: Array<string | HTMLElement> = [];
  const values: Record<NudgeAxis, number> = { X: point.x, Y: point.y, Z: point.z };
  AXES.forEach((axis, i) => {
    const letter = document.createElement('span');
    letter.className = `axis-letter axis-letter--${axis.toLowerCase()}`;
    letter.textContent = axis;
    const text = formatMm(mToMm(values[axis])).replace(/\s*мм$/, '');
    parts.push(letter, ` ${text}${i < 2 ? ' · ' : ' мм'}`);
  });
  return parts;
}

export function createPointEditor(viewer: Viewer, handlers: PointEditorHandlers): PointEditor {
  const element = document.createElement('div');
  element.className = 'point-editor';
  element.dataset.testid = 'point-editor';
  element.hidden = true;

  const readout = document.createElement('div');
  readout.className = 'point-readout';
  const title = document.createElement('p');
  title.className = 'point-title';
  title.dataset.testid = 'point-title';
  const coords = document.createElement('p');
  coords.className = 'point-coords';
  coords.dataset.testid = 'point-coords';
  const shift = document.createElement('p');
  shift.className = 'point-shift';
  shift.dataset.testid = 'point-shift';
  readout.append(title, coords, shift);

  const controls = document.createElement('div');
  controls.className = 'point-controls';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'confirm-button';
  confirm.dataset.testid = 'confirm-point';
  confirm.textContent = 'Підтвердити точку';

  let point: PointM | null = null;
  let origin: PointM | null = null;
  let label: string | null = null;
  let customTitle: string | null = null;
  let axis: NudgeAxis | null = null;
  let segment: SegmentOptions | null = null;
  /** Тягнуть назад по попередньому відрізку — точка стоїть, підказуємо чому. */
  let blockedBack = false;
  /** До цього часу точка «стоїть» на початку відрізка (див. ANCHOR_DETENT_MS). */
  let detentUntil = 0;
  const controller = createStickController();

  /** Вісь, по якій уже йде відрізок (null — не режим відрізка або точка на початку). */
  const segmentAxis = (): NudgeAxis | null => (segment && point ? lockedAxis(segment.anchor, point) : null);
  const segmentLengthMm = () => (segment && point ? mToMm(distance(segment.anchor, point)) : 0);
  const canConfirm = () => !!point && (!segment || (segmentAxis() !== null && segmentLengthMm() > NODE_TOLERANCE_MM));

  /** Зсунути точку на крок; true — точка змінилась. */
  const apply = (stepAxis: NudgeAxis, deltaMm: number, now: number): boolean => {
    if (!point) return false;
    if (!segment) {
      point = movePoint(point, stepAxis, deltaMm);
      return true;
    }
    if (now < detentUntil) return false;
    const next = stepAlongSegment(segment.anchor, point, stepAxis, mmToM(deltaMm), segment.back);
    const atAnchor = samePoint(next, segment.anchor);
    blockedBack =
      atAnchor && !!segment.back && segment.back.axis === stepAxis && Math.sign(deltaMm) !== segment.back.sign;
    if (samePoint(next, point)) return false;
    if (atAnchor) detentUntil = now + ANCHOR_DETENT_MS;
    point = next;
    return true;
  };

  // Цикл анімації працює лише поки джойстик чи повзунок утримують.
  // Рух рахується за реальним часом (performance.now), а не за кількістю кадрів:
  // якщо браузер малює рідко, точка все одно проходить стільки, скільки тримали.
  let frame = 0;
  let lastTime = 0;
  const integrate = (now: number) => {
    const dt = lastTime ? (now - lastTime) / MS_PER_SECOND : 0;
    lastTime = now;
    if (!point) return;
    let changed = false;
    const locked = segmentAxis();
    // Відрізок уже йде по Y — джойстик (X/Z) не працює; по X чи Z — не працює повзунок.
    const stickUsable = locked !== 'Y';
    const sliderUsable = locked === null || locked === 'Y';
    if (stick.active && stickUsable) {
      const screen = viewer.screenAxes(point);
      const only = locked === 'X' || locked === 'Z' ? locked : null;
      const step = controller.update(stick.value, { X: screen.X, Z: screen.Z }, dt, only);
      axis = controller.axis;
      stick.setKnobAxis(axis);
      if (step) changed = apply(step.axis, step.deltaMm, now);
    } else if (slider.active && sliderUsable) {
      // Одночасно — лише одна вісь: джойстик має перевагу, повзунок — коли джойстик вільний.
      const step = sliderStep(-slider.value.y, dt);
      if (step) {
        axis = 'Y';
        slider.setKnobAxis('Y');
        changed = apply(step.axis, step.deltaMm, now);
      }
    }
    if (changed) {
      handlers.onChange(point);
      viewer.requestRender();
    }
    render();
  };
  const loop = () => {
    integrate(performance.now());
    if (stick.active || slider.active) frame = requestAnimationFrame(loop);
    else stopLoop();
  };
  const startLoop = () => {
    if (frame) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(loop);
  };
  const stopLoop = (settle = true) => {
    const wasRunning = frame !== 0 && settle;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    controller.release();
    axis = null;
    blockedBack = false;
    detentUntil = 0;
    stick.setKnobAxis(null);
    slider.setKnobAxis(null);
    render();
    if (wasRunning && point) handlers.onSettle?.(point);
  };

  const stick = createStick({
    mode: '2d',
    label: 'Джойстик: зсув точки по X або Z',
    testid: 'stick-xz',
    onActiveChange(isActive) {
      if (isActive) {
        startLoop();
        return;
      }
      // Відпустили джойстик: дорахувати рух до цієї миті й зняти фіксацію осі —
      // навіть якщо повзунок ще тримають.
      integrate(performance.now());
      controller.release();
      axis = null;
      blockedBack = false;
      detentUntil = 0;
      stick.setKnobAxis(null);
      if (!slider.active) stopLoop();
      else render();
    },
  });
  const slider = createStick({
    mode: 'vertical',
    label: 'Повзунок: зсув точки по висоті Y',
    testid: 'stick-y',
    onActiveChange(isActive) {
      if (isActive) {
        startLoop();
        return;
      }
      integrate(performance.now());
      if (axis === 'Y') axis = null;
      blockedBack = false;
      detentUntil = 0;
      slider.setKnobAxis(null);
      if (!stick.active) stopLoop();
      else render();
    },
  });
  controls.append(stick.element, slider.element, confirm);
  element.append(readout, controls);

  // Стрілки осей біля точки.
  const overlay = document.createElement('div');
  overlay.className = 'axis-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'axis-svg');
  overlay.append(svg);
  const arrows = AXES.map((name) => {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', `axis-arrow axis-arrow--${name.toLowerCase()}`);
    const line = document.createElementNS(SVG_NS, 'line');
    const head = document.createElementNS(SVG_NS, 'polygon');
    const text = document.createElementNS(SVG_NS, 'text');
    text.textContent = name;
    group.append(line, head, text);
    svg.append(group);
    return { name, group, line, head, text };
  });

  const drawArrows = () => {
    if (!point || element.hidden) {
      overlay.hidden = true;
      return;
    }
    const screen = viewer.screenAxes(point);
    // Підсвічуємо вісь, по якій точка рухається зараз або по якій уже йде відрізок.
    const shown = axis ?? segmentAxis();
    // Стрілки на самому джойстику — куди він рухає X і Z (з урахуванням «розведення» осей).
    const layout = joystickLayout({ X: screen.X, Z: screen.Z });
    stick.setAxes(controller.dirs ?? layout.dirs, shown === 'X' || shown === 'Z' ? shown : null, layout.layout.depth ?? null);
    const base = viewer.projectPoint(point);
    overlay.hidden = !base.visible;
    if (!base.visible) return;
    const longest = Math.max(...AXES.map((a) => Math.hypot(screen[a].x, screen[a].y)));
    for (const arrow of arrows) {
      const dir: Vec2 = screen[arrow.name];
      const len = Math.hypot(dir.x, dir.y);
      // Вісь, що «дивиться в камеру», не малюємо — по ній джойстик і не рухає.
      const visible = len > 0 && len >= longest * 0.15;
      arrow.group.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const ux = dir.x / len;
      const uy = dir.y / len;
      const tipX = base.x + ux * ARROW_PX;
      const tipY = base.y + uy * ARROW_PX;
      // Без «хвоста» за точкою й з відступом від неї — місце виміру не закрите.
      arrow.line.setAttribute('x1', String(base.x + ux * ARROW_GAP_PX));
      arrow.line.setAttribute('y1', String(base.y + uy * ARROW_GAP_PX));
      arrow.line.setAttribute('x2', String(tipX));
      arrow.line.setAttribute('y2', String(tipY));
      const side = 6;
      const back = 12;
      arrow.head.setAttribute(
        'points',
        `${tipX + ux * 4},${tipY + uy * 4} ${tipX - ux * back - uy * side},${tipY - uy * back + ux * side} ` +
          `${tipX - ux * back + uy * side},${tipY - uy * back - ux * side}`,
      );
      arrow.text.setAttribute('x', String(tipX + ux * 16));
      arrow.text.setAttribute('y', String(tipY + uy * 16 + 5));
      arrow.group.classList.toggle('axis-arrow--active', shown === arrow.name);
      arrow.group.classList.toggle('axis-arrow--dim', shown !== null && shown !== arrow.name);
    }
  };
  const stopFrames = viewer.onFrame(drawArrows);

  function render(): void {
    if (!point || !origin) return;
    title.textContent = customTitle ?? `Точка ${label ?? ''}`.trim();
    confirm.textContent = `Підтвердити точку ${label ?? ''}`.trim();
    confirm.disabled = !canConfirm();
    coords.replaceChildren(...coordinates(point));
    const locked = segmentAxis();
    for (const [control, off] of [
      [stick.element, locked === 'Y'],
      [slider.element, locked === 'X' || locked === 'Z'],
    ] as const) {
      control.classList.toggle('stick--off', off);
      control.setAttribute('aria-disabled', String(off));
    }
    shift.classList.toggle('point-shift--warning', segment !== null && blockedBack);
    if (segment) {
      shift.textContent = segmentText(locked);
      drawArrows();
      return;
    }
    const moved: string[] = [];
    const deltas: Record<NudgeAxis, number> = {
      X: mToMm(point.x - origin.x),
      Y: mToMm(point.y - origin.y),
      Z: mToMm(point.z - origin.z),
    };
    for (const a of AXES) {
      if (Math.abs(deltas[a]) >= 0.05) moved.push(`${a} ${deltas[a] > 0 ? '+' : ''}${formatMm(deltas[a])}`);
    }
    shift.textContent = moved.length ? `Зсув: ${moved.join(' · ')}` : 'Зсув: немає';
    drawArrows();
  }

  /** «Відрізок: X +1 250 мм» або підказка, поки точка на початку. */
  function segmentText(locked: NudgeAxis | null): string {
    if (blockedBack) return 'Назад по попередньому відрізку не можна';
    if (!segment || !point || !locked) return 'Тягніть джойстиком (X, Z) чи повзунком (Y)';
    const key = locked.toLowerCase() as 'x' | 'y' | 'z';
    const offset = mToMm(point[key] - segment.anchor[key]);
    return `Відрізок: ${locked} ${offset > 0 ? '+' : '−'}${formatMm(Math.abs(offset))}`;
  }

  confirm.addEventListener('click', () => {
    if (!point || !canConfirm()) return;
    const confirmed = point;
    handlers.onConfirm(confirmed);
  });

  return {
    element,
    overlay,
    get state() {
      return {
        active: !element.hidden,
        label,
        point: point ? { ...point } : null,
        origin: origin ? { ...origin } : null,
        axis,
        moved: !!point && !!origin && (point.x !== origin.x || point.y !== origin.y || point.z !== origin.z),
        segment:
          segment && point ? { anchor: { ...segment.anchor }, axis: segmentAxis(), lengthMm: segmentLengthMm() } : null,
        canConfirm: canConfirm(),
      };
    },
    edit(next, nextLabel, options = {}) {
      segment = options.segment ? { anchor: { ...options.segment.anchor }, back: options.segment.back } : null;
      // У режимі відрізка точка завжди стартує в попередньому вузлі.
      point = segment ? { ...segment.anchor } : { ...next };
      origin = { ...point };
      label = nextLabel;
      customTitle = options.title ?? null;
      blockedBack = false;
      detentUntil = 0;
      element.hidden = false;
      render();
      viewer.requestRender();
    },
    close() {
      // Якщо джойстик ще тримають (підтвердили другим пальцем), наступна точка від цього
      // утримання не поїде: цикл зупинено, а час руху скинуто.
      stopLoop(false);
      lastTime = 0;
      point = null;
      origin = null;
      label = null;
      customTitle = null;
      segment = null;
      element.hidden = true;
      overlay.hidden = true;
      viewer.requestRender();
    },
    dispose() {
      stopLoop();
      stopFrames();
      stick.dispose();
      slider.dispose();
      element.remove();
      overlay.remove();
    },
  };
}
