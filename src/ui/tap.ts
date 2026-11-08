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

/** Підказка, поки чекаємо повторного дотику. */
export const HINT_CONFIRM_MOVE = 'Точку вже підсунуто. Торкніться тут ще раз, щоб перенести її сюди';
/** Повторний дотик для перенесення вже підсунутої точки: не пізніше й не далі за це. */
export const RETAP_MS = 4000;
export const RETAP_PX = 40;

/**
 * Підсунуту джойстиком точку випадковий дотик не переносить: потрібен другий дотик у тому самому місці
 * (не пізніше RETAP_MS і не далі RETAP_PX від першого).
 */
export interface RetapGuard {
  /** Дотик у (x, y): true — це повторний дотик (можна переносити), false — перший, чекаємо другий. */
  confirm(clientX: number, clientY: number): boolean;
  /** Чи чекаємо зараз повторного дотику (для підказки). */
  readonly waiting: boolean;
  clear(): void;
}

/** onExpire — час на повторний дотик сплив (прибрати підказку). */
export function createRetapGuard(onExpire: () => void): RetapGuard {
  let pending: { x: number; y: number; time: number } | null = null;
  let timer = 0;
  const clear = () => {
    pending = null;
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };
  return {
    confirm(x, y) {
      const now = performance.now();
      const repeated = !!pending && now - pending.time < RETAP_MS && Math.hypot(x - pending.x, y - pending.y) < RETAP_PX;
      clear();
      if (repeated) return true;
      pending = { x, y, time: now };
      timer = window.setTimeout(() => {
        pending = null;
        timer = 0;
        onExpire();
      }, RETAP_MS);
      return false;
    },
    get waiting() {
      return pending !== null;
    },
    clear,
  };
}
