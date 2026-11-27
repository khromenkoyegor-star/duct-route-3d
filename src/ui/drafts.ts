/**
 * Чернетки проєкту в браузері (етап 6) — запасний варіант на випадок, коли сторінку перезавантажили,
 * Safari закрив її через пам'ять або відкрили інший скан. Окремо для кожного скану (за відбитком):
 * відкриваєш той самий скан — програма пропонує повернути траси.
 *
 * Сховище — localStorage під ключем «Траса 3D 2» (стабільна 4.1 сховища не використовує). Воно може
 * бути недоступне (приватний режим) чи переповнене — тоді чернетки просто не пишуться, програма працює.
 * Надійне збереження — файл проєкту (project.ts).
 */
import { type ProjectData, parseProject, sameScan, type ScanFingerprint, scanKey, serializeProject } from '../core/project';

export const DRAFTS_KEY = 'trasa3d2.drafts.v1';
/** Скільки сканів пам'ятаємо (найновіші). */
export const DRAFTS_LIMIT = 10;

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Draft {
  /** Коли записано (ISO 8601). */
  savedAt: string;
  project: ProjectData;
}

export interface Drafts {
  /** Чи є сховище (у приватному режимі чи без дозволу — немає, і чернетки не пишуться). */
  readonly available: boolean;
  /** Чернетка для цього скану або null. */
  get(scan: ScanFingerprint): Draft | null;
  /** Записати чернетку проєкту (скан — у project.scan). Без трас — чернетку скану прибрати. */
  save(project: ProjectData): void;
  remove(scan: ScanFingerprint): void;
}

type Stored = Record<string, { savedAt: string; text: string }>;

/** localStorage, якщо він доступний (у приватному режимі чи без дозволу доступ може кинути помилку). */
export function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createDrafts(storage: DraftStorage | null, now: () => Date = () => new Date()): Drafts {
  /** Лише справні записи (зіпсований чи чужий запис усередині сховища просто відкидається). */
  const read = (): Stored => {
    if (!storage) return {};
    try {
      const raw = storage.getItem(DRAFTS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const out: Stored = {};
      for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const e = entry as { savedAt?: unknown; text?: unknown } | null;
        if (e && typeof e === 'object' && typeof e.savedAt === 'string' && typeof e.text === 'string') {
          out[key] = { savedAt: e.savedAt, text: e.text };
        }
      }
      return out;
    } catch {
      return {};
    }
  };
  const write = (all: Stored) => {
    if (!storage) return;
    try {
      const keys = Object.keys(all);
      if (keys.length === 0) storage.removeItem(DRAFTS_KEY);
      else storage.setItem(DRAFTS_KEY, JSON.stringify(all));
    } catch {
      // Переповнено чи заборонено — чернетка просто не запишеться.
    }
  };

  /**
   * Прибрати з `all` чернетки цього скану. «Той самий скан» — за sameScan (трикутники й габарит ±1 мм),
   * а не за ключем запису: так немає межі округлення, і різні скани з однаковою кількістю трикутників
   * не затирають один одного. Зіпсовані записи теж прибираються.
   */
  const dropScan = (all: Stored, scan: ScanFingerprint) => {
    for (const [key, entry] of Object.entries(all)) {
      const parsed = parseProject(entry.text);
      if (!parsed.ok || !parsed.project.scan || sameScan(parsed.project.scan, scan)) delete all[key];
    }
  };

  return {
    available: storage !== null,
    get(scan) {
      // Чернеток не більше DRAFTS_LIMIT — перебрати всі й узяти найновішу для цього скану.
      let best: Draft | null = null;
      for (const entry of Object.values(read())) {
        const parsed = parseProject(entry.text);
        if (!parsed.ok || !parsed.project.scan || parsed.project.set.routes.length === 0) continue;
        if (!sameScan(parsed.project.scan, scan)) continue;
        if (!best || entry.savedAt > best.savedAt) best = { savedAt: entry.savedAt, project: parsed.project };
      }
      return best;
    },
    save(project) {
      if (!project.scan) return;
      const all = read();
      dropScan(all, project.scan);
      if (project.set.routes.length > 0) {
        const size = project.scan.sizeMm;
        const key = `${scanKey(project.scan)}:${Math.round(size.x)}x${Math.round(size.y)}x${Math.round(size.z)}`;
        all[key] = { savedAt: now().toISOString(), text: serializeProject(project) };
        // Лише DRAFTS_LIMIT сканів: щойно записаний лишається завжди (навіть якщо годинник перевели назад),
        // з решти — найновіші.
        const others = Object.keys(all)
          .filter((k) => k !== key)
          .sort((a, b) => all[b]!.savedAt.localeCompare(all[a]!.savedAt));
        for (const old of others.slice(DRAFTS_LIMIT - 1)) delete all[old];
      }
      write(all);
    },
    remove(scan) {
      const all = read();
      dropScan(all, scan);
      write(all);
    },
  };
}
