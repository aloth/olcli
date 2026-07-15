# Migration to the tracked-review fork

This guide covers migration from upstream `@aloth/olcli` 0.7.x to the
experimental `@xyin-anl/olcli` fork.

## Package identity

The fork uses a separate npm scope and experimental dist-tag so it cannot
replace the upstream package accidentally. The scoped package has not been
published yet. For the current source checkout, use:

```bash
npm ci
npm run build
npm link
```

After the first approved npm release, migration from upstream will use:

```bash
npm uninstall -g @aloth/olcli
npm install -g @xyin-anl/olcli@experimental
```

The executable names remain `olcli`, `olcli-mcp`, and
`git-remote-overleaf`. Do not install upstream and the fork globally at the
same time because their executable names collide.

Library imports change to:

```ts
import { OverleafClient } from '@xyin-anl/olcli';
```

## Intentional safety changes

MCP Overleaf mutations now default off. Configure the least capable mode that
fits the agent:

```text
OLCLI_MCP_REVIEW_MODE=read
OLCLI_MCP_REVIEW_MODE=suggest
OLCLI_MCP_REVIEW_MODE=full
```

Tracked-review mutations also require `OLCLI_EXPERIMENTAL_REVIEW=1`. For the
CLI, `--experimental-review` is an equivalent per-invocation opt-in. Read-only
capability, comment, tracked-change, and history commands do not require it.

MCP mutation-shaped tools default to dry-run. A caller must explicitly pass
`dry_run: false` plus the document version and source SHA-256 from a fresh
preview.

## Workflow data

`review address` creates `.olcli-review.json` by default. Schema version 1
stores operation, thread, document, change, Git, timestamp, state, and hash
metadata; it does not store source passages or reply bodies. Add the file to a
private workflow backup if durable reconciliation across machines is needed.

## History and Git

`history list` and `history diff` expose read-only native Overleaf history.
Their version numbers are not Git commits or document OT versions. The Git
remote helper still imports the current Overleaf state as one snapshot and
does not replay native history.

## Recommended first run

1. Authenticate against a disposable project.
2. Run `changes doctor`, `changes list`, and `history list`.
3. Preview a targeted suggestion with `changes suggest --dry-run`.
4. Enable experimental mutation and submit with both preview preconditions.
5. Compile and verify the native change in Overleaf.
6. Configure MCP in `suggest` mode only after the CLI round trip succeeds.
