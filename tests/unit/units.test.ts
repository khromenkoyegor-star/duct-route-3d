import { describe, expect, it } from 'vitest';
import { MM_PER_M, formatMm, mToMm, mmToM } from '../../src/core/units.ts';

describe('units: мм ↔ м', () => {
  it('1 м = 1000 мм', () => {
    expect(MM_PER_M).toBe(1000);
    expect(mToMm(1)).toBe(1000);
    expect(mmToM(1000)).toBe(1);
  });

  it('габарит тестової кімнати 4000 × 2700 × 3000 мм', () => {
    expect(mmToM(4000)).toBe(4);
    expect(mmToM(2700)).toBeCloseTo(2.7, 12);
    expect(mmToM(3000)).toBe(3);
  });

  it('туди й назад без втрати точності (±0,1 мм)', () => {
    for (const mm of [0, 0.1, 1, 10, 50, 100, 199.9, 2500, 12345.6, -750, 1e6]) {
      expect(Math.abs(mToMm(mmToM(mm)) - mm)).toBeLessThan(1e-6);
    }
  });

  it('відʼємні значення (координати нижче нуля) переводяться коректно', () => {
    expect(mmToM(-2500)).toBe(-2.5);
    expect(mToMm(-0.05)).toBeCloseTo(-50, 9);
  });

  it('NaN і нескінченність — помилка, а не тихе «NaN мм»', () => {
    expect(() => mmToM(Number.NaN)).toThrow(RangeError);
    expect(() => mToMm(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => formatMm(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatMm', () => {
  // Intl для uk-UA ставить нерозривний пробіл між тисячами — нормалізуємо для порівняння.
  const plain = (s: string) => s.replace(/\s/g, ' ');

  it('ціле число з одиницями', () => {
    expect(plain(formatMm(4000))).toBe('4 000 мм');
    expect(plain(formatMm(200))).toBe('200 мм');
  });

  it('до 0,1 мм, десяткова кома', () => {
    expect(plain(formatMm(2500.04))).toBe('2 500 мм');
    expect(plain(formatMm(2500.06))).toBe('2 500,1 мм');
  });

  it('без «−0»', () => {
    expect(plain(formatMm(-0.01))).toBe('0 мм');
  });
});
