export const FILE_MUTATING_TOOLS = new Set([
  'ApplyPatch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export function isFileMutatingTool(canonicalName: string): boolean {
  return FILE_MUTATING_TOOLS.has(canonicalName);
}
