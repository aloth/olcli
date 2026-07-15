#!/usr/bin/env bash
#
# Explicitly gated live test for comment → suggestion → reply → reconciliation.
# It uses the safe `never` policy and rejects the test suggestion during cleanup.

set -euo pipefail

CLI=(node dist/cli.js)

fail() {
  printf 'review workflow E2E: %s\n' "$1" >&2
  exit 1
}

[[ "${OLCLI_ALLOW_REVIEW_MUTATIONS:-}" == "1" ]] \
  || fail 'refusing to mutate Overleaf; set OLCLI_ALLOW_REVIEW_MUTATIONS=1 for a disposable project'
export OLCLI_EXPERIMENTAL_REVIEW=1
[[ -n "${OLCLI_E2E_PROJECT_ID:-}" ]] || fail 'OLCLI_E2E_PROJECT_ID is required'
[[ -n "${OLCLI_E2E_THREAD_ID:-}" ]] || fail 'OLCLI_E2E_THREAD_ID is required'
[[ -n "${OLCLI_E2E_REVIEW_FILE:-}" ]] || fail 'OLCLI_E2E_REVIEW_FILE is required'
[[ -n "${OLCLI_E2E_REVIEW_OLD:-}" ]] || fail 'OLCLI_E2E_REVIEW_OLD is required'
[[ -n "${OLCLI_E2E_REVIEW_NEW:-}" ]] || fail 'OLCLI_E2E_REVIEW_NEW is required'
[[ -n "${OLCLI_E2E_OPERATION_ID:-}" ]] || fail 'OLCLI_E2E_OPERATION_ID is required as a UUID'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -f dist/cli.js ]] || fail 'dist/cli.js is missing; run npm run build first'

PROJECT_ID="${OLCLI_E2E_PROJECT_ID}"
THREAD_ID="${OLCLI_E2E_THREAD_ID}"
FILE_PATH="${OLCLI_E2E_REVIEW_FILE}"
OLD_TEXT="${OLCLI_E2E_REVIEW_OLD}"
NEW_TEXT="${OLCLI_E2E_REVIEW_NEW}"
OPERATION_ID="${OLCLI_E2E_OPERATION_ID}"
REPLY="${OLCLI_E2E_REPLY:-Proposed a tracked revision from the olcli disposable workflow test.}"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
LEDGER="$TEST_DIR/.olcli-review.json"
PREVIEW="$TEST_DIR/preview.json"
RESULT="$TEST_DIR/result.json"
RETRY="$TEST_DIR/retry.json"
RECONCILE="$TEST_DIR/reconcile.json"
REJECT_PREVIEW="$TEST_DIR/reject-preview.json"

printf 'review workflow E2E: previewing linked suggestion\n'
"${CLI[@]}" review address "$THREAD_ID" "$PROJECT_ID" \
  --file "$FILE_PATH" --old "$OLD_TEXT" --new "$NEW_TEXT" \
  --reply "$REPLY" --resolve never --operation-id "$OPERATION_ID" \
  --ledger "$LEDGER" --dry-run --json > "$PREVIEW"
jq -e '.relatedToComment == true and .resolutionPolicy == "never"' "$PREVIEW" >/dev/null

EXPECTED_VERSION="$(jq -r '.suggestion.version' "$PREVIEW")"
EXPECTED_SHA256="$(jq -r '.suggestion.textSha256' "$PREVIEW")"

printf 'review workflow E2E: creating suggestion and reply\n'
"${CLI[@]}" review address "$THREAD_ID" "$PROJECT_ID" \
  --file "$FILE_PATH" --old "$OLD_TEXT" --new "$NEW_TEXT" \
  --reply "$REPLY" --resolve never --operation-id "$OPERATION_ID" \
  --ledger "$LEDGER" --expected-version "$EXPECTED_VERSION" \
  --expected-sha256 "$EXPECTED_SHA256" --json > "$RESULT"
jq -e '.resumed == false and .entry.state == "suggested"
  and .entry.replyStatus == "posted" and (.entry.changeIds | length > 0)' "$RESULT" >/dev/null

printf 'review workflow E2E: verifying idempotent retry and private ledger\n'
"${CLI[@]}" review address "$THREAD_ID" "$PROJECT_ID" \
  --file "$FILE_PATH" --old "$OLD_TEXT" --new "$NEW_TEXT" \
  --reply "$REPLY" --resolve never --operation-id "$OPERATION_ID" \
  --ledger "$LEDGER" --json > "$RETRY"
jq -e '.resumed == true and .entry.replyStatus == "posted"' "$RETRY" >/dev/null
jq -e --arg old "$OLD_TEXT" --arg new "$NEW_TEXT" --arg reply "$REPLY" \
  '[.. | strings] | all((contains($old) or contains($new) or contains($reply)) | not)' \
  "$LEDGER" >/dev/null

printf 'review workflow E2E: verifying pending reconciliation\n'
"${CLI[@]}" review reconcile "$PROJECT_ID" --ledger "$LEDGER" --dry-run --json > "$RECONCILE"
jq -e '.items[0].state == "suggested"
  and .items[0].commentResolved == false
  and .items[0].commentResolutionPlanned == false' "$RECONCILE" >/dev/null

CHANGE_ID_CSV="$(jq -r '.entry.changeIds | join(",")' "$RESULT")"
IFS=',' read -r -a CHANGE_IDS <<<"$CHANGE_ID_CSV"
"${CLI[@]}" changes reject "$FILE_PATH" "${CHANGE_IDS[@]}" \
  --project "$PROJECT_ID" --dry-run --json > "$REJECT_PREVIEW"
REJECT_VERSION="$(jq -r '.version' "$REJECT_PREVIEW")"
REJECT_SHA256="$(jq -r '.textSha256' "$REJECT_PREVIEW")"
"${CLI[@]}" changes reject "$FILE_PATH" "${CHANGE_IDS[@]}" \
  --project "$PROJECT_ID" --expected-version "$REJECT_VERSION" \
  --expected-sha256 "$REJECT_SHA256" --json >/dev/null

printf 'review workflow E2E: reconciling rejection without resolving comment\n'
"${CLI[@]}" review reconcile "$PROJECT_ID" --ledger "$LEDGER" --json > "$RECONCILE"
jq -e '.items[0].state == "rejected" and .items[0].commentResolved == false' "$RECONCILE" >/dev/null
"${CLI[@]}" compile "$PROJECT_ID" >/dev/null

printf 'review workflow E2E: passed\n'
