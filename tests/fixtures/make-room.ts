/**
 * Записує тестову кімнату у tests/fixtures/room-4000x2700x3000.glb.
 * Запуск (тільки розробнику): npm run make:room
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildRoomGlb, ROOM_FILE_NAME } from './room.ts';

const path = fileURLToPath(new URL(ROOM_FILE_NAME, import.meta.url));
const bytes = buildRoomGlb();
await writeFile(path, bytes);
console.log(`✓ ${ROOM_FILE_NAME} (${bytes.byteLength} байт)`);
