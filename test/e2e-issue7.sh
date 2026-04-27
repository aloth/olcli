#!/bin/bash
# Focused test for #7 fix and re-enabled delete/rename commands.
# Runs slowly to avoid 429 rate limits.
set -e

PROJECT_ID="697fca16dcd57d705b794c03"
TEST_DIR=$(mktemp -d)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TEST_ID="del_test_${TIMESTAMP}"
PASSED=0
FAILED=0

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED+1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED+1)); }
sec()  { echo -e "\n${BLUE}── $1 ──${NC}"; }
info() { echo -e "${YELLOW}  → $1${NC}"; }

PAUSE=4

# Use a single dedicated subfolder name for this test run
RENAME_OLD="${TEST_ID}_rename_old.txt"
RENAME_NEW="${TEST_ID}_rename_new.txt"
DELETE_FILE="${TEST_ID}_to_delete.txt"
SYNC_DEL_FILE="${TEST_ID}_sync_del.txt"
NODEL_FILE="${TEST_ID}_nodel.txt"

echo "Test ID: $TEST_ID"
echo "Test dir: $TEST_DIR"
echo "Pause between API calls: ${PAUSE}s"

# ─────────────────────────────────────────────────────────────────────
sec "1. delete CLI command"
# ─────────────────────────────────────────────────────────────────────

echo "delete payload" > "$TEST_DIR/$DELETE_FILE"
sleep $PAUSE
info "uploading $DELETE_FILE"
olcli upload "$TEST_DIR/$DELETE_FILE" "$PROJECT_ID" >/dev/null 2>&1 && ok "upload" || fail "upload"

sleep $PAUSE
info "deleting $DELETE_FILE via 'olcli delete'"
olcli delete "$DELETE_FILE" "$PROJECT_ID" >/dev/null 2>&1 && ok "delete command" || fail "delete command"

sleep $PAUSE
info "verifying it is gone (should fail)"
if olcli download "$DELETE_FILE" "$PROJECT_ID" -o "$TEST_DIR/_dl_check.txt" >/dev/null 2>&1; then
  fail "delete left file accessible"
else
  ok "deleted file no longer downloadable"
fi

# ─────────────────────────────────────────────────────────────────────
sec "2. rename CLI command"
# ─────────────────────────────────────────────────────────────────────

echo "rename payload" > "$TEST_DIR/$RENAME_OLD"
sleep $PAUSE
info "uploading $RENAME_OLD"
olcli upload "$TEST_DIR/$RENAME_OLD" "$PROJECT_ID" >/dev/null 2>&1 && ok "upload" || fail "upload"

sleep $PAUSE
info "renaming to $RENAME_NEW via 'olcli rename'"
olcli rename "$RENAME_OLD" "$RENAME_NEW" "$PROJECT_ID" >/dev/null 2>&1 && ok "rename command" || fail "rename command"

sleep $PAUSE
info "downloading under new name"
olcli download "$RENAME_NEW" "$PROJECT_ID" -o "$TEST_DIR/_rn_check.txt" >/dev/null 2>&1 && ok "renamed file accessible under new name" || fail "renamed file accessible under new name"

sleep $PAUSE
info "downloading under old name (should fail)"
if olcli download "$RENAME_OLD" "$PROJECT_ID" -o "$TEST_DIR/_rn_old.txt" >/dev/null 2>&1; then
  fail "old name still accessible after rename"
else
  ok "old name no longer accessible"
fi

sleep $PAUSE
info "cleanup: deleting $RENAME_NEW"
olcli delete "$RENAME_NEW" "$PROJECT_ID" >/dev/null 2>&1 && ok "cleanup delete" || fail "cleanup delete"

# ─────────────────────────────────────────────────────────────────────
sec "3. sync propagates local deletion (issue #7)"
# ─────────────────────────────────────────────────────────────────────

SYNC_DIR="$TEST_DIR/sync_proj"
mkdir -p "$SYNC_DIR"

echo "sync deletion payload" > "$TEST_DIR/$SYNC_DEL_FILE"
sleep $PAUSE
info "seeding remote with $SYNC_DEL_FILE"
olcli upload "$TEST_DIR/$SYNC_DEL_FILE" "$PROJECT_ID" >/dev/null 2>&1 && ok "seed upload" || fail "seed upload"

sleep $PAUSE
info "initial pull (writes manifest)"
olcli pull "$PROJECT_ID" "$SYNC_DIR" --force >/dev/null 2>&1 && ok "pull" || fail "pull"

if grep -q "$SYNC_DEL_FILE" "$SYNC_DIR/.olcli.json"; then
  ok "manifest contains seeded file"
else
  fail "manifest missing seeded file"
  cat "$SYNC_DIR/.olcli.json"
fi

info "deleting $SYNC_DEL_FILE locally"
rm -f "$SYNC_DIR/$SYNC_DEL_FILE"
[ ! -f "$SYNC_DIR/$SYNC_DEL_FILE" ] && ok "local file removed" || fail "rm failed"

sleep $PAUSE
info "sync --dry-run --verbose (should report deletion, not apply it)"
DRY_OUT=$(cd "$SYNC_DIR" && olcli sync --dry-run --verbose 2>&1)
if echo "$DRY_OUT" | grep -q "deleted on remote\|Deleted on remote"; then
  ok "dry-run reports planned deletion"
else
  fail "dry-run did not surface deletion"
  echo "$DRY_OUT"
fi

sleep $PAUSE
info "verifying file STILL on remote after dry-run"
olcli download "$SYNC_DEL_FILE" "$PROJECT_ID" -o "$TEST_DIR/_dryrun.txt" >/dev/null 2>&1 && ok "dry-run did not delete" || fail "dry-run incorrectly deleted"

sleep $PAUSE
info "real sync (should propagate deletion)"
SYNC_OUT=$(cd "$SYNC_DIR" && olcli sync --verbose 2>&1)
echo "$SYNC_OUT" | tail -10
if echo "$SYNC_OUT" | grep -q "deleted on remote"; then
  ok "sync reported deletion"
else
  fail "sync did not report deletion"
fi

sleep $PAUSE
info "verifying file is GONE from remote"
if olcli download "$SYNC_DEL_FILE" "$PROJECT_ID" -o "$TEST_DIR/_post.txt" >/dev/null 2>&1; then
  fail "BUG #7 NOT FIXED: file still on remote after sync"
else
  ok "file deleted from remote (issue #7 fixed!)"
fi

[ ! -f "$SYNC_DIR/$SYNC_DEL_FILE" ] && ok "local file stays deleted" || fail "local file resurrected"

# ─────────────────────────────────────────────────────────────────────
sec "4. sync --no-delete safety flag"
# ─────────────────────────────────────────────────────────────────────

echo "no-delete payload" > "$TEST_DIR/$NODEL_FILE"
sleep $PAUSE
info "seeding $NODEL_FILE"
olcli upload "$TEST_DIR/$NODEL_FILE" "$PROJECT_ID" >/dev/null 2>&1 && ok "seed upload" || fail "seed upload"

sleep $PAUSE
info "refreshing manifest"
olcli pull "$PROJECT_ID" "$SYNC_DIR" --force >/dev/null 2>&1 && ok "pull refresh" || fail "pull refresh"

info "deleting locally"
rm -f "$SYNC_DIR/$NODEL_FILE"

sleep $PAUSE
info "sync --no-delete"
(cd "$SYNC_DIR" && olcli sync --no-delete >/dev/null 2>&1) && ok "sync --no-delete success" || fail "sync --no-delete failed"

sleep $PAUSE
info "verifying file STILL on remote (--no-delete protected it)"
olcli download "$NODEL_FILE" "$PROJECT_ID" -o "$TEST_DIR/_nodel.txt" >/dev/null 2>&1 && ok "--no-delete preserved file" || fail "--no-delete failed to preserve"

sleep $PAUSE
info "cleanup: deleting $NODEL_FILE"
olcli delete "$NODEL_FILE" "$PROJECT_ID" >/dev/null 2>&1 && ok "cleanup delete" || fail "cleanup delete"

# ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "  Passed: ${GREEN}$PASSED${NC}    Failed: ${RED}$FAILED${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
[ $FAILED -eq 0 ] && exit 0 || exit 1
