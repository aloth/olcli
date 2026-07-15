#!/usr/bin/env bash
#
# Explicitly gated live test for one native tracked replacement.
# This test leaves the verified suggestion pending in the disposable project.

set -euo pipefail

CLI=(node dist/cli.js)

fail() {
  printf 'review E2E: %s\n' "$1" >&2
  exit 1
}

if [[ "${OLCLI_ALLOW_REVIEW_MUTATIONS:-}" != "1" ]]; then
  fail 'refusing to mutate Overleaf; set OLCLI_ALLOW_REVIEW_MUTATIONS=1 for a disposable project'
fi
export OLCLI_EXPERIMENTAL_REVIEW=1

[[ -n "${OLCLI_E2E_PROJECT_ID:-}" ]] || fail 'OLCLI_E2E_PROJECT_ID is required'
[[ -n "${OLCLI_E2E_REVIEW_FILE:-}" ]] || fail 'OLCLI_E2E_REVIEW_FILE is required'
[[ -n "${OLCLI_E2E_REVIEW_OLD:-}" ]] || fail 'OLCLI_E2E_REVIEW_OLD must be a non-empty unique passage'
[[ -n "${OLCLI_E2E_REVIEW_NEW+x}" ]] || fail 'OLCLI_E2E_REVIEW_NEW must be set (it may be empty for a deletion)'
[[ "${OLCLI_E2E_REVIEW_OLD}" != "${OLCLI_E2E_REVIEW_NEW}" ]] || fail 'old and new passages must differ'

command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -f dist/cli.js ]] || fail 'dist/cli.js is missing; run npm run build first'

PROJECT_ID="${OLCLI_E2E_PROJECT_ID}"
FILE_PATH="${OLCLI_E2E_REVIEW_FILE}"
OLD_TEXT="${OLCLI_E2E_REVIEW_OLD}"
NEW_TEXT="${OLCLI_E2E_REVIEW_NEW}"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

BEFORE="$TEST_DIR/doctor-before.json"
PREVIEW="$TEST_DIR/preview.json"
RESULT="$TEST_DIR/result.json"
AFTER="$TEST_DIR/doctor-after.json"
CHANGES="$TEST_DIR/changes.json"

printf 'review E2E: checking capabilities\n'
"${CLI[@]}" changes doctor "$PROJECT_ID" --file "$FILE_PATH" --json > "$BEFORE"
jq -e '.canSuggest == true and .trackChangesStateReadable == true' "$BEFORE" >/dev/null

printf 'review E2E: preparing non-mutating preview\n'
"${CLI[@]}" changes suggest "$FILE_PATH" "$PROJECT_ID" \
  --old "$OLD_TEXT" \
  --new "$NEW_TEXT" \
  --dry-run \
  --json > "$PREVIEW"
jq -e '.version >= 0 and (.textSha256 | test("^[a-f0-9]{64}$"))' "$PREVIEW" >/dev/null

EXPECTED_VERSION="$(jq -r '.version' "$PREVIEW")"
EXPECTED_SHA256="$(jq -r '.textSha256' "$PREVIEW")"

printf 'review E2E: submitting one preconditioned tracked replacement\n'
"${CLI[@]}" changes suggest "$FILE_PATH" "$PROJECT_ID" \
  --old "$OLD_TEXT" \
  --new "$NEW_TEXT" \
  --expected-version "$EXPECTED_VERSION" \
  --expected-sha256 "$EXPECTED_SHA256" \
  --json > "$RESULT"
jq -e \
  --argjson expectedVersion "$EXPECTED_VERSION" \
  '.verified == true
    and .trackChangesStateRestored == true
    and .beforeVersion == $expectedVersion
    and .afterVersion > .beforeVersion
    and (.changeIds | length > 0)' \
  "$RESULT" >/dev/null

printf 'review E2E: verifying state restoration and native ranges\n'
"${CLI[@]}" changes doctor "$PROJECT_ID" --file "$FILE_PATH" --json > "$AFTER"
BEFORE_STATE="$(jq -cS '.trackChangesState' "$BEFORE")"
AFTER_STATE="$(jq -cS '.trackChangesState' "$AFTER")"
[[ "$BEFORE_STATE" == "$AFTER_STATE" ]] || fail 'tracked-changes state was not restored exactly'

"${CLI[@]}" changes list "$PROJECT_ID" --file "$FILE_PATH" --json > "$CHANGES"
while IFS= read -r change_id; do
  jq -e --arg id "$change_id" 'any(.[]; .id == $id)' "$CHANGES" >/dev/null \
    || fail 'a returned change ID was not found after re-listing'
done < <(jq -r '.changeIds[]' "$RESULT")

printf 'review E2E: compiling the disposable project\n'
"${CLI[@]}" compile "$PROJECT_ID" >/dev/null

printf 'review E2E: passed; inspect the pending suggestion in the Overleaf review panel\n'
