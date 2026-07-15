#!/usr/bin/env bash
#
# Read-only live checks for native Overleaf project history.

set -euo pipefail

CLI=(node dist/cli.js)

fail() {
  printf 'history E2E: %s\n' "$1" >&2
  exit 1
}

[[ -n "${OLCLI_E2E_PROJECT_ID:-}" ]] || fail 'OLCLI_E2E_PROJECT_ID is required'
[[ -n "${OLCLI_E2E_HISTORY_FILE:-}" ]] || fail 'OLCLI_E2E_HISTORY_FILE is required'
[[ -n "${OLCLI_E2E_HISTORY_FROM:-}" ]] || fail 'OLCLI_E2E_HISTORY_FROM is required'
[[ -n "${OLCLI_E2E_HISTORY_TO:-}" ]] || fail 'OLCLI_E2E_HISTORY_TO is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -f dist/cli.js ]] || fail 'dist/cli.js is missing; run npm run build first'

PROJECT_ID="${OLCLI_E2E_PROJECT_ID}"
FILE_PATH="${OLCLI_E2E_HISTORY_FILE}"
FROM_VERSION="${OLCLI_E2E_HISTORY_FROM}"
TO_VERSION="${OLCLI_E2E_HISTORY_TO}"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

PAGE="$TEST_DIR/page.json"
NEXT_PAGE="$TEST_DIR/next-page.json"
DIFF="$TEST_DIR/diff.json"

printf 'history E2E: listing normalized update groups\n'
"${CLI[@]}" history list "$PROJECT_ID" --limit 3 --json > "$PAGE"
jq -e \
  --arg project "$PROJECT_ID" \
  '.projectId == $project
    and (.entries | length > 0)
    and all(.entries[]; .toVersion > .fromVersion)
    and ([.. | objects | has("email")] | all(. == false))' \
  "$PAGE" >/dev/null

NEXT_BEFORE="$(jq -r '.nextBefore // empty' "$PAGE")"
if [[ -n "$NEXT_BEFORE" ]]; then
  printf 'history E2E: following the version cursor\n'
  "${CLI[@]}" history list "$PROJECT_ID" \
    --before "$NEXT_BEFORE" --limit 3 --json > "$NEXT_PAGE"
  jq -e --argjson before "$NEXT_BEFORE" \
    'all(.entries[]; .toVersion <= $before)' "$NEXT_PAGE" >/dev/null
fi

printf 'history E2E: fetching a metadata-only file diff\n'
"${CLI[@]}" history diff "$FILE_PATH" "$PROJECT_ID" \
  --from "$FROM_VERSION" \
  --to "$TO_VERSION" \
  --no-content \
  --json > "$DIFF"
jq -e \
  --arg project "$PROJECT_ID" \
  --arg path "$FILE_PATH" \
  --argjson from "$FROM_VERSION" \
  --argjson to "$TO_VERSION" \
  '.projectId == $project
    and .path == $path
    and .fromVersion == $from
    and .toVersion == $to
    and all(.chunks[]; has("text") | not)
    and (.stats.insertedCharacters >= 0)
    and (.stats.deletedCharacters >= 0)
    and (.stats.unchangedCharacters >= 0)' "$DIFF" >/dev/null

printf 'history E2E: passed (read-only; no project state was changed)\n'
