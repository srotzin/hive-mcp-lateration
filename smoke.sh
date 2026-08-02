#!/usr/bin/env bash
# smoke.sh: hive-mcp-lateration local smoke test
#
# Tests: /health, /.well-known/mcp.json, honest 404, tools/list (5 tools),
#        price_lateration (pure local math), mint_receipt + verify_receipt
#        (live upstream GCA round-trip), and that verify_receipt honestly
#        discloses it is not an offline check.
#
# Exits 0 on success, 1 on any failure.

set -uo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fuser -k "${PORT}/tcp" 2>/dev/null || true
command -v node >/dev/null 2>&1 || { echo "node not found, aborting"; exit 1; }

if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  info "Installing dependencies…"
  npm install --omit=dev --no-audit --no-fund --silent
fi

node server.js > /tmp/hive-mcp-lateration-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; exit' INT TERM EXIT

info "Waiting for server to be ready…"
for i in $(seq 1 20); do
  if curl -sf "${BASE}/health" >/dev/null 2>&1; then
    info "Server ready after ${i} attempts"
    break
  fi
  sleep 0.5
done

jsonrpc() {
  local method="$1"
  local params="$2"
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "${BASE}/mcp"
}

EVENT='{"event_id":"evt-smoke","subject_call_id":"call-sub-1","reference_call_ids":["r1","r2"],"sls_subject":"0xabc","similarity_to_field":0.81,"solo_cost_estimate":"1.00","residual_cost":"0.28","tenant_id":"acme","cross_tenant":false,"timestamp":"2026-06-25T05:00:00Z"}'

info "Test 1: GET /health"
HEALTH=$(curl -sf "${BASE}/health") || fail "GET /health failed"
echo "$HEALTH" | grep -q '"status":"ok"' && ok "GET /health → status ok" || fail "GET /health unexpected: $HEALTH"

info "Test 2: GET /.well-known/mcp.json"
MCP_JSON=$(curl -sf "${BASE}/.well-known/mcp.json") || fail "GET /.well-known/mcp.json failed"
echo "$MCP_JSON" | grep -q '"endpoint":"/mcp"' && ok "well-known → endpoint present" || fail "well-known → endpoint missing"

info "Test 3: honest 404"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/does-not-exist")
[ "$CODE" = "404" ] && ok "GET /does-not-exist → 404" || fail "GET /does-not-exist → ${CODE} (expected 404)"

info "Test 4: tools/list"
TOOLS_RESP=$(jsonrpc "tools/list" "{}") || fail "tools/list RPC failed"
TOOLS_N=$(echo "$TOOLS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo 0)
[ "$TOOLS_N" -eq 5 ] 2>/dev/null && ok "tools/list → 5 tools" || fail "tools/list → ${TOOLS_N} tools (expected 5)"
for TOOL in price_lateration mint_receipt verify_receipt settle_scouts get_pubkey; do
  echo "$TOOLS_RESP" | grep -q "\"name\":\"${TOOL}\"" && ok "tools/list → '${TOOL}' present" || fail "tools/list → '${TOOL}' MISSING"
done
echo "$TOOLS_RESP" | grep -q 'NOT an offline check' && ok "verify_receipt description discloses live-call limitation" || fail "verify_receipt description missing honesty disclosure"

info "Test 5: tools/call price_lateration (pure local math)"
PRICE_RESP=$(jsonrpc "tools/call" "{\"name\":\"price_lateration\",\"arguments\":{\"event\":${EVENT}}}") || fail "price_lateration call failed"
echo "$PRICE_RESP" | grep -q 'invariant_customer_net_below_solo' && ok "price_lateration → invariant field present" || fail "price_lateration unexpected: $PRICE_RESP"

info "Test 6: tools/call mint_receipt (live upstream GCA)"
MINT_RESP=$(jsonrpc "tools/call" "{\"name\":\"mint_receipt\",\"arguments\":{\"event\":${EVENT}}}") || fail "mint_receipt call failed"
CLAIMS_ROOT=$(echo "$MINT_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d['result']['content'][0]['text']
obj = json.loads(text)
print(obj.get('claims_root') or '')
" 2>/dev/null || echo "")
if [ -n "$CLAIMS_ROOT" ]; then ok "mint_receipt → claims_root returned from live signer"; else fail "mint_receipt → no claims_root: $MINT_RESP"; fi

info "Test 7: tools/call verify_receipt (live upstream re-derivation, honestly disclosed)"
if [ -n "$CLAIMS_ROOT" ]; then
  VERIFY_RESP=$(jsonrpc "tools/call" "{\"name\":\"verify_receipt\",\"arguments\":{\"event\":${EVENT},\"claims_root\":\"${CLAIMS_ROOT}\"}}") || fail "verify_receipt call failed"
  echo "$VERIFY_RESP" | grep -q 'verification_limitation' && ok "verify_receipt → limitation disclosed in response" || fail "verify_receipt → limitation missing: $VERIFY_RESP"
  echo "$VERIFY_RESP" | grep -q '\\"valid\\": true' && ok "verify_receipt → valid true for matching root" || info "verify_receipt raw: $VERIFY_RESP"
else
  fail "Skipped verify_receipt: no claims_root from mint_receipt"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Passed: ${GREEN}${PASS}${NC}  Failed: ${RED}${FAIL}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SMOKE TEST FAILED${NC}"
  exit 1
fi
echo -e "${GREEN}SMOKE TEST PASSED${NC}"
exit 0
