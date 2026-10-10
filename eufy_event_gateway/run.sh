#!/bin/sh
set -eu

options=/data/options.json
token_file=/data/api_token

option() {
  jq -er --arg key "$1" '.[$key] | select(type == "string" and length > 0)' "$options"
}

export EUFY_USERNAME="$(option username)"
export EUFY_PASSWORD="$(option password)"
export EUFY_COUNTRY="$(option country)"
export EUFY_VERIFY_CODE="$(jq -r '.verification_code // empty' "$options")"
export EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES="$(jq -r '.capture_failed_event_images // false' "$options")"
if [ ! -s "$token_file" ]; then
  umask 077
  token_tmp="${token_file}.tmp"
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$token_tmp"
  mv "$token_tmp" "$token_file"
fi
export EUFY_GATEWAY_API_TOKEN="$(cat "$token_file")"
export EUFY_GATEWAY_HOST=0.0.0.0
export EUFY_GATEWAY_PORT=3218
export EUFY_GATEWAY_DATA_DIR=/data/runtime
export EUFY_GATEWAY_RUN_ID="${EUFY_GATEWAY_RUN_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID().slice(0, 8))')}"

launcher_error() {
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '%s ERROR version=%s run=%s component=launcher event=%s %s\n' \
    "$timestamp" "${EUFY_GATEWAY_VERSION:-development}" "$EUFY_GATEWAY_RUN_ID" "$1" "$2" >&2
}

node /app/dist/main.js &
gateway_pid=$!

stop_gateway() {
  kill -TERM "$gateway_pid" 2>/dev/null || true
  wait "$gateway_pid" 2>/dev/null || true
}

graceful_shutdown() {
  trap - INT TERM
  stop_gateway
  exit 0
}

trap graceful_shutdown INT TERM

attempt=0
until curl -fsS http://127.0.0.1:3218/live >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ] || ! kill -0 "$gateway_pid" 2>/dev/null; then
    launcher_error gateway_start_failed "Gateway did not become healthy"
    stop_gateway
    exit 1
  fi
  sleep 1
done

if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  gateway_host="$(hostname)"
  discovery_config="$(jq -cn \
    --arg host "$gateway_host" \
    --argjson port 3218 \
    --arg api_token "$EUFY_GATEWAY_API_TOKEN" \
    '{host:$host, port:$port, api_token:$api_token}')"
  discovery_payload="$(jq -cn \
    --arg service eufy_event_gateway \
    --argjson config "$discovery_config" \
    '{service:$service, config:$config}')"

  if ! curl -fsS \
    -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$discovery_payload" \
    http://supervisor/discovery >/dev/null 2>&1; then
    launcher_error supervisor_discovery_failed "Gateway is healthy, but Supervisor discovery failed"
  fi
fi

set +e
wait "$gateway_pid"
gateway_status=$?
set -e
exit "$gateway_status"
