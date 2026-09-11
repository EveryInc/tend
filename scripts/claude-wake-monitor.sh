#!/usr/bin/env bash

set -u

usage() {
  printf 'Usage: %s --session <id> [--label <text>] [--port <n>]\n' "$0" >&2
}

json_escape() {
  printf '%s' "$1" | perl -0777 -pe 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\r/\\r/g; s/\t/\\t/g'
}

session_id=""
label="Claude"
port="4321"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage
        exit 2
      fi
      session_id="$2"
      shift 2
      ;;
    --label)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      label="$2"
      shift 2
      ;;
    --port)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage
        exit 2
      fi
      port="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'claude-wake-monitor: unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$session_id" ]; then
  printf 'claude-wake-monitor: --session is required.\n' >&2
  usage
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
runtime_root=${ATTENTION_HOME:-"$HOME/.attention"}
ledger="$runtime_root/data/agents/claude/wake.jsonl"
presence_url="http://127.0.0.1:$port/api/agents/claude/presence"
heartbeat_pid=""

post_presence() {
  escaped_session=$(json_escape "$session_id")
  escaped_label=$(json_escape "$label")
  payload=$(printf '{"sessionId":"%s","label":"%s"}' "$escaped_session" "$escaped_label")
  curl -fsS -m 5 \
    -H 'content-type: application/json' \
    -d "$payload" \
    "$presence_url" >/dev/null
}

cleanup() {
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup INT TERM

if ! startup_error=$(post_presence 2>&1); then
  printf 'claude-wake-monitor: failed to register Claude presence at %s: %s\n' "$presence_url" "$startup_error" >&2
  exit 1
fi

if [ ! -f "$ledger" ]; then
  printf 'claude-wake-monitor: server has not created the wake ledger at %s after presence registration; refusing to tail a fallback path.\n' "$ledger" >&2
  exit 1
fi

(
  while true; do
    sleep 30 || exit 0
    if ! heartbeat_error=$(post_presence 2>&1); then
      printf 'claude-wake-monitor: presence heartbeat failed: %s\n' "$heartbeat_error" >&2
    fi
  done
) &
heartbeat_pid=$!

tail -n 0 -F "$ledger"
