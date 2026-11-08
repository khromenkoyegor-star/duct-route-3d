import {
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { mmToM } from '../core/units';
import type { SceneTheme } from './theme';

/** Довжина стрілки осі — одна клітинка сітки. */
const AXIS_LENGTH_MM = 1000;
const SHAFT_RADIUS_MM = 18;
const HEAD_RADIUS_MM = 55;
const HEAD_LENGTH_MM = 160;
const LABEL_SIZE_MM = 340;
const LABEL_GAP_MM = 220;

export type AxisName = 'X' | 'Y' | 'Z';

interface AxisParts {
  name: AxisName;
  direction: Vector3;
  material: MeshBasicMaterial;
  label: Sprite;
  labelMaterial: SpriteMaterial;
  labelTexture: CanvasTexture;
}

export interface Axes {
  group: Group;
  /** Точка, де стоїть підпис осі (у метрах сцени) — для тестів і майбутніх підказок. */
  labelPosition(name: AxisName): Vector3;
  setTheme(theme: SceneTheme): void;
  dispose(): void;
}

function axisColor(theme: SceneTheme, name: AxisName): number {
  return name === 'X' ? theme.axisX : name === 'Y' ? theme.axisY : theme.axisZ;
}

/** Кругла «плашка» кольору осі з білою літерою. */
function makeLabelTexture(letter: string, color: number): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 76px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, size / 2, size / 2 + 4);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Три стрілки з початку координат: X — червона, Y — зелена (вгору), Z — синя.
 * Вісь Y — вертикаль, як у glTF і Three.js; нічого не обертаємо.
 */
export function createAxes(theme: SceneTheme): Axes {
  const group = new Group();
  group.name = 'axes';

  const length = mmToM(AXIS_LENGTH_MM);
  const headLength = mmToM(HEAD_LENGTH_MM);
  const shaftLength = length - headLength;

  // Спільні геометрії, побудовані вздовж +Y; для X і Z повертаємо меш.
  const shaftGeometry = new CylinderGeometry(mmToM(SHAFT_RADIUS_MM), mmToM(SHAFT_RADIUS_MM), shaftLength, 16);
  shaftGeometry.translate(0, shaftLength / 2, 0);
  const headGeometry = new ConeGeometry(mmToM(HEAD_RADIUS_MM), headLength, 24);
  headGeometry.translate(0, shaftLength + headLength / 2, 0);

  const directions: Record<AxisName, Vector3> = {
    X: new Vector3(1, 0, 0),
    Y: new Vector3(0, 1, 0),
    Z: new Vector3(0, 0, 1),
  };

  const parts: AxisParts[] = (['X', 'Y', 'Z'] as const).map((name) => {
    const direction = directions[name];
    const material = new MeshBasicMaterial({ color: axisColor(theme, name) });

    const arrow = new Group();
    arrow.name = `axis-${name}`;
    arrow.add(new Mesh(shaftGeometry, material), new Mesh(headGeometry, material));
    // Геометрія дивиться вздовж +Y: X — поворот −90° навколо Z, Z — +90° навколо X.
    if (name === 'X') arrow.rotation.z = -Math.PI / 2;
    if (name === 'Z') arrow.rotation.x = Math.PI / 2;
    group.add(arrow);

    const labelTexture = makeLabelTexture(name, axisColor(theme, name));
    const labelMaterial = new SpriteMaterial({ map: labelTexture, depthTest: false, transparent: true });
    const label = new Sprite(labelMaterial);
    label.name = `axis-label-${name}`;
    label.renderOrder = 10;
    const labelSize = mmToM(LABEL_SIZE_MM);
    label.scale.set(labelSize, labelSize, 1);
    label.position.copy(direction).multiplyScalar(length + mmToM(LABEL_GAP_MM));
    group.add(label);

    return { name, direction, material, label, labelMaterial, labelTexture };
  });

  return {
    group,
    labelPosition(name) {
      const part = parts.find((p) => p.name === name);
      return part ? part.label.getWorldPosition(new Vector3()) : new Vector3();
    },
    setTheme(next) {
      for (const part of parts) {
        const color = axisColor(next, part.name);
        part.material.color.setHex(color);
        part.labelTexture.dispose();
        part.labelTexture = makeLabelTexture(part.name, color);
        part.labelMaterial.map = part.labelTexture;
        part.labelMaterial.needsUpdate = true;
      }
    },
    dispose() {
      shaftGeometry.dispose();
      headGeometry.dispose();
      for (const part of parts) {
        part.material.dispose();
        part.labelMaterial.dispose();
        part.labelTexture.dispose();
      }
      group.clear();
    },
  };
}
