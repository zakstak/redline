export function resolveStartupWorkspace(
  workspaceOverride: string | undefined,
  startupDirectory: string,
) {
  return workspaceOverride?.trim() ? workspaceOverride : startupDirectory;
}
