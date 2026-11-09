/**
 * Траси на екрані поверх сцени:
 * - відрізки — товста лінія кольору траси;
 * - вузли — кружечки без літер (видно, де повороти);
 * - номер траси — біля першої точки;
 * - у трасі, яку будують, — довжина кожного відрізка в мм (і того, що тягнуть зараз).
 * Вибрана у списку «Видалити траєкторію» траса підсвічується, решта — приглушені.
 * Малюється з даних трас (мм) щокадру; відрізки за камерою обрізаються (viewer.projectPath).
 */
import type { PointM } from '../core/nudge';
import { distance, type Route, toM } from '../core/route';
import { formatMm, mToMm } from '../core/units';
import type { ProjectedPath, ScreenPoint, Viewer } from '../scene/viewer';

export interface RouteDraft {
  /** Номер, який отримає траса. */
  id: number;
  /** Підтверджені вузли (м сцени). */
  nodes: readonly PointM[];
  /** Точка, яку зараз доводять / тягнуть (м), або null. */
  pending: PointM | null;
}

export interface RouteLayerData {
  routes: readonly Route[];
  draft: RouteDraft | null;
  /** Підсвічена траса (вибрана у списку на видалення) або null. */
  highlight: number | null;
}

export interface RouteLayer {
  element: HTMLElement;
  update(data: RouteLayerData): void;
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_R = 6;
/**
 * Підпис довжини показуємо лише на відрізку, довшому на екрані за сам підпис із запасом
 * (інакше він закриває короткий відрізок, а підписи злипаються).
 */
const LABEL_MIN_PX = 64;
const LABEL_CHAR_PX = 8.6;
const LABEL_SPARE_PX = 38;
/** Номер траси — на цій відстані від першої точки, з протилежного від траси боку (не закриває її). */
const TAG_OFFSET_PX = 26;

interface Parts {
  group: SVGGElement;
  halo: SVGPathElement;
  line: SVGPathElement;
  pending: SVGPathElement;
  nodes: SVGPathElement;
  pendingNode: SVGPathElement;
  tag: HTMLElement;
}

const fmt = (n: number) => n.toFixed(1);

function linePath(segments: ProjectedPath['segments'], from = 0, to = segments.length): string {
  let d = '';
  let last: ScreenPoint | null = null;
  for (let i = from; i < to; i++) {
    const seg = segments[i];
    if (!seg) {
      last = null;
      continue;
    }
    const [a, b] = seg;
    if (!last || last.x !== a.x || last.y !== a.y) d += `M${fmt(a.x)} ${fmt(a.y)}`;
    d += `L${fmt(b.x)} ${fmt(b.y)}`;
    last = b;
  }
  return d;
}

/**
 * Вузли, що на екрані ближчі за це до вже намальованого, не малюємо: вони однаково зливаються
 * в одну пляму, а сотні кружечків на довгій трасі здалеку лише гальмують малювання.
 * Наблизиш камеру — вузли розійдуться й з'являться.
 */
const NODE_MIN_GAP_PX = 10;

function circlesPath(nodes: ProjectedPath['nodes'], count = nodes.length): string {
  let d = '';
  let last: ScreenPoint | null = null;
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    if (!n.visible) continue;
    // Останній вузол (звідки тягнуть наступну точку) — завжди.
    if (last && i < count - 1 && Math.hypot(n.x - last.x, n.y - last.y) < NODE_MIN_GAP_PX) continue;
    d += `M${fmt(n.x - NODE_R)} ${fmt(n.y)}a${NODE_R} ${NODE_R} 0 1 0 ${NODE_R * 2} 0a${NODE_R} ${NODE_R} 0 1 0 ${-NODE_R * 2} 0`;
    last = n;
  }
  return d;
}

interface DrawJob {
  key: string;
  id: number;
  nodes: readonly PointM[];
  pending: PointM | null;
  withLengths: boolean;
  /** nodes + pending. */
  all: readonly PointM[];
  projected: ProjectedPath;
  /** Куди від першої точки ставити номер (null — перша точка не видна). */
  tagDir: ScreenPoint | null;
}

export function createRouteLayer(viewer: Viewer): RouteLayer {
  const element = document.createElement('div');
  element.className = 'route-layer';
  element.dataset.testid = 'route-layer';
  element.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'route-svg');
  element.append(svg);

  const parts = new Map<string, Parts>();
  const labels: HTMLElement[] = [];
  /** Вузли трас у метрах (траси незмінні — рахуємо раз). */
  const metres = new WeakMap<Route, PointM[]>();
  let data: RouteLayerData = { routes: [], draft: null, highlight: null };

  const partsFor = (key: string): Parts => {
    let p = parts.get(key);
    if (p) return p;
    const group = document.createElementNS(SVG_NS, 'g');
    const make = (cls: string) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', cls);
      group.append(path);
      return path;
    };
    const halo = make('route-halo');
    const line = make('route-line');
    const pending = make('route-line route-line--pending');
    const nodes = make('route-nodes');
    const pendingNode = make('route-nodes route-nodes--pending');
    const tag = document.createElement('span');
    tag.className = 'route-tag';
    svg.append(group);
    element.append(tag);
    p = { group, halo, line, pending, nodes, pendingNode, tag };
    parts.set(key, p);
    return p;
  };

  let labelCount = 0;
  const addLabel = (seg: [ScreenPoint, ScreenPoint] | null | undefined, lengthMm: number, live: boolean) => {
    if (!seg) return;
    const [a, b] = seg;
    const text = formatMm(lengthMm);
    const needed = Math.max(LABEL_MIN_PX, text.length * LABEL_CHAR_PX + LABEL_SPARE_PX);
    if (Math.hypot(b.x - a.x, b.y - a.y) < needed) return;
    let label = labels[labelCount];
    if (!label) {
      label = document.createElement('span');
      label.className = 'route-length';
      element.append(label);
      labels.push(label);
    }
    labelCount += 1;
    label.hidden = false;
    label.textContent = text;
    label.classList.toggle('route-length--live', live);
    label.style.transform = `translate(${fmt((a.x + b.x) / 2)}px, ${fmt((a.y + b.y) / 2)}px) translate(-50%, -50%)`;
  };

  /** Читання: проєкції й напрямок номера (лише обчислення, DOM не змінюється). */
  const prepare = (key: string, id: number, nodes: readonly PointM[], pending: PointM | null, withLengths: boolean): DrawJob => {
    const all = pending ? [...nodes, pending] : nodes;
    const projected = viewer.projectPath(all);
    const first = projected.nodes[0];
    const tagDir = first?.visible ? tagDirection(first, projected.nodes[1], all[0]!) : null;
    return { key, id, nodes, pending, withLengths, all, projected, tagDir };
  };

  /** Запис: оновити лінії, вузли, номер і підписи однієї траси. */
  const apply = ({ key, id, nodes, pending, withLengths, all, projected, tagDir }: DrawJob) => {
    const p = partsFor(key);
    const confirmedSegments = Math.max(0, nodes.length - 1);
    const d = linePath(projected.segments, 0, confirmedSegments);
    p.halo.setAttribute('d', d + (pending ? linePath(projected.segments, confirmedSegments) : ''));
    p.line.setAttribute('d', d);
    p.pending.setAttribute('d', pending ? linePath(projected.segments, confirmedSegments) : '');
    p.nodes.setAttribute('d', circlesPath(projected.nodes, nodes.length));
    p.pendingNode.setAttribute('d', pending ? circlesPath(projected.nodes.slice(nodes.length)) : '');
    const highlighted = data.highlight === id;
    const dim = data.highlight !== null && !highlighted;
    // Поки будують нову трасу, готові приглушені — не сплутати, яку саме будуєш.
    const background = data.highlight === null && data.draft !== null && key !== 'draft';
    p.group.setAttribute(
      'class',
      `route${key === 'draft' ? ' route--draft' : ''}${highlighted ? ' route--highlight' : ''}` +
        `${dim ? ' route--dim' : ''}${background ? ' route--background' : ''}`,
    );
    const first = projected.nodes[0];
    p.tag.hidden = !first?.visible;
    p.tag.textContent = String(id);
    p.tag.classList.toggle('route-tag--highlight', highlighted);
    p.tag.classList.toggle('route-tag--dim', dim);
    p.tag.classList.toggle('route-tag--background', background);
    if (first?.visible && tagDir) {
      p.tag.style.transform =
        `translate(${fmt(first.x + tagDir.x * TAG_OFFSET_PX)}px, ${fmt(first.y + tagDir.y * TAG_OFFSET_PX)}px) translate(-50%, -50%)`;
    }
    if (!withLengths) return;
    for (let i = 1; i < all.length; i++) {
      addLabel(projected.segments[i - 1], mToMm(distance(all[i - 1]!, all[i]!)), i === all.length - 1 && !!pending);
    }
  };

  /**
   * Куди від першої точки ставити номер: з протилежного від траси боку; якщо другої точки ще немає
   * (чи вона на тому самому місці екрана) — туди, де немає стрілок осей X, Y, Z біля точки.
   */
  const tagDirection = (first: ScreenPoint, second: (ScreenPoint & { visible: boolean }) | undefined, world: PointM) => {
    const len = second?.visible ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
    if (len > 1) return { x: -(second!.x - first.x) / len, y: -(second!.y - first.y) / len };
    const axes = viewer.screenAxes(world);
    const lines = (['X', 'Y', 'Z'] as const)
      .map((a) => axes[a])
      .map((v) => ({ v, l: Math.hypot(v.x, v.y) }))
      .filter((a) => a.l > 0)
      .map((a) => ({ x: a.v.x / a.l, y: a.v.y / a.l }));
    let best = { x: 0, y: -1 };
    let bestGap = -1;
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const c = { x: Math.cos(angle), y: Math.sin(angle) };
      // Найменший кут до стрілок (вони йдуть лише в один бік від точки).
      const gap = Math.min(Math.PI, ...lines.map((d) => Math.acos(Math.max(-1, Math.min(1, c.x * d.x + c.y * d.y)))));
      // За рівних — ближче до «вгору-праворуч», де номер звично шукати.
      const score = gap - 0.01 * Math.hypot(c.x - 0.7, c.y + 0.7);
      if (score > bestGap) {
        bestGap = score;
        best = c;
      }
    }
    return best;
  };

  const draw = () => {
    labelCount = 0;
    // Спершу всі проєкції (читання розмірів екрана), потім усі зміни DOM: інакше браузер
    // перераховував би розкладку сторінки посеред кадру для кожної траси.
    const jobs: DrawJob[] = [];
    for (const route of data.routes) {
      let nodes = metres.get(route);
      if (!nodes) {
        nodes = route.nodes.map(toM);
        metres.set(route, nodes);
      }
      jobs.push(prepare(`route-${route.id}`, route.id, nodes, null, false));
    }
    const draft = data.draft;
    if (draft && (draft.nodes.length > 0 || draft.pending)) {
      // Поки першу точку лише ставлять, лінії ще немає — показуємо саму точку й номер траси.
      if (draft.nodes.length > 0) jobs.push(prepare('draft', draft.id, draft.nodes, draft.pending, true));
      else jobs.push(prepare('draft', draft.id, [draft.pending!], null, false));
    }
    const seen = new Set(jobs.map((j) => j.key));
    for (const job of jobs) apply(job);
    for (const [key, p] of parts) {
      if (seen.has(key)) continue;
      p.group.remove();
      p.tag.remove();
      parts.delete(key);
    }
    for (let i = labelCount; i < labels.length; i++) labels[i]!.hidden = true;
  };

  const stopFrames = viewer.onFrame(draw);

  return {
    element,
    update(next) {
      data = next;
      // Малюється в найближчому кадрі сцени (onFrame) — раз за кадр, навіть якщо оновлень було кілька.
      viewer.requestRender();
    },
    dispose() {
      stopFrames();
      element.remove();
    },
  };
}
