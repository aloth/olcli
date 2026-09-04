# Contributing to olcli

Thanks for helping. This file covers the things a fresh clone does not tell
you: how to get the checks passing locally, which tests need a real Overleaf
account, and what happens to a pull request after you open it.

For how the code is shaped and why — there is no public Overleaf API, so the
client authenticates as a logged-in browser session — see `docs/ARCHITECTURE.md`.

## Getting set up

```bash
git clone https://github.com/aloth/olcli.git
cd olcli
npm ci
npm run build
```

Use `npm ci`, not `npm install`. CI fails when `package-lock.json` and
`package.json` disagree, which is the point — `npm install` would quietly
rewrite the lockfile and hide the disagreement until someone else hit it.

**Node 20.18.1 or newer.** That exact patch version is the floor, not "Node
20". `cheerio` pulls in `undici@7.x`, which references `File` as a global —
Node exposes it from 20 onwards, and every `undici` release in the range
declares `>=20.18.1` itself. On an older runtime olcli dies before printing
anything, `--version` included. CI runs 20.18.1 and 24: the floor itself, and
the version releases are built with.

To run your build as the `olcli` command:

```bash
npm link
```

## The checks

CI runs exactly these, in this order. Run them before pushing and there are no
surprises:

```bash
npm run lint
npm run build
npm test
```

A fourth step verifies the build actually emitted entry points:

```bash
for f in dist/cli.js dist/mcp.js dist/remote-helper.js dist/index.js; do
  test -s "$f" || echo "missing or empty: $f"
done
node dist/cli.js --version
```

`tsc` exiting zero does not prove anything was emitted, which is how a broken
Node floor once survived every other check.

### About lint warnings

`npm run lint` reports a pile of `no-explicit-any` **warnings** and exits
zero. They sit where untyped JSON comes back from Overleaf, which publishes no
schema for those responses. Treat the count as a budget: don't add to it
without reason, and don't take fixing the existing ones as a side quest inside
an unrelated pull request.

## Tests

`npm test` runs `tsx --test test/*.test.ts`. These need no Overleaf account
and no network — they are the ones CI runs.

**`test/e2e*.sh` are deliberately outside that glob.** They drive a real
Overleaf account: logging in, pulling, pushing and compiling against a live
project. Please do not "fix" their absence by widening the glob; CI has no
account, and a pull request that made it try would fail for everyone.

Prefer adding to the unit suite. Much of olcli is written so that it can be:
`diff.ts`, `ignore.ts`, `paths.ts`, `rename-plan.ts` and `scan.ts` are pure
functions over data, and `client.ts` request construction can be tested
against a local HTTP server that captures the outgoing request — see
`test/client.test.ts`. Reach for e2e only when the thing under test is the
conversation with Overleaf itself.

### Running the e2e suite

You need a real account, `jq`, and `npm link` so that `olcli` resolves to your
build. Authentication comes from the usual resolution order, so any of
`OVERLEAF_SESSION`, a `.olauth` file, or `olcli auth` will do.

`test/e2e.sh` looks for a project named `olcli test`, overridable:

```bash
OLCLI_E2E_PROJECT_NAME="my scratch project" ./test/e2e.sh
```

⚠️ `test/e2e-ignore.sh` and `test/e2e-issue7.sh` have a maintainer's project ID
hardcoded near the top. As written they only run for that account; point them
at your own project ID if you need them.

These suites create, rename and delete files on the project you point them at.
Use a scratch project, never one with work in it.

## Opening a pull request

Discuss first for anything beyond a small fix. Open an issue describing the
problem and the shape of the change; design questions get settled there, which
is faster than settling them in review of finished code. Small, obvious fixes
can go straight to a pull request.

**Write a CHANGELOG entry.** `CHANGELOG.md` is maintained by hand — nothing
generates it from commits. Add your entry under an `## [Unreleased]` heading
at the top, using the `Added` / `Changed` / `Fixed` sections already in use.
Say what changed and why it was worth changing; the existing entries are the
length to aim for. The maintainer folds `Unreleased` into a version at release
time.

Then the usual: branch, commit, push to your fork, open the pull request.

### What to expect from CI

**A first contribution sits at `action_required` until a maintainer approves
it.** GitHub holds workflow runs from first-time contributors. From your side
it looks like a broken pull request; it is a queue. Nothing to do but wait,
and it only happens once.

**CI checks out `refs/pull/<n>/merge`.** Your branch is tested as merged into
the current `main`, so a branch that is behind `main` is not by itself a
reason for a red build.

**"Update branch" is enabled on this repository.** It merges `main` into your
branch from a button, so a stale branch does not need a maintainer pushing to
your fork. The button only appears when the merge is clean — real conflicts
still mean merging `main` locally and resolving them yourself.

## Releases

You do not need to do any of this, but it explains where your change goes.

Releases are tag-triggered: pushing a `v*` tag runs `.github/workflows/publish.yml`,
which reinstalls from the lockfile, builds, tests, publishes to npm, and then
bumps the Homebrew formula in `aloth/homebrew-tap`. Nothing publishes from
`main` alone, and `ci.yml` never publishes anything.

That is the reason for the CHANGELOG entry: at release time your `Unreleased`
lines become the release notes, and a change that arrived without one has to
be reconstructed from its diff.

## Reporting bugs

Use the issue templates. For anything involving requests to Overleaf, include
the output of `olcli --verbose <command>`, which prints requests and responses
to stderr, and `olcli check`, which reports where credentials are coming from
without printing them.

Redact your session cookie. It is a live credential — anyone holding it is
logged into your account.
