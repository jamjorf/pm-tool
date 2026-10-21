import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'no', 'off', ''].includes(v.toLowerCase())));

const ConfigSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/pmtool'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  APP_SECRET: z.string().min(16).default('change-me-please-32-bytes-minimum-secret'),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:3001'),
  AUTH_MODE: z.enum(['dev', 'magic']).default('dev'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('pm-tool@example.com'),
  EMAIL_INBOUND_DOMAIN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
  /** Run background workers (webhooks, notification deliveries, due_soon). Disabled in tests. */
  WORKERS: bool.default(true),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Load config from env with sane defaults; empty strings are treated as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') cleaned[k] = v;
  return ConfigSchema.parse(cleaned);
}
