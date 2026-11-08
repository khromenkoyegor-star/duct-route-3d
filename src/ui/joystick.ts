/**
 * Джойстик (коло з «кулькою») і повзунок (вертикальна доріжка) для точного доведення точки.
 * Працюють пальцем і мишкою (Pointer Events).
 *
 * «Плаваючий» нуль: відлік — від місця, де торкнулися, а не від центру кола. Тож неточний дотик
 * не зрушує точку: поки палець не відійшов на ≈ 10 px (мертва зона), нічого не відбувається.
 * Хід — 64 px від місця дотику в будь-який бік (палець може вийти за коло — його не губимо).
 * Відпустив — «кулька» повертається в центр, значення 0.
 * Значення: x — вправо, y — вниз (як на екрані), довжина ≤ 1. Для повзунка x = 0.
 */
import type { HorizontalAxis, Vec2 } from '../core/nudge';

/** Хід джойстика від місця дотику до повного відхилення, px. */
export const STICK_TRAVEL_PX = 64;

export interface Stick {
  element: HTMLElement;
  /** Поточне відхилення (0, 0 — на місці дотику). */
  readonly value: Vec2;
  /** Чи тримають зараз джойстик. */
  readonly active: boolean;
  /** Стрілки осей на колі джойстика (лише для 2D) і вісь, по якій зараз рух. */
  setAxes(dirs: Record<HorizontalAxis, Vec2> | null, active: HorizontalAxis | null, depth?: HorizontalAxis | null): void;
  /** Вісь, яку показує «кулька» під час руху (колір і літера). */
  setKnobAxis(axis: 'X' | 'Y' | 'Z' | null): void;
  dispose(): void;
}

export interface StickOptions {
  mode: '2d' | 'vertical';
  label: string;
  testid: string;
  /** Викликається на початку й у кінці утримання. */
  onActiveChange?(active: boolean): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createStick(options: StickOptions): Stick {
  const element = document.createElement('div');
  element.className = options.mode === '2d' ? 'stick stick--2d' : 'stick stick--vertical';
  element.dataset.testid = options.testid;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', options.label);

  // Стрілки X і Z на колі — у тих напрямках, у яких джойстик їх рухає.
  const guides = options.mode === '2d' ? document.createElementNS(SVG_NS, 'svg') : null;
  const guideParts = new Map<HorizontalAxis, { line: SVGLineElement; text: SVGTextElement }>();
  if (guides) {
    guides.setAttribute('class', 'stick-guides');
    guides.setAttribute('viewBox', '-70 -70 140 140');
    for (const axis of ['X', 'Z'] as const) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', `stick-guide stick-guide--${axis.toLowerCase()}`);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', `stick-guide-label stick-guide-label--${axis.toLowerCase()}`);
      text.textContent = axis;
      guides.append(line, text);
      guideParts.set(axis, { line, text });
    }
    element.append(guides);
  }

  const knob = document.createElement('div');
  knob.className = 'stick-knob';
  knob.setAttribute('aria-hidden', 'true');
  element.append(knob);
  if (options.mode === 'vertical') {
    const up = document.createElement('span');
    up.className = 'stick-hint stick-hint--up';
    up.textContent = '▲';
    const down = document.createElement('span');
    down.className = 'stick-hint stick-hint--down';
    down.textContent = '▼';
    element.append(up, down);
  }

  let pointerId: number | null = null;
  let origin = { x: 0, y: 0 };
  let value: Vec2 = { x: 0, y: 0 };

  /** Наскільки «кулька» може відійти від центру, не вилазячи за коло/доріжку, px. */
  const visualTravel = () => {
    const rect = element.getBoundingClientRect();
    return {
      x: options.mode === '2d' ? Math.max(0, (rect.width - knob.offsetWidth) / 2) : 0,
      y: Math.max(0, (rect.height - knob.offsetHeight) / 2),
    };
  };

  const setKnob = (v: Vec2, animate: boolean) => {
    const travel = visualTravel();
    knob.classList.toggle('stick-knob--return', animate);
    knob.style.transform = `translate(${v.x * travel.x}px, ${v.y * travel.y}px)`;
  };

  const read = (event: PointerEvent): Vec2 => {
    let x = options.mode === '2d' ? (event.clientX - origin.x) / STICK_TRAVEL_PX : 0;
    let y = (event.clientY - origin.y) / STICK_TRAVEL_PX;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  };

  const release = () => {
    if (pointerId === null) return;
    // Спершу повідомляємо (значення ще останнє — редактор дорахує рух до моменту відпускання),
    // потім скидаємо.
    options.onActiveChange?.(false);
    pointerId = null;
    value = { x: 0, y: 0 };
    element.classList.remove('stick--active');
    setKnob(value, true);
  };

  const down = (event: PointerEvent) => {
    // Події джойстика не мають доходити до камери (OrbitControls слухає документ):
    // інакше палець на джойстику плюс палець на скані «смикають» камеру.
    event.stopPropagation();
    if (pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    origin = { x: event.clientX, y: event.clientY };
    try {
      // Палець може вийти за межі джойстика — події все одно йдуть сюди.
      element.setPointerCapture(event.pointerId);
    } catch {
      // Деякі браузери не дають захопити вказівник — працюємо й без цього (див. onWindowUp).
    }
    element.classList.add('stick--active');
    value = { x: 0, y: 0 };
    setKnob(value, false);
    options.onActiveChange?.(true);
  };
  const move = (event: PointerEvent) => {
    event.stopPropagation();
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    value = read(event);
    setKnob(value, false);
  };
  const up = (event: PointerEvent) => {
    event.stopPropagation();
    if (event.pointerId !== pointerId) return;
    release();
  };
  // Відпустили деінде (захоплення не спрацювало) — теж відпускання.
  const onWindowUp = (event: PointerEvent) => {
    if (event.pointerId === pointerId) release();
  };
  // Програму згорнули / перемкнули вкладку, а «відпускання» не прийшло — не їхати далі самому.
  const onHidden = () => {
    if (document.visibilityState === 'hidden') release();
  };

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);
  element.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('pointerup', onWindowUp, true);
  window.addEventListener('pointercancel', onWindowUp, true);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', onHidden);

  return {
    element,
    get value() {
      return value;
    },
    get active() {
      return pointerId !== null;
    },
    setAxes(dirs, activeAxis, depth = null) {
      if (!guides) return;
      guides.style.display = dirs ? '' : 'none';
      if (!dirs) return;
      for (const [axis, part] of guideParts) {
        const d = dirs[axis];
        const r = 50;
        part.line.setAttribute('x1', String(-d.x * r));
        part.line.setAttribute('y1', String(-d.y * r));
        part.line.setAttribute('x2', String(d.x * r));
        part.line.setAttribute('y2', String(d.y * r));
        part.text.setAttribute('x', String(d.x * 60));
        part.text.setAttribute('y', String(d.y * 60 + 5));
        part.line.classList.toggle('stick-guide--active', activeAxis === axis);
        part.line.classList.toggle('stick-guide--dim', activeAxis !== null && activeAxis !== axis);
        part.text.classList.toggle('stick-guide--dim', activeAxis !== null && activeAxis !== axis);
        // Вісь, що дивиться в камеру: рух по ній — углиб екрана, тому вона приглушена й підписана «⊙».
        part.line.classList.toggle('stick-guide--depth', depth === axis);
        part.text.classList.toggle('stick-guide--depth', depth === axis);
        part.text.textContent = depth === axis ? `${axis}⊙` : axis;
      }
    },
    setKnobAxis(axis) {
      knob.dataset.axis = axis ?? '';
      knob.textContent = axis ?? '';
    },
    dispose() {
      release();
      window.removeEventListener('pointerup', onWindowUp, true);
      window.removeEventListener('pointercancel', onWindowUp, true);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onHidden);
      element.remove();
    },
  };
}
