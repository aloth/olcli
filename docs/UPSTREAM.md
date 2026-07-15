# Upstream synchronization

This fork tracks [`aloth/olcli`](https://github.com/aloth/olcli) as `upstream`.
It publishes, if explicitly approved, under the separate experimental package
name `@xyin-anl/olcli`; never change the fork back to the upstream npm scope.

The fork baseline is upstream version `v0.7.0` at commit:

```text
e1447668ececfd61dd745eb7ef19b970dfe9c8fb
```

Configure and inspect the remotes:

```bash
git remote add upstream https://github.com/aloth/olcli.git
git fetch upstream --tags
git remote -v
```

Update the fork from upstream without rewriting `main` unexpectedly. The fork
uses `dev` as its experimental integration branch:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch dev
git rebase main
git switch <feature-branch>
git rebase dev
```

If upstream has diverged from the fork's review-protocol modules, resolve those
conflicts on a short-lived branch and rerun `npm run typecheck`, `npm test`, and
`npm run build` before merging.

Do not copy implementation code from Overleaf's AGPL repository into this MIT
repository without an explicit licensing review. It may be used to understand
observable behavior and protocol shapes.

## Contribution boundaries

Prefer small upstreamable changes for generally useful pieces such as redacted
logging, error serialization, test infrastructure, or real-time session
cleanup. Keep fork-specific agent policy, review-ledger orchestration,
experimental feature gates, and release identity in separate commits/modules
so an upstream pull request does not inherit local policy accidentally.

Before proposing an upstream change:

1. Rebase on the latest upstream `main` in a short-lived branch.
2. Remove fork package/release metadata from the proposed patch.
3. Confirm no sanitized fixture contains real IDs, emails, credentials, or
   manuscript text.
4. Run `npm run verify` and `npm pack --dry-run`.
5. Explain that internal Overleaf protocols are unsupported and identify any
   behavior learned from AGPL sources without copying their implementation.
