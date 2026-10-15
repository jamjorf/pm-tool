import type { ItemType, Project, User, WorkflowState, WorkflowTransition, Workflow, WorkItem } from '@pm/core';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const TYPE_ID = '33333333-3333-4333-8333-333333333333';
export const WF_ID = '44444444-4444-4444-8444-444444444444';
export const STATE_TODO = '55555555-5555-4555-8555-555555555551';
export const STATE_PROG = '55555555-5555-4555-8555-555555555552';
export const STATE_DONE = '55555555-5555-4555-8555-555555555553';
export const ITEM_ID = '66666666-6666-4666-8666-666666666666';

const synced = { version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null };

export const user: User = { id: USER_ID, email: 'alice@firm.com', name: 'Alice', avatar_url: null, firm_role: 'member', is_active: true, is_service: false, settings: {}, ...synced };
export const project: Project = { id: PROJECT_ID, key: 'RATES', name: 'Rates', description: null, status: 'active', visibility: 'firm', lead_id: null, team_id: null, item_seq: 3, default_type_id: TYPE_ID, allowed_type_ids: null, settings: {}, start_date: null, target_date: null, archived_at: null, ...synced };
export const workflow: Workflow = { id: WF_ID, key: 'standard', name: 'Standard', description: null, ...synced };
export const states: WorkflowState[] = [
  { id: STATE_TODO, workflow_id: WF_ID, key: 'todo', name: 'Todo', category: 'todo', color: '#60a5fa', sort: 0, is_initial: true, ...synced },
  { id: STATE_PROG, workflow_id: WF_ID, key: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#f59e0b', sort: 1, is_initial: false, ...synced },
  { id: STATE_DONE, workflow_id: WF_ID, key: 'done', name: 'Done', category: 'done', color: '#10b981', sort: 2, is_initial: false, ...synced },
];
export const transitions: WorkflowTransition[] = [
  { id: '77777777-7777-4777-8777-777777777771', workflow_id: WF_ID, key: 'start', name: 'Start', from_state_id: null, to_state_id: STATE_PROG, guards: [{ type: 'require_field', field: 'assignee_id' }], effects: [{ type: 'set_field', field: 'start_date', value: '$today', only_if_null: true }], sort: 0, ...synced },
  { id: '77777777-7777-4777-8777-777777777772', workflow_id: WF_ID, key: 'complete', name: 'Complete', from_state_id: null, to_state_id: STATE_DONE, guards: [], effects: [{ type: 'set_field', field: 'completed_at', value: '$now' }], sort: 1, ...synced },
];
export const itemType: ItemType = { id: TYPE_ID, key: 'task', name: 'Task', plural_name: 'Tasks', icon: null, color: '#60a5fa', description: null, workflow_id: WF_ID, field_defs: [{ key: 'severity', label: 'Severity', kind: 'select', options: [{ value: 's1', label: 'S1' }], default: 's1' }], is_container: false, sort: 0, is_active: true, ...synced };
export const item: WorkItem = { id: ITEM_ID, project_id: PROJECT_ID, type_id: TYPE_ID, number: 3, key: 'RATES-3', title: 'Existing item', description: '', state_id: STATE_TODO, priority: 3, assignee_id: null, reporter_id: USER_ID, start_date: null, due_date: null, estimate: null, fields: {}, confidential: false, sort_order: 1, created_by: USER_ID, completed_at: null, canceled_at: null, archived_at: null, ...synced };
