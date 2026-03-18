#!/usr/bin/env bash
set -euo pipefail

log() {
	printf '[local-transcribe-entrypoint] %s\n' "$*"
}

child_pid=""

forward_signal() {
	local signal="$1"
	log "received ${signal}"
	if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
		kill "-${signal}" "${child_pid}" 2>/dev/null || true
	fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP
trap 'forward_signal QUIT' QUIT

log "starting uvicorn"
python3 -m uvicorn app:app --host 0.0.0.0 --port 8765 &
child_pid="$!"
wait "${child_pid}"
exit_code="$?"
log "uvicorn exited with code ${exit_code}"
exit "${exit_code}"
