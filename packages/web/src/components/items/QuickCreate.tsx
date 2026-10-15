// `c` → quick-create: project, type, title, then properties.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Folder } from 'lucide-react';
import type { FieldDef } from '@pm/core';
import { useUI } from '../../state';
import { useStore, useProjectTypes } from '../../store/hooks';
import { useActions } from './useActions';
import { Dialog, Button, Input, Textarea, Avatar, Checkbox, Picker, type PickerItem } from '../ui';
import { AssigneePicker, PriorityPicker, DatePicker, LabelPicker, PriorityIcon, TypeIcon, DueDateLabel } from './properties';
import { FieldsForm, runValidate } from './FieldsForm';
import { PRIORITY_LABELS } from '@pm/core';
import { Calendar, Tag } from 'lucide-react';
import { useSession } from '../../session';

export function QuickCreate() {
  const { quickCreate, closeQuickCreate, openItem } = useUI();
  const { projects, projectsById, typesById, labelsById, usersById, itemsById } = useStore();
  const { me } = useSession();
  const a = useActions();
  const navigate = useNavigate();

  const [projectId, setProjectId] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [priority, setPriority] = useState(0);
  const [due, setDue] = useState<string | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confidential, setConfidential] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [anchor, setAnchor] = useState<{ kind: string; el: HTMLElement } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const project = projectsById[projectId];
  const types = useProjectTypes(project);
  const type = typesById[typeId];
  const defs: FieldDef[] = useMemo(() => type?.field_defs ?? [], [type]);
  const assigneeUser = assignee ? usersById[assignee] : undefined;
  const parentKey = quickCreate?.parent_id ? itemsById[quickCreate.parent_id]?.key : undefined;

  useEffect(() => {
    if (!quickCreate) return;
    const p = quickCreate.project_id ?? projects.find((x) => !x.archived_at)?.id ?? '';
    setProjectId(p);
    setTitle(quickCreate.title ?? '');
    setDescription('');
    setAssignee(null);
    setPriority(0);
    setDue(null);
    setLabelIds([]);
    setFields({});
    setErrors({});
    setConfidential(false);
    setTimeout(() => titleRef.current?.focus(), 30);
  }, [quickCreate, projects]);

  useEffect(() => {
    if (!project) return;
    const wanted = quickCreate?.type_id ?? project.default_type_id ?? types[0]?.id ?? '';
    setTypeId(types.some((t) => t.id === wanted) ? wanted : (types[0]?.id ?? ''));
  }, [project, types, quickCreate?.type_id]);

  useEffect(() => {
    // apply defaults when the type changes
    const next: Record<string, unknown> = {};
    for (const d of defs) if (d.default !== undefined) next[d.key] = d.default;
    setFields(next);
    setErrors({});
  }, [defs]);

  if (!quickCreate) return null;

  const submit = async () => {
    if (!projectId || !typeId || !title.trim()) return;
    const r = runValidate(defs, fields);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.value)) if (v !== null && v !== undefined && v !== '') cleanFields[k] = v;
    const id = await a.createItem({
      project_id: projectId,
      type_id: typeId,
      title: title.trim(),
      description: description || undefined,
      assignee_id: assignee,
      priority,
      due_date: due,
      label_ids: labelIds,
      parent_id: quickCreate.parent_id ?? null,
      fields: cleanFields,
      confidential,
      state_id: quickCreate.state_id,
    });
    if (!id) return;
    if (createMore) {
      setTitle('');
      setDescription('');
      titleRef.current?.focus();
    } else {
      closeQuickCreate();
      if (!location.pathname.startsWith('/p/')) navigate(`/p/${project?.key}`);
      openItem(id);
    }
  };

  const projectItems: PickerItem[] = projects.filter((p) => !p.archived_at).map((p) => ({ id: p.id, label: p.name, hint: p.key, icon: <Folder size={14} />, selected: p.id === projectId, keywords: p.key }));
  const typeItems: PickerItem[] = types.map((t) => ({ id: t.id, label: t.name, icon: <TypeIcon type={t} />, selected: t.id === typeId }));

  const chip = (kind: string, node: React.ReactNode, title?: string) => (
    <button type="button" title={title} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-fg-muted hover:bg-bg-muted" onClick={(e) => setAnchor({ kind, el: e.currentTarget })}>
      {node}
    </button>
  );

  return (
    <Dialog open onClose={closeQuickCreate} width={640} className="overflow-visible">
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        {chip('project', <><Folder size={13} /> {project?.name ?? 'Project'} <ChevronDown size={12} /></>, 'Project')}
        <span className="text-fg-faint">›</span>
        {chip('type', <><TypeIcon type={type} size={12} /> {type?.name ?? 'Type'} <ChevronDown size={12} /></>, 'Type')}
        {parentKey && <span className="text-fg-faint">child of {parentKey}</span>}
      </div>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Item title"
        className="mb-2 w-full bg-transparent text-lg font-medium outline-none placeholder:text-fg-faint"
      />
      <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description… (markdown)" rows={3} className="mb-3 border-0 bg-bg-subtle" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }} />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {chip('assignee', <><Avatar user={assigneeUser ?? null} size={14} /> {assigneeUser?.name ?? 'Assignee'}</>, 'Assignee')}
        {chip('priority', <><PriorityIcon priority={priority} size={13} /> {priority ? PRIORITY_LABELS[priority] : 'Priority'}</>, 'Priority')}
        {chip('due', <><Calendar size={13} /> {due ? <DueDateLabel date={due} /> : 'Due date'}</>, 'Due date')}
        {chip('labels', <><Tag size={13} /> {labelIds.length ? labelIds.map((id) => labelsById[id]?.name).filter(Boolean).join(', ') : 'Labels'}</>, 'Labels')}
        <Checkbox checked={confidential} onChange={setConfidential} label="Confidential" className="ml-1 text-xs text-fg-muted" />
      </div>
      {defs.length > 0 && (
        <div className="mb-3 rounded-md border border-border p-3">
          <FieldsForm defs={defs} value={fields} onChange={setFields} errors={errors} />
        </div>
      )}
      <div className="flex items-center justify-between">
        <Checkbox checked={createMore} onChange={setCreateMore} label="Create more" className="text-xs text-fg-muted" />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={closeQuickCreate}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!title.trim() || !projectId || !typeId} title="⌘↵">
            Create {type?.name ?? 'item'}
          </Button>
        </div>
      </div>

      <Picker open={anchor?.kind === 'project'} onClose={() => setAnchor(null)} anchor={anchor?.el ?? null} items={projectItems} onSelect={(i) => setProjectId(i.id)} placeholder="Project…" />
      <Picker open={anchor?.kind === 'type'} onClose={() => setAnchor(null)} anchor={anchor?.el ?? null} items={typeItems} onSelect={(i) => setTypeId(i.id)} placeholder="Type…" width={220} />
      <AssigneePicker open={anchor?.kind === 'assignee'} onClose={() => setAnchor(null)} anchor={anchor?.el ?? null} value={assignee} projectId={projectId} onChange={setAssignee} />
      <PriorityPicker open={anchor?.kind === 'priority'} onClose={() => setAnchor(null)} anchor={anchor?.el ?? null} value={priority} onChange={setPriority} />
      <DatePicker open={anchor?.kind === 'due'} onClose={() => setAnchor(null)} anchor={anchor?.el ?? null} value={due} onChange={setDue} />
      <LabelPicker
        open={anchor?.kind === 'labels'}
        onClose={() => setAnchor(null)}
        anchor={anchor?.el ?? null}
        projectId={projectId}
        selectedIds={new Set(labelIds)}
        onToggle={(id) => setLabelIds((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))}
        onCreate={async (name) => {
          const id = await a.createLabel(name, projectId || null);
          if (id) setLabelIds((xs) => [...xs, id]);
        }}
      />
      <span className="sr-only">{me?.user.name}</span>
    </Dialog>
  );
}

