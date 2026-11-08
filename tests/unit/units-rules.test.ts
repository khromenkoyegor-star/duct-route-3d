/**
 * Правила з CLAUDE.md щодо одиниць і структури коду + крайні випадки units.ts.
 *  - Переведення м ↔ мм — тільки в src/core/units.ts.
 *  - src/core/ — чиста логіка: без Three.js і без DOM.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatMm, mmToM, mToMm } from '../../src/core/units.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const UNITS = 'core/units.ts';

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Код без коментарів (щоб «1000 мм» у тексті коментаря не рахувалося). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('правило: м ↔ мм переводимо тільки в src/core/units.ts', () => {
  it('ніде, крім units.ts, немає множення/ділення на 1000 чи 0,001', async () => {
    const offenders: string[] = [];
    // * 1000, / 1000, * 1_000, / 1e3, * 0.001, * 1e-3, / 0.001 …
    const conversion = /[*/]\s*(1_?000(?:\.0*)?|1e3|0?\.001|1e-3)(?![\d_.])/;
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (rel === UNITS) continue;
      const lines = stripComments(await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (conversion.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('константа MM_PER_M використовується лише в units.ts', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (rel === UNITS) continue;
      if (/\bMM_PER_M\b/.test(stripComments(await readFile(file, 'utf8')))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('правило: src/core — без Three.js і без DOM', () => {
  it('жоден файл у src/core не імпортує three і не звертається до window/document', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(SRC, 'core'))) {
      const code = stripComments(await readFile(file, 'utf8'));
      const rel = relative(SRC, file);
      if (/from\s+['"]three(\/[^'"]*)?['"]|import\(\s*['"]three/.test(code)) offenders.push(`${rel}: імпорт three`);
      if (/\b(window|document|navigator|HTMLElement|localStorage)\b/.test(code)) offenders.push(`${rel}: DOM`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('units: крайні випадки', () => {
  const plain = (s: string) => s.replace(/\s/g, ' ');

  it('точність ±0,1 мм туди й назад на всьому робочому діапазоні (крок 0,1 мм)', () => {
    // Від −100 м до +100 м — більше будь-якого цеху; детерміновані «випадкові» значення.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 20_000; i++) {
      const mm = Math.round((next() * 200_000 - 100_000) * 10) / 10;
      expect(Math.abs(mToMm(mmToM(mm)) - mm)).toBeLessThan(1e-6);
    }
  });

  it('напрямок переведення не переплутано: мм → м зменшує, м → мм збільшує', () => {
    expect(mmToM(2500)).toBe(2.5);
    expect(mToMm(2.5)).toBe(2500);
    expect(mmToM(0)).toBe(0);
    expect(mToMm(0)).toBe(0);
  });

  it('−∞ і NaN відхиляються в обидва боки', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => mmToM(bad)).toThrow(RangeError);
      expect(() => mToMm(bad)).toThrow(RangeError);
      expect(() => formatMm(bad)).toThrow(RangeError);
    }
  });

  it('formatMm: відʼємні координати показуються з мінусом', () => {
    expect(plain(formatMm(-2500))).toMatch(/^[-−]2 500 мм$/);
    expect(plain(formatMm(-0.3))).toMatch(/^[-−]0,3 мм$/);
    expect(plain(formatMm(-1234.56))).toMatch(/^[-−]1 234,6 мм$/);
  });

  it('formatMm: округлення до 0,1 мм', () => {
    expect(plain(formatMm(0.04))).toBe('0 мм');
    expect(plain(formatMm(0.06))).toBe('0,1 мм');
    expect(plain(formatMm(1234.56))).toBe('1 234,6 мм');
    expect(plain(formatMm(999.96))).toBe('1 000 мм');
  });

  it('formatMm: −0 і крихітні відʼємні не дають «−0 мм»', () => {
    for (const v of [-0, -0.0001, -0.04]) expect(plain(formatMm(v))).toBe('0 мм');
  });

  it('formatMm: великі значення (траса 500 м) без експоненти', () => {
    expect(plain(formatMm(500_000))).toBe('500 000 мм');
    expect(plain(formatMm(123_456.7))).toBe('123 456,7 мм');
  });
});
