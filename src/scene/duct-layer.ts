/**
 * Повітропроводи всіх трас на сцені: одна 3D-модель (Mesh) на трасу; перебудовується лише тоді,
 * коли змінилась сама траса (траси незмінні — порівнюємо об'єкт). Підсвітка:
 * - вибраний відрізок (панель «Повітропровід», перехід) — синім;
 * - закороткі відрізки (деталі не вміщаються) — червоним.
 * Звільняє геометрії, коли трасу видалили, змінили чи відкрили інший скан.
 */
import { Box3, type BufferGeometry, Group, type Material, Mesh } from 'three';
import { type DuctLayout, ductLayout } from '../core/duct';
import type { Route } from '../core/route';
import { mToMm } from '../core/units';
import { buildDuctGeometry, createGalvanizedMaterial, createHighlightMaterial } from './duct-mesh';
import type { Viewer } from './viewer';

/** Підсвітка трохи ширша за трубу, мм — щоб не «мерехтіла» разом з її поверхнею. */
const HIGHLIGHT_GROW_MM = 6;
const SELECTED_COLOR = 0x0a84ff;
const PROBLEM_COLOR = 0xff3b30;

export interface DuctSelection {
  routeId: number;
  segment: number;
}

export interface DuctLayer {
  /** Показати повітропроводи трас (траси без повітропроводу пропускаються). */
  update(routes: readonly Route[], selection: DuctSelection | null): void;
  setVisible(visible: boolean): void;
  /** Розкладання траси на деталі (для панелі й вибору дотиком) або null. */
  layout(routeId: number): DuctLayout | null;
  /** Габарит повітропроводу траси, мм (для тестів) або null. */
  boxMm(routeId: number): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  /** Скільки трикутників у всіх повітропроводах (для тестів і перевірки пам'яті). */
  readonly triangles: number;
  dispose(): void;
}

interface Entry {
  route: Route;
  layout: DuctLayout;
  mesh: Mesh;
  problems: Mesh | null;
}

export function createDuctLayer(viewer: Viewer): DuctLayer {
  const group = new Group();
  group.name = 'ducts';
  viewer.add(group);
  const material = createGalvanizedMaterial();
  // Закороткий відрізок — яскраво, щоб було видно навіть дрібно на iPhone.
  const problemMaterial = createHighlightMaterial(PROBLEM_COLOR, 0.75);
  const selectedMaterial = createHighlightMaterial(SELECTED_COLOR);
  const entries = new Map<number, Entry>();
  let selected: Mesh | null = null;
  let selectedKey = '';

  const disposeMesh = (mesh: Mesh | null) => {
    if (!mesh) return;
    group.remove(mesh);
    (mesh.geometry as BufferGeometry).dispose();
  };

  const remove = (id: number) => {
    const entry = entries.get(id);
    if (!entry) return;
    disposeMesh(entry.mesh);
    disposeMesh(entry.problems);
    entries.delete(id);
  };

  const build = (route: Route): Entry | null => {
    if (!route.duct || route.nodes.length < 2) return null;
    const layout = ductLayout(route.nodes, route.duct);
    const mesh = new Mesh(buildDuctGeometry(route.nodes, layout), material);
    mesh.name = `duct-${route.id}`;
    group.add(mesh);
    let problems: Mesh | null = null;
    if (layout.problems.length > 0) {
      const segments = new Set(layout.problems.map((p) => p.segment));
      problems = new Mesh(buildDuctGeometry(route.nodes, layout, { segments, grow: HIGHLIGHT_GROW_MM }), problemMaterial);
      problems.renderOrder = 1;
      group.add(problems);
    }
    return { route, layout, mesh, problems };
  };

  const updateSelection = (selection: DuctSelection | null) => {
    const entry = selection ? entries.get(selection.routeId) : undefined;
    const key = entry && selection ? `${selection.routeId}:${selection.segment}:${entries.get(selection.routeId)?.mesh.uuid}` : '';
    if (key === selectedKey) return;
    selectedKey = key;
    disposeMesh(selected);
    selected = null;
    if (!entry || !selection) return;
    selected = new Mesh(
      buildDuctGeometry(entry.route.nodes, entry.layout, { segments: new Set([selection.segment]), grow: HIGHLIGHT_GROW_MM }),
      selectedMaterial,
    );
    selected.renderOrder = 2;
    group.add(selected);
  };

  return {
    update(routes, selection) {
      const alive = new Set<number>();
      for (const route of routes) {
        alive.add(route.id);
        const existing = entries.get(route.id);
        if (existing && existing.route === route) continue;
        remove(route.id);
        const entry = build(route);
        if (entry) entries.set(route.id, entry);
      }
      for (const id of [...entries.keys()]) if (!alive.has(id)) remove(id);
      if (entries.size > 0) viewer.enableMetalLighting();
      updateSelection(selection);
      viewer.requestRender();
    },
    setVisible(visible) {
      if (group.visible === visible) return;
      group.visible = visible;
      viewer.requestRender();
    },
    layout(routeId) {
      return entries.get(routeId)?.layout ?? null;
    },
    boxMm(routeId) {
      const entry = entries.get(routeId);
      if (!entry) return null;
      const geometry = entry.mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox ?? new Box3();
      const mm = (v: { x: number; y: number; z: number }) => ({ x: mToMm(v.x), y: mToMm(v.y), z: mToMm(v.z) });
      return { min: mm(box.min), max: mm(box.max) };
    },
    get triangles() {
      let total = 0;
      for (const e of entries.values()) total += e.mesh.geometry.getAttribute('position').count / 3;
      return total;
    },
    dispose() {
      for (const id of [...entries.keys()]) remove(id);
      disposeMesh(selected);
      for (const m of [material, problemMaterial, selectedMaterial] as Material[]) m.dispose();
      viewer.remove(group);
    },
  };
}
