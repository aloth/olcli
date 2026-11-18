/**
 * The Node.js version olcli 1.0 will require, and the one-line notice the
 * CLI prints on an older runtime until then. The `engines` field still allows
 * Node 20.18.1; this only gives people a release cycle of warning.
 *
 * Printed only by the `olcli` command, only when both stdout and stderr are a
 * terminal, so scripts, pipes, CI logs, the MCP server (stdio) and the git
 * remote helper never see it.
 */

export const NEXT_NODE_MAJOR = 22;

export function nodeMajor(version: string = process.versions.node): number {
  return Number.parseInt(version.split('.')[0], 10);
}

export function nodeFloorNotice(
  version: string = process.versions.node,
  streams: { stdout: { isTTY?: boolean }; stderr: { isTTY?: boolean } } = process,
): string | undefined {
  const major = nodeMajor(version);
  if (!Number.isFinite(major) || major >= NEXT_NODE_MAJOR) return undefined;
  if (!streams.stdout.isTTY || !streams.stderr.isTTY) return undefined;
  return `olcli 1.0 requires Node ${NEXT_NODE_MAJOR} or newer; this is Node ${version}. Please upgrade before then.`;
}
