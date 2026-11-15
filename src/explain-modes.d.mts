export type ExplainMode = 'overview' | 'callTree' | 'interactive'
export const CALL_TREE_PROMPT: string
export const WALKTHROUGH_FENCE: string
export const EXPLAIN_MODES: Record<ExplainMode, { label: string; prompt: string }>
export function isExplainMode(value: unknown): value is ExplainMode
