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
 */
import {
  createStickController,
  joystickDirections,
  movePoint,
  type NudgeAxis,
  type PointM,
  sliderStep,
  type Vec2,
} from '../core/nudge';
import { formatMm, mToMm } from '../core/units';
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
}

export interface PointEditor {
  /** Кнопки: джойстик, повзунок Y, «Підтвердити точку», координати. */
  element: HTMLElement;
  /** Стрілки осей біля точки. */
  overlay: HTMLElement;
  readonly state: PointEditorState;
  /** Почати доведення точки (або замінити точку, якщо редагування вже йде). */
  edit(point: PointM, label: string): void;
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
  let axis: NudgeAxis | null = null;
  const controller = createStickController();

  // Цикл анімації працює лише поки джойстик чи повзунок утримують.
  let frame = 0;
  let lastTime = 0;
  const loop = (time: number) => {
    const dt = lastTime ? (time - lastTime) / MS_PER_SECOND : 0;
    lastTime = time;
    if (point) {
      let step = null;
      if (stick.active) {
        const screen = viewer.screenAxes(point);
        step = controller.update(stick.value, { X: screen.X, Z: screen.Z }, dt);
        axis = controller.axis;
        stick.setKnobAxis(axis);
      } else if (slider.active) {
        step = sliderStep(-slider.value.y, dt);
        axis = step ? 'Y' : axis;
        slider.setKnobAxis(axis === 'Y' ? 'Y' : null);
      }
      if (step) {
        point = movePoint(point, step.axis, step.deltaMm);
        handlers.onChange(point);
        viewer.requestRender();
      }
      render();
    }
    if (stick.active || slider.active) frame = requestAnimationFrame(loop);
    else stopLoop();
  };
  const startLoop = () => {
    if (frame) return;
    lastTime = 0;
    frame = requestAnimationFrame(loop);
  };
  const stopLoop = () => {
    const wasRunning = frame !== 0;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    controller.release();
    axis = null;
    stick.setKnobAxis(null);
    slider.setKnobAxis(null);
    render();
    if (wasRunning && point) handlers.onSettle?.(point);
  };
  const onActiveChange = (isActive: boolean) => {
    if (isActive) startLoop();
  };

  const stick = createStick({
    mode: '2d',
    label: 'Джойстик: зсув точки по X або Z',
    testid: 'stick-xz',
    onActiveChange,
  });
  const slider = createStick({
    mode: 'vertical',
    label: 'Повзунок: зсув точки по висоті Y',
    testid: 'stick-y',
    onActiveChange,
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
    // Стрілки на самому джойстику — куди він рухає X і Z (з урахуванням «розведення» осей).
    stick.setAxes(joystickDirections({ X: screen.X, Z: screen.Z }), axis === 'X' || axis === 'Z' ? axis : null);
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
      arrow.group.classList.toggle('axis-arrow--active', axis === arrow.name);
      arrow.group.classList.toggle('axis-arrow--dim', axis !== null && axis !== arrow.name);
    }
  };
  const stopFrames = viewer.onFrame(drawArrows);

  function render(): void {
    if (!point || !origin) return;
    title.textContent = `Точка ${label ?? ''}`.trim();
    confirm.textContent = `Підтвердити точку ${label ?? ''}`.trim();
    coords.replaceChildren(...coordinates(point));
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

  confirm.addEventListener('click', () => {
    if (!point) return;
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
      };
    },
    edit(next, nextLabel) {
      point = { ...next };
      origin = { ...next };
      label = nextLabel;
      element.hidden = false;
      render();
      viewer.requestRender();
    },
    close() {
      stopLoop();
      point = null;
      origin = null;
      label = null;
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
