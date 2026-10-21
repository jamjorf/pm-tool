import type { Q, Row } from './db.js';
import { stripSearch } from './mutations/helpers.js';
import { attachLabelIds } from './query.js';

export interface SearchOptions { projectId?: string | null; limit?: number }

/**
 * Full-text search over work_items_v with ranking + ts_headline snippet; falls back to a
 * trigram/ILIKE title match when FTS finds nothing. Always scoped by can_view_item().
 */
export async function searchItems(q: Q, userId: string, query: string, opts: SearchOptions = {}): Promise<Row[]> {
  const text = query.trim();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  if (!text) return [];
  const pid = opts.projectId ?? null;
  let rows: Row[] = await q`
    select w.*, ts_rank(w.search, qq.q) as rank,
           ts_headline('english', w.title || ' — ' || left(w.description, 2000), qq.q, 'MaxFragments=2, MaxWords=18, MinWords=6, StartSel=**, StopSel=**') as snippet
    from work_items_v w, websearch_to_tsquery('english', ${text}) qq(q)
    where w.deleted_at is null and w.search @@ qq.q and can_view_item(${userId}, w.id)
      and (${pid}::uuid is null or w.project_id = ${pid}::uuid)
    order by rank desc, w.updated_at desc
    limit ${limit}`;
  if (!rows.length) {
    rows = await q`
      select w.*, greatest(similarity(w.title, ${text}), case when w.key ilike ${'%' + text + '%'} then 1.0 else 0 end) as rank, w.title as snippet
      from work_items_v w
      where w.deleted_at is null and can_view_item(${userId}, w.id)
        and (${pid}::uuid is null or w.project_id = ${pid}::uuid)
        and (w.title % ${text} or w.title ilike ${'%' + text + '%'} or w.key ilike ${'%' + text + '%'})
      order by rank desc, w.updated_at desc
      limit ${limit}`;
  }
  rows = rows.map((r) => stripSearch(r));
  await attachLabelIds(q, rows);
  return rows;
}
