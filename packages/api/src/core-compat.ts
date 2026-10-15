// ============================================================================
// Single import point for the @pm/core implementations the write path relies on.
// (Kept as a module so the API has one place to adapt if core's surface changes.)
// ============================================================================
export { diffItem, eventKindOf, extractMentions, extractItemKeys, validateFields, permissions, workflowEngine } from '@pm/core';
