/**
 * Етап 6: чернетки в браузері — окремо для кожного скану, не більше 10, без трас — прибираються;
 * зіпсоване чи недоступне сховище не ламає програму.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectData, ScanFingerprint } from '../../src/core/project';
import { createDrafts, DRAFTS_KEY, DRAFTS_LIMIT, type DraftStorage } from '../../src/ui/drafts';

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const scan = (triangles: number): ScanFingerprint => ({ name: `scan-${triangles}.zip`, triangles, sizeMm: { x: 4000, y: 2700, z: 3000 }, fileBytes: 1 });

const project = (s: ScanFingerprint, routes = 1): ProjectData => ({
  name: 'Чернетка',
  savedAt: '',
  scan: s,
  set: {
    routes: Array.from({ length: routes }, (_, i) => ({
      id: i + 1,
      nodes: [
        { x: 0, y: 0, z: i * 100 },
        { x: 1000, y: 0, z: i * 100 },
      ],
      duct: null,
    })),
    nextId: routes + 1,
  },
  view: null,
  display: null,
});

describe('чернетки', () => {
  it('записати й прочитати: для того самого скану — та сама траса; для іншого — нічого', () => {
    const storage = memoryStorage();
    let t = 0;
    const drafts = createDrafts(storage, () => new Date(Date.UTC(2026, 10, 27, 14, 5, t++)));
    drafts.save(project(scan(100), 2));
    const d = drafts.get(scan(100))!;
    expect(d.project.set.routes).toHaveLength(2);
    expect(d.project.set.routes[1]!.nodes[1]).toEqual({ x: 1000, y: 0, z: 100 });
    expect(d.savedAt).toBe('2026-11-27T14:05:00.000Z');
    expect(drafts.get(scan(200))).toBeNull();
    // Той самий скан, перейменований файл — та сама чернетка.
    expect(drafts.get({ ...scan(100), name: 'інша назва.glb' })).not.toBeNull();
  });

  it('без трас — чернетку скану прибрано; remove — теж', () => {
    const storage = memoryStorage();
    const drafts = createDrafts(storage);
    drafts.save(project(scan(1)));
    drafts.save(project(scan(2)));
    drafts.save(project(scan(1), 0));
    expect(drafts.get(scan(1))).toBeNull();
    expect(drafts.get(scan(2))).not.toBeNull();
    drafts.remove(scan(2));
    expect(drafts.get(scan(2))).toBeNull();
    expect(storage.data.has(DRAFTS_KEY)).toBe(false);
  });

  it(`не більше ${DRAFTS_LIMIT} сканів — найстаріші забуваються`, () => {
    const storage = memoryStorage();
    let t = 0;
    const drafts = createDrafts(storage, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    for (let i = 1; i <= DRAFTS_LIMIT + 3; i++) drafts.save(project(scan(i)));
    expect(Object.keys(JSON.parse(storage.data.get(DRAFTS_KEY)!))).toHaveLength(DRAFTS_LIMIT);
    expect(drafts.get(scan(1))).toBeNull();
    expect(drafts.get(scan(3))).toBeNull();
    expect(drafts.get(scan(4))).not.toBeNull();
    expect(drafts.get(scan(DRAFTS_LIMIT + 3))).not.toBeNull();
  });

  it('проєкт без скану не записується', () => {
    const storage = memoryStorage();
    createDrafts(storage).save({ ...project(scan(1)), scan: null });
    expect(storage.data.size).toBe(0);
  });

  it('зіпсоване, недоступне чи переповнене сховище — без помилок, чернеток просто немає', () => {
    const broken = memoryStorage();
    broken.data.set(DRAFTS_KEY, '{не json');
    expect(createDrafts(broken).get(scan(1))).toBeNull();
    // Зіпсований запис для скану — теж «немає».
    broken.data.set(DRAFTS_KEY, JSON.stringify({ '1:4000x2700x3000': { savedAt: 'x', text: '{"format":"other"}' } }));
    expect(createDrafts(broken).get(scan(1))).toBeNull();

    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const drafts = createDrafts(throwing);
    expect(() => drafts.save(project(scan(1)))).not.toThrow();
    expect(drafts.get(scan(1))).toBeNull();
    expect(() => createDrafts(null).save(project(scan(1)))).not.toThrow();
    expect(createDrafts(null).get(scan(1))).toBeNull();
  });
});
