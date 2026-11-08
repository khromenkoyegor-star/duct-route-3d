/**
 * Короткий дотик / клік, який не плутається з перетягуванням (обертанням камери).
 * Дотик = один палець (або ліва кнопка мишки) майже без руху: мишка ≤ 5 px, палець ≤ 10 px
 * (палець завжди трохи тремтить). Тривалість не обмежуємо: нерухоме натискання камеру не крутить,
 * тож повільний акуратний дотик — теж дотик.
 * Точка дотику — місце НАТИСКАННЯ (а не відпускання): саме туди людина цілилась.
 * Якщо під час жесту торкнувся другий палець — це щипок/зсув, а не дотик.
 */
export const TAP_MAX_MOVE_MOUSE_PX = 5;
export const TAP_MAX_MOVE_TOUCH_PX = 10;

export interface TapHandlers {
  /** Натискання почалось (можна запам'ятати положення камери). */
  onDown?(clientX: number, clientY: number): void;
  /** Це був дотик: координати місця натискання. */
  onTap(clientX: number, clientY: number): void;
}

interface Track {
  x: number;
  y: number;
  limit: number;
  cancelled: boolean;
}

export function onTap(element: HTMLElement, handlers: TapHandlers): () => void {
  const active = new Map<number, Track>();

  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Другий палець скасовує дотик для всіх.
    for (const track of active.values()) track.cancelled = true;
    const limit = event.pointerType === 'mouse' ? TAP_MAX_MOVE_MOUSE_PX : TAP_MAX_MOVE_TOUCH_PX;
    active.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      limit,
      cancelled: active.size > 0,
    });
    if (active.size === 1) handlers.onDown?.(event.clientX, event.clientY);
  };
  const move = (event: PointerEvent) => {
    const track = active.get(event.pointerId);
    if (!track) return;
    if (Math.hypot(event.clientX - track.x, event.clientY - track.y) > track.limit) track.cancelled = true;
  };
  const up = (event: PointerEvent) => {
    const track = active.get(event.pointerId);
    active.delete(event.pointerId);
    if (!track || track.cancelled) return;
    if (Math.hypot(event.clientX - track.x, event.clientY - track.y) > track.limit) return;
    handlers.onTap(track.x, track.y);
  };
  const cancel = (event: PointerEvent) => {
    active.delete(event.pointerId);
  };

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', cancel);
  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', cancel);
  };
}
