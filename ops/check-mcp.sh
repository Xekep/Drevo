#!/usr/bin/env bash
set -euo pipefail

: "${MCP_TOKEN:?Set MCP_TOKEN to a Drevo MCP token}"
MCP_URL="${MCP_URL:-https://mydrevo.org/mcp}"

tmp_config="$(mktemp)"
trap 'rm -f "$tmp_config"' EXIT
chmod 600 "$tmp_config"

cat >"$tmp_config" <<EOF
silent
show-error
fail-with-body
header = "Authorization: Bearer ${MCP_TOKEN}"
header = "Content-Type: application/json"
header = "Accept: application/json, text/event-stream"
header = "MCP-Protocol-Version: 2026-07-28"
EOF

post_rpc() {
  local method="$1"
  curl --config "$tmp_config" \
    --header "Mcp-Method: ${method}" \
    --request POST \
    --data-binary @- \
    "$MCP_URL"
}

discover="$(
  cat <<'JSON' | post_rpc "server/discover"
{"jsonrpc":"2.0","id":"deploy-discover","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"drevo-deployment-smoke","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}
JSON
)"

DISCOVER="$discover" python3 - <<'PY'
import json, os, sys
data = json.loads(os.environ["DISCOVER"])
result = data.get("result") or {}
assert result.get("resultType") == "complete", result
assert "2026-07-28" in result.get("supportedVersions", []), result
assert "tools" in (result.get("capabilities") or {}), result
meta = result.get("_meta") or {}
server = meta.get("io.modelcontextprotocol/serverInfo") or {}
assert server.get("name") == "drevo", result
print("server/discover: OK")
PY

tools="$(
  cat <<'JSON' | post_rpc "tools/list"
{"jsonrpc":"2.0","id":"deploy-tools","method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"drevo-deployment-smoke","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}
JSON
)"

TOOLS="$tools" python3 - <<'PY'
import json, os
data = json.loads(os.environ["TOOLS"])
result = data.get("result") or {}
assert result.get("resultType") == "complete", result
names = {item.get("name") for item in result.get("tools", [])}
assert "search_people" in names, names
print(f"tools/list: OK ({len(names)} tools)")
PY

call="$(
  cat <<'JSON' | post_rpc "tools/call"
{"jsonrpc":"2.0","id":"deploy-call","method":"tools/call","params":{"name":"search_people","arguments":{"query":"__drevo_mcp_deployment_smoke__"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"drevo-deployment-smoke","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}
JSON
)"

CALL="$call" python3 - <<'PY'
import json, os
data = json.loads(os.environ["CALL"])
result = data.get("result") or {}
assert result.get("resultType") == "complete", result
assert not result.get("isError"), result
structured = result.get("structuredContent") or {}
assert isinstance(structured.get("people"), list), result
print("tools/call search_people: OK")
PY

printf 'Drevo MCP deployment smoke passed: %s\n' "$MCP_URL"
