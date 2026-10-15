// ============================================================================
// Workflow engine contract. Implementation in ./engine.ts (pure; no I/O).
// The same evaluator runs on the client (to show/disable transition buttons
// instantly) and on the server (authoritative, before committing).
// ============================================================================
import type { WorkItem, WorkflowState, WorkflowTransition, ProjectRole, StateCategory, Guard, Effect } from '../schema/entities.js';

export interface WorkflowDefinition {
  id: string;
  key: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

/** Everything a guard may need; the caller (server/client) loads it. */
export interface GuardContext {
  actorId: string;
  actorRole: ProjectRole | null;           // effective role in the item's project
  now: Date;
  openBlockerCount: number;                // from item_open_blockers()
  childrenCategories: StateCategory[];     // categories of direct children
  labelNames: string[];
}

export interface GuardFailure { guard: Guard; reason: string }

export interface TransitionResult {
  ok: boolean;
  transition: WorkflowTransition;
  toState: WorkflowState;
  failures: GuardFailure[];
  /** Field patch to apply to the item (state_id + set_field effects). */
  patch: Partial<WorkItem>;
  /** Effects the caller must execute with I/O (notify, webhook, parent/children transitions, labels). */
  deferredEffects: Effect[];
}

export interface WorkflowEngine {
  /** Transitions available from the item's current state (guards NOT evaluated). */
  availableTransitions(def: WorkflowDefinition, item: Pick<WorkItem, 'state_id'>): WorkflowTransition[];
  /** Evaluate guards and compute the patch/effects for one transition. */
  evaluate(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): TransitionResult;
  /** Shortcut used by the client to grey out buttons. */
  canTransition(def: WorkflowDefinition, item: WorkItem, transitionKey: string, ctx: GuardContext): boolean;
  initialState(def: WorkflowDefinition): WorkflowState;
  /** Validate a workflow definition: one initial state, transitions reference known states, keys unique, every state reachable. */
  validateDefinition(def: WorkflowDefinition): string[];
}
