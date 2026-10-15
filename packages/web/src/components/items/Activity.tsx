// Activity timeline from /api/v1/items/:key/activity, grouped by txn: "field: old → new".
import { useEffect, useState } from 'react';
import { PRIORITY_LABELS, fieldLabel, type ActivityEvent, type ItemRow } from '@pm/core';
import { api } from '../../api';
import { useStore } from '../../store/hooks';
import { Avatar } from '../ui';
import { relTime } from '../../lib/util';
import { format } from 'date-fns';

function useFormatValue() {
  const { usersById, statesById, typesById, projectsById, labelsById, itemsById } = useStore();
  return (field: string | null, v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '—';
      return v.map((x) => (typeof x === 'string' && labelsById[x] ? labelsById[x]!.name : String(x))).join(', ');
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.type === 'string') {
        const other = [o.to_item_id, o.from_item_id].find((id): id is string => typeof id === 'string' && !!itemsById[id]);
        const ext = typeof o.external_kind === 'string' ? `${o.external_kind}` : '';
        return `${o.type} ${other ? itemsById[other]!.key : ext}`.trim();
      }
      if (typeof o.key === 'string') return o.key;
    }
    if (typeof v === 'string') {
      if (field === 'assignee_id' || field === 'reporter_id' || field === 'created_by') return usersById[v]?.name ?? v.slice(0, 8);
      if (field === 'state_id') return statesById[v]?.name ?? v.slice(0, 8);
      if (field === 'type_id') return typesById[v]?.name ?? v.slice(0, 8);
      if (field === 'project_id') return projectsById[v]?.key ?? v.slice(0, 8);
      if (field === 'label_id' || field === 'label') return labelsById[v]?.name ?? v;
      if (field === 'description' && v.length > 80) return v.slice(0, 80) + '…';
      return v;
    }
    if (typeof v === 'number' && field === 'priority') return PRIORITY_LABELS[v] ?? String(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return JSON.stringify(v);
  };
}

function label(field: string | null, defs: ItemRow extends never ? never : { key: string; label: string }[] | undefined): string {
  if (!field) return '';
  try {
    return fieldLabel(field, defs as never);
  } catch {
    const k = field.replace(/^fields\./, '');
    return defs?.find((d) => d.key === k)?.label ?? k.replace(/_id$/, '').replace(/_/g, ' ');
  }
}

export function ActivitySection({ item }: { item: ItemRow }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { usersById, typesById } = useStore();
  const fmt = useFormatValue();
  const key = item.number > 0 ? item.key : item.id;
  const defs = typesById[item.type_id]?.field_defs;

  useEffect(() => {
    let cancelled = false;
    api
      .activity(key)
      .then((r) => {
        if (cancelled) return;
        setEvents(Array.isArray(r) ? r : r.events);
        setError(null);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [key, item.version, item.updated_at]);

  if (error) return <div className="text-xs text-fg-faint">Activity unavailable ({error}).</div>;
  if (!events) return <div className="text-xs text-fg-faint">Loading activity…</div>;
  if (events.length === 0) return <div className="text-xs text-fg-faint">No activity yet.</div>;

  // group by txn_id preserving order (newest first)
  const groups: { txn: string; events: ActivityEvent[] }[] = [];
  for (const e of [...events].sort((a, b) => b.id - a.id)) {
    const g = groups[groups.length - 1];
    if (g && g.txn === e.txn_id) g.events.push(e);
    else groups.push({ txn: e.txn_id, events: [e] });
  }

  return (
    <ol className="space-y-3">
      {groups.map((g) => {
        const first = g.events[0]!;
        const actor = first.actor_id ? usersById[first.actor_id] : undefined;
        const actorName = actor?.name ?? first.actor_label ?? first.actor_kind;
        return (
          <li key={g.txn} className="flex gap-2.5 text-sm">
            <Avatar user={actor} size={20} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{actorName}</span>
                {first.actor_kind !== 'user' && <span className="ml-1 rounded bg-bg-muted px-1 text-[10px]">{first.actor_kind}</span>}
                {first.source && first.source !== 'web' && <span className="ml-1 text-fg-faint">via {first.source}</span>}
                <span className="ml-2 text-fg-faint" title={format(new Date(first.created_at), 'PPpp')}>{relTime(first.created_at)}</span>
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {g.events.map((e) => (
                  <li key={e.id} className="text-[13px] text-fg-muted">
                    {e.field === 'transition_key' ? (
                      <span>via transition <span className="text-fg">{String(e.new_value ?? '')}</span></span>
                    ) : e.field ? (
                      <>
                        <span className="text-fg">{label(e.field, defs)}</span>: <span className="line-through decoration-fg-faint/60">{fmt(e.field, e.old_value)}</span> → <span className="text-fg">{fmt(e.field, e.new_value)}</span>
                      </>
                    ) : e.action === 'relation_add' || e.action === 'relation_remove' ? (
                      <span>{e.action === 'relation_add' ? 'added relation' : 'removed relation'} <span className="text-fg">{fmt(null, e.new_value ?? e.old_value)}</span></span>
                    ) : e.entity_type === 'comment' ? (
                      <span>{e.action.replace(/_/g, ' ')} comment</span>
                    ) : (
                      <span>
                        {e.action.replace(/_/g, ' ')} {e.entity_type !== 'work_item' ? e.entity_type : ''}
                        {e.new_value !== null && e.new_value !== undefined && typeof e.new_value !== 'object' ? <span className="text-fg"> {fmt(null, e.new_value)}</span> : null}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
