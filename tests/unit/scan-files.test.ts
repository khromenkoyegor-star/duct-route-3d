import { describe, expect, it } from 'vitest';
import {
  basename,
  detectScanFileKind,
  dirname,
  externalReferences,
  isJunkPath,
  mimeType,
  normalizePath,
  pickMainModel,
  resolveUri,
  unsupportedRequiredExtensions,
} from '../../src/core/scan-files.ts';
import {
  describeScan,
  formatBytes,
  formatCount,
  formatOffsetY,
  formatSizeMm,
  type ScanStats,
} from '../../src/core/scan-info.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('тип файлу — за вмістом, а не за розширенням', () => {
  it('ZIP, GLB, GLTF', () => {
    expect(detectScanFileKind('scan.zip', bytes(0x50, 0x4b, 0x03, 0x04, 0))).toBe('zip');
    expect(detectScanFileKind('scan', bytes(0x50, 0x4b, 0x03, 0x04))).toBe('zip'); // без розширення
    expect(detectScanFileKind('scan.glb', text('glTF\x02\x00\x00\x00'))).toBe('glb');
    expect(detectScanFileKind('scene.gltf', text('{"asset":{}}'))).toBe('gltf');
    expect(detectScanFileKind('scene.txt', text('﻿  {"asset":{}}'))).toBe('gltf');
  });

  it('не скан', () => {
    expect(detectScanFileKind('photo.jpg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('unknown');
    expect(detectScanFileKind('empty.glb', bytes())).toBe('unknown');
    expect(detectScanFileKind('notes.txt', text('hello'))).toBe('unknown');
  });
});

describe('шляхи в архіві', () => {
  it('normalizePath / dirname / basename', () => {
    expect(normalizePath('./a/./b/../c.bin')).toBe('a/c.bin');
    expect(normalizePath('\\x\\y.png')).toBe('x/y.png');
    expect(normalizePath('/abs/z')).toBe('abs/z');
    expect(dirname('Room/scene.gltf')).toBe('Room');
    expect(dirname('scene.gltf')).toBe('');
    expect(basename('Room/textures/a.jpg')).toBe('a.jpg');
  });

  it('resolveUri: відносно папки моделі, з розкодуванням %20', () => {
    expect(resolveUri('Room', 'textures/my%20tex.jpg')).toBe('Room/textures/my tex.jpg');
    expect(resolveUri('Room/sub', '../scene.bin')).toBe('Room/scene.bin');
    expect(resolveUri('', 'scene.bin')).toBe('scene.bin');
    expect(resolveUri('', 'bad%E0name.bin')).toBe('bad%E0name.bin');
  });

  it('службові файли macOS ігноруються', () => {
    expect(isJunkPath('__MACOSX/Room/._scene.gltf')).toBe(true);
    expect(isJunkPath('Room/._scene.gltf')).toBe(true);
    expect(isJunkPath('Room/.DS_Store')).toBe(true);
    expect(isJunkPath('Room/scene.gltf')).toBe(false);
  });

  it('головна модель: .gltf/.glb, найменш вкладена, не службова', () => {
    expect(
      pickMainModel(['__MACOSX/Room/._scene.gltf', 'Room/', 'Room/scene.bin', 'Room/scene.gltf', 'Room/tex/a.jpg']),
    ).toBe('Room/scene.gltf');
    expect(pickMainModel(['deep/a/b.glb', 'top.GLTF'])).toBe('top.GLTF');
    expect(pickMainModel(['a.jpg', 'b.bin'])).toBeNull();
    expect(pickMainModel([])).toBeNull();
  });
});

describe('посилання glTF', () => {
  it('зовнішні буфери й текстури; data: і http — ні', () => {
    const json = {
      buffers: [{ uri: 'scene.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }, {}],
      images: [{ uri: 'textures/a%20b.jpg' }, { uri: 'https://example.com/x.png' }, { bufferView: 1 }],
    };
    expect(externalReferences(json)).toEqual([
      { kind: 'buffer', index: 0, uri: 'scene.bin' },
      { kind: 'image', index: 0, uri: 'textures/a%20b.jpg' },
    ]);
    expect(externalReferences({})).toEqual([]);
  });

  it('непідтримувані обов\'язкові розширення (Draco)', () => {
    expect(unsupportedRequiredExtensions({ extensionsRequired: ['KHR_draco_mesh_compression'] })).toEqual([
      'KHR_draco_mesh_compression',
    ]);
    expect(unsupportedRequiredExtensions({ extensionsRequired: ['KHR_materials_unlit'] })).toEqual([]);
    expect(unsupportedRequiredExtensions({})).toEqual([]);
  });

  it('MIME за розширенням', () => {
    expect(mimeType('a/b.JPG')).toBe('image/jpeg');
    expect(mimeType('x.png')).toBe('image/png');
    expect(mimeType('x.bin')).toBe('application/octet-stream');
  });
});

describe('інформація про скан', () => {
  const room: ScanStats = {
    min: [-2, 0, -1.5],
    max: [2, 2.7, 1.5],
    triangles: 12,
    fileBytes: 5068,
    textures: 1,
    texturePixels: 64 * 64,
    texturesReduced: 0,
    offsetY: 0,
  };

  it('габарит тестової кімнати — 4000 × 2700 × 3000 мм', () => {
    const info = describeScan(room, 'tablet');
    expect(info.sizeMm.x).toBeCloseTo(4000, 6);
    expect(info.sizeMm.y).toBeCloseTo(2700, 6);
    expect(info.sizeMm.z).toBeCloseTo(3000, 6);
    expect(plain(formatSizeMm(info.sizeMm))).toBe('4 000 × 2 700 × 3 000 мм');
    expect(info.warnings).toEqual([]);
  });

  it('попередження для завеликого скану: на iPhone раніше, ніж на iPad', () => {
    const heavy = { ...room, triangles: 2_000_000 };
    expect(describeScan(heavy, 'phone').warnings.length).toBe(1);
    expect(describeScan(heavy, 'tablet').warnings).toEqual([]);
    const huge = { ...room, triangles: 5_000_000, fileBytes: 200 * 1024 * 1024, texturePixels: 3 * 8192 * 8192 };
    expect(describeScan(huge, 'tablet').warnings.length).toBe(3);
  });

  it('скан 40 МБ на iPad — без попередження про розмір файлу', () => {
    expect(describeScan({ ...room, fileBytes: 40 * 1024 * 1024 }, 'tablet').warnings).toEqual([]);
  });

  it('зменшені текстури й порожній файл — пояснення', () => {
    expect(describeScan({ ...room, texturesReduced: 2 }, 'phone').warnings[0]).toMatch(/Текстури зменшено \(2\)/);
    expect(describeScan({ ...room, triangles: 0 }, 'phone').warnings[0]).toMatch(/немає поверхонь/);
  });

  it('зсув по висоті: у мм, зі знаком, зрозумілим підписом', () => {
    expect(describeScan({ ...room, offsetY: 1.4 }, 'tablet').offsetYMm).toBeCloseTo(1400, 9);
    expect(plain(formatOffsetY(1400))).toBe('Низ скану на Y = 0 · скан піднято на 1 400 мм');
    expect(plain(formatOffsetY(-250.04))).toBe('Низ скану на Y = 0 · скан опущено на 250 мм');
    expect(formatOffsetY(0.2)).toBe('Низ скану на Y = 0');
    expect(formatOffsetY(-0)).toBe('Низ скану на Y = 0');
  });

  it('формати чисел', () => {
    expect(plain(formatCount(1234567))).toBe('1 234 567');
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(850 * 1024)).toBe('850 КБ');
    expect(formatBytes(1.3 * 1024 * 1024)).toBe('1,3 МБ');
    expect(formatBytes(10.5 * 1024 * 1024)).toBe('10,5 МБ');
    expect(formatBytes(40 * 1024 * 1024)).toBe('40 МБ');
  });
});
