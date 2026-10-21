import type { Sql } from '../db.js';
import { createNotification } from './rules.js';

/**
 * Hourly: notify assignees of open items due within the next 24h (or overdue by < 1 day),
 * at most once per item per 36h.
 */
export async function runDueSoon(sql: Sql, log: { info: Function }): Promise<number> {
  const rows = await sql`
    select w.id, w.key, w.title, w.assignee_id, w.due_date from work_items w
    join workflow_states s on s.id = w.state_id
    where w.deleted_at is null and w.assignee_id is not null and w.due_date is not null
      and s.category not in ('done','canceled')
      and w.due_date between current_date and current_date + 1
      and not exists (
        select 1 from notifications n where n.item_id = w.id and n.user_id = w.assignee_id and n.kind = 'due_soon'
          and n.created_at > now() - interval '36 hours')`;
  let count = 0;
  for (const w of rows) {
    const id = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(42)`;
      return createNotification(tx, {
        user_id: w.assignee_id, item_id: w.id, kind: 'due_soon', actor_id: null,
        title: `${w.key} is due ${w.due_date === new Date().toISOString().slice(0, 10) ? 'today' : 'tomorrow'}: ${w.title}`, body: `Due ${w.due_date}`,
      });
    });
    if (id) count++;
  }
  if (count) log.info({ count }, 'due_soon notifications created');
  return count;
}
