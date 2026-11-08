/**
 * Джойстик (коло з «кулькою») і повзунок (вертикальна доріжка) для точного доведення точки.
 * Працюють пальцем і мишкою (Pointer Events). Відпустив — «кулька» повертається в центр, значення 0.
 * Значення: x — вправо, y — вниз (як на екрані), довжина ≤ 1. Для повзунка x = 0.
 */
import type { Vec2 } from '../core/nudge';

export interface Stick {
  element: HTMLElement;
  /** Поточне відхилення (0, 0 — у центрі). */
  readonly value: Vec2;
  /** Чи тримають зараз джойстик. */
  readonly active: boolean;
  dispose(): void;
}

export interface StickOptions {
  mode: '2d' | 'vertical';
  label: string;
  testid: string;
  /** Викликається на початку й у кінці утримання. */
  onActiveChange?(active: boolean): void;
}

export function createStick(options: StickOptions): Stick {
  const element = document.createElement('div');
  element.className = options.mode === '2d' ? 'stick stick--2d' : 'stick stick--vertical';
  element.dataset.testid = options.testid;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', options.label);
  const knob = document.createElement('div');
  knob.className = 'stick-knob';
  knob.setAttribute('aria-hidden', 'true');
  element.append(knob);
  if (options.mode === 'vertical') {
    const up = document.createElement('span');
    up.className = 'stick-hint stick-hint--up';
    up.textContent = '+Y';
    const down = document.createElement('span');
    down.className = 'stick-hint stick-hint--down';
    down.textContent = '−Y';
    element.append(up, down);
  }

  let pointerId: number | null = null;
  let value: Vec2 = { x: 0, y: 0 };

  const setKnob = (v: Vec2, animate: boolean) => {
    const rect = element.getBoundingClientRect();
    const travelX = options.mode === '2d' ? (rect.width - knob.offsetWidth) / 2 : 0;
    const travelY = (rect.height - knob.offsetHeight) / 2;
    knob.classList.toggle('stick-knob--return', animate);
    knob.style.transform = `translate(${v.x * travelX}px, ${v.y * travelY}px)`;
  };

  const read = (event: PointerEvent): Vec2 => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const travelX = Math.max(1, (rect.width - knob.offsetWidth) / 2);
    const travelY = Math.max(1, (rect.height - knob.offsetHeight) / 2);
    let x = options.mode === '2d' ? (event.clientX - cx) / travelX : 0;
    let y = (event.clientY - cy) / travelY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  };

  const down = (event: PointerEvent) => {
    if (pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    try {
      // Палець може вийти за межі джойстика — події все одно йдуть сюди.
      element.setPointerCapture(event.pointerId);
    } catch {
      // Деякі браузери не дають захопити вказівник — працюємо й без цього.
    }
    element.classList.add('stick--active');
    value = read(event);
    setKnob(value, false);
    options.onActiveChange?.(true);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    value = read(event);
    setKnob(value, false);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    value = { x: 0, y: 0 };
    element.classList.remove('stick--active');
    setKnob(value, true);
    options.onActiveChange?.(false);
  };

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);
  element.addEventListener('lostpointercapture', up);
  element.addEventListener('contextmenu', (event) => event.preventDefault());

  return {
    element,
    get value() {
      return value;
    },
    get active() {
      return pointerId !== null;
    },
    dispose() {
      element.remove();
    },
  };
}
