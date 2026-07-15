#!/usr/bin/env bash
#
# Explicitly gated live test for accepting or rejecting selected native ranges.

set -euo pipefail

CLI=(node dist/cli.js)

fail() {
  printf 'resolution E2E: %s\n' "$1" >&2
  exit 1
}

[[ "${OLCLI_ALLOW_REVIEW_MUTATIONS:-}" == "1" ]] \
  || fail 'refusing to mutate Overleaf; set OLCLI_ALLOW_REVIEW_MUTATIONS=1 for a disposable project'
export OLCLI_EXPERIMENTAL_REVIEW=1
[[ -n "${OLCLI_E2E_PROJECT_ID:-}" ]] || fail 'OLCLI_E2E_PROJECT_ID is required'
[[ -n "${OLCLI_E2E_REVIEW_FILE:-}" ]] || fail 'OLCLI_E2E_REVIEW_FILE is required'
[[ -n "${OLCLI_E2E_CHANGE_IDS:-}" ]] || fail 'OLCLI_E2E_CHANGE_IDS is required as comma-separated explicit IDs'
[[ "${OLCLI_E2E_RESOLUTION:-}" == "accept" || "${OLCLI_E2E_RESOLUTION:-}" == "reject" ]] \
  || fail 'OLCLI_E2E_RESOLUTION must be accept or reject'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -f dist/cli.js ]] || fail 'dist/cli.js is missing; run npm run build first'

PROJECT_ID="${OLCLI_E2E_PROJECT_ID}"
FILE_PATH="${OLCLI_E2E_REVIEW_FILE}"
ACTION="${OLCLI_E2E_RESOLUTION}"
IFS=',' read -r -a CHANGE_IDS <<<"${OLCLI_E2E_CHANGE_IDS}"
[[ "${#CHANGE_IDS[@]}" -gt 0 ]] || fail 'at least one change ID is required'

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
BEFORE="$TEST_DIR/doctor-before.json"
PREVIEW="$TEST_DIR/preview.json"
RESULT="$TEST_DIR/result.json"
AFTER="$TEST_DIR/doctor-after.json"
CHANGES="$TEST_DIR/changes.json"

printf 'resolution E2E: checking capabilities\n'
"${CLI[@]}" changes doctor "$PROJECT_ID" --file "$FILE_PATH" --json > "$BEFORE"
jq -e --arg action "$ACTION" '
  .trackChangesStateReadable == true
  and (if $action == "accept" then .canAccept else .canReject end) == true
' "$BEFORE" >/dev/null

printf 'resolution E2E: preparing non-mutating preview\n'
"${CLI[@]}" changes "$ACTION" "$FILE_PATH" "${CHANGE_IDS[@]}" \
  --project "$PROJECT_ID" \
  --dry-run \
  --json > "$PREVIEW"
EXPECTED_VERSION="$(jq -r '.version' "$PREVIEW")"
EXPECTED_SHA256="$(jq -r '.textSha256' "$PREVIEW")"
jq -e --arg action "$ACTION" --argjson count "${#CHANGE_IDS[@]}" '
  .action == $action and .version >= 0 and (.changeIds | length) == $count
' "$PREVIEW" >/dev/null

printf 'resolution E2E: resolving explicit IDs\n'
"${CLI[@]}" changes "$ACTION" "$FILE_PATH" "${CHANGE_IDS[@]}" \
  --project "$PROJECT_ID" \
  --expected-version "$EXPECTED_VERSION" \
  --expected-sha256 "$EXPECTED_SHA256" \
  --json > "$RESULT"
jq -e '.verified == true and .beforeVersion >= 0 and .afterVersion >= .beforeVersion' "$RESULT" >/dev/null

printf 'resolution E2E: verifying IDs, state, and compilation\n'
"${CLI[@]}" changes list "$PROJECT_ID" --file "$FILE_PATH" --json > "$CHANGES"
for change_id in "${CHANGE_IDS[@]}"; do
  jq -e --arg id "$change_id" 'all(.[]; .id != $id)' "$CHANGES" >/dev/null \
    || fail 'a requested change ID remains after resolution'
done

"${CLI[@]}" changes doctor "$PROJECT_ID" --file "$FILE_PATH" --json > "$AFTER"
[[ "$(jq -cS '.trackChangesState' "$BEFORE")" == "$(jq -cS '.trackChangesState' "$AFTER")" ]] \
  || fail 'tracked-changes state changed during resolution'
"${CLI[@]}" compile "$PROJECT_ID" >/dev/null

printf 'resolution E2E: passed\n'
