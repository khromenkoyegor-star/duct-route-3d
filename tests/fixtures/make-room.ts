/**
 * Записує тестову кімнату: tests/fixtures/room-4000x2700x3000.glb і .zip («як з Polycam»).
 * Запуск (тільки розробнику): npm run make:room
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildRoomGlb, buildRoomZip, ROOM_FILE_NAME, ROOM_ZIP_FILE_NAME } from './room.ts';

for (const [name, bytes] of [
  [ROOM_FILE_NAME, buildRoomGlb()],
  [ROOM_ZIP_FILE_NAME, buildRoomZip()],
] as const) {
  await writeFile(fileURLToPath(new URL(name, import.meta.url)), bytes);
  console.log(`✓ ${name} (${bytes.byteLength} байт)`);
}
