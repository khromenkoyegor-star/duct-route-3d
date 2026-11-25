import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/** Короткий хеш коміту — показується в куті екрана, щоб було видно, що відкрилась свіжа версія. */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // «Траса 3D 2» (нова версія, у ній ведеться вся подальша робота):
  // https://khromenkoyegor-star.github.io/duct-route-3d/next/
  // Стара адреса …/duct-route-3d/ — незмінна стабільна версія 4.1 (див. .github/workflows/ci.yml).
  base: '/duct-route-3d/next/',
  define: {
    __APP_VERSION__: JSON.stringify(gitShortSha()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'safari16',
    chunkSizeWarningLimit: 1000,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
