// Item types + field_defs editor → PUT /api/v1/types/:key
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { FieldKind, type FieldDef, type MutationArgsOf } from '@pm/core';
import { useStore } from '../../store/hooks';
import { useReplicache } from '../../sync/context';
import { api } from '../../api';
import { Button, Input, Select, Checkbox } from '../../components/ui';
import { toast } from '../../lib/toast';
import { cn, uuid } from '../../lib/util';

type Draft = MutationArgsOf<'upsertItemType'>;

export function TypesPage() {
  const { types, workflows } = useStore();
  const rep = useReplicache();
  const [selected, setSelected] = useState<string | 'new'>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!selected && types[0]) setSelected(types[0].id); }, [types, selected]);
  useEffect(() => {
    if (selected === 'new') { setDraft({ id: uuid(), key: '', name: '', plural_name: '', icon: null, color: '#60a5fa', description: null, workflow_id: workflows[0]?.id ?? '', field_defs: [], is_container: false, sort: types.length, is_active: true }); return; }
    const t = types.find((x) => x.id === selected);
    if (t) setDraft({ id: t.id, key: t.key, name: t.name, plural_name: t.plural_name, icon: t.icon, color: t.color, description: t.description, workflow_id: t.workflow_id, field_defs: t.field_defs, is_container: t.is_container, sort: t.sort, is_active: t.is_active });
  }, [selected, types, workflows]);
  if (!draft) return <div className="p-8 text-sm text-fg-muted">No item types.</div>;

  const upDef = (i: number, patch: Partial<FieldDef>) => setDraft({ ...draft, field_defs: draft.field_defs.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const save = async () => {
    if (!draft.key || !draft.name || !draft.workflow_id) { toast({ kind: 'error', title: 'Key, name and workflow are required' }); return; }
    for (const d of draft.field_defs) if (!/^[a-z][a-z0-9_]*$/.test(d.key)) { toast({ kind: 'error', title: `Invalid field key "${d.key}"`, body: 'Use lowercase letters, digits and underscores.' }); return; }
    setSaving(true);
    try {
      await api.upsertType(draft.key, { ...draft, workflow: workflows.find((w) => w.id === draft.workflow_id)?.key });
      await rep.mutate.upsertItemType(draft).catch(() => undefined);
      toast({ kind: 'success', title: 'Type saved' });
      setSelected(draft.id);
    } catch (e) { void e; } finally { setSaving(false); }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-56 shrink-0 overflow-auto border-r border-border p-2">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Item types</div>
        {types.map((t) => <button key={t.id} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-muted', selected === t.id && 'bg-bg-muted font-medium', !t.is_active && 'opacity-50')} onClick={() => setSelected(t.id)}><span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color ?? '#999' }} />{t.name}</button>)}
        <button className={cn('mt-2 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-accent hover:bg-bg-muted', selected === 'new' && 'bg-bg-muted')} onClick={() => setSelected('new')}><Plus size={13} /> New type</button>
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-6">
        <div className="mb-4 grid grid-cols-4 gap-3">
          <label><div className="mb-1 text-xs text-fg-muted">Key</div><Input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} disabled={selected !== 'new'} /></label>
          <label><div className="mb-1 text-xs text-fg-muted">Name</div><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label><div className="mb-1 text-xs text-fg-muted">Plural</div><Input value={draft.plural_name ?? ''} onChange={(e) => setDraft({ ...draft, plural_name: e.target.value || null })} /></label>
          <label><div className="mb-1 text-xs text-fg-muted">Workflow</div><Select value={draft.workflow_id} onChange={(e) => setDraft({ ...draft, workflow_id: e.target.value })}>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>
          <label><div className="mb-1 text-xs text-fg-muted">Color</div><input type="color" value={draft.color ?? '#60a5fa'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="h-8 w-16 cursor-pointer rounded-md border border-border bg-bg" /></label>
          <label><div className="mb-1 text-xs text-fg-muted">Icon (lucide name)</div><Input value={draft.icon ?? ''} onChange={(e) => setDraft({ ...draft, icon: e.target.value || null })} /></label>
          <label className="col-span-2"><div className="mb-1 text-xs text-fg-muted">Description</div><Input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} /></label>
          <div className="col-span-4 flex items-center gap-6">
            <Checkbox checked={!!draft.is_container} onChange={(v) => setDraft({ ...draft, is_container: v })} label="Container (can have children; shows rollup)" />
            <Checkbox checked={draft.is_active ?? true} onChange={(v) => setDraft({ ...draft, is_active: v })} label="Active" />
            <span className="ml-auto" />
            <Button variant="primary" loading={saving} onClick={() => void save()}>Save type</Button>
          </div>
        </div>

        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Fields</h2><Button size="xs" icon={<Plus size={12} />} onClick={() => setDraft({ ...draft, field_defs: [...draft.field_defs, { key: `field_${draft.field_defs.length + 1}`, label: 'New field', kind: 'text' }] })}>Add field</Button></div>
        <div className="space-y-2">
          {draft.field_defs.map((d, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={d.key} onChange={(e) => upDef(i, { key: e.target.value })} className="h-7 w-36 font-mono text-xs" placeholder="key" />
                <Input value={d.label} onChange={(e) => upDef(i, { label: e.target.value })} className="h-7 w-44" placeholder="Label" />
                <Select value={d.kind} onChange={(e) => upDef(i, { kind: e.target.value as FieldDef['kind'] })} className="h-7 w-32">{FieldKind.options.map((k) => <option key={k} value={k}>{k}</option>)}</Select>
                <Checkbox checked={!!d.required} onChange={(v) => upDef(i, { required: v })} label="required" className="text-xs" />
                {(d.kind === 'select' || d.kind === 'multi_select') && <Checkbox checked={!!d.multi || d.kind === 'multi_select'} onChange={(v) => upDef(i, { multi: v })} label="multi" className="text-xs" />}
                <Checkbox checked={!!d.show_in_list} onChange={(v) => upDef(i, { show_in_list: v })} label="show in list" className="text-xs" />
                {d.kind === 'number' && <><Input type="number" value={d.min ?? ''} onChange={(e) => upDef(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} className="h-7 w-20" placeholder="min" /><Input type="number" value={d.max ?? ''} onChange={(e) => upDef(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} className="h-7 w-20" placeholder="max" /></>}
                <button className="ml-auto text-fg-faint hover:text-danger" onClick={() => setDraft({ ...draft, field_defs: draft.field_defs.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
              </div>
              <div className="mt-2 flex gap-2"><Input value={d.description ?? ''} onChange={(e) => upDef(i, { description: e.target.value || undefined })} className="h-7" placeholder="Help text (optional)" /></div>
              {(d.kind === 'select' || d.kind === 'multi_select') && (
                <div className="mt-2">
                  <div className="mb-1 text-xs text-fg-muted">Options (value · label)</div>
                  <div className="space-y-1">
                    {(d.options ?? []).map((o, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <Input value={o.value} onChange={(e) => upDef(i, { options: d.options!.map((x, k) => (k === oi ? { ...x, value: e.target.value } : x)) })} className="h-7 w-32 font-mono text-xs" />
                        <Input value={o.label} onChange={(e) => upDef(i, { options: d.options!.map((x, k) => (k === oi ? { ...x, label: e.target.value } : x)) })} className="h-7 w-48" />
                        <input type="color" value={o.color ?? '#9ca3af'} onChange={(e) => upDef(i, { options: d.options!.map((x, k) => (k === oi ? { ...x, color: e.target.value } : x)) })} className="h-7 w-9 rounded border border-border bg-bg" />
                        <button className="text-fg-faint hover:text-danger" onClick={() => upDef(i, { options: d.options!.filter((_, k) => k !== oi) })}><Trash2 size={12} /></button>
                      </div>
                    ))}
                    <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => upDef(i, { options: [...(d.options ?? []), { value: `opt_${(d.options?.length ?? 0) + 1}`, label: 'Option' }] })}>Add option</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {draft.field_defs.length === 0 && <div className="text-sm text-fg-faint">No typed fields. Items of this type only use the built-in properties.</div>}
        </div>
      </div>
    </div>
  );
}
