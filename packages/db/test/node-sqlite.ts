// Test-only shim. vite-node 2.x (vitest 2) strips the `node:` prefix and does
// not list `sqlite` among Node's builtins, so under vitest the
// `import { DatabaseSync } from 'node:sqlite'` in src/sqlite.ts is resolved
// as an npm package and fails. vitest.config.ts aliases 'node:sqlite' to this
// file, which hands back the real builtin. Not part of the build (tsconfig
// includes src/ only) and never imported by application code.
import { createRequire } from 'node:module';

type NodeSqlite = typeof import('node:sqlite');
const load = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
const sqlite: NodeSqlite = (load ? load('node:sqlite') : createRequire(import.meta.url)('node:sqlite')) as NodeSqlite;

export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export default sqlite;
