import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Box3, type Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRoomGlb, ROOM_FILE_NAME, ROOM_SIZE_MM } from '../fixtures/room.ts';

const fixturePath = fileURLToPath(new URL(`../fixtures/${ROOM_FILE_NAME}`, import.meta.url));
/** Допуск координат: ±0,1 мм. */
const TOL_M = 0.0001;

let fileBytes: Uint8Array;

beforeAll(async () => {
  fileBytes = new Uint8Array(await readFile(fixturePath));
});

describe('тестова кімната .glb', () => {
  it('файл у репозиторії збігається з генератором (інакше: npm run make:room)', () => {
    expect(Buffer.from(fileBytes).equals(Buffer.from(buildRoomGlb()))).toBe(true);
  });

  it('валідний заголовок GLB 2.0', () => {
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(fileBytes.byteLength);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a); // перший чанк — JSON
  });

  describe('після завантаження через GLTFLoader (як у додатку)', () => {
    let meshes: Mesh[];
    let box: Box3;

    beforeAll(async () => {
      const buffer = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
      const gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, '');
      meshes = [];
      gltf.scene.traverse((object) => {
        if ((object as Mesh).isMesh) meshes.push(object as Mesh);
      });
      box = new Box3().setFromObject(gltf.scene);
    });

    it('габарит 4000 × 2700 × 3000 мм (±0,1 мм), масштаб 1 одиниця = 1 м', () => {
      const size = box.getSize(new Vector3());
      expect(Math.abs(size.x - ROOM_SIZE_MM.x / 1000)).toBeLessThan(TOL_M);
      expect(Math.abs(size.y - ROOM_SIZE_MM.y / 1000)).toBeLessThan(TOL_M);
      expect(Math.abs(size.z - ROOM_SIZE_MM.z / 1000)).toBeLessThan(TOL_M);
    });

    it('підлога на Y = 0, кімната по центру в XZ', () => {
      expect(Math.abs(box.min.y)).toBeLessThan(TOL_M);
      const center = box.getCenter(new Vector3());
      expect(Math.abs(center.x)).toBeLessThan(TOL_M);
      expect(Math.abs(center.z)).toBeLessThan(TOL_M);
    });

    it('6 поверхонь: підлога, стеля, 4 стіни', () => {
      expect(meshes.map((m) => m.name).sort()).toEqual(
        ['ceiling', 'floor', 'wall-x-minus', 'wall-x-plus', 'wall-z-minus', 'wall-z-plus'].sort(),
      );
    });

    it('кожна поверхня дивиться всередину кімнати (нормалі й порядок обходу)', () => {
      const roomCenter = box.getCenter(new Vector3());
      for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute('position');
        const normal = mesh.geometry.getAttribute('normal');
        const index = mesh.geometry.getIndex();
        expect(index, mesh.name).not.toBeNull();
        const at = (i: number) => new Vector3().fromBufferAttribute(position, i);
        const a = at(index!.getX(0));
        const b = at(index!.getX(1));
        const c = at(index!.getX(2));
        // Нормаль з порядку обходу (лицьова сторона)
        const faceNormal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
        const storedNormal = new Vector3().fromBufferAttribute(normal, 0);
        const toCenter = new Vector3().subVectors(roomCenter, a);
        expect(faceNormal.dot(storedNormal), mesh.name).toBeCloseTo(1, 6);
        expect(faceNormal.dot(toCenter), mesh.name).toBeGreaterThan(0);
      }
    });

    it('протилежні стіни: 4000 мм по X і 3000 мм по Z (для «Рулетки» етапу 1)', () => {
      const wallBox = (name: string) => new Box3().setFromObject(meshes.find((m) => m.name === name)!);
      const xMinus = wallBox('wall-x-minus');
      const xPlus = wallBox('wall-x-plus');
      const zMinus = wallBox('wall-z-minus');
      const zPlus = wallBox('wall-z-plus');
      expect(Math.abs(xPlus.min.x - xMinus.max.x - 4)).toBeLessThan(TOL_M);
      expect(Math.abs(zPlus.min.z - zMinus.max.z - 3)).toBeLessThan(TOL_M);
    });
  });
});
