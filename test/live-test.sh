#!/usr/bin/env bash
# ===========================================================================
# ModelRelay Live Integration Tests
# ===========================================================================
# Tests the Anthropic ↔ OpenAI adapter against a running server.
# These are end-to-end smoke tests that verify the adapter handles:
#   - Basic non-streaming messages
#   - Server-Sent Events (SSE) streaming
#   - Multi-turn tool call round-trips (thinking + tool_use → tool_result)
#
# Usage:
#   ./test/live-test.sh                    # uses default http://localhost:7777
#   BASE_URL=http://localhost:7777 ./test/live-test.sh
#   API_KEY=sk-xxx ./test/live-test.sh
#
# Exit codes: 0 = all pass, 1 = any failure
# ===========================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:7352}"
API_KEY="${API_KEY:-test}"
PASS=0
FAIL=0

# ---- Helpers ---------------------------------------------------------------

pass()  { PASS=$((PASS+1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL+1)); echo "  ❌ FAIL: $1"; echo "     $2"; }

# Send a request, print the HTTP code + body on separate lines (last = code)
curl_raw() {
  curl -sS -w "\n%{http_code}" "$@" 2>&1 || true
}

http_code() { echo "$1" | tail -1; }
http_body() { echo "$1" | sed '$d'; }

echo "══════════════════════════════════════════════════════════════"
echo "  ModelRelay Live Tests  —  ${BASE_URL}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ============================================================
# 1. Basic non-streaming
# ============================================================
echo "── 1. Basic non-streaming ──────────────────────────────────"

RAW=$(curl_raw "$BASE_URL/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "anthropic-auto-fastest",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Say hello in exactly 3 words"}
    ]
  }')

CODE=$(http_code "$RAW")
BODY=$(http_body "$RAW")

if [ "$CODE" != "200" ]; then
  fail "non-streaming request" "HTTP $CODE — $(echo "$BODY" | head -c 200)"
else
  pass "HTTP 200"
  if echo "$BODY" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert r.get('type') == 'message', 'missing type'
assert r.get('role') == 'assistant', 'missing role'
assert 'id' in r, 'missing id'
assert len(r.get('content', [])) > 0, 'empty content'
print('OK')
" 2>&1; then
    pass "response shape valid"
  else
    fail "response shape invalid" "see above"
  fi
fi
echo ""

# ============================================================
# 2. SSE Streaming
# ============================================================
echo "── 2. SSE Streaming ────────────────────────────────────────"

STREAM_OUT=$(curl -sS "$BASE_URL/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "anthropic-auto-fastest",
    "max_tokens": 50,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Say 1 2 3"}
    ]
  }' 2>&1)

if [ -z "$STREAM_OUT" ]; then
  fail "streaming" "empty response"
  echo ""; exit 1
fi

check_sse() {
  local label="$1" pattern="$2"
  if echo "$STREAM_OUT" | grep -q "$pattern"; then
    pass "$label"
  else
    fail "$label" "Pattern '$pattern' not found in stream"
  fi
}

check_sse "message_start event"    '"type":"message_start"'
check_sse "content_block_start"    '"type":"content_block_start"'
check_sse "content_block_delta"    '"type":"content_block_delta"'
check_sse "content_block_stop"     '"type":"content_block_stop"'
check_sse "message_delta event"    '"type":"message_delta"'
check_sse "message_stop event"     '"type":"message_stop"'

echo "$STREAM_OUT" | python3 -c "
import sys, json
events = [l for l in sys.stdin.read().splitlines() if l.startswith('{')]
event_types = [json.loads(e)['type'] for e in events]
start_idx = event_types.index('message_start')
stop_idx = event_types.index('content_block_stop')
assert start_idx < stop_idx, 'content_block_stop before message_start'
delta_idx = event_types.index('message_delta')
stop_idx2 = event_types.index('message_stop')
assert delta_idx < stop_idx2, 'message_stop before message_delta'
print('OK')
" 2>/dev/null && pass "SSE event ordering" || fail "SSE event ordering" "sequence broken"

echo ""

# ============================================================
# 3. Multi-turn tool call round-trip
# ============================================================
echo "── 3. Tool call round-trip ─────────────────────────────────"

TOOL_DEF='[{
  "name": "calculator",
  "description": "Add two numbers",
  "input_schema": {
    "type": "object",
    "properties": {
      "a": {"type": "number"},
      "b": {"type": "number"}
    },
    "required": ["a", "b"]
  }
}]'

# Step 1: Ask the model to use a tool, retrying if it answers directly
STEP1=""
TOOL_USE_ID=""
for attempt in 1 2 3 4 5; do
  RAW=$(curl_raw "$BASE_URL/v1/messages" \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{
      \"model\": \"anthropic-auto-fastest\",
      \"max_tokens\": 300,
      \"tools\": $TOOL_DEF,
      \"tool_choice\": {\"type\": \"any\"},
      \"messages\": [
        {\"role\": \"user\", \"content\": \"What is 2 + 5?\"}
      ]
    }") || continue

  CODE=$(http_code "$RAW")
  STEP1=$(http_body "$RAW")

  if [ "$CODE" != "200" ]; then
    echo "  (attempt $attempt: HTTP $CODE, retrying...)"
    continue
  fi

  TOOL_USE_ID=$(echo "$STEP1" | python3 -c "
import sys, json
r = json.load(sys.stdin)
tool = [b for b in r.get('content', []) if b.get('type') == 'tool_use']
print(tool[0]['id'] if tool else '')
" 2>/dev/null || true)

  if [ -n "$TOOL_USE_ID" ]; then
    pass "Step 1: tool_use obtained (attempt $attempt)"
    break
  fi
  echo "  (attempt $attempt: model answered directly, retrying...)"
done

if [ -z "$TOOL_USE_ID" ]; then
  fail "Step 1" "model never used a tool after 5 attempts"
  echo ""; exit 1
fi

# Validate step 1 response
STOP_REASON=$(echo "$STEP1" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(r.get('stop_reason', 'N/A'))
" 2>/dev/null || true)

if [ "$STOP_REASON" = "tool_use" ]; then
  pass "Step 1: stop_reason = tool_use"
else
  fail "Step 1: stop_reason" "expected 'tool_use', got '$STOP_REASON'"
fi

echo "$STEP1" | python3 -c "
import sys, json
r = json.load(sys.stdin)
content = r.get('content', [])
thinking = [b for b in content if b.get('type') == 'thinking']
assert len(thinking) > 0, 'no thinking block'
assert len(thinking[0].get('thinking', '')) > 0, 'empty thinking'
print('OK')
" 2>/dev/null && pass "Step 1: thinking block present" || fail "Step 1: thinking block" "missing"

# Step 2: Send tool result back
CONTENT_ARR=$(echo "$STEP1" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(json.dumps(r['content']))
" 2>/dev/null || true)

RAW2=$(curl_raw "$BASE_URL/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{
    \"model\": \"anthropic-auto-fastest\",
    \"max_tokens\": 300,
    \"tools\": $TOOL_DEF,
    \"messages\": [
      {\"role\": \"user\", \"content\": \"What is 2 + 5?\"},
      {\"role\": \"assistant\", \"content\": $CONTENT_ARR},
      {\"role\": \"user\", \"content\": [{\"type\": \"tool_result\", \"tool_use_id\": \"$TOOL_USE_ID\", \"content\": \"7\"}]}
    ]
  }") || { fail "Step 2 curl" "curl failed"; exit 1; }

CODE2=$(http_code "$RAW2")
STEP2=$(http_body "$RAW2")

if [ "$CODE2" != "200" ]; then
  fail "Step 2" "HTTP $CODE2"
  echo ""; exit 1
fi
pass "Step 2: HTTP 200"

FINAL_TEXT=$(echo "$STEP2" | python3 -c "
import sys, json
r = json.load(sys.stdin)
content = r.get('content', [])
text = [b for b in content if b.get('type') == 'text']
print(text[0].get('text', '') if text else 'N/A')
" 2>/dev/null || true)

FINAL_STOP=$(echo "$STEP2" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(r.get('stop_reason', 'N/A'))
" 2>/dev/null || true)

if [ "$FINAL_STOP" = "end_turn" ]; then
  pass "Step 2: stop_reason = end_turn"
else
  fail "Step 2: stop_reason" "expected 'end_turn', got '$FINAL_STOP'"
fi

if echo "$FINAL_TEXT" | grep -qiE "(7|seven|sum)"; then
  pass "Step 2: final text mentions the answer 7"
else
  fail "Step 2: final text" "expected '7' or 'seven', got '$FINAL_TEXT'"
fi

echo "$STEP2" | python3 -c "
import sys, json
r = json.load(sys.stdin)
content = r.get('content', [])
thinking = [b for b in content if b.get('type') == 'thinking']
assert len(thinking) > 0, 'no thinking block'
print('OK')
" 2>/dev/null && pass "Step 2: thinking block preserved in round-trip" || fail "Step 2: thinking block" "missing in round-trip"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Summary:  ${PASS} passed  ·  ${FAIL} failed"
echo "══════════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
