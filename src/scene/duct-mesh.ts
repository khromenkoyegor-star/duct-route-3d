/**
 * 3D-повітропровід з розкладання траси (core/duct.ts): одна геометрія на трасу.
 * - прямі ділянки: круглі — труба, прямокутні — короб;
 * - коліна: круглі — сегментні (косо зрізані сегменти, шви видно), прямокутні — радіусні з плоскими боковинами;
 * - переходи: круглі — конус, прямокутні — «піраміда» (концентричні);
 * - торці на початку й у кінці траси закриті.
 * Геометрія будується в мм і масштабується в метри через units.ts.
 */
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import {
  type DuctElbow,
  type DuctLayout,
  type DuctSection,
  elbowArcPoint,
  type Frame,
  roundElbowPolyline,
} from '../core/duct';
import type { P3, PointMm } from '../core/route';
import { mmToM } from '../core/units';

/** Скільки граней по колу в круглої труби. */
const RADIAL = 32;
/** Кроків по дузі радіусного прямокутного коліна. */
const ARC_STEPS = 24;

const add = (a: P3, b: P3): P3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: P3, b: P3): P3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: P3, k: number): P3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: P3, b: P3): P3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: P3): P3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? scale(a, 1 / l) : a;
};

/** Накопичувач трикутників (мм), без індексів: кожен трикутник — свої вершини й нормалі. */
class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];

  private vertex(p: P3, n: P3): void {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
  }

  tri(a: P3, na: P3, b: P3, nb: P3, c: P3, nc: P3): void {
    this.vertex(a, na);
    this.vertex(b, nb);
    this.vertex(c, nc);
  }

  /** Чотирикутник a-b-c-d (по колу) з нормалями в кутах. */
  quad(a: P3, b: P3, c: P3, d: P3, na: P3, nb: P3, nc: P3, nd: P3): void {
    this.tri(a, na, b, nb, c, nc);
    this.tri(a, na, c, nc, d, nd);
  }

  /** Плаский чотирикутник: нормаль — з напрямком `outward`. */
  flatQuad(a: P3, b: P3, c: P3, d: P3, outward: P3): void {
    let n = norm(cross(sub(b, a), sub(d, a)));
    if (dot(n, outward) < 0) n = scale(n, -1);
    this.quad(a, b, c, d, n, n, n, n);
  }

  get triangles(): number {
    return this.positions.length / 9;
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    // мм → м (масштаб сцени); переведення — лише через units.ts.
    const k = mmToM(1);
    geometry.scale(k, k, k);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Точка на колі навколо осі: centre + r·(cos α·e1 + sin α·e2). */
const ring = (centre: P3, e1: P3, e2: P3, r: number, alpha: number): P3 =>
  add(centre, add(scale(e1, r * Math.cos(alpha)), scale(e2, r * Math.sin(alpha))));

/** Кругла труба або конус-перехід від A (радіус r1) до B (r2), без торців. */
function roundFrustum(b: Builder, from: P3, to: P3, r1: number, r2: number, frame: Frame): void {
  const axis = sub(to, from);
  const len = Math.hypot(axis.x, axis.y, axis.z);
  if (!(len > 0)) return;
  const dir = scale(axis, 1 / len);
  // Нахил стінки конуса: нормаль відхиляється до вужчого кінця.
  const tilt = (r1 - r2) / len;
  for (let i = 0; i < RADIAL; i++) {
    const a0 = (i / RADIAL) * Math.PI * 2;
    const a1 = ((i + 1) / RADIAL) * Math.PI * 2;
    const n0 = norm(add(ring({ x: 0, y: 0, z: 0 }, frame.u, frame.v, 1, a0), scale(dir, tilt)));
    const n1 = norm(add(ring({ x: 0, y: 0, z: 0 }, frame.u, frame.v, 1, a1), scale(dir, tilt)));
    b.quad(
      ring(from, frame.u, frame.v, r1, a0),
      ring(from, frame.u, frame.v, r1, a1),
      ring(to, frame.u, frame.v, r2, a1),
      ring(to, frame.u, frame.v, r2, a0),
      n0,
      n1,
      n1,
      n0,
    );
  }
}

/**
 * Сегментне коліно: кожен сегмент — косо зрізаний циліндр між площинами стиків (бісектрисами).
 * У кожного сегмента свої вершини й нормалі — на стиках видно шви, як у справжнього коліна.
 */
function roundElbow(b: Builder, elbow: DuctElbow, r: number): void {
  const pts = roundElbowPolyline(elbow);
  const n = norm(cross(elbow.dirIn, elbow.dirOut));
  const dirs: P3[] = [];
  for (let i = 1; i < pts.length; i++) dirs.push(norm(sub(pts[i]!, pts[i - 1]!)));
  /** Точка кола сегмента i під кутом α, спроєктована вздовж осі сегмента на площину стику в вершині v. */
  const onPlane = (i: number, vertex: P3, planeNormal: P3, alpha: number) => {
    const t = dirs[i]!;
    const m = cross(t, n);
    const offset = add(scale(n, r * Math.cos(alpha)), scale(m, r * Math.sin(alpha)));
    const s = -dot(offset, planeNormal) / dot(t, planeNormal);
    return { p: add(vertex, add(offset, scale(t, s))), normal: norm(offset) };
  };
  for (let i = 0; i < dirs.length; i++) {
    const t = dirs[i]!;
    // Площина стику: на кінцях коліна — перпендикулярно осі, всередині — бісектриса сусідніх сегментів.
    const startN = i === 0 ? t : norm(add(dirs[i - 1]!, t));
    const endN = i === dirs.length - 1 ? t : norm(add(t, dirs[i + 1]!));
    for (let k = 0; k < RADIAL; k++) {
      const a0 = (k / RADIAL) * Math.PI * 2;
      const a1 = ((k + 1) / RADIAL) * Math.PI * 2;
      const s0 = onPlane(i, pts[i]!, startN, a0);
      const s1 = onPlane(i, pts[i]!, startN, a1);
      const e1 = onPlane(i, pts[i + 1]!, endN, a1);
      const e0 = onPlane(i, pts[i + 1]!, endN, a0);
      b.quad(s0.p, s1.p, e1.p, e0.p, s0.normal, s1.normal, e1.normal, e0.normal);
    }
  }
}

/** Розміри прямокутника вздовж рамки: половини ширини (u) і висоти (v). */
const halfSizes = (s: DuctSection, grow: number) =>
  s.shape === 'rect' ? { hu: s.widthMm / 2 + grow, hv: s.heightMm / 2 + grow } : { hu: 0, hv: 0 };

/** Короб або «піраміда»-перехід від A до B: 4 стінки, без торців. */
function rectFrustum(b: Builder, from: P3, to: P3, frame: Frame, s1: DuctSection, s2: DuctSection, grow: number): void {
  const a = halfSizes(s1, grow);
  const c = halfSizes(s2, grow);
  const corner = (p: P3, hu: number, hv: number, su: number, sv: number) =>
    add(p, add(scale(frame.u, su * hu), scale(frame.v, sv * hv)));
  const sides: Array<[number, number, number, number, P3]> = [
    // [su0, sv0, su1, sv1, напрямок назовні]
    [1, -1, 1, 1, frame.u],
    [1, 1, -1, 1, frame.v],
    [-1, 1, -1, -1, scale(frame.u, -1)],
    [-1, -1, 1, -1, scale(frame.v, -1)],
  ];
  for (const [su0, sv0, su1, sv1, out] of sides) {
    b.flatQuad(
      corner(from, a.hu, a.hv, su0, sv0),
      corner(from, a.hu, a.hv, su1, sv1),
      corner(to, c.hu, c.hv, su1, sv1),
      corner(to, c.hu, c.hv, su0, sv0),
      out,
    );
  }
}

/** Радіусне прямокутне коліно: переріз протягнуто по дузі; боковини плоскі, внутрішня й зовнішня стінки — гнуті. */
function rectElbow(b: Builder, elbow: DuctElbow, grow: number): void {
  const s = elbow.section;
  if (s.shape !== 'rect') return;
  // Яка сторона рамки — у площині повороту (дивиться у напрямку виходу).
  const uInPlane = Math.abs(dot(elbow.frameIn.u, elbow.dirOut)) > 0.5;
  const across = uInPlane ? elbow.frameIn.v : elbow.frameIn.u;
  const half = halfSizes(s, grow);
  const hb = uInPlane ? half.hu : half.hv;
  const ha = uInPlane ? half.hv : half.hu;
  // У площині повороту: напрямок до центру дуги W(θ) = dirOut·cos θ − dirIn·sin θ.
  const section = (theta: number) => {
    const c = elbowArcPoint(elbow, theta);
    const w = sub(scale(elbow.dirOut, Math.cos(theta)), scale(elbow.dirIn, Math.sin(theta)));
    return { c, w };
  };
  for (let j = 0; j < ARC_STEPS; j++) {
    const t0 = (j / ARC_STEPS) * (Math.PI / 2);
    const t1 = ((j + 1) / ARC_STEPS) * (Math.PI / 2);
    const A = section(t0);
    const B = section(t1);
    const pt = (sec: { c: P3; w: P3 }, sw: number, sa: number) => add(sec.c, add(scale(sec.w, sw * hb), scale(across, sa * ha)));
    // Внутрішня стінка (до центру) і зовнішня — нормалі вздовж ±W, плавні по дузі.
    b.quad(pt(A, 1, -1), pt(A, 1, 1), pt(B, 1, 1), pt(B, 1, -1), A.w, A.w, B.w, B.w);
    const nA = scale(A.w, -1);
    const nB = scale(B.w, -1);
    b.quad(pt(A, -1, 1), pt(A, -1, -1), pt(B, -1, -1), pt(B, -1, 1), nA, nA, nB, nB);
    // Боковини — плоскі, нормаль ±across.
    const nAcross = across;
    const nBack = scale(across, -1);
    b.quad(pt(A, -1, 1), pt(B, -1, 1), pt(B, 1, 1), pt(A, 1, 1), nAcross, nAcross, nAcross, nAcross);
    b.quad(pt(A, 1, -1), pt(B, 1, -1), pt(B, -1, -1), pt(A, -1, -1), nBack, nBack, nBack, nBack);
  }
}

/** Закритий торець на кінці траси (outward — назовні від труби). */
function cap(b: Builder, at: P3, section: DuctSection, frame: Frame, outward: P3, grow: number): void {
  if (section.shape === 'round') {
    const r = section.diameterMm / 2 + grow;
    for (let i = 0; i < RADIAL; i++) {
      const a0 = (i / RADIAL) * Math.PI * 2;
      const a1 = ((i + 1) / RADIAL) * Math.PI * 2;
      b.tri(at, outward, ring(at, frame.u, frame.v, r, a0), outward, ring(at, frame.u, frame.v, r, a1), outward);
    }
    return;
  }
  const { hu, hv } = halfSizes(section, grow);
  const c = (su: number, sv: number) => add(at, add(scale(frame.u, su * hu), scale(frame.v, sv * hv)));
  b.flatQuad(c(-1, -1), c(1, -1), c(1, 1), c(-1, 1), outward);
}

/** Що будувати: усі деталі траси або лише деталі вибраних відрізків (підсвітка). */
export interface DuctGeometryOptions {
  /** Лише ці відрізки (з колінами на їхніх кінцях і переходом на них). */
  segments?: ReadonlySet<number>;
  /** Наскільки розширити переріз, мм (підсвітка трохи більша за саму трубу). */
  grow?: number;
}

/** Геометрія повітропроводу траси (м сцени). */
export function buildDuctGeometry(nodes: readonly PointMm[], layout: DuctLayout, options: DuctGeometryOptions = {}): BufferGeometry {
  const b = new Builder();
  const grow = options.grow ?? 0;
  const only = options.segments;
  const wanted = (segment: number) => !only || only.has(segment);
  const radius = (s: DuctSection) => (s.shape === 'round' ? s.diameterMm / 2 + grow : 0);

  for (const s of layout.straights) {
    if (!wanted(s.segment)) continue;
    if (s.section.shape === 'round') roundFrustum(b, s.from, s.to, radius(s.section), radius(s.section), s.frame);
    else rectFrustum(b, s.from, s.to, s.frame, s.section, s.section, grow);
  }
  for (const t of layout.transitions) {
    if (!wanted(t.segment)) continue;
    if (t.fromSection.shape === 'round') roundFrustum(b, t.from, t.to, radius(t.fromSection), radius(t.toSection), t.frame);
    else rectFrustum(b, t.from, t.to, t.frame, t.fromSection, t.toSection, grow);
  }
  for (const e of layout.elbows) {
    // Коліно у вузлі k — між відрізками k−1 і k.
    if (!wanted(e.node - 1) && !wanted(e.node)) continue;
    if (e.section.shape === 'round') roundElbow(b, e, radius(e.section));
    else rectElbow(b, e, grow);
  }
  const segs = layout.segments;
  if (segs.length > 0 && !only) {
    const first = segs[0]!;
    const last = segs[segs.length - 1]!;
    // На початку — розмір до переходу на першому відрізку (якщо він там є).
    const startSection = layout.transitions.find((t) => t.segment === 0)?.fromSection ?? first.section;
    cap(b, nodes[0]!, startSection, first.frame, scale(first.dir, -1), grow);
    cap(b, nodes[nodes.length - 1]!, last.section, last.frame, last.dir, grow);
  }
  return b.build();
}

/** Оцинкована сталь: світло-сірий метал з легким відблиском (освітлення — RoomEnvironment у viewer). */
export function createGalvanizedMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color(0xc9ced3),
    metalness: 0.8,
    // Трохи матовіше: у світлій темі верх труби не «вигорає» до білого.
    roughness: 0.45,
    side: DoubleSide,
  });
}

/** Підсвітка поверх труби (вибраний відрізок, закороткий відрізок). */
export function createHighlightMaterial(color: number, opacity = 0.45): Material {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide });
}
