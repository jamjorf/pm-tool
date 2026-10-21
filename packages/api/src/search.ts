import { escapeLike, ftsMatch, nothing, type Q, type Row } from './db.js';
import { stripSearch, visibleItem } from './mutations/helpers.js';
import { attachLabelIds } from './query.js';

export interface SearchOptions { projectId?: string | null; limit?: number }

/**
 * Full-text search over work_items_v through the FTS5 index (work_items_fts: key, title, description),
 * ranked with bm25 (key and title weigh more) and a `**`-highlighted snippet; falls back to a
 * case-insensitive title/key substring match when FTS finds nothing. Always scoped by visible_items.
 * `rank` is exposed as a positive number (higher = better; bm25 itself is lower-is-better).
 */
export async function searchItems(q: Q, userId: string, query: string, opts: SearchOptions = {}): Promise<Row[]> {
  const text = query.trim();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  if (!text) return [];
  const pid = opts.projectId ?? null;
  const scope = q`w.deleted_at is null and ${visibleItem(q, userId, 'w.id')} and (${pid} is null or w.project_id = ${pid})`;
  const match = ftsMatch(text);
  let rows: Row[] = [];
  if (match) {
    rows = await q`
      select w.*, -f.rank as rank, f.snippet as snippet
      from (select f.id, bm25(f.work_items_fts, 10.0, 5.0, 1.0) as rank, snippet(f.work_items_fts, -1, '**', '**', '…', 12) as snippet
            from work_items_fts f where f.work_items_fts match ${match}) f
      join work_items_v w on w.id = f.id
      where ${scope}
      order by f.rank asc, w.updated_at desc
      limit ${limit}`;
  }
  if (!rows.length) {
    const like = `%${escapeLike(text.toLowerCase())}%`;
    rows = await q`
      select w.*, case when lower(w.key) like ${like} escape '\\' then 1.0 else 0.5 end as rank, w.title as snippet
      from work_items_v w
      where ${scope} and (lower(w.title) like ${like} escape '\\' or lower(w.key) like ${like} escape '\\')
      order by rank desc, w.updated_at desc
      limit ${limit}`;
  }
  rows = rows.map((r) => stripSearch(r));
  await attachLabelIds(q, rows);
  return rows;
}

export { nothing };
