// Load a .env file from the repo root (or cwd) without a dependency: Node 22 has
// process.loadEnvFile. Existing environment variables win. Silently skipped when absent.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(): void {
  const candidates = [process.env.PM_ENV_FILE, resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')].filter(Boolean) as string[];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore malformed files */
    }
    return;
  }
}
