#!/usr/bin/env bash
#
# Explicitly gated live test for stale-version rejection and comment anchors.
# The target must be a disposable project: this script uploads and deletes a
# fixture, creates and deletes three comments, and creates/rejects suggestions.

set -euo pipefail

CLI=(node dist/cli.js)

fail() {
  printf 'comment-anchor E2E: %s\n' "$1" >&2
  exit 1
}

if [[ "${OLCLI_ALLOW_REVIEW_MUTATIONS:-}" != "1" ]]; then
  fail 'refusing to mutate Overleaf; set OLCLI_ALLOW_REVIEW_MUTATIONS=1 for a disposable project'
fi
export OLCLI_EXPERIMENTAL_REVIEW=1

[[ -n "${OLCLI_E2E_PROJECT_ID:-}" ]] || fail 'OLCLI_E2E_PROJECT_ID is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -f dist/cli.js ]] || fail 'dist/cli.js is missing; run npm run build first'

PROJECT_ID="$OLCLI_E2E_PROJECT_ID"
FIXTURE_PATH="${OLCLI_E2E_ANCHOR_FIXTURE:-test/fixtures/e2e/comment-anchors.tex}"
REMOTE_FILE="$FIXTURE_PATH"
TARGET_OLD='original wording'
TARGET_NEW='revised tracked wording'
CONCURRENT_OLD='OLCLI_CONCURRENT_MARKER'
CONCURRENT_NEW='OLCLI_CONCURRENT_MARKER_UPDATED'
TEST_DIR="$(mktemp -d)"
THREAD_IDS=()
ACTIVE_CHANGE_IDS=()
THREAD_COUNT=0
ACTIVE_CHANGE_COUNT=0
THREADS_CLEANED=0
REMOTE_CREATED=0
API_PAUSE_SECONDS="${OLCLI_E2E_API_PAUSE_SECONDS:-1}"

pause_for_api() {
  sleep "$API_PAUSE_SECONDS"
}

cleanup() {
  local original_status=$?
  trap - EXIT
  set +e

  if [[ "$ACTIVE_CHANGE_COUNT" -gt 0 ]]; then
    "${CLI[@]}" changes reject "$REMOTE_FILE" "${ACTIVE_CHANGE_IDS[@]}" \
      --project "$PROJECT_ID" --json >/dev/null 2>&1
  fi
  if [[ "$THREADS_CLEANED" == "0" && "$THREAD_COUNT" -gt 0 ]]; then
    for thread_id in "${THREAD_IDS[@]}"; do
      "${CLI[@]}" comments delete "$thread_id" "$PROJECT_ID" >/dev/null 2>&1
    done
  fi
  if [[ "$REMOTE_CREATED" == "1" ]]; then
    "${CLI[@]}" delete "$REMOTE_FILE" "$PROJECT_ID" >/dev/null 2>&1
  fi
  rm -rf "$TEST_DIR"
  exit "$original_status"
}
trap cleanup EXIT

add_comment() {
  local selected_text="$1"
  local message="$2"
  local output_file="$3"
  local thread_id

  "${CLI[@]}" comments add "$REMOTE_FILE" "$message" "$PROJECT_ID" \
    --text "$selected_text" --json > "$output_file"
  pause_for_api
  thread_id="$(jq -r '.comment.threadId' "$output_file")"
  [[ -n "$thread_id" && "$thread_id" != "null" ]] || fail 'comment creation returned no thread ID'
  THREAD_IDS+=("$thread_id")
  THREAD_COUNT=$((THREAD_COUNT + 1))
  LAST_THREAD_ID="$thread_id"
}

preview_suggestion() {
  local old_text="$1"
  local new_text="$2"
  local output_file="$3"

  "${CLI[@]}" changes suggest "$REMOTE_FILE" "$PROJECT_ID" \
    --old "$old_text" --new "$new_text" --dry-run --json > "$output_file"
  pause_for_api
}

submit_suggestion() {
  local old_text="$1"
  local new_text="$2"
  local preview_file="$3"
  local output_file="$4"
  local version sha256

  version="$(jq -r '.version' "$preview_file")"
  sha256="$(jq -r '.textSha256' "$preview_file")"
  "${CLI[@]}" changes suggest "$REMOTE_FILE" "$PROJECT_ID" \
    --old "$old_text" --new "$new_text" \
    --expected-version "$version" --expected-sha256 "$sha256" \
    --json > "$output_file"
  pause_for_api
  jq -e '.verified == true and (.changeIds | length > 0)' "$output_file" >/dev/null
}

load_active_change_ids() {
  local result_file="$1"
  ACTIVE_CHANGE_IDS=()
  while IFS= read -r change_id; do
    ACTIVE_CHANGE_IDS+=("$change_id")
  done < <(jq -r '.changeIds[]' "$result_file")
  ACTIVE_CHANGE_COUNT="${#ACTIVE_CHANGE_IDS[@]}"
  [[ "$ACTIVE_CHANGE_COUNT" -gt 0 ]] || fail 'suggestion returned no change IDs'
}

reject_active_changes() {
  local preview_file="$1"
  local result_file="$2"
  local version sha256

  [[ "$ACTIVE_CHANGE_COUNT" -gt 0 ]] || fail 'there are no active change IDs to reject'
  "${CLI[@]}" changes reject "$REMOTE_FILE" "${ACTIVE_CHANGE_IDS[@]}" \
    --project "$PROJECT_ID" --dry-run --json > "$preview_file"
  pause_for_api
  version="$(jq -r '.version' "$preview_file")"
  sha256="$(jq -r '.textSha256' "$preview_file")"
  "${CLI[@]}" changes reject "$REMOTE_FILE" "${ACTIVE_CHANGE_IDS[@]}" \
    --project "$PROJECT_ID" --expected-version "$version" \
    --expected-sha256 "$sha256" --json > "$result_file"
  pause_for_api
  jq -e '.verified == true and (.remainingChangeIds | length == 0)' "$result_file" >/dev/null
  ACTIVE_CHANGE_COUNT=0
}

printf 'comment-anchor E2E: uploading isolated fixture\n'
"${CLI[@]}" delete "$REMOTE_FILE" "$PROJECT_ID" >/dev/null 2>&1 || true
pause_for_api
"${CLI[@]}" upload "$FIXTURE_PATH" "$PROJECT_ID" >/dev/null
pause_for_api
REMOTE_CREATED=1

"${CLI[@]}" changes doctor "$PROJECT_ID" --file "$REMOTE_FILE" --json \
  > "$TEST_DIR/doctor.json"
pause_for_api
jq -e '.canSuggest == true and .trackChangesStateReadable == true' \
  "$TEST_DIR/doctor.json" >/dev/null

printf 'comment-anchor E2E: creating before/inside/after comments\n'
add_comment \
  'OLCLI_ANCHOR_BEFORE is before the tracked edit.' \
  'before-anchor probe' "$TEST_DIR/comment-before.json"
BEFORE_ID="$LAST_THREAD_ID"
add_comment \
  'OLCLI_ANCHOR_TARGET has original wording.' \
  'inside-anchor probe' "$TEST_DIR/comment-inside.json"
INSIDE_ID="$LAST_THREAD_ID"
add_comment \
  'OLCLI_ANCHOR_AFTER is after the tracked edit.' \
  'after-anchor probe' "$TEST_DIR/comment-after.json"
AFTER_ID="$LAST_THREAD_ID"

printf 'comment-anchor E2E: proving stale document versions are rejected\n'
preview_suggestion "$TARGET_OLD" "$TARGET_NEW" "$TEST_DIR/stale-preview.json"
preview_suggestion "$CONCURRENT_OLD" "$CONCURRENT_NEW" "$TEST_DIR/concurrent-preview.json"
submit_suggestion "$CONCURRENT_OLD" "$CONCURRENT_NEW" \
  "$TEST_DIR/concurrent-preview.json" "$TEST_DIR/concurrent-result.json"
load_active_change_ids "$TEST_DIR/concurrent-result.json"

STALE_VERSION="$(jq -r '.version' "$TEST_DIR/stale-preview.json")"
STALE_SHA256="$(jq -r '.textSha256' "$TEST_DIR/stale-preview.json")"
if "${CLI[@]}" changes suggest "$REMOTE_FILE" "$PROJECT_ID" \
  --old "$TARGET_OLD" --new "$TARGET_NEW" \
  --expected-version "$STALE_VERSION" --expected-sha256 "$STALE_SHA256" \
  --json > "$TEST_DIR/stale-error.json" 2>&1; then
  fail 'a stale precondition unexpectedly mutated the document'
fi
pause_for_api
jq -e '.error.code == "VERSION_CONFLICT"' "$TEST_DIR/stale-error.json" >/dev/null
reject_active_changes "$TEST_DIR/concurrent-reject-preview.json" \
  "$TEST_DIR/concurrent-reject-result.json"

printf 'comment-anchor E2E: creating a tracked edit inside the middle comment\n'
preview_suggestion "$TARGET_OLD" "$TARGET_NEW" "$TEST_DIR/target-preview.json"
submit_suggestion "$TARGET_OLD" "$TARGET_NEW" \
  "$TEST_DIR/target-preview.json" "$TEST_DIR/target-result.json"
load_active_change_ids "$TEST_DIR/target-result.json"

"${CLI[@]}" comments list "$PROJECT_ID" --status all --json \
  > "$TEST_DIR/comments-after-suggestion.json"
pause_for_api
if ! jq -e \
  --arg before "$BEFORE_ID" --arg inside "$INSIDE_ID" --arg after "$AFTER_ID" \
  --arg path "$REMOTE_FILE" '
    def comment($id): first(.[] | select(.threadId == $id));
    (comment($before).path == $path)
      and (comment($inside).path == $path)
      and (comment($after).path == $path)
      and (comment($before).line < comment($inside).line)
      and (comment($inside).line < comment($after).line)
      and (comment($before).selectedText | contains("OLCLI_ANCHOR_BEFORE"))
      and (comment($inside).selectedText | length > 0)
      and (comment($after).selectedText | contains("OLCLI_ANCHOR_AFTER"))
  ' "$TEST_DIR/comments-after-suggestion.json" >/dev/null; then
  jq \
    --arg before "$BEFORE_ID" --arg inside "$INSIDE_ID" --arg after "$AFTER_ID" '
      [.[] | select(.threadId == $before or .threadId == $inside or .threadId == $after)
        | { threadId, path, line, column, selectedText }]
    ' "$TEST_DIR/comments-after-suggestion.json" >&2
  fail 'comment anchors did not match the expected ordering after suggestion'
fi

"${CLI[@]}" changes list "$PROJECT_ID" --file "$REMOTE_FILE" --json \
  > "$TEST_DIR/changes-after-suggestion.json"
pause_for_api
for change_id in "${ACTIVE_CHANGE_IDS[@]}"; do
  jq -e --arg id "$change_id" 'any(.[]; .id == $id)' \
    "$TEST_DIR/changes-after-suggestion.json" >/dev/null
done

printf 'comment-anchor E2E: rejecting the tracked edit and verifying anchors again\n'
reject_active_changes "$TEST_DIR/target-reject-preview.json" \
  "$TEST_DIR/target-reject-result.json"
"${CLI[@]}" comments list "$PROJECT_ID" --status all --json \
  > "$TEST_DIR/comments-after-reject.json"
pause_for_api
jq -e \
  --arg before "$BEFORE_ID" --arg inside "$INSIDE_ID" --arg after "$AFTER_ID" \
  --arg path "$REMOTE_FILE" '
    def comment($id): first(.[] | select(.threadId == $id));
    (comment($before).path == $path)
      and (comment($inside).path == $path)
      and (comment($after).path == $path)
      and (comment($before).line < comment($inside).line)
      and (comment($inside).line < comment($after).line)
      and (comment($inside).selectedText | contains("original wording"))
  ' "$TEST_DIR/comments-after-reject.json" >/dev/null

for thread_id in "${THREAD_IDS[@]}"; do
  "${CLI[@]}" comments delete "$thread_id" "$PROJECT_ID" >/dev/null
  pause_for_api
done
THREADS_CLEANED=1
"${CLI[@]}" delete "$REMOTE_FILE" "$PROJECT_ID" >/dev/null
pause_for_api
REMOTE_CREATED=0

printf 'comment-anchor E2E: passed; stale writes were refused and all anchors survived\n'
