/**
 * Інформація про скан для інтерфейсу: габарит у мм, кількість трикутників, розмір файлу
 * і попередження, якщо скан завеликий для пристрою. Чиста логіка — без Three.js і без DOM.
 */
import { formatMm, mToMm } from './units';

export type DeviceClass = 'phone' | 'tablet';

/** Зібрано зі сцени (у метрах, як у сцені). */
export interface ScanStats {
  /** Межі скану в метрах: [x, y, z]. */
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  triangles: number;
  /** Розмір вибраного файлу (архіву) у байтах. */
  fileBytes: number;
  /** Кількість текстур і сумарна кількість пікселів (після можливого зменшення). */
  textures: number;
  texturePixels: number;
  /** Скільки текстур було зменшено, щоб не перевантажити пам'ять. */
  texturesReduced: number;
  /**
   * На скільки скан піднято (+) чи опущено (−) по Y, щоб найнижча точка була на Y = 0 (м).
   * min/max — уже після цього зсуву.
   */
  offsetY: number;
}

export interface ScanInfo {
  sizeMm: { x: number; y: number; z: number };
  /** Зсув скану по висоті (мм): + піднято, − опущено. */
  offsetYMm: number;
  triangles: number;
  fileBytes: number;
  /** Усі зауваження про скан (для довідки). */
  warnings: string[];
  /**
   * Лише ті, що загрожують роботі (скан може гальмувати чи закритися, або це не скан) —
   * їх показуємо віконцем одразу після відкриття.
   */
  risks: string[];
}

/**
 * Орієнтовні межі, після яких Safari може не витримати скан. Підбираються на реальних сканах.
 * texturePixels: 4096² ≈ 16,8 млн пікселів ≈ 90 МБ відеопам'яті з mip-рівнями.
 */
export const SCAN_LIMITS: Record<DeviceClass, { triangles: number; fileBytes: number; texturePixels: number }> = {
  phone: { triangles: 1_500_000, fileBytes: 60 * 1024 * 1024, texturePixels: 3 * 4096 * 4096 },
  tablet: { triangles: 4_000_000, fileBytes: 150 * 1024 * 1024, texturePixels: 2 * 8192 * 8192 },
};

/** Найбільша сторона текстури, до якої зменшуємо великі текстури. */
export const MAX_TEXTURE_SIDE: Record<DeviceClass, number> = { phone: 4096, tablet: 8192 };

const countFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

/** 1234567 → «1 234 567». */
export function formatCount(n: number): string {
  return countFormat.format(n);
}

/** Розмір файлу: «850 КБ», «10,5 МБ». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${countFormat.format(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${countFormat.format(Math.round(bytes / 1024))} КБ`;
  return `${decimalFormat.format(Math.round((bytes / (1024 * 1024)) * 10) / 10)} МБ`;
}

/**
 * Підпис зсуву по висоті: «Низ скану на Y = 0 · скан піднято на 1 400 мм».
 * Зсув менший за 0,5 мм не згадуємо.
 */
export function formatOffsetY(offsetYMm: number): string {
  if (Math.abs(offsetYMm) < 0.5) return 'Низ скану на Y = 0';
  const direction = offsetYMm > 0 ? 'піднято' : 'опущено';
  return `Низ скану на Y = 0 · скан ${direction} на ${formatMm(Math.abs(offsetYMm))}`;
}

/** «4 000 × 2 700 × 3 000 мм» (X × Y × Z). */
export function formatSizeMm(size: { x: number; y: number; z: number }): string {
  const n = (mm: number) => formatMm(mm).replace(/\s*мм$/, '');
  return `${n(size.x)} × ${n(size.y)} × ${n(size.z)} мм`;
}

export function describeScan(stats: ScanStats, device: DeviceClass): ScanInfo {
  const sizeMm = {
    x: mToMm(stats.max[0] - stats.min[0]),
    y: mToMm(stats.max[1] - stats.min[1]),
    z: mToMm(stats.max[2] - stats.min[2]),
  };
  const limits = SCAN_LIMITS[device];
  const where = device === 'phone' ? 'для iPhone' : 'для iPad';
  const risks: string[] = [];
  if (stats.triangles > limits.triangles) {
    risks.push(
      `Дуже детальний скан (${formatCount(stats.triangles)} трикутників) — ${where} це забагато, може гальмувати або закритися.`,
    );
  }
  if (stats.fileBytes > limits.fileBytes) {
    risks.push(`Великий файл (${formatBytes(stats.fileBytes)}) — ${where} це забагато.`);
  }
  if (stats.texturePixels > limits.texturePixels) {
    risks.push(`Дуже великі текстури — ${where} може не вистачити пам'яті.`);
  }
  if (stats.triangles === 0) {
    risks.push('У файлі немає поверхонь — це не скан приміщення?');
  }
  const warnings = [...risks];
  if (stats.texturesReduced > 0) {
    // Довідково: на розміри не впливає, віконцем не показуємо.
    warnings.splice(
      risks.length - (stats.triangles === 0 ? 1 : 0),
      0,
      `Текстури зменшено (${stats.texturesReduced}), щоб скан не перевантажив пам'ять. Розміри від цього не змінюються.`,
    );
  }
  return {
    sizeMm,
    offsetYMm: mToMm(stats.offsetY),
    triangles: stats.triangles,
    fileBytes: stats.fileBytes,
    warnings,
    risks,
  };
}
