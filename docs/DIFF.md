# Diff

`olcli diff` compares the bytes of your local files against the project's current contents and prints a unified diff.

```bash
olcli diff                 # every changed file, as patches
olcli diff --name-only     # just the changed paths
olcli diff --file main.tex # one file
olcli diff -U 8            # wider context
olcli diff --exit-code     # exit 1 if anything differs, for CI
```

**The remote side is fetched fresh on every run.** The diff describes the project as it is at that moment, which is what a subsequent `push` would overwrite, and not a comparison against your last `pull`. `.olcli.json` records remote *paths*, never remote *contents*, so there is no stored snapshot to compare against; and the whole project arrives in a single request, the same one `pull` makes, so fetching fresh costs one round trip rather than one per file. A collaborator editing between `diff` and `push` can still change the outcome, which is why the fetch time is printed.

In the output, `a/` is the remote and `b/` is local: a `+` line is content `push` would upload, a `-` line is content it would overwrite. Files that differ only in bytes that are not text (PDFs, images) are reported as `Binary files ... differ`. Both sides pass through the same ignore layers, so build artifacts sitting on Overleaf are not reported as locally deleted.

`diff --name-only` and `push --dry-run` answer different questions and will disagree. `push --dry-run` lists files whose **modification time** is newer than the last pull, because that is what `push` uploads; `diff` lists files whose **contents** actually differ. A file you touched without editing appears in the first and not the second.

## Marked-up revisions with latexdiff

A unified diff is the right artifact for a developer and the wrong one for a thesis advisor. `--latexdiff` marks the same revision up inside the document instead (deletions struck through, additions underlined), which is what advisors and journals ask for.

```bash
olcli diff --latexdiff          # write .olcli-diff/main-diff.tex
olcli diff --latexdiff --pdf    # ...and compile it, download .olcli-diff/main-diff.pdf
```

Requires `latexdiff` on your PATH. It ships with TeX Live and MacTeX; nothing else in `olcli diff` needs an external tool.

**`--pdf` compiles on Overleaf, so you do not need a local TeX installation.** The compile endpoint can only build a file that is in the project, so the marked-up document is uploaded as `olcli-latexdiff.tex` next to your root document, compiled, downloaded, and then removed. The command says so before it does it, refuses to overwrite a file of that name if one already exists, and prints the exact `olcli rm` command if the cleanup itself fails.

`\input` and `\include` are inlined before comparing (`--no-flatten` to opt out). Without that, a remote compile would resolve those against the files sitting in the project (the old content) and quietly produce a PDF showing every input file as unchanged.

Output goes to `.olcli-diff/`, which is dotted so that `push` and `sync` never pick it up; `-o <path>` puts it elsewhere. The root document is the `.tex` file declaring `\documentclass`; if several do, `--main <path>` picks one rather than the command guessing. `--latexdiff-opt` passes anything else straight through, e.g. `--latexdiff-opt --math-markup=0`.

One limit worth knowing: `--pdf` compiles against the project, not against your working directory, so anything the markup needs must already be on Overleaf. A `.sty` or `.cls` you added locally fails the compile, and the compiler log is written next to the marked-up source when that happens. A *figure* you added locally does not fail it; Overleaf draws a placeholder box naming the missing file and the rest of the PDF is fine.

## Using `diff` as a CI gate

`--exit-code` turns the command into a check, with the statuses `diff(1)` uses:

| Status | Meaning |
|--------|---------|
| `0` | Nothing differs |
| `1` | Something differs |
| `2` | The run failed: bad flags, no session, project unreachable |

```yaml
- name: Fail if the paper on Overleaf has drifted from the repo
  run: olcli diff --exit-code --name-only
  env:
    OVERLEAF_SESSION: ${{ secrets.OVERLEAF_SESSION }}
```

**The `1` versus `2` split is the point of the flag.** Without it a pipeline cannot tell a changed file from an expired session cookie, and a job that goes red for the second reason sends whoever reads the log hunting for a diff that was never computed. Every other olcli command reports failure as `1`, and `olcli diff` still does when `--exit-code` is absent, so adding the flag does not change what existing scripts see.

The gate covers whatever was compared: `--file main.tex` narrows it to one file, the way a `git diff --exit-code` pathspec does, and a `--file` that matches nothing is `0` rather than an error. Under `--latexdiff` it still reports on the project as a whole, since a changed figure is a real difference even though a marked-up root document cannot show it.

Note that this compares against Overleaf **now**, not against your last pull, so the check is "has anyone drifted from what is committed here", which is what makes it worth running on a schedule as well as on a push.
