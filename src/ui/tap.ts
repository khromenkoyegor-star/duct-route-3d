/**
 * Короткий дотик / клік, який не плутається з перетягуванням (обертанням камери).
 * Дотик = один палець (або ліва кнопка мишки), зсув не більше TAP_MAX_MOVE_PX і не довше TAP_MAX_MS.
 * Якщо під час жесту торкнувся другий палець — це щипок/зсув, а не дотик.
 */
export const TAP_MAX_MOVE_PX = 6;
export const TAP_MAX_MS = 350;

interface Track {
  x: number;
  y: number;
  t: number;
  cancelled: boolean;
}

export function onTap(element: HTMLElement, callback: (clientX: number, clientY: number) => void): () => void {
  const active = new Map<number, Track>();

  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Другий палець скасовує дотик для всіх.
    for (const track of active.values()) track.cancelled = true;
    active.set(event.pointerId, { x: event.clientX, y: event.clientY, t: event.timeStamp, cancelled: active.size > 0 });
  };
  const move = (event: PointerEvent) => {
    const track = active.get(event.pointerId);
    if (!track) return;
    if (Math.hypot(event.clientX - track.x, event.clientY - track.y) > TAP_MAX_MOVE_PX) track.cancelled = true;
  };
  const up = (event: PointerEvent) => {
    const track = active.get(event.pointerId);
    active.delete(event.pointerId);
    if (!track || track.cancelled) return;
    if (event.timeStamp - track.t > TAP_MAX_MS) return;
    if (Math.hypot(event.clientX - track.x, event.clientY - track.y) > TAP_MAX_MOVE_PX) return;
    callback(event.clientX, event.clientY);
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
