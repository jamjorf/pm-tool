// ============================================================================
// Seed: a realistic finance-firm dataset for local development and demos.
//   pnpm --filter @pm/db seed [--force]
// Idempotent: skips when any user exists unless --force (which wipes data
// tables first, including the append-only activity log, by temporarily
// disabling its guard triggers — development only).
// ============================================================================
import type { TransactionSql } from 'postgres';
import { connect, hasFlag, isMain, type Sql } from './client.js';

const uuid = () => crypto.randomUUID();
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Static catalogue
// ---------------------------------------------------------------------------
export const SEED_USERS = [
  { key: 'alice', email: 'alice@firm.com', name: 'Alice Chen', firm_role: 'owner' },
  { key: 'bob', email: 'bob@firm.com', name: 'Bob Okafor', firm_role: 'admin' },
  { key: 'carol', email: 'carol@firm.com', name: 'Carol Nakamura', firm_role: 'member' },
  { key: 'dan', email: 'dan@firm.com', name: 'Dan Whitfield', firm_role: 'member' },
  { key: 'eve', email: 'eve@firm.com', name: 'Eve Lindqvist', firm_role: 'member' },
  { key: 'frank', email: 'frank@firm.com', name: 'Frank Moreau', firm_role: 'member' },
  { key: 'grace', email: 'grace@firm.com', name: 'Grace Patel', firm_role: 'member' },
  { key: 'hugo', email: 'hugo@firm.com', name: 'Hugo Schmidt', firm_role: 'member' },
  { key: 'agent', email: 'agent@firm.com', name: 'PM Agent', firm_role: 'member', is_service: true },
] as const;
type UserKey = (typeof SEED_USERS)[number]['key'];

const TEAMS = [
  { key: 'RATES', name: 'Rates Technology', description: 'Pricing, risk and booking for the rates desk', members: ['carol', 'dan', 'eve'] as UserKey[], lead: 'carol' as UserKey },
  { key: 'EQD', name: 'Equity Derivatives Technology', description: 'Exotics pricing and hedging tools', members: ['dan', 'frank', 'eve'] as UserKey[], lead: 'dan' as UserKey },
  { key: 'OPS', name: 'Operations', description: 'Settlements, onboarding and controls', members: ['grace', 'hugo', 'frank'] as UserKey[], lead: 'grace' as UserKey },
];

const FIRM_LABELS = ['regulatory', 'tech-debt', 'quick-win'];

type TypeKey = 'task' | 'bug' | 'initiative' | 'request';
interface ItemSeed {
  type: TypeKey;
  title: string;
  state: string;             // state key within the type's workflow
  priority?: number;         // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  assignee?: UserKey | null;
  reporter?: UserKey;
  due?: number | null;       // days from today
  start?: number | null;     // days from today
  estimate?: number | null;
  fields?: Record<string, unknown>;
  labels?: string[];
  description?: string;
  confidential?: boolean;
  children?: ItemSeed[];
  /** titles of items this one blocks */
  blocks?: string[];
  /** title of the item this one duplicates */
  duplicates?: string;
  /** external GitHub PR link */
  pr?: { repo: string; number: number; title: string };
}
interface ProjectSeed {
  key: string; name: string; description: string; visibility: 'firm' | 'private'; lead: UserKey; team: string;
  members?: { user: UserKey; role: 'admin' | 'editor' | 'viewer' }[];
  labels: string[];
  items: ItemSeed[];
}

const bug = (title: string, state: string, severity: 's1' | 's2' | 's3' | 's4', env: 'prod' | 'uat' | 'dev', extra: Partial<ItemSeed> = {}): ItemSeed => ({
  type: 'bug', title, state, priority: Number(severity[1]), fields: { severity, environment: env, steps: extra.description ? undefined : `1. Open the ${title.split(' ')[0]!.toLowerCase()} screen\n2. Trigger the condition\n3. Observe the wrong result` }, ...extra,
});
const task = (title: string, state: string, extra: Partial<ItemSeed> = {}): ItemSeed => ({ type: 'task', title, state, priority: 3, ...extra });
const request = (title: string, state: string, desk: string, urgency: 'today' | 'this_week' | 'whenever', approved: boolean, extra: Partial<ItemSeed> = {}): ItemSeed =>
  ({ type: 'request', title, state, priority: 3, estimate: 1, fields: { requester_desk: desk, urgency, approved }, ...extra });
const initiative = (title: string, state: string, desk: string, budget: number, quarter: '2026Q4' | '2027Q1' | '2027Q2', business_case: string, extra: Partial<ItemSeed>): ItemSeed =>
  ({ type: 'initiative', title, state, priority: 2, fields: { owner_desk: desk, budget, quarter, business_case }, estimate: null, ...extra });

export const SEED_PROJECTS: ProjectSeed[] = [
  {
    key: 'RATES', name: 'Rates Desk Platform', description: 'Pricing, risk and booking tooling for the interest-rate swaps desk.', visibility: 'firm', lead: 'carol', team: 'RATES',
    labels: ['sofr', 'pricing'],
    items: [
      initiative('SOFR transition: retire LIBOR curve dependencies', 'in_progress', 'Rates', 250_000, '2026Q4',
        'USD LIBOR is gone; every pricer and curve still carrying a LIBOR fallback is a regulatory finding waiting to happen.',
        { assignee: 'carol', start: -40, due: 45, labels: ['regulatory', 'sofr'], description: 'Tracks everything required to remove the last LIBOR dependencies from the rates stack before year end.',
          children: [
            task('Replace LIBOR fallback in swap pricer', 'in_progress', { assignee: 'carol', due: 3, estimate: 5, labels: ['sofr', 'pricing'], blocks: ['Decommission USD-LIBOR curve bootstrapper'], pr: { repo: 'firm/rates-platform', number: 412, title: 'pricer: SOFR fallback spreads per ISDA protocol' }, description: 'Apply the ISDA fallback spread adjustment and remove the hard-coded LIBOR tenor map.' }),
            task('Backfill SOFR fixings 2019-2024', 'done', { assignee: 'eve', due: -20, estimate: 3, labels: ['sofr'] }),
            bug('Swaption vol surface fails to calibrate on holiday dates', 'todo', 's1', 'prod', { assignee: 'dan', due: -2, estimate: 2, labels: ['pricing'], description: 'Calibration throws when the holiday calendar returns no fixings for the valuation date. Started after the SOFR calendar switch.' }),
            task('Decommission USD-LIBOR curve bootstrapper', 'backlog', { assignee: null, due: 40, estimate: 8, labels: ['tech-debt', 'sofr'], priority: 4 }),
          ] }),
      initiative('Intraday risk: sub-minute DV01 for the swaps book', 'in_progress', 'Rates', 180_000, '2027Q1',
        'Traders hedge off a 15-minute-old risk ladder; a streaming DV01 cuts hedge slippage on the swaps book.',
        { assignee: 'dan', start: -25, due: 90, labels: ['pricing'],
          children: [
            task('Stream trade events to the risk engine', 'in_review', { assignee: 'dan', due: 1, estimate: 5, blocks: ['Risk dashboard: add curve-shift scenarios'] }),
            task('Vectorise bucketed DV01 computation', 'in_progress', { assignee: 'eve', due: 6, estimate: 8, labels: ['pricing'] }),
            bug('DV01 ladder double-counts cleared trades', 'in_progress', 's2', 'uat', { assignee: 'dan', due: -1, estimate: 3 }),
            task('Risk dashboard: add curve-shift scenarios', 'todo', { assignee: 'carol', due: 21, estimate: 5, priority: 4 }),
          ] }),
      bug('Repo blotter shows stale haircuts after EOD roll', 'todo', 's3', 'uat', { assignee: 'eve', due: 5, estimate: 2 }),
      task('Nightly P&L explain: attribute carry and roll-down', 'done', { assignee: 'carol', due: -30, estimate: 5, labels: ['pricing'] }),
      task('Add OIS discounting toggle to curve builder', 'backlog', { assignee: null, due: null, estimate: 3, labels: ['pricing', 'quick-win'], priority: 4 }),
      request('Access to swaps blotter for new joiner', 'done', 'Rates', 'this_week', true, { assignee: 'eve', due: -12 }),
      request('Export daily curve snapshot to CSV', 'todo', 'Rates', 'whenever', false, { assignee: 'carol', due: 10 }),
      bug('Bond futures CTD switch not reflected in hedge ratios', 'in_review', 's2', 'prod', { assignee: 'carol', due: -3, estimate: 3, labels: ['pricing'] }),
      task('Migrate curve marking spreadsheet to the platform', 'canceled', { assignee: 'eve', due: -15, estimate: 8, labels: ['tech-debt'] }),
      task('Curve builder: support turn-of-year jumps', 'todo', { assignee: 'alice', due: 14, estimate: 3, labels: ['pricing'] }),
      bug('Swap pricer rounds fixed leg accruals incorrectly', 'todo', 's2', 'uat', { assignee: 'carol', due: 2, estimate: 1, labels: ['pricing', 'quick-win'] }),
    ],
  },
  {
    key: 'EQD', name: 'Equity Derivs Tooling', description: 'Exotics pricing, hedging and surface services for the equity derivatives desk.', visibility: 'firm', lead: 'dan', team: 'EQD',
    labels: ['vol', 'greeks'],
    items: [
      initiative('Autocall pricing engine v2', 'in_progress', 'EQD', 400_000, '2027Q1',
        'The current autocall pricer cannot handle worst-of baskets with memory coupons; the desk prices those by hand.',
        { assignee: 'dan', start: -30, due: 75, labels: ['vol'],
          children: [
            task('Implement local-vol Monte Carlo pricer', 'in_progress', { assignee: 'frank', due: 4, estimate: 13, labels: ['vol'], blocks: ['Model validation pack for autocall v2'] }),
            task('Calibrate dividend curve from listed options', 'todo', { assignee: 'eve', due: 12, estimate: 5 }),
            bug('Barrier monitoring uses wrong fixing calendar for Nikkei', 'in_progress', 's1', 'prod', { assignee: 'dan', due: -1, estimate: 2, labels: ['regulatory'], description: 'Knock-in checks on JPY underlyings use the LSE calendar, so Tokyo holidays are treated as fixing dates.' }),
            task('Greeks aggregation per underlying', 'done', { assignee: 'frank', due: -8, estimate: 5, labels: ['greeks'] }),
            task('Model validation pack for autocall v2', 'backlog', { assignee: null, due: 60, estimate: 8, labels: ['regulatory'], priority: 4 }),
          ] }),
      initiative('Vol surface service consolidation', 'todo', 'EQD', 90_000, '2027Q2',
        'Three desks run three surface builders with subtly different arbitrage checks; one service, one set of marks.',
        { assignee: 'frank', start: 10, due: 120, labels: ['tech-debt', 'vol'],
          children: [
            task('Unify SVI parametrisation across desks', 'todo', { assignee: 'frank', due: 25, estimate: 8, labels: ['vol'] }),
            task('Retire legacy surface cache', 'backlog', { assignee: null, due: null, estimate: 3, labels: ['tech-debt'], priority: 4 }),
            bug('Surface arbitrage check flags valid butterflies', 'todo', 's3', 'uat', { assignee: 'eve', due: 7, estimate: 2, labels: ['vol'] }),
          ] }),
      bug('Delta hedger sends duplicate orders on reconnect', 'in_review', 's1', 'prod', { assignee: 'dan', due: -4, estimate: 3, labels: ['greeks'], pr: { repo: 'firm/eqd-tooling', number: 88, title: 'hedger: idempotent order replay after reconnect' }, description: 'After a FIX session drop the hedger replays its working orders without checking acks, doubling the hedge.' }),
      task('Exotics blotter: show knock-in status', 'in_progress', { assignee: 'frank', due: 5, estimate: 3, labels: ['quick-win'] }),
      request('New Bloomberg entitlement for EQD quant', 'doing', 'EQD', 'this_week', true, { assignee: 'hugo', due: 2 }),
      task('Dividend forecast loader for STOXX names', 'done', { assignee: 'eve', due: -18, estimate: 5 }),
      task('Var swap replication tool', 'canceled', { assignee: 'frank', due: -5, estimate: 8, labels: ['vol'] }),
      task('Vol surface explorer UI', 'backlog', { assignee: null, due: null, estimate: 5, labels: ['vol'], priority: 4 }),
      request('Access to EQD risk reports for audit', 'todo', 'Internal Audit', 'today', false, { assignee: 'alice', due: 0, labels: ['regulatory'], priority: 2 }),
    ],
  },
  {
    key: 'ONB', name: 'Client Onboarding', description: 'KYC, account opening and client lifecycle work. Private: contains client-identifying details.', visibility: 'private', lead: 'grace', team: 'OPS',
    members: [{ user: 'grace', role: 'admin' }, { user: 'hugo', role: 'editor' }, { user: 'eve', role: 'viewer' }],
    labels: ['kyc'],
    items: [
      initiative('KYC refresh automation', 'in_progress', 'Onboarding', 120_000, '2026Q4',
        'Periodic KYC reviews are tracked in spreadsheets; automating screening and evidence collection removes a recurring audit finding.',
        { assignee: 'grace', start: -20, due: 50, labels: ['regulatory', 'kyc'],
          children: [
            task('Integrate screening provider API', 'in_progress', { assignee: 'hugo', due: 3, estimate: 8, labels: ['kyc'], blocks: ['Periodic review scheduler'] }),
            task('Periodic review scheduler', 'todo', { assignee: 'grace', due: 20, estimate: 5, labels: ['kyc'] }),
            task('Document evidence vault', 'backlog', { assignee: null, due: null, estimate: 8, priority: 4 }),
            bug('PEP match false positives on common names', 'todo', 's2', 'prod', { assignee: 'hugo', due: -6, estimate: 3, labels: ['kyc', 'regulatory'] }),
          ] }),
      request('Onboard new prime broker entity', 'todo', 'Prime Services', 'today', false, { assignee: 'grace', due: 1, priority: 1, confidential: true, description: 'Legal entity details are in the shared drive; do not paste them here.' }),
      request('Update client classification for MiFID', 'done', 'Compliance', 'this_week', true, { assignee: 'hugo', due: -9, labels: ['regulatory'] }),
      task('Onboarding checklist v3', 'done', { assignee: 'grace', due: -14, estimate: 3, labels: ['quick-win'] }),
      task('Client portal welcome pack', 'backlog', { assignee: null, due: null, estimate: 2, priority: 4 }),
    ],
  },
  {
    key: 'OPS', name: 'Operations Backlog', description: 'Settlements, reconciliations and controls across the operations team.', visibility: 'firm', lead: 'frank', team: 'OPS',
    labels: ['runbook'],
    items: [
      initiative('Settlement fails reduction', 'in_progress', 'Operations', 80_000, '2027Q1',
        'Fails cost us CSDR penalties every month; tagging root causes and chasing earlier halves the bill.',
        { assignee: 'frank', start: -15, due: 60, labels: ['regulatory'],
          children: [
            task('Fails dashboard with root-cause tagging', 'in_progress', { assignee: 'grace', due: 4, estimate: 5 }),
            task('Auto-chase counterparties on T+1 fails', 'todo', { assignee: 'hugo', due: 15, estimate: 5 }),
            bug('SSI mismatch not flagged for new accounts', 'todo', 's2', 'prod', { assignee: 'frank', due: -2, estimate: 2 }),
            task('Weekly fails report to desk heads', 'done', { assignee: 'grace', due: -7, estimate: 2, labels: ['quick-win'] }),
          ] }),
      task('Rotate SFTP keys for custodian feeds', 'todo', { assignee: 'hugo', due: 6, estimate: 1, labels: ['runbook'] }),
      task('Runbook: EOD batch restart procedure', 'done', { assignee: 'frank', due: -25, estimate: 2, labels: ['runbook'] }),
      bug('Reconciliation breaks on multi-leg trades', 'backlog', 's3', 'uat', { assignee: null, due: 30, estimate: 3 }),
      request('Laptop for new ops analyst', 'done', 'Operations', 'this_week', true, { assignee: 'hugo', due: -11 }),
      request('Extra storage for trade archive', 'canceled', 'Operations', 'whenever', false, { assignee: 'frank', due: -3, duplicates: 'Archive 2019 trade files to cold storage' }),
      task('Archive 2019 trade files to cold storage', 'backlog', { assignee: null, due: null, estimate: 3, labels: ['tech-debt'], priority: 4 }),
      task('Audit log retention policy', 'in_review', { assignee: 'alice', due: -1, estimate: 2, labels: ['regulatory'] }),
      task('Onboard new custodian feed (HSBC)', 'in_progress', { assignee: 'hugo', due: 8, estimate: 5, labels: ['runbook'] }),
      task('Reduce manual touch on corporate actions', 'backlog', { assignee: null, due: null, estimate: 8, priority: 4 }),
      bug('EOD batch alert emails sent twice', 'done', 's4', 'prod', { assignee: 'frank', due: -16, estimate: 1, labels: ['quick-win'] }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
export interface SeedSummary {
  users: number; teams: number; projects: number; labels: number; work_items: number; relations: number;
  comments: number; watchers: number; activity_events: number; views: number; notification_preferences: number;
  webhook_endpoints: number; integration_configs: number;
}

export interface SeedOptions {
  force?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFrom = (now: Date, n: number) => ymd(new Date(now.getTime() + n * DAY));

/** Wipe every data table (dev only). activity_events is append-only, so its guard triggers are disabled for the truncate. */
async function wipe(tx: TransactionSql): Promise<void> {
  await tx.unsafe(`
    alter table activity_events disable trigger activity_events_append_only;
    alter table activity_events disable trigger activity_events_no_truncate;
    truncate activity_events, webhook_deliveries, notification_deliveries, inbound_events, sync_clients, sync_client_groups cascade;
    alter table activity_events enable trigger activity_events_append_only;
    alter table activity_events enable trigger activity_events_no_truncate;
    truncate users, teams, projects, labels, views, webhook_endpoints, integration_configs cascade;
  `);
}

export async function seed(sql: Sql, opts: SeedOptions = {}): Promise<SeedSummary | null> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(42)`;
    const [row] = await tx<{ n: number }[]>`select count(*)::int as n from users`;
    const n = row?.n ?? 0;
    if (n > 0) {
      if (!opts.force) { log(`seed: ${n} users already present; skipping (use --force to reseed)`); return null; }
      await wipe(tx);
      log('seed: existing data wiped (--force)');
    }

    // --- users ---------------------------------------------------------------
    const users: Record<UserKey, string> = {} as Record<UserKey, string>;
    for (const u of SEED_USERS) {
      users[u.key] = uuid();
      await tx`insert into users (id, email, name, firm_role, is_service, avatar_url) values
        (${users[u.key]}, ${u.email}, ${u.name}, ${u.firm_role}::text::firm_role, ${'is_service' in u && u.is_service}, ${`https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(u.name)}`})`;
    }

    // --- teams ---------------------------------------------------------------
    const teams: Record<string, string> = {};
    for (const t of TEAMS) {
      teams[t.key] = uuid();
      await tx`insert into teams (id, key, name, description) values (${teams[t.key]!}, ${t.key}, ${t.name}, ${t.description})`;
      for (const m of t.members) await tx`insert into team_members (team_id, user_id, is_lead) values (${teams[t.key]!}, ${users[m]}, ${m === t.lead})`;
    }

    // --- workflows / types ---------------------------------------------------
    const types = await tx<{ id: string; key: TypeKey; workflow_id: string }[]>`select id, key, workflow_id from item_types where deleted_at is null`;
    const states = await tx<{ id: string; workflow_id: string; key: string; category: string; is_initial: boolean }[]>`select id, workflow_id, key, category, is_initial from workflow_states where deleted_at is null`;
    const typeByKey = Object.fromEntries(types.map((t) => [t.key, t])) as Record<TypeKey, (typeof types)[number]>;
    const stateOf = (type: TypeKey, key: string) => {
      const s = states.find((x) => x.workflow_id === typeByKey[type].workflow_id && x.key === key);
      if (!s) throw new Error(`seed: no state "${key}" in workflow of type ${type}`);
      return s;
    };
    const initialOf = (type: TypeKey) => states.find((x) => x.workflow_id === typeByKey[type].workflow_id && x.is_initial)!;

    // --- labels --------------------------------------------------------------
    const firmLabels: Record<string, string> = {};
    for (const name of FIRM_LABELS) {
      firmLabels[name] = uuid();
      await tx`insert into labels (id, project_id, name, color) values (${firmLabels[name]!}, null, ${name}, ${LABEL_COLORS[name] ?? '#6b7280'})`;
    }
    let labelCount = FIRM_LABELS.length;

    // --- projects + items ----------------------------------------------------
    const counts = { items: 0, relations: 0, comments: 0, watchers: 0, events: 0, views: 0 };
    const itemIdByTitle = new Map<string, string>();
    type Inserted = { id: string; key: string; title: string; type: TypeKey; project: string; projectKey: string; seed: ItemSeed; reporter: UserKey; assignee: UserKey | null; createdAt: Date; stateId: string; stateKey: string; category: string; completedAt: Date | null };
    const inserted: Inserted[] = [];
    const projectIds: Record<string, string> = {};
    let seq = 0;

    const insertItem = async (p: ProjectSeed, s: ItemSeed, parent: Inserted | null): Promise<Inserted> => {
      const i = seq++;
      const id = uuid();
      const type = typeByKey[s.type];
      const state = stateOf(s.type, s.state);
      const reporter: UserKey = s.reporter ?? (i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : p.lead);
      const assignee = s.assignee === undefined ? p.lead : s.assignee;
      const createdAt = new Date(now.getTime() - (5 + ((i * 7) % 55)) * DAY - (i % 24) * 3_600_000 - i * 1000);
      const updatedAt = new Date(Math.min(now.getTime() - (i % 5) * 3_600_000, createdAt.getTime() + ((i * 3) % 20 + 1) * DAY));
      const completedAt = state.category === 'done' ? new Date(Math.max(createdAt.getTime() + DAY, now.getTime() - ((i * 5) % 28) * DAY - i * 60_000)) : null;
      const canceledAt = state.category === 'canceled' ? new Date(now.getTime() - ((i * 4) % 14) * DAY) : null;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.fields ?? {})) if (v !== undefined) fields[k] = v;
      const description = s.description ?? (s.type === 'initiative' ? String((s.fields ?? {}).business_case ?? '') : '');
      await tx`insert into work_items (id, project_id, type_id, title, description, state_id, priority, assignee_id, reporter_id, created_by,
          start_date, due_date, estimate, fields, confidential, sort_order, created_at, updated_at, completed_at, canceled_at)
        values (${id}, ${projectIds[p.key]!}, ${type.id}, ${s.title}, ${description}, ${state.id}, ${s.priority ?? 3},
          ${assignee ? users[assignee] : null}, ${users[reporter]}, ${users[reporter]},
          ${s.start === undefined || s.start === null ? null : daysFrom(now, s.start)}, ${s.due === undefined || s.due === null ? null : daysFrom(now, s.due)},
          ${s.estimate === undefined ? (s.type === 'initiative' ? null : 3) : s.estimate}, ${tx.json(fields as never)}, ${s.confidential ?? false}, ${(i * 37) % 11},
          ${createdAt}, ${updatedAt}, ${completedAt}, ${canceledAt})`;
      const [row] = await tx<{ key: string }[]>`select key from work_items where id = ${id}`;
      const rec: Inserted = { id, key: row!.key, title: s.title, type: s.type, project: projectIds[p.key]!, projectKey: p.key, seed: s, reporter, assignee, createdAt, stateId: state.id, stateKey: state.key, category: state.category, completedAt };
      inserted.push(rec);
      itemIdByTitle.set(s.title, id);
      counts.items++;
      for (const name of s.labels ?? []) {
        const labelId = firmLabels[name] ?? projectLabels[p.key]?.[name];
        if (!labelId) throw new Error(`seed: unknown label ${name} for ${p.key}`);
        await tx`insert into work_item_labels (item_id, label_id) values (${id}, ${labelId})`;
      }
      if (parent) {
        await tx`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uuid()}, 'parent_of', ${parent.id}, ${id}, ${users[reporter]})`;
        counts.relations++;
      }
      for (const c of s.children ?? []) await insertItem(p, c, rec);
      return rec;
    };

    const projectLabels: Record<string, Record<string, string>> = {};
    for (const p of SEED_PROJECTS) {
      projectIds[p.key] = uuid();
      await tx`insert into projects (id, key, name, description, status, visibility, lead_id, team_id, start_date, target_date, default_type_id) values
        (${projectIds[p.key]!}, ${p.key}, ${p.name}, ${p.description}, 'active', ${p.visibility}::text::project_visibility, ${users[p.lead]}, ${teams[p.team]!},
         ${daysFrom(now, -90)}, ${daysFrom(now, 120)}, ${typeByKey.task.id})`;
      for (const m of p.members ?? []) await tx`insert into project_members (project_id, user_id, role) values (${projectIds[p.key]!}, ${users[m.user]}, ${m.role}::text::project_role)`;
      projectLabels[p.key] = {};
      for (const name of p.labels) {
        const id = uuid();
        projectLabels[p.key]![name] = id;
        await tx`insert into labels (id, project_id, name, color) values (${id}, ${projectIds[p.key]!}, ${name}, ${LABEL_COLORS[name] ?? '#0ea5e9'})`;
        labelCount++;
      }
      for (const s of p.items) await insertItem(p, s, null);
    }

    // --- relations: blocks / duplicates / external links ---------------------
    const idOf = (title: string) => { const id = itemIdByTitle.get(title); if (!id) throw new Error(`seed: unknown item title "${title}"`); return id; };
    for (const it of inserted) {
      for (const t of it.seed.blocks ?? []) {
        await tx`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uuid()}, 'blocks', ${it.id}, ${idOf(t)}, ${users[it.reporter]})`;
        counts.relations++;
      }
      if (it.seed.duplicates) {
        await tx`insert into relations (id, type, from_item_id, to_item_id, created_by) values (${uuid()}, 'duplicates', ${it.id}, ${idOf(it.seed.duplicates)}, ${users[it.reporter]})`;
        counts.relations++;
      }
      if (it.seed.pr) {
        const pr = it.seed.pr;
        const ref = { id: `${pr.repo}#${pr.number}`, url: `https://github.com/${pr.repo}/pull/${pr.number}`, repo: pr.repo, number: pr.number, title: pr.title, state: 'open' };
        await tx`insert into relations (id, type, from_item_id, external_kind, external_ref, created_by) values (${uuid()}, 'links_to', ${it.id}, 'github_pr', ${tx.json(ref)}, ${users[it.reporter]})`;
        counts.relations++;
      }
    }

    // --- comments (markdown; mentions as @[Name](user:<uuid>)) ---------------
    const mention = (k: UserKey) => `@[${SEED_USERS.find((u) => u.key === k)!.name}](user:${users[k]})`;
    const commentSeeds: { title: string; author: UserKey; body: string; reply?: { author: UserKey; body: string } }[] = [
      { title: 'Replace LIBOR fallback in swap pricer', author: 'carol', body: `PR is up (firm/rates-platform#412). ${mention('dan')} can you review the fallback spread logic before we cut the UAT build?`, reply: { author: 'dan', body: 'Looking now. USD spreads match the ISDA table; checking the GBP SONIA tenor map next.' } },
      { title: 'Swaption vol surface fails to calibrate on holiday dates', author: 'dan', body: 'Reproduced on prod at 07:15 London: the calendar returns no fixings for 2026-10-12 (Columbus Day) and the calibrator throws instead of rolling to the previous business day.' },
      { title: 'DV01 ladder double-counts cleared trades', author: 'eve', body: 'Root cause: cleared trades appear both as the original and the novated leg in the position feed. Filtering on `clearing_status = novated` fixes the ladder in UAT.' },
      { title: 'Barrier monitoring uses wrong fixing calendar for Nikkei', author: 'dan', body: 'Compliance flagged this in the quarterly model review; needs to be fixed before the next Nikkei autocall observation date.' },
      { title: 'Delta hedger sends duplicate orders on reconnect', author: 'frank', body: 'Order ids are now derived from (session, seq) so replays are idempotent. Soak test running overnight.' },
      { title: 'Integrate screening provider API', author: 'hugo', body: 'Sandbox credentials received. Rate limit is 10 req/s, which is fine for the nightly batch but not for interactive screening.' },
      { title: 'Onboard new prime broker entity', author: 'grace', body: 'Legal pack is complete; waiting on the signed ISDA before we can open the accounts.' },
      { title: 'Fails dashboard with root-cause tagging', author: 'grace', body: 'First cut of the root-cause taxonomy: SSI, inventory, counterparty, late allocation, other.' },
      { title: 'Autocall pricing engine v2', author: 'alice', body: 'Steering committee approved the budget increase. Please keep the validation pack on the critical path.' },
      { title: 'SOFR transition: retire LIBOR curve dependencies', author: 'bob', body: 'Reminder: the regulator wants a written attestation by quarter end. Link the evidence to this initiative.' },
      { title: 'Audit log retention policy', author: 'frank', body: 'Draft policy says 7 years for trade-related events, 2 years for everything else. Comments welcome.' },
    ];
    const commentEvents: { id: string; itemId: string; author: UserKey; at: Date }[] = [];
    for (const [i, c] of commentSeeds.entries()) {
      const it = inserted.find((x) => x.title === c.title)!;
      const at = new Date(Math.min(now.getTime() - (i + 1) * 3_600_000 * 5, it.createdAt.getTime() + 2 * DAY));
      const createdAt = at < it.createdAt ? new Date(it.createdAt.getTime() + 3_600_000) : at;
      const id = uuid();
      await tx`insert into comments (id, item_id, author_id, body, source, created_at, updated_at) values (${id}, ${it.id}, ${users[c.author]}, ${c.body}, 'app', ${createdAt}, ${createdAt})`;
      counts.comments++;
      commentEvents.push({ id, itemId: it.id, author: c.author, at: createdAt });
      if (c.reply) {
        const rid = uuid();
        const rAt = new Date(createdAt.getTime() + 45 * 60_000);
        await tx`insert into comments (id, item_id, author_id, body, parent_id, source, created_at, updated_at) values (${rid}, ${it.id}, ${users[c.reply.author]}, ${c.reply.body}, ${id}, 'app', ${rAt}, ${rAt})`;
        counts.comments++;
        commentEvents.push({ id: rid, itemId: it.id, author: c.reply.author, at: rAt });
      }
    }

    // --- watchers ------------------------------------------------------------
    const watch = new Map<string, { item: string; user: UserKey; reason: string }>();
    const addWatch = (item: string, user: UserKey, reason: string) => { const k = `${item}/${user}`; if (!watch.has(k)) watch.set(k, { item, user, reason }); };
    for (const it of inserted) {
      if (it.assignee) addWatch(it.id, it.assignee, 'assignee');
      addWatch(it.id, it.reporter, 'reporter');
    }
    for (const c of commentEvents) addWatch(c.itemId, c.author, 'commenter');
    addWatch(idOf('Replace LIBOR fallback in swap pricer'), 'dan', 'mention');
    for (const w of watch.values()) {
      await tx`insert into item_watchers (item_id, user_id, reason) values (${w.item}, ${users[w.user]}, ${w.reason}::text::watch_reason)`;
      counts.watchers++;
    }

    // --- activity log --------------------------------------------------------
    const event = async (e: { entity_type: string; entity_id: string; item_id: string | null; project_id: string; actor: UserKey; action: string; field?: string | null; old?: unknown; new?: unknown; mutation: string; at: Date; txn?: string }) => {
      await tx`insert into activity_events (txn_id, entity_type, entity_id, item_id, project_id, actor_kind, actor_id, actor_label, action, field, old_value, new_value, mutation_name, source, created_at)
        values (${e.txn ?? uuid()}, ${e.entity_type}, ${e.entity_id}, ${e.item_id}, ${e.project_id}, 'user', ${users[e.actor]}, null, ${e.action}, ${e.field ?? null},
          ${e.old === undefined ? null : tx.json(e.old as never)}, ${e.new === undefined ? null : tx.json(e.new as never)}, ${e.mutation}, 'app', ${e.at})`;
      counts.events++;
    };
    for (const [i, it] of inserted.entries()) {
      const initial = initialOf(it.type);
      await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor: it.reporter, action: 'create', mutation: 'createItem', at: it.createdAt,
        new: { key: it.key, title: it.title, type: it.type, state_id: initial.id, assignee_id: it.assignee ? users[it.assignee] : null } });
      if (it.stateId !== initial.id) {
        const actor = it.assignee ?? it.reporter;
        const txn = uuid();
        if (it.category === 'in_progress' || it.category === 'done' || it.category === 'canceled') {
          const mid = it.type === 'request' ? stateOf('request', 'doing') : stateOf(it.type, 'in_progress');
          const at = new Date(it.createdAt.getTime() + DAY);
          if (mid.id !== it.stateId) {
            await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor, action: 'update', field: 'state_id', old: initial.id, new: mid.id, mutation: 'transitionItem', at });
          }
          const finalAt = it.completedAt ?? new Date(Math.min(now.getTime() - 3_600_000, at.getTime() + 3 * DAY));
          await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor, action: 'update', field: 'state_id', old: mid.id !== it.stateId ? mid.id : initial.id, new: it.stateId, mutation: 'transitionItem', at: finalAt, txn });
          if (it.category === 'done') await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor, action: 'update', field: 'completed_at', old: null, new: finalAt.toISOString(), mutation: 'transitionItem', at: finalAt, txn });
        } else {
          await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor, action: 'update', field: 'state_id', old: initial.id, new: it.stateId, mutation: 'transitionItem', at: new Date(it.createdAt.getTime() + 2 * DAY) });
        }
      }
      if (i % 9 === 4) {
        await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor: it.reporter, action: 'update', field: 'title', old: `Draft: ${it.title}`, new: it.title, mutation: 'updateItem', at: new Date(it.createdAt.getTime() + 3_600_000) });
      }
      if (i % 11 === 6 && it.assignee) {
        await event({ entity_type: 'work_item', entity_id: it.id, item_id: it.id, project_id: it.project, actor: it.reporter, action: 'update', field: 'assignee_id', old: null, new: users[it.assignee], mutation: 'updateItem', at: new Date(it.createdAt.getTime() + 2 * 3_600_000) });
      }
    }
    for (const c of commentEvents) {
      const it = inserted.find((x) => x.id === c.itemId)!;
      await event({ entity_type: 'comment', entity_id: c.id, item_id: it.id, project_id: it.project, actor: c.author, action: 'create', mutation: 'addComment', at: c.at, new: { comment_id: c.id } });
    }

    // --- views ---------------------------------------------------------------
    const openFilter = { field: 'state.category', op: 'nin', value: ['done', 'canceled'] };
    const overdueFilter = { and: [{ field: 'due_date', op: 'before', value: '$today' }, openFilter] };
    const insertView = async (v: { project_id: string | null; owner_id: string | null; name: string; kind: string; spec: unknown; is_shared: boolean; is_default?: boolean; icon?: string; sort: number }) => {
      await tx`insert into views (id, project_id, owner_id, name, kind, spec, is_shared, is_default, icon, sort) values
        (${uuid()}, ${v.project_id}, ${v.owner_id}, ${v.name}, ${v.kind}::text::view_kind, ${tx.json(v.spec as never)}, ${v.is_shared}, ${v.is_default ?? false}, ${v.icon ?? null}, ${v.sort})`;
      counts.views++;
    };
    for (const p of SEED_PROJECTS) {
      const pid = projectIds[p.key]!;
      const scope = { field: 'project_id', op: 'eq', value: pid };
      await insertView({ project_id: pid, owner_id: null, name: 'All open', kind: 'list', is_shared: true, is_default: true, icon: 'list', sort: 0,
        spec: { kind: 'list', filter: { and: [scope, openFilter] }, sort: [{ field: 'priority', dir: 'asc' }, { field: 'due_date', dir: 'asc' }], group_by: null,
          columns: ['key', 'title', 'type_id', 'state_id', 'assignee_id', 'priority', 'due_date', 'labels'] } });
      await insertView({ project_id: pid, owner_id: null, name: 'Board', kind: 'board', is_shared: true, icon: 'columns', sort: 1,
        spec: { kind: 'board', filter: { and: [scope, { field: 'state.category', op: 'neq', value: 'canceled' }] }, sort: [{ field: 'sort_order', dir: 'asc' }], group_by: 'state_id',
          board: { column_field: 'state_id', swimlane_field: null, hide_empty: false } } });
      await insertView({ project_id: pid, owner_id: null, name: 'Roadmap', kind: 'timeline', is_shared: true, icon: 'calendar', sort: 2,
        spec: { kind: 'timeline', filter: { and: [scope, { field: 'type.key', op: 'eq', value: 'initiative' }] }, sort: [{ field: 'start_date', dir: 'asc' }],
          timeline: { start_field: 'start_date', end_field: 'due_date', zoom: 'month', show_dependencies: true } } });
      await insertView({ project_id: pid, owner_id: null, name: 'Overview', kind: 'dashboard', is_shared: true, icon: 'chart', sort: 3,
        spec: { kind: 'dashboard', filter: scope, dashboard: { widgets: [
          { id: 'open_by_state', title: 'Open by state', viz: 'bar', query: { filter: { and: [scope, openFilter] } }, group_by: 'state_id', measure: 'count', w: 6, h: 3 },
          { id: 'open_by_assignee', title: 'Open by assignee', viz: 'bar', query: { filter: { and: [scope, openFilter] } }, group_by: 'assignee_id', measure: 'count', w: 6, h: 3 },
          { id: 'overdue', title: 'Overdue', viz: 'number', query: { filter: { and: [scope, overdueFilter] } }, measure: 'count', w: 3, h: 2 },
          { id: 'completed_30d', title: 'Completed last 30 days', viz: 'number', query: { filter: { and: [scope, { field: 'completed_at', op: 'within_days', value: -30 }] } }, measure: 'count', w: 3, h: 2 },
        ] } } });
    }
    await insertView({ project_id: null, owner_id: users.alice, name: 'My work', kind: 'list', is_shared: false, icon: 'user', sort: 0,
      spec: { kind: 'list', filter: { and: [{ field: 'assignee_id', op: 'eq', value: '$me' }, openFilter] }, sort: [{ field: 'due_date', dir: 'asc' }, { field: 'priority', dir: 'asc' }], group_by: 'project_id',
        columns: ['key', 'title', 'project_id', 'state_id', 'priority', 'due_date'] } });
    await insertView({ project_id: null, owner_id: users.alice, name: 'Overdue across the firm', kind: 'list', is_shared: true, icon: 'alert', sort: 1,
      spec: { kind: 'list', filter: overdueFilter, sort: [{ field: 'due_date', dir: 'asc' }], group_by: 'project_id', columns: ['key', 'title', 'project_id', 'assignee_id', 'due_date'] } });
    await insertView({ project_id: null, owner_id: users.alice, name: 'Regulatory work', kind: 'list', is_shared: true, icon: 'shield', sort: 2,
      spec: { kind: 'list', filter: { and: [{ field: 'labels', op: 'has', value: 'regulatory' }, openFilter] }, sort: [{ field: 'priority', dir: 'asc' }], group_by: 'state.category', columns: ['key', 'title', 'project_id', 'state_id', 'priority', 'due_date'] } });

    // --- notification preferences --------------------------------------------
    let prefs = 0;
    for (const u of SEED_USERS) {
      await tx`insert into notification_preferences (user_id, channel, cadence) values (${users[u.key]}, 'in_app', 'immediate')`;
      await tx`insert into notification_preferences (user_id, channel, cadence, quiet_hours) values (${users[u.key]}, 'email', 'daily', ${tx.json({ start: '19:00', end: '07:00', tz: 'Europe/London' })})`;
      prefs += 2;
    }

    // --- webhook endpoint + integration configs (inactive) -------------------
    await tx`insert into webhook_endpoints (id, name, url, secret, event_kinds, project_id, is_active, created_by) values
      (${uuid()}, 'Example sink', 'https://example.com/hook', ${'whsec_' + uuid().replace(/-/g, '')}, '{*}', null, false, ${users.alice})`;
    await tx`insert into integration_configs (kind, config, is_active, updated_by) values
      ('slack', ${tx.json({ team_id: 'T0EXAMPLE', channel_map: { RATES: 'C0RATES', EQD: 'C0EQD', OPS: 'C0OPS' }, notify_on: ['item.transitioned', 'comment.created'] })}, false, ${users.alice}),
      ('github', ${tx.json({ repos: ['firm/rates-platform', 'firm/eqd-tooling'], autolink: true, close_on_merge: true })}, false, ${users.alice}),
      ('email', ${tx.json({ inbound_domain: 'pm.firm.com', from: 'pm@firm.com' })}, false, ${users.alice})`;

    const summary: SeedSummary = {
      users: SEED_USERS.length, teams: TEAMS.length, projects: SEED_PROJECTS.length, labels: labelCount, work_items: counts.items, relations: counts.relations,
      comments: counts.comments, watchers: counts.watchers, activity_events: counts.events, views: counts.views, notification_preferences: prefs,
      webhook_endpoints: 1, integration_configs: 3,
    };
    log(`seed: ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return summary;
  });
}

const LABEL_COLORS: Record<string, string> = {
  regulatory: '#ef4444', 'tech-debt': '#f59e0b', 'quick-win': '#10b981', sofr: '#6366f1', pricing: '#8b5cf6', vol: '#ec4899', greeks: '#14b8a6', kyc: '#f97316', runbook: '#64748b',
};

if (isMain(import.meta.url)) {
  const sql = connect();
  try {
    const s = await seed(sql, { force: hasFlag('--force'), log: (m) => console.log(m) });
    if (s) {
      console.log('seed users:');
      for (const u of SEED_USERS) console.log(`  ${u.email.padEnd(16)} ${u.name.padEnd(16)} ${u.firm_role}${'is_service' in u && u.is_service ? ' (service)' : ''}`);
      console.log(`projects: ${SEED_PROJECTS.map((p) => `${p.key} (${p.visibility})`).join(', ')}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
