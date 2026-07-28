# RedLog shell hook — source this in your .zshrc
# Usage: source ~/.redlog/shell-hook.zsh
#
# Sends each command to RedLog's HTTP API for recording.
# Requires RedLog to be running (listens on localhost:6660).

_REDLOG_PORT_FILE="$HOME/.redlog/api-port"
_REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"
_REDLOG_CMD=""
_REDLOG_CMD_START=0

_redlog_api() {
  local endpoint="$1"
  local payload="$2"
  local port token

  [[ -f "$_REDLOG_PORT_FILE" ]] || return 0
  [[ -f "$_REDLOG_TOKEN_FILE" ]] || return 0

  port=$(<"$_REDLOG_PORT_FILE")
  token=$(<"$_REDLOG_TOKEN_FILE")

  curl -sf -X POST "http://127.0.0.1:${port}${endpoint}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 1 --max-time 2 \
    >/dev/null 2>&1 &!
}

_redlog_preexec() {
  _REDLOG_CMD="$1"
  _REDLOG_CMD_START=$EPOCHSECONDS

  _redlog_api "/api/events" \
    "{\"agent_type\":\"shell\",\"data\":{\"subtype\":\"command_start\",\"command\":$(printf '%s' "$_REDLOG_CMD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"shell\":\"zsh\",\"pid\":$$,\"tty\":\"$TTY\",\"cwd\":$(printf '%s' "$PWD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}}"
}

_redlog_precmd() {
  local exit_code=$?
  [[ -z "$_REDLOG_CMD" ]] && return 0

  local elapsed=0
  (( _REDLOG_CMD_START > 0 )) && (( elapsed = EPOCHSECONDS - _REDLOG_CMD_START ))

  _redlog_api "/api/events" \
    "{\"agent_type\":\"shell\",\"data\":{\"subtype\":\"command_end\",\"command\":$(printf '%s' "$_REDLOG_CMD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"exit_code\":$exit_code,\"elapsed_sec\":$elapsed,\"shell\":\"zsh\",\"pid\":$$,\"cwd\":$(printf '%s' "$PWD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}}"

  _REDLOG_CMD=""
  _REDLOG_CMD_START=0
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _redlog_preexec
add-zsh-hook precmd _redlog_precmd
