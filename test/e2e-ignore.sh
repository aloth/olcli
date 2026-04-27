#!/bin/bash
# E2E test for #19 (.olignore + built-in LaTeX artifact filtering)
# Ensures local LaTeX build noise never reaches Overleaf.
set -e

PROJECT_ID="697fca16dcd57d705b794c03"
TEST_DIR=$(mktemp -d)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TEST_ID="ign_${TIMESTAMP}"
PASSED=0
FAILED=0

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED+1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED+1)); }
sec()  { echo -e "\n${BLUE}── $1 ──${NC}"; }
info() { echo -e "${YELLOW}  → $1${NC}"; }

# Pause between API calls to avoid 429 rate limits
PAUSE=4

echo "Test ID: $TEST_ID"
echo "Test dir: $TEST_DIR"

# ─────────────────────────────────────────────────────────────────────
sec "1. olcli ignored — built-in defaults visible"
# ─────────────────────────────────────────────────────────────────────

OUT=$(olcli ignored "$TEST_DIR" 2>&1)
echo "$OUT" | grep -q "built-in defaults" && ok "lists built-in defaults" || fail "no built-in defaults section"
echo "$OUT" | grep -qE '^\s+\*\.aux\b' && ok "*.aux in defaults" || fail "*.aux missing"
echo "$OUT" | grep -qE '^\s+\*\.bbl\b' && ok "*.bbl in defaults" || fail "*.bbl missing"
echo "$OUT" | grep -qE '^\s+\*\.synctex\.gz\b' && ok "*.synctex.gz in defaults" || fail "*.synctex.gz missing"
echo "$OUT" | grep -qi "pdf" && ok "documents PDF special rule" || fail "PDF rule not documented"

# ─────────────────────────────────────────────────────────────────────
sec "2. --no-default-ignore disables defaults"
# ─────────────────────────────────────────────────────────────────────

OUT=$(olcli ignored "$TEST_DIR" --no-default-ignore 2>&1)
if echo "$OUT" | grep -q "built-in defaults"; then
  fail "--no-default-ignore should hide defaults"
else
  ok "--no-default-ignore hides defaults"
fi

# ─────────────────────────────────────────────────────────────────────
sec "3. .olignore file picked up"
# ─────────────────────────────────────────────────────────────────────

OLIGN_DIR="$TEST_DIR/with-olignore"
mkdir -p "$OLIGN_DIR"
cat > "$OLIGN_DIR/.olignore" <<EOF
# my project ignores
*.draft.tex
notes/
!important.aux
EOF

OUT=$(olcli ignored "$OLIGN_DIR" 2>&1)
echo "$OUT" | grep -q "\.olignore" && ok ".olignore section present" || fail ".olignore not loaded"
echo "$OUT" | grep -qE '^\s+\*\.draft\.tex\b' && ok ".olignore pattern visible" || fail ".olignore pattern not loaded"
echo "$OUT" | grep -qE '^\s+!important\.aux\b' && ok "negation pattern visible" || fail "negation not loaded"

# ─────────────────────────────────────────────────────────────────────
sec "4. .olignore.local stacks on top"
# ─────────────────────────────────────────────────────────────────────

cat > "$OLIGN_DIR/.olignore.local" <<EOF
machine-only.tex
EOF
OUT=$(olcli ignored "$OLIGN_DIR" 2>&1)
echo "$OUT" | grep -q "\.olignore\.local" && ok ".olignore.local section present" || fail ".olignore.local not loaded"
echo "$OUT" | grep -qE '^\s+machine-only\.tex\b' && ok ".olignore.local pattern visible" || fail "machine-only.tex not loaded"

# ─────────────────────────────────────────────────────────────────────
sec "5. push --dry-run filters LaTeX artifacts"
# ─────────────────────────────────────────────────────────────────────

PUSH_DIR="$TEST_DIR/push-dry"
mkdir -p "$PUSH_DIR"
# Marker file we EXPECT to appear in the upload list
MARKER="${TEST_ID}_marker.txt"
echo "marker payload" > "$PUSH_DIR/$MARKER"
# Build artifacts we expect to be filtered
echo "aux" > "$PUSH_DIR/${TEST_ID}_doc.aux"
echo "bbl" > "$PUSH_DIR/${TEST_ID}_doc.bbl"
echo "log" > "$PUSH_DIR/${TEST_ID}_doc.log"
echo "synctex" > "$PUSH_DIR/${TEST_ID}_doc.synctex.gz"
# PDF + sibling .tex → PDF should be ignored
echo "tex source" > "$PUSH_DIR/${TEST_ID}_doc.tex"
echo "pdf out"    > "$PUSH_DIR/${TEST_ID}_doc.pdf"
# Standalone PDF (no sibling .tex) → should NOT be ignored
echo "stand pdf" > "$PUSH_DIR/${TEST_ID}_diagram.pdf"
# Minimal .olcli.json so push can resolve the project
cat > "$PUSH_DIR/.olcli.json" <<EOF
{
  "projectId": "$PROJECT_ID",
  "projectName": "olcli test",
  "lastPull": "2020-01-01T00:00:00.000Z"
}
EOF

sleep $PAUSE
OUT=$(olcli push "$PUSH_DIR" --all --dry-run --show-ignored 2>&1)

# Slice output into the two relevant blocks so greps don't cross-contaminate.
UPL_BLOCK=$(echo "$OUT" | awk '/Would upload/{flag=1; next} flag')
IGN_BLOCK=$(echo "$OUT" | awk '/Ignored/{flag=1; next} /Would upload/{flag=0} flag')

# Expected to upload (check upload block only)
echo "$UPL_BLOCK" | grep -qF "$MARKER" && ok "marker .txt queued for upload" || fail "marker missing from upload"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.tex" && ok ".tex queued for upload" || fail ".tex missing from upload"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_diagram.pdf" && ok "standalone .pdf queued for upload" || fail "standalone .pdf missing"

# Expected to be ignored (check upload block does NOT contain them)
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.aux" && fail ".aux leaked into upload" || ok ".aux filtered"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.bbl" && fail ".bbl leaked into upload" || ok ".bbl filtered"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.log" && fail ".log leaked into upload" || ok ".log filtered"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.synctex.gz" && fail ".synctex.gz leaked" || ok ".synctex.gz filtered"

# PDF sibling rule: doc.pdf in ignored block, diagram.pdf in upload block
echo "$IGN_BLOCK" | grep -qF "${TEST_ID}_doc.pdf" && ok "sibling-tex .pdf in ignored list" || fail "doc.pdf not ignored"
echo "$IGN_BLOCK" | grep -qF "${TEST_ID}_diagram.pdf" && fail "standalone .pdf wrongly ignored" || ok "standalone .pdf preserved"

# ─────────────────────────────────────────────────────────────────────
sec "6. push --no-default-ignore disables built-ins"
# ─────────────────────────────────────────────────────────────────────

sleep $PAUSE
OUT=$(olcli push "$PUSH_DIR" --all --dry-run --no-default-ignore 2>&1)
UPL_BLOCK=$(echo "$OUT" | awk '/Would upload/{flag=1; next} flag')
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.aux" && ok ".aux uploaded with --no-default-ignore" || fail ".aux still filtered"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.pdf" && ok "sibling-rule disabled with --no-default-ignore" || fail "doc.pdf still filtered"

# ─────────────────────────────────────────────────────────────────────
sec "7. push --no-ignore is the full escape hatch"
# ─────────────────────────────────────────────────────────────────────

# Add a .olignore that would block doc.tex if respected
echo "${TEST_ID}_doc.tex" > "$PUSH_DIR/.olignore"
sleep $PAUSE
OUT=$(olcli push "$PUSH_DIR" --all --dry-run --no-ignore 2>&1)
UPL_BLOCK=$(echo "$OUT" | awk '/Would upload/{flag=1; next} flag')
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.tex" && ok ".tex uploaded despite .olignore (--no-ignore)" || fail "--no-ignore did not bypass .olignore"
echo "$UPL_BLOCK" | grep -qF "${TEST_ID}_doc.aux" && ok ".aux uploaded with --no-ignore" || fail ".aux still filtered with --no-ignore"
rm -f "$PUSH_DIR/.olignore"

# ─────────────────────────────────────────────────────────────────────
sec "8. .olignore overrides at project level"
# ─────────────────────────────────────────────────────────────────────

# Project ignores doc.tex; defaults still ignore doc.aux
echo "${TEST_ID}_doc.tex" > "$PUSH_DIR/.olignore"
sleep $PAUSE
OUT=$(olcli push "$PUSH_DIR" --all --dry-run --show-ignored 2>&1)
IGN_BLOCK=$(echo "$OUT" | awk '/Ignored/{flag=1; next} /Would upload/{flag=0} flag')
echo "$IGN_BLOCK" | grep -qF "${TEST_ID}_doc.tex" && ok ".tex listed as ignored via .olignore" || fail ".olignore pattern not applied"
# doc.tex is now ignored → sibling rule should NOT fire because…
# actually: PDF rule looks at filesystem, not at ignore decisions. So doc.pdf
# is STILL ignored (sibling doc.tex exists on disk regardless of ignore status).
# That is correct behavior — the PDF rule prevents accidental upload of build
# artifacts; whether the .tex itself is synced is independent.
echo "$IGN_BLOCK" | grep -qF "${TEST_ID}_doc.pdf" && ok "PDF rule still fires (sibling .tex on disk)" || fail "PDF rule unexpectedly disabled"
rm -f "$PUSH_DIR/.olignore"

# ─────────────────────────────────────────────────────────────────────
sec "9. Real upload smoke test: ignored files do NOT reach Overleaf"
# ─────────────────────────────────────────────────────────────────────

# Use unique names so we can detect them on the remote without touching
# unrelated files. We rely on the fact that 'olcli download <file>' fails
# with non-zero exit code when the file does not exist.
SMOKE_AUX="${TEST_ID}_smoke.aux"
SMOKE_TEX="${TEST_ID}_smoke.tex"
SMOKE_PDF="${TEST_ID}_smoke.pdf"
SMOKE_DIAG="${TEST_ID}_smoke_diagram.pdf"

SMOKE_DIR="$TEST_DIR/smoke"
mkdir -p "$SMOKE_DIR"
cat > "$SMOKE_DIR/.olcli.json" <<EOF
{
  "projectId": "$PROJECT_ID",
  "projectName": "olcli test",
  "lastPull": "2020-01-01T00:00:00.000Z"
}
EOF
echo "should-not-upload"  > "$SMOKE_DIR/$SMOKE_AUX"
echo "should-upload"      > "$SMOKE_DIR/$SMOKE_TEX"
echo "should-not-upload"  > "$SMOKE_DIR/$SMOKE_PDF"
echo "should-upload"      > "$SMOKE_DIR/$SMOKE_DIAG"

sleep $PAUSE
info "real push (ignore active)"
olcli push "$SMOKE_DIR" --all >/dev/null 2>&1 && ok "push completed" || fail "push failed"

sleep $PAUSE
info "verifying $SMOKE_TEX uploaded"
olcli download "$SMOKE_TEX" "$PROJECT_ID" -o "$TEST_DIR/_dl_tex" >/dev/null 2>&1 \
  && ok "$SMOKE_TEX is on remote" || fail "$SMOKE_TEX missing from remote"

sleep $PAUSE
info "verifying $SMOKE_DIAG (standalone .pdf) uploaded"
olcli download "$SMOKE_DIAG" "$PROJECT_ID" -o "$TEST_DIR/_dl_diag" >/dev/null 2>&1 \
  && ok "$SMOKE_DIAG is on remote" || fail "$SMOKE_DIAG missing from remote"

sleep $PAUSE
info "verifying $SMOKE_AUX did NOT upload"
if olcli download "$SMOKE_AUX" "$PROJECT_ID" -o "$TEST_DIR/_dl_aux" >/dev/null 2>&1; then
  fail "$SMOKE_AUX leaked to remote"
else
  ok "$SMOKE_AUX correctly absent from remote"
fi

sleep $PAUSE
info "verifying $SMOKE_PDF (sibling-of-tex) did NOT upload"
if olcli download "$SMOKE_PDF" "$PROJECT_ID" -o "$TEST_DIR/_dl_pdf" >/dev/null 2>&1; then
  fail "$SMOKE_PDF leaked to remote"
else
  ok "$SMOKE_PDF correctly absent from remote"
fi

# Cleanup uploaded files from remote
sleep $PAUSE
info "cleaning up uploaded test files from remote"
olcli delete "$SMOKE_TEX"  "$PROJECT_ID" >/dev/null 2>&1 || true
sleep $PAUSE
olcli delete "$SMOKE_DIAG" "$PROJECT_ID" >/dev/null 2>&1 || true

# ─────────────────────────────────────────────────────────────────────
sec "Summary"
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((PASSED + FAILED))
echo "Passed: $PASSED / $TOTAL"
if [ $FAILED -gt 0 ]; then
  echo -e "${RED}$FAILED test(s) failed${NC}"
  exit 1
fi
echo -e "${GREEN}All tests passed${NC}"
