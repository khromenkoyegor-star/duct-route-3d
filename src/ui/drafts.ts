/**
 * Чернетки проєкту в браузері (етап 6) — запасний варіант на випадок, коли сторінку перезавантажили,
 * Safari закрив її через пам'ять або відкрили інший скан. Окремо для кожного скану (за відбитком):
 * відкриваєш той самий скан — програма пропонує повернути траси.
 *
 * Сховище — localStorage під ключем «Траса 3D 2» (стабільна 4.1 сховища не використовує). Воно може
 * бути недоступне (приватний режим) чи переповнене — тоді чернетки просто не пишуться, програма працює.
 * Надійне збереження — файл проєкту (project.ts).
 */
import { type ProjectData, parseProject, type ScanFingerprint, scanKey, serializeProject } from '../core/project';

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
  const read = (): Stored => {
    if (!storage) return {};
    try {
      const raw = storage.getItem(DRAFTS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Stored) : {};
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

  return {
    available: storage !== null,
    get(scan) {
      const entry = read()[scanKey(scan)];
      if (!entry || typeof entry.text !== 'string') return null;
      const parsed = parseProject(entry.text);
      if (!parsed.ok || parsed.project.set.routes.length === 0) return null;
      return { savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : parsed.project.savedAt, project: parsed.project };
    },
    save(project) {
      if (!project.scan) return;
      const all = read();
      const key = scanKey(project.scan);
      if (project.set.routes.length === 0) {
        delete all[key];
      } else {
        all[key] = { savedAt: now().toISOString(), text: serializeProject(project) };
        // Лише найновіші DRAFTS_LIMIT сканів.
        const keys = Object.keys(all).sort((a, b) => (all[b]!.savedAt > all[a]!.savedAt ? 1 : -1));
        for (const old of keys.slice(DRAFTS_LIMIT)) delete all[old];
      }
      write(all);
    },
    remove(scan) {
      const all = read();
      delete all[scanKey(scan)];
      write(all);
    },
  };
}
