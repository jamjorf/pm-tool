// Workflow editor: states + transitions with structured guard/effect editors; validate + PUT /api/v1/workflows/:key
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { workflowEngine, type Guard, type Effect, type MutationArgsOf, type StateCategory } from '@pm/core';
import { useStore } from '../../store/hooks';
import { useActions } from '../../components/items/useActions';
import { api } from '../../api';
import { Button, Input, Select, Checkbox } from '../../components/ui';
import { toast, toastError } from '../../lib/toast';
import { cn, uuid, CATEGORY_LABEL } from '../../lib/util';
import { useReplicache } from '../../sync/context';

type Draft = MutationArgsOf<'upsertWorkflow'>;
const CATEGORIES: StateCategory[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
const GUARD_TYPES: Guard['type'][] = ['require_field', 'field_equals', 'field_in', 'no_open_blockers', 'children_in_category', 'require_role', 'require_assignee_is_actor', 'require_label'];
const EFFECT_TYPES: Effect['type'][] = ['set_field', 'notify', 'webhook', 'add_label', 'remove_label', 'transition_parent_if', 'transition_children'];

function defaultGuard(type: Guard['type']): Guard {
  switch (type) {
    case 'require_field': return { type, field: 'assignee_id' };
    case 'field_equals': return { type, field: 'priority', value: 1 };
    case 'field_in': return { type, field: 'priority', values: [1, 2] };
    case 'no_open_blockers': return { type };
    case 'children_in_category': return { type, categories: ['done', 'canceled'] };
    case 'require_role': return { type, roles: ['admin', 'editor'] };
    case 'require_assignee_is_actor': return { type };
    case 'require_label': return { type, label: '' };
  }
}
function defaultEffect(type: Effect['type']): Effect {
  switch (type) {
    case 'set_field': return { type, field: 'completed_at', value: '$now' };
    case 'notify': return { type, audience: ['watchers'], template: 'state_changed' };
    case 'webhook': return { type, event: 'item.transitioned' };
    case 'add_label': return { type, label: '' };
    case 'remove_label': return { type, label: '' };
    case 'transition_parent_if': return { type, all_children_category: ['done', 'canceled'], to: 'done' };
    case 'transition_children': return { type, to: 'canceled' };
  }
}

function parseJsonish(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

function GuardEditor({ g, onChange, onRemove }: { g: Guard; onChange: (g: Guard) => void; onRemove: () => void }) {
  const cls = 'h-7 rounded-md border border-border bg-bg px-1.5 text-xs';
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-bg-subtle px-2 py-1">
      <select className={cls} value={g.type} onChange={(e) => onChange(defaultGuard(e.target.value as Guard['type']))}>{GUARD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
      {'field' in g && <input className={cn(cls, 'w-32')} value={g.field} placeholder="field" onChange={(e) => onChange({ ...g, field: e.target.value })} />}
      {g.type === 'field_equals' && <input className={cn(cls, 'w-24')} value={JSON.stringify(g.value) ?? ''} onChange={(e) => onChange({ ...g, value: parseJsonish(e.target.value) })} placeholder="value (JSON)" />}
      {g.type === 'field_in' && <input className={cn(cls, 'w-40')} value={JSON.stringify(g.values)} onChange={(e) => { const v = parseJsonish(e.target.value); if (Array.isArray(v)) onChange({ ...g, values: v }); }} placeholder='["a","b"]' />}
      {g.type === 'children_in_category' && CATEGORIES.map((c) => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={g.categories.includes(c)} onChange={(e) => onChange({ ...g, categories: e.target.checked ? [...g.categories, c] : g.categories.filter((x) => x !== c) })} />{c}</label>)}
      {g.type === 'require_role' && (['admin', 'editor', 'viewer'] as const).map((r) => <label key={r} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={g.roles.includes(r)} onChange={(e) => onChange({ ...g, roles: e.target.checked ? [...g.roles, r] : g.roles.filter((x) => x !== r) })} />{r}</label>)}
      {g.type === 'require_label' && <input className={cn(cls, 'w-32')} value={g.label} placeholder="label name" onChange={(e) => onChange({ ...g, label: e.target.value })} />}
      <button className="ml-auto text-fg-faint hover:text-danger" onClick={onRemove}><Trash2 size={12} /></button>
    </div>
  );
}

function EffectEditor({ e: ef, onChange, onRemove, stateKeys }: { e: Effect; onChange: (e: Effect) => void; onRemove: () => void; stateKeys: string[] }) {
  const cls = 'h-7 rounded-md border border-border bg-bg px-1.5 text-xs';
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-bg-subtle px-2 py-1">
      <select className={cls} value={ef.type} onChange={(e) => onChange(defaultEffect(e.target.value as Effect['type']))}>{EFFECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
      {ef.type === 'set_field' && <><input className={cn(cls, 'w-32')} value={ef.field} onChange={(e) => onChange({ ...ef, field: e.target.value })} placeholder="field" /><input className={cn(cls, 'w-28')} value={typeof ef.value === 'string' ? ef.value : JSON.stringify(ef.value) ?? ''} onChange={(e) => { const v = e.target.value; onChange({ ...ef, value: v.startsWith('$') ? v : parseJsonish(v) }); }} placeholder="$now | $today | $actor | JSON" /><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!ef.only_if_null} onChange={(e) => onChange({ ...ef, only_if_null: e.target.checked })} />only if null</label></>}
      {ef.type === 'notify' && <>{(['watchers', 'assignee', 'reporter', 'project_admins'] as const).map((a) => <label key={a} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={ef.audience.includes(a)} onChange={(e) => onChange({ ...ef, audience: e.target.checked ? [...ef.audience, a] : ef.audience.filter((x) => x !== a) })} />{a}</label>)}<input className={cn(cls, 'w-32')} value={ef.template} onChange={(e) => onChange({ ...ef, template: e.target.value })} placeholder="template" /></>}
      {ef.type === 'webhook' && <input className={cn(cls, 'w-40')} value={ef.event} onChange={(e) => onChange({ ...ef, event: e.target.value })} placeholder="event kind" />}
      {(ef.type === 'add_label' || ef.type === 'remove_label') && <input className={cn(cls, 'w-32')} value={ef.label} onChange={(e) => onChange({ ...ef, label: e.target.value })} placeholder="label name" />}
      {ef.type === 'transition_parent_if' && <>{CATEGORIES.map((c) => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={ef.all_children_category.includes(c)} onChange={(e) => onChange({ ...ef, all_children_category: e.target.checked ? [...ef.all_children_category, c] : ef.all_children_category.filter((x) => x !== c) })} />{c}</label>)}<span className="text-xs text-fg-muted">→</span><select className={cls} value={ef.to} onChange={(e) => onChange({ ...ef, to: e.target.value })}>{stateKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select></>}
      {ef.type === 'transition_children' && <select className={cls} value={ef.to} onChange={(e) => onChange({ ...ef, to: e.target.value })}>{stateKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>}
      <button className="ml-auto text-fg-faint hover:text-danger" onClick={onRemove}><Trash2 size={12} /></button>
    </div>
  );
}

export function WorkflowsPage() {
  const { workflows } = useStore();
  const rep = useReplicache();
  const a = useActions();
  const [selected, setSelected] = useState<string | 'new'>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  void a;

  useEffect(() => {
    if (!selected && workflows[0]) setSelected(workflows[0].id);
  }, [workflows, selected]);
  useEffect(() => {
    if (selected === 'new') { setDraft({ id: uuid(), key: '', name: '', description: null, states: [{ id: uuid(), key: 'todo', name: 'Todo', category: 'todo', color: '#60a5fa', sort: 0, is_initial: true }, { id: uuid(), key: 'done', name: 'Done', category: 'done', color: '#10b981', sort: 1, is_initial: false }], transitions: [] }); setErrors(null); return; }
    const w = workflows.find((x) => x.id === selected);
    if (w) setDraft({ id: w.id, key: w.key, name: w.name, description: w.description, states: w.states.map((s) => ({ id: s.id, key: s.key, name: s.name, category: s.category, color: s.color, sort: s.sort, is_initial: s.is_initial })), transitions: w.transitions.map((t) => ({ id: t.id, key: t.key, name: t.name, from_state_id: t.from_state_id, to_state_id: t.to_state_id, guards: t.guards, effects: t.effects, sort: t.sort })) });
    setErrors(null);
  }, [selected, workflows]);

  const stateKeys = useMemo(() => draft?.states.map((s) => s.key) ?? [], [draft]);
  if (!draft) return <div className="p-8 text-sm text-fg-muted">No workflows yet.</div>;

  const validate = (): string[] => {
    try {
      return workflowEngine.validateDefinition({ id: draft.id, key: draft.key, states: draft.states.map((s) => ({ ...s, color: s.color ?? null, workflow_id: draft.id, version: 0, created_at: '', updated_at: '', deleted_at: null })), transitions: draft.transitions.map((t) => ({ ...t, workflow_id: draft.id, version: 0, created_at: '', updated_at: '', deleted_at: null })) });
    } catch (e) {
      const errs: string[] = [];
      if (draft.states.filter((s) => s.is_initial).length !== 1) errs.push('Exactly one initial state is required');
      if (new Set(draft.states.map((s) => s.key)).size !== draft.states.length) errs.push('State keys must be unique');
      if (new Set(draft.transitions.map((t) => t.key)).size !== draft.transitions.length) errs.push('Transition keys must be unique');
      for (const t of draft.transitions) if (!draft.states.some((s) => s.id === t.to_state_id)) errs.push(`Transition ${t.key} targets an unknown state`);
      void e;
      return errs;
    }
  };
  const save = async () => {
    const errs = validate();
    setErrors(errs);
    if (errs.length || !draft.key || !draft.name) { if (!draft.key || !draft.name) setErrors([...errs, 'Key and name are required']); return; }
    setSaving(true);
    try {
      await api.upsertWorkflow(draft.key, draft);
      await rep.mutate.upsertWorkflow(draft).catch(() => undefined);
      toast({ kind: 'success', title: 'Workflow saved' });
      setSelected(draft.id);
    } catch (e) { void e; } finally { setSaving(false); }
  };
  const upState = (i: number, patch: Partial<Draft['states'][number]>) => setDraft({ ...draft, states: draft.states.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const upTrans = (i: number, patch: Partial<Draft['transitions'][number]>) => setDraft({ ...draft, transitions: draft.transitions.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const moveState = (i: number, d: -1 | 1) => { const xs = [...draft.states]; const j = i + d; if (j < 0 || j >= xs.length) return; [xs[i], xs[j]] = [xs[j]!, xs[i]!]; setDraft({ ...draft, states: xs.map((s, k) => ({ ...s, sort: k })) }); };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-56 shrink-0 overflow-auto border-r border-border p-2">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Workflows</div>
        {workflows.map((w) => <button key={w.id} className={cn('block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-muted', selected === w.id && 'bg-bg-muted font-medium')} onClick={() => setSelected(w.id)}>{w.name} <span className="text-xs text-fg-faint">{w.key}</span></button>)}
        <button className={cn('mt-2 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-accent hover:bg-bg-muted', selected === 'new' && 'bg-bg-muted')} onClick={() => setSelected('new')}><Plus size={13} /> New workflow</button>
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-6">
        <div className="mb-4 flex items-end gap-3">
          <label className="block"><div className="mb-1 text-xs text-fg-muted">Key</div><Input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} className="w-40" disabled={selected !== 'new'} /></label>
          <label className="block"><div className="mb-1 text-xs text-fg-muted">Name</div><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-64" /></label>
          <label className="block flex-1"><div className="mb-1 text-xs text-fg-muted">Description</div><Input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} /></label>
          <Button onClick={() => setErrors(validate())}>Validate</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Save</Button>
        </div>
        {errors && (
          <div className={cn('mb-4 rounded-md px-3 py-2 text-sm', errors.length ? 'bg-danger-soft text-danger' : 'bg-ok-soft text-ok')}>
            {errors.length ? <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul> : 'Workflow definition is valid.'}
          </div>
        )}

        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">States</h2><Button size="xs" icon={<Plus size={12} />} onClick={() => setDraft({ ...draft, states: [...draft.states, { id: uuid(), key: `state_${draft.states.length + 1}`, name: 'New state', category: 'todo', color: '#60a5fa', sort: draft.states.length, is_initial: false }] })}>Add state</Button></div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-fg-faint"><th className="w-8"></th><th>Key</th><th>Name</th><th>Category</th><th>Color</th><th>Initial</th><th></th></tr></thead>
            <tbody>
              {draft.states.map((s, i) => (
                <tr key={s.id} className="border-b border-border">
                  <td className="py-1"><span className="flex flex-col"><button onClick={() => moveState(i, -1)} className="text-fg-faint hover:text-fg"><ChevronUp size={12} /></button><button onClick={() => moveState(i, 1)} className="text-fg-faint hover:text-fg"><ChevronDown size={12} /></button></span></td>
                  <td><Input value={s.key} onChange={(e) => upState(i, { key: e.target.value })} className="h-7 w-32" /></td>
                  <td><Input value={s.name} onChange={(e) => upState(i, { name: e.target.value })} className="h-7 w-40" /></td>
                  <td><Select value={s.category} onChange={(e) => upState(i, { category: e.target.value as StateCategory })} className="h-7 w-36">{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select></td>
                  <td><input type="color" value={s.color ?? '#9ca3af'} onChange={(e) => upState(i, { color: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-border bg-bg" /></td>
                  <td><Checkbox checked={s.is_initial} onChange={(v) => setDraft({ ...draft, states: draft.states.map((x, j) => ({ ...x, is_initial: j === i ? v : v ? false : x.is_initial })) })} /></td>
                  <td className="text-right"><button className="text-fg-faint hover:text-danger" onClick={() => setDraft({ ...draft, states: draft.states.filter((_, j) => j !== i) })}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Transitions</h2><Button size="xs" icon={<Plus size={12} />} onClick={() => setDraft({ ...draft, transitions: [...draft.transitions, { id: uuid(), key: `t_${draft.transitions.length + 1}`, name: 'New transition', from_state_id: null, to_state_id: draft.states[0]?.id ?? '', guards: [], effects: [], sort: draft.transitions.length }] })}>Add transition</Button></div>
          <div className="space-y-3">
            {draft.transitions.map((t, i) => (
              <div key={t.id} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Input value={t.key} onChange={(e) => upTrans(i, { key: e.target.value })} className="h-7 w-28" placeholder="key" />
                  <Input value={t.name} onChange={(e) => upTrans(i, { name: e.target.value })} className="h-7 w-40" placeholder="name" />
                  <span className="text-xs text-fg-muted">from</span>
                  <Select value={t.from_state_id ?? ''} onChange={(e) => upTrans(i, { from_state_id: e.target.value || null })} className="h-7 w-36"><option value="">any state</option>{draft.states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                  <span className="text-xs text-fg-muted">to</span>
                  <Select value={t.to_state_id} onChange={(e) => upTrans(i, { to_state_id: e.target.value })} className="h-7 w-36">{draft.states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                  <button className="ml-auto text-fg-faint hover:text-danger" onClick={() => setDraft({ ...draft, transitions: draft.transitions.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-fg-muted">Guards <button className="text-accent" onClick={() => upTrans(i, { guards: [...t.guards, defaultGuard('require_field')] })}>+ add</button></div>
                    <div className="space-y-1">{t.guards.map((g, gi) => <GuardEditor key={gi} g={g} onChange={(ng) => upTrans(i, { guards: t.guards.map((x, k) => (k === gi ? ng : x)) })} onRemove={() => upTrans(i, { guards: t.guards.filter((_, k) => k !== gi) })} />)}{t.guards.length === 0 && <div className="text-xs text-fg-faint">No guards — always allowed.</div>}</div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-fg-muted">Effects <button className="text-accent" onClick={() => upTrans(i, { effects: [...t.effects, defaultEffect('set_field')] })}>+ add</button></div>
                    <div className="space-y-1">{t.effects.map((ef, ei) => <EffectEditor key={ei} e={ef} stateKeys={stateKeys} onChange={(ne) => upTrans(i, { effects: t.effects.map((x, k) => (k === ei ? ne : x)) })} onRemove={() => upTrans(i, { effects: t.effects.filter((_, k) => k !== ei) })} />)}{t.effects.length === 0 && <div className="text-xs text-fg-faint">No effects.</div>}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <span className="hidden">{String(toastError)}</span>
    </div>
  );
}
