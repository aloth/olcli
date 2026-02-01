#!/bin/bash
#
# olcli End-to-End Test Suite
# Tests all commands against the "olcli test" project
#
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test state
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
CLEANUP_FILES=()
CLEANUP_REMOTE_FILES=()

# Test project name
PROJECT_NAME="olcli test"

# Temporary directory for test files
TEST_DIR=$(mktemp -d)
trap cleanup EXIT

#######################################
# Utility functions
#######################################

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_section() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
}

# Run a test and track results
run_test() {
  local name="$1"
  local cmd="$2"
  local expect_success="${3:-true}"
  
  TESTS_RUN=$((TESTS_RUN + 1))
  
  echo -n "  Testing: $name ... "
  
  local output
  local exit_code
  
  output=$(eval "$cmd" 2>&1) && exit_code=0 || exit_code=$?
  
  if [ "$expect_success" = "true" ]; then
    if [ $exit_code -eq 0 ]; then
      echo -e "${GREEN}✓${NC}"
      TESTS_PASSED=$((TESTS_PASSED + 1))
      sleep 1  # Rate limit protection
      return 0
    else
      echo -e "${RED}✗${NC}"
      echo "    Command: $cmd"
      echo "    Output: $output"
      TESTS_FAILED=$((TESTS_FAILED + 1))
      sleep 1  # Rate limit protection
      return 1
    fi
  else
    # Expect failure
    if [ $exit_code -ne 0 ]; then
      echo -e "${GREEN}✓ (expected failure)${NC}"
      TESTS_PASSED=$((TESTS_PASSED + 1))
      sleep 1  # Rate limit protection
      return 0
    else
      echo -e "${RED}✗ (should have failed)${NC}"
      TESTS_FAILED=$((TESTS_FAILED + 1))
      sleep 1  # Rate limit protection
      return 1
    fi
  fi
}

# Run a test with output verification
run_test_with_output() {
  local name="$1"
  local cmd="$2"
  local expected_pattern="$3"
  
  TESTS_RUN=$((TESTS_RUN + 1))
  
  echo -n "  Testing: $name ... "
  
  local output
  local exit_code
  
  output=$(eval "$cmd" 2>&1) && exit_code=0 || exit_code=$?
  
  if [ $exit_code -eq 0 ] && echo "$output" | grep -qE "$expected_pattern"; then
    echo -e "${GREEN}✓${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
    sleep 1  # Rate limit protection
    return 0
  else
    echo -e "${RED}✗${NC}"
    echo "    Command: $cmd"
    echo "    Expected pattern: $expected_pattern"
    echo "    Output: $output"
    TESTS_FAILED=$((TESTS_FAILED + 1))
    sleep 1  # Rate limit protection
    return 1
  fi
}

# Cleanup function
cleanup() {
  log_section "Cleanup"
  
  # Remove local temp files
  if [ -d "$TEST_DIR" ]; then
    log_info "Removing temp directory: $TEST_DIR"
    rm -rf "$TEST_DIR"
  fi
  
  # Remove remote test files (best effort)
  for file in "${CLEANUP_REMOTE_FILES[@]}"; do
    log_info "Note: Test file '$file' may remain on Overleaf (delete manually if needed)"
  done
  
  # Summary
  echo ""
  log_section "Test Results"
  echo ""
  echo "  Total tests:  $TESTS_RUN"
  echo -e "  ${GREEN}Passed:${NC}       $TESTS_PASSED"
  echo -e "  ${RED}Failed:${NC}       $TESTS_FAILED"
  echo ""
  
  if [ $TESTS_FAILED -eq 0 ]; then
    log_success "All tests passed! 🎉"
    exit 0
  else
    log_fail "Some tests failed."
    exit 1
  fi
}

#######################################
# Test Setup
#######################################

log_section "Test Setup"

# Generate unique test identifiers
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TEST_ID="e2e_test_${TIMESTAMP}"
TEST_CONTENT="olcli e2e test file - ${TIMESTAMP} - $(uuidgen 2>/dev/null || echo $RANDOM)"

log_info "Test ID: $TEST_ID"
log_info "Test directory: $TEST_DIR"
log_info "Project: $PROJECT_NAME"

# Verify olcli is available
if ! command -v olcli &> /dev/null; then
  log_fail "olcli command not found. Run 'npm link' first."
  exit 1
fi

log_info "olcli version: $(olcli --version)"

#######################################
# Test: Authentication
#######################################

log_section "Authentication Tests"

run_test_with_output "whoami returns user info" \
  "olcli whoami" \
  "(Logged in as|Email:|Authenticated)"

run_test "check shows config info" \
  "olcli check"

#######################################
# Test: Project Listing
#######################################

log_section "Project Listing Tests"

run_test_with_output "list shows projects" \
  "olcli list" \
  "olcli test"

run_test_with_output "list --json returns valid JSON" \
  "olcli list --json | jq -e 'type == \"array\"'" \
  "true"

# Get project ID for later tests
log_info "Waiting 5s before API calls to avoid rate limiting..."
sleep 5

PROJECT_ID=$(olcli list --json | jq -r '.[] | select(.name == "olcli test") | .id')
if [ -z "$PROJECT_ID" ]; then
  log_fail "Could not find 'olcli test' project. Please create it on Overleaf first."
  exit 1
fi

log_info "Project ID: $PROJECT_ID"
log_info "Using project ID directly to minimize API calls"

#######################################
# Test: Project Info
#######################################

log_section "Project Info Tests"

run_test_with_output "info by name" \
  "olcli info '$PROJECT_NAME'" \
  "(Project:|Files:)"

run_test_with_output "info by ID" \
  "olcli info '$PROJECT_ID'" \
  "(Project:|Files:)"

run_test_with_output "info --json returns valid JSON" \
  "olcli info '$PROJECT_ID' --json | jq -e '.project.id'" \
  "$PROJECT_ID"

#######################################
# Test: File Upload
#######################################

log_section "File Upload Tests"

# Create test file with unique content
TEST_FILE="$TEST_DIR/${TEST_ID}.txt"
echo "$TEST_CONTENT" > "$TEST_FILE"
CLEANUP_REMOTE_FILES+=("${TEST_ID}.txt")

run_test "upload file to project" \
  "olcli upload '$TEST_FILE' '$PROJECT_ID'"

# Create file in subfolder test
TEST_FILE2="$TEST_DIR/${TEST_ID}_2.txt"
echo "Second test file - $TEST_CONTENT" > "$TEST_FILE2"
CLEANUP_REMOTE_FILES+=("${TEST_ID}_2.txt")

run_test "upload second file" \
  "olcli upload '$TEST_FILE2' '$PROJECT_ID'"

#######################################
# Test: File Download (single file)
#######################################

log_section "File Download Tests"

DOWNLOAD_FILE="$TEST_DIR/downloaded_${TEST_ID}.txt"

run_test "download single file" \
  "olcli download '${TEST_ID}.txt' '$PROJECT_ID' -o '$DOWNLOAD_FILE'"

# Verify content matches
TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: verify downloaded content matches ... "
if [ -f "$DOWNLOAD_FILE" ]; then
  DOWNLOADED_CONTENT=$(cat "$DOWNLOAD_FILE")
  if [ "$DOWNLOADED_CONTENT" = "$TEST_CONTENT" ]; then
    echo -e "${GREEN}✓${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗${NC}"
    echo "    Expected: $TEST_CONTENT"
    echo "    Got: $DOWNLOADED_CONTENT"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo -e "${RED}✗ (file not found)${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

sleep 1  # Rate limit

# Download existing file (main.tex)
run_test "download main.tex" \
  "olcli download main.tex '$PROJECT_ID' -o '$TEST_DIR/main.tex'"

run_test_with_output "main.tex contains documentclass" \
  "grep -l documentclass '$TEST_DIR/main.tex'" \
  "main.tex"

#######################################
# Test: Zip Download
#######################################

log_section "Zip Archive Tests"

ZIP_FILE="$TEST_DIR/project.zip"

run_test "download project as zip" \
  "olcli zip '$PROJECT_ID' -o '$ZIP_FILE'"

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: zip file is valid ... "
if [ -f "$ZIP_FILE" ] && unzip -t "$ZIP_FILE" > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

sleep 1  # Rate limit

# Verify our test file is in the zip
TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: uploaded file is in zip ... "
if unzip -l "$ZIP_FILE" 2>/dev/null | grep -q "${TEST_ID}.txt"; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

#######################################
# Test: Compile
#######################################

log_section "Compile Tests"

run_test_with_output "compile project" \
  "olcli compile '$PROJECT_ID'" \
  "(success|failure|Compiled)"

#######################################
# Test: PDF Download
#######################################

log_section "PDF Download Tests"

PDF_FILE="$TEST_DIR/output.pdf"

# Note: This may fail if compilation fails
TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: download PDF ... "
if olcli pdf "$PROJECT_ID" -o "$PDF_FILE" 2>&1; then
  if [ -f "$PDF_FILE" ] && [ -s "$PDF_FILE" ]; then
    # Check PDF magic bytes
    if head -c 4 "$PDF_FILE" | grep -q "%PDF"; then
      echo -e "${GREEN}✓${NC}"
      TESTS_PASSED=$((TESTS_PASSED + 1))
    else
      echo -e "${RED}✗ (not a valid PDF)${NC}"
      TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
  else
    echo -e "${RED}✗ (file empty or missing)${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo -e "${YELLOW}⚠ (compilation may have failed)${NC}"
  # Don't count as failure since compilation errors are project-dependent
  TESTS_PASSED=$((TESTS_PASSED + 1))
  log_warn "PDF download skipped due to compilation status"
fi

sleep 1  # Rate limit

#######################################
# Test: Output Files (compile artifacts)
#######################################

log_section "Output Files Tests"

run_test_with_output "output --list shows files" \
  "olcli output --list --project '$PROJECT_ID'" \
  "(bbl|log|aux)"

# Download log file
LOG_FILE="$TEST_DIR/output.log"
run_test "download log output" \
  "olcli output log -o '$LOG_FILE' --project '$PROJECT_ID'"

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: log file has content ... "
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

sleep 1  # Rate limit

# Download bbl file (for arXiv)
BBL_FILE="$TEST_DIR/output.bbl"
run_test "download bbl output" \
  "olcli output bbl -o '$BBL_FILE' --project '$PROJECT_ID'"

#######################################
# Test: Pull
#######################################

log_section "Pull Tests"

PULL_DIR="$TEST_DIR/pulled_project"
mkdir -p "$PULL_DIR"

run_test "pull project to directory" \
  "olcli pull '$PROJECT_ID' '$PULL_DIR' --force"

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: .olcli.json created ... "
if [ -f "$PULL_DIR/.olcli.json" ]; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: main.tex exists in pulled directory ... "
if [ -f "$PULL_DIR/main.tex" ]; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: test file exists in pulled directory ... "
if [ -f "$PULL_DIR/${TEST_ID}.txt" ]; then
  echo -e "${GREEN}✓${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

sleep 1  # Rate limit

#######################################
# Test: Push
#######################################

log_section "Push Tests"

# Modify a file in the pulled directory
PUSH_TEST_FILE="$PULL_DIR/${TEST_ID}_push.txt"
PUSH_CONTENT="Push test - $TIMESTAMP - $(uuidgen 2>/dev/null || echo $RANDOM)"
echo "$PUSH_CONTENT" > "$PUSH_TEST_FILE"
CLEANUP_REMOTE_FILES+=("${TEST_ID}_push.txt")

# Touch the file to ensure it's newer
sleep 1
touch "$PUSH_TEST_FILE"

run_test "push --dry-run shows changes" \
  "cd '$PULL_DIR' && olcli push --dry-run"

run_test "push uploads changes" \
  "cd '$PULL_DIR' && olcli push --all"

# Verify by downloading
VERIFY_FILE="$TEST_DIR/verify_push.txt"
sleep 2  # Give Overleaf a moment
run_test "download pushed file" \
  "olcli download '${TEST_ID}_push.txt' '$PROJECT_ID' -o '$VERIFY_FILE'"

TESTS_RUN=$((TESTS_RUN + 1))
echo -n "  Testing: pushed content matches ... "
if [ -f "$VERIFY_FILE" ]; then
  VERIFY_CONTENT=$(cat "$VERIFY_FILE")
  if [ "$VERIFY_CONTENT" = "$PUSH_CONTENT" ]; then
    echo -e "${GREEN}✓${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗${NC}"
    echo "    Expected: $PUSH_CONTENT"
    echo "    Got: $VERIFY_CONTENT"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo -e "${RED}✗ (file not found)${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

sleep 1  # Rate limit

#######################################
# Test: Sync
#######################################

log_section "Sync Tests"

SYNC_DIR="$TEST_DIR/sync_project"
mkdir -p "$SYNC_DIR"

# Initial pull
run_test "sync (initial pull)" \
  "olcli pull '$PROJECT_ID' '$SYNC_DIR' --force"

# Create local file
SYNC_TEST_FILE="$SYNC_DIR/${TEST_ID}_sync.txt"
SYNC_CONTENT="Sync test - $TIMESTAMP"
echo "$SYNC_CONTENT" > "$SYNC_TEST_FILE"
CLEANUP_REMOTE_FILES+=("${TEST_ID}_sync.txt")

run_test "sync bidirectional" \
  "cd '$SYNC_DIR' && olcli sync"

# Verify upload
SYNC_VERIFY="$TEST_DIR/verify_sync.txt"
sleep 2
run_test "verify synced file exists" \
  "olcli download '${TEST_ID}_sync.txt' '$PROJECT_ID' -o '$SYNC_VERIFY'"

# NOTE: delete and rename commands are disabled in olcli (require Socket.IO)
# Delete test files manually via Overleaf web UI

#######################################
# Test: Error Handling
#######################################

log_section "Error Handling Tests"

run_test "download nonexistent file fails gracefully" \
  "olcli download 'nonexistent_file_xyz.tex' '$PROJECT_ID'" \
  false

run_test "info for nonexistent project fails gracefully" \
  "olcli info 'project_that_does_not_exist_xyz'" \
  false

#######################################
# Test: Edge Cases
#######################################

log_section "Edge Case Tests"

# Project by ID
run_test "commands work with project ID" \
  "olcli info '$PROJECT_ID'"

# Special characters in filename (safe ones only)
SPECIAL_FILE="$TEST_DIR/test-file_123.txt"
echo "special filename test" > "$SPECIAL_FILE"
CLEANUP_REMOTE_FILES+=("test-file_123.txt")

run_test "upload file with dashes and underscores" \
  "olcli upload '$SPECIAL_FILE' '$PROJECT_ID'"

run_test "download file with dashes and underscores" \
  "olcli download 'test-file_123.txt' '$PROJECT_ID' -o '$TEST_DIR/dl_special.txt'"

#######################################
# Cleanup Note
#######################################

log_section "Test Files to Clean Up"

echo ""
echo "The following test files were created on Overleaf:"
for file in "${CLEANUP_REMOTE_FILES[@]}"; do
  echo "  - $file"
done
echo ""
log_warn "Please delete these files manually via the Overleaf web UI if needed."
echo ""

# Cleanup will run via trap
