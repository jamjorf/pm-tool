import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEST_DB = process.env.TEST_DB_NAME ?? 'pmtool_api_test';
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const MIGRATION = path.resolve(here, '../../db/migrations/0001_init.sql');

const psql = (url: string, args: string[]) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

/** Drop + recreate the test database and apply the migration once per vitest run. */
export default async function setup() {
  psql(ADMIN_URL, ['-c', `drop database if exists ${TEST_DB} with (force)`]);
  psql(ADMIN_URL, ['-c', `create database ${TEST_DB}`]);
  psql(ADMIN_URL.replace(/\/postgres$/, `/${TEST_DB}`), ['-f', MIGRATION]);
}
