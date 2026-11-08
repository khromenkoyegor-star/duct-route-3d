/**
 * Одиниці виміру.
 *
 * Сцена (Three.js, glTF) — у метрах: 1 одиниця сцени = 1 м реального простору.
 * Інтерфейс показує й приймає міліметри.
 * Переведення м ↔ мм робиться ТІЛЬКИ тут — ніде більше в коді не множимо й не ділимо на 1000.
 */

/** Скільки міліметрів в одному метрі. */
export const MM_PER_M = 1000;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} має бути скінченним числом, отримано: ${String(value)}`);
  }
}

/** Міліметри (інтерфейс) → метри (сцена). */
export function mmToM(mm: number): number {
  assertFinite(mm, 'mm');
  return mm / MM_PER_M;
}

/** Метри (сцена) → міліметри (інтерфейс). */
export function mToMm(m: number): number {
  assertFinite(m, 'm');
  return m * MM_PER_M;
}

const mmFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

/** Підпис для інтерфейсу: 4000 → «4 000 мм». До 0,1 мм. */
export function formatMm(mm: number): string {
  assertFinite(mm, 'mm');
  // Прибираємо «−0» після округлення до 0,1 мм.
  const rounded = Math.round(mm * 10) / 10;
  return `${mmFormat.format(rounded === 0 ? 0 : rounded)} мм`;
}
