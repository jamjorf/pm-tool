import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // vite-node 2.x strips `node:` and does not know `sqlite` is a Node builtin,
    // so src/sqlite.ts's import would be resolved as an npm package. Route it to
    // a shim that returns the real builtin (see test/node-sqlite.ts).
    alias: [{ find: /^node:sqlite$/, replacement: fileURLToPath(new URL('./test/node-sqlite.ts', import.meta.url)) }],
  },
  test: { include: ['src/**/*.test.ts'] },
});
