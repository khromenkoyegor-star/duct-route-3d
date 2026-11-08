import { BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, type Vector3 } from 'three';

/** Лінія рулетки між двома точками: завжди видно поверх скану. */
export interface RulerLine {
  object: Line;
  set(a: Vector3 | null, b: Vector3 | null): void;
  dispose(): void;
}

export function createRulerLine(color = 0xff9f0a): RulerLine {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
  const material = new LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new Line(geometry, material);
  line.name = 'ruler-line';
  line.renderOrder = 20;
  line.frustumCulled = false;
  line.visible = false;

  return {
    object: line,
    set(a, b) {
      if (!a || !b) {
        line.visible = false;
        return;
      }
      const position = geometry.getAttribute('position') as Float32BufferAttribute;
      position.setXYZ(0, a.x, a.y, a.z);
      position.setXYZ(1, b.x, b.y, b.z);
      position.needsUpdate = true;
      geometry.computeBoundingSphere();
      line.visible = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
