// All writes go through here: typed wrappers over rep.mutate with toasts.
import { useMemo } from 'react';
import type { ItemPatch, MutationArgsOf, ViewSpec, ViewKind } from '@pm/core';
import { useReplicache } from '../../sync/context';
import { GuardError } from '../../sync/mutators';
import { useSession } from '../../session';
import { useStore } from '../../store/hooks';
import { toast, toastError } from '../../lib/toast';
import { uuid } from '../../lib/util';

export function useActions() {
  const rep = useReplicache();
  const { me } = useSession();
  const store = useStore();

  return useMemo(() => {
    const run = async (p: Promise<unknown>, okMsg?: string) => {
      try {
        await p;
        if (okMsg) toast({ kind: 'success', title: okMsg, ttl: 2000 });
        return true;
      } catch (e) {
        if (e instanceof GuardError) toastError('Transition blocked', e.failures.map((f) => '• ' + f.reason).join('\n'));
        else toastError('Change failed', (e as Error).message);
        return false;
      }
    };

    const update = (id: string, patch: ItemPatch) => run(rep.mutate.updateItem({ id, patch }));
    const bulkUpdate = (ids: string[], patch: ItemPatch) =>
      ids.length === 1 ? update(ids[0]!, patch) : run(rep.mutate.bulkUpdateItems({ ids, patch }), `Updated ${ids.length} items`);

    return {
      async createItem(args: Omit<MutationArgsOf<'createItem'>, 'id'> & { id?: string }): Promise<string | null> {
        const id = args.id ?? uuid();
        const ok = await run(rep.mutate.createItem({ ...args, id }));
        return ok ? id : null;
      },
      update,
      bulkUpdate,
      setAssignee: (ids: string[], assignee_id: string | null) => bulkUpdate(ids, { assignee_id }),
      setPriority: (ids: string[], priority: number) => bulkUpdate(ids, { priority }),
      setDueDate: (ids: string[], due_date: string | null) => bulkUpdate(ids, { due_date }),
      setStartDate: (ids: string[], start_date: string | null) => bulkUpdate(ids, { start_date }),
      setEstimate: (id: string, estimate: number | null) => update(id, { estimate }),
      setTitle: (id: string, title: string) => update(id, { title }),
      setDescription: (id: string, description: string) => update(id, { description }),
      setFields: (id: string, fields: Record<string, unknown>) => update(id, { fields }),
      setConfidential: (id: string, confidential: boolean) => update(id, { confidential }),
      setType: (id: string, type_id: string) => update(id, { type_id }),

      transition: (id: string, transition_key: string, comment?: string) => run(rep.mutate.transitionItem({ id, transition_key, comment })),
      bulkTransition: async (ids: string[], transition_key: string) => {
        if (ids.length === 1) return run(rep.mutate.transitionItem({ id: ids[0]!, transition_key }));
        return run(rep.mutate.bulkTransitionItems({ ids, transition_key }), `Transitioned ${ids.length} items`);
      },
      reorder: (id: string, sort_order: number) => run(rep.mutate.reorderItem({ id, sort_order })),
      move: async (ids: string[], project_id: string) => {
        for (const id of ids) await run(rep.mutate.moveItem({ id, project_id }));
        toast({ kind: 'success', title: `Moved ${ids.length} item${ids.length > 1 ? 's' : ''}`, ttl: 2000 });
      },
      remove: async (ids: string[]) => {
        for (const id of ids) await run(rep.mutate.deleteItem({ id }));
        toast({
          kind: 'info',
          title: `Deleted ${ids.length} item${ids.length > 1 ? 's' : ''}`,
          action: { label: 'Undo', onClick: () => ids.forEach((id) => void rep.mutate.restoreItem({ id })) },
          ttl: 6000,
        });
      },
      restore: (id: string) => run(rep.mutate.restoreItem({ id })),

      addLabel: async (ids: string[], label_id: string) => {
        for (const item_id of ids) await run(rep.mutate.addLabel({ item_id, label_id }));
      },
      removeLabel: (item_id: string, label_id: string) => run(rep.mutate.removeLabel({ item_id, label_id })),
      toggleLabel: async (ids: string[], label_id: string) => {
        const all = ids.every((id) => (store.labelIdsByItem[id] ?? []).includes(label_id));
        for (const item_id of ids) {
          if (all) await run(rep.mutate.removeLabel({ item_id, label_id }));
          else if (!(store.labelIdsByItem[item_id] ?? []).includes(label_id)) await run(rep.mutate.addLabel({ item_id, label_id }));
        }
      },
      createLabel: async (name: string, project_id: string | null, color?: string | null) => {
        const id = uuid();
        const ok = await run(rep.mutate.createLabel({ id, project_id, name, color: color ?? null }));
        return ok ? id : null;
      },

      addRelation: (args: Omit<MutationArgsOf<'addRelation'>, 'id'>) => run(rep.mutate.addRelation({ ...args, id: uuid() })),
      removeRelation: (id: string) => run(rep.mutate.removeRelation({ id })),
      setParent: (id: string, parent_id: string | null) => run(rep.mutate.setParent({ id, parent_id })),

      addComment: (item_id: string, body: string, parent_id?: string | null) => run(rep.mutate.addComment({ id: uuid(), item_id, body, parent_id: parent_id ?? null })),
      editComment: (id: string, body: string) => run(rep.mutate.editComment({ id, body })),
      deleteComment: (id: string) => run(rep.mutate.deleteComment({ id })),

      watch: (item_id: string) => run(rep.mutate.watchItem({ item_id })),
      unwatch: (item_id: string) => run(rep.mutate.unwatchItem({ item_id })),
      isWatching: (item_id: string) => !!me && (store.watchersByItem[item_id] ?? []).some((w) => w.user_id === me.user.id && !w.muted),

      markRead: (id: string) => run(rep.mutate.markNotificationRead({ id })),
      markAllRead: () => run(rep.mutate.markAllNotificationsRead({})),

      createView: async (args: { project_id: string | null; name: string; kind: ViewKind; spec: ViewSpec; is_shared?: boolean; icon?: string | null }) => {
        const id = uuid();
        const ok = await run(rep.mutate.createView({ id, ...args }), 'View saved');
        return ok ? id : null;
      },
      updateView: (id: string, patch: MutationArgsOf<'updateView'>['patch'], msg?: string) => run(rep.mutate.updateView({ id, patch }), msg),
      deleteView: (id: string) => run(rep.mutate.deleteView({ id }), 'View deleted'),

      createProject: (args: Omit<MutationArgsOf<'createProject'>, 'id'>) => {
        const id = uuid();
        return run(rep.mutate.createProject({ id, ...args }), 'Project created').then((ok) => (ok ? id : null));
      },
      updateProject: (id: string, patch: MutationArgsOf<'updateProject'>['patch']) => run(rep.mutate.updateProject({ id, patch })),
      setProjectMember: (project_id: string, user_id: string, role: MutationArgsOf<'setProjectMember'>['role']) => run(rep.mutate.setProjectMember({ project_id, user_id, role })),
      removeProjectMember: (project_id: string, user_id: string) => run(rep.mutate.removeProjectMember({ project_id, user_id })),
      updateNotificationPreference: (args: MutationArgsOf<'updateNotificationPreference'>) => run(rep.mutate.updateNotificationPreference(args), 'Preferences saved'),
    };
  }, [rep, me, store.labelIdsByItem, store.watchersByItem]);
}

export type Actions = ReturnType<typeof useActions>;
