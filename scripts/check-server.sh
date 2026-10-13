#!/usr/bin/env bash
# Start-up check for the server (T2, docs/TECH-SPEC.md). Node runs the server's .ts source with
# no build step, so typecheck and tests passing doesn't prove it starts: an import Node can't
# resolve, or syntax it can't strip, only shows when Node loads the file. For each role (api,
# realtime, worker) this starts the server, waits for /health, expects /ready to answer 200,
# checks the role serves only its own routes (below), sends SIGTERM and expects a clean exit
# within 15 s, with nothing but JSON log lines written (a Node warning would show up as plain
# text).
#
# The routes (C0.5): a code request (POST /api/auth/otp/request from APP_ORIGIN, for the number
# "x") and a WebSocket upgrade to /ws from another origin. The api role answers them 400
# (invalid_phone) and 404, the realtime role 404 and 403, and the worker 404 and 404: only the
# realtime role listens for upgrades, so elsewhere Node passes one to Fastify as a plain request.
# Both stop before anything is looked up or sent (the number is refused before Valkey, the
# upgrade before its session lookup), so they need no stack, and the local SMS provider prints
# nothing that would break the JSON-only check. This is the only check that main.ts puts the
# routes on the right roles; the unit tests build the app directly. The api role also loads
# @simplewebauthn/server as it starts, so the image mode proves the image holds it.
#
#   scripts/check-server.sh               runs apps/server's source with plain Node
#   IMAGE=hearth-server scripts/check-server.sh
#                                         runs the production image instead (Docker)
#
# Both read their settings from .env.example (ENV_FILE to change it), so the dependencies it
# names must be up and the database built: `docker compose up -d --wait`, then
# `npm run db:reset`. EXPECT_READY=0 skips the /ready
# check, for running without them. The image mode uses host networking, so it needs Docker on
# Linux, as in CI (Docker Desktop only with host networking turned on in its settings).
set -euo pipefail

cd "$(dirname "$0")/.."
env_file=${ENV_FILE:-.env.example}
port=${PORT:-3100}
expect_ready=${EXPECT_READY:-1}
image=${IMAGE:-}

fail() {
  echo "check-server: $*" >&2
  exit 1
}

[ -f "$env_file" ] || fail "no $env_file"
# Absolute, since the source-mode server starts in apps/server.
env_file=$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")
# The app's origin, which the code request must come from to pass the Origin check.
origin=$(sed -n 's/^APP_ORIGIN=//p' "$env_file" | tail -n 1)
origin=${origin%\"}
origin=${origin#\"}
[ -n "$origin" ] || fail "no APP_ORIGIN in $env_file"

# Whatever happens, leave no server running: a failed check exits early, and a server left on
# the port would answer the next run's probes.
pid=
container=
log=
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if [ -n "$log" ]; then rm -f "$log" "$log.ready"; fi
}
trap cleanup EXIT

# Refuse to start if something already answers on the port, rather than check that instead.
if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
  fail "something is already listening on port $port"
fi

for role in api realtime worker; do
  log=$(mktemp)
  if [ -n "$image" ]; then
    # Host networking, so the container reaches the Compose stack on 127.0.0.1 as .env.example
    # says, and the check reaches the server on the same port. A read-only root filesystem, as
    # the task will run in AWS, proves the server writes nothing at run time.
    container=$(docker run -d --read-only --network host --env-file "$env_file" -e ROLE="$role" -e PORT="$port" "$image")
  else
    (cd apps/server && ROLE=$role PORT=$port exec node --env-file="$env_file" src/main.ts) >"$log" 2>&1 &
    pid=$!
  fi

  running() {
    if [ -n "$image" ]; then
      [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ]
    else
      kill -0 "$pid" 2>/dev/null
    fi
  }
  show_log() {
    if [ -n "$image" ]; then docker logs "$container" >"$log" 2>&1 || true; fi
    sed 's/^/  | /' "$log" >&2
  }

  up=
  deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
      up=1
      break
    fi
    running || { show_log; fail "$role exited before answering /health"; }
    sleep 0.2
  done
  [ -n "$up" ] || { show_log; fail "$role didn't answer /health within 20 s"; }

  if [ "$expect_ready" = 1 ]; then
    status=$(curl -sS --max-time 5 -o "$log.ready" -w '%{http_code}' "http://127.0.0.1:$port/ready" || true)
    [ "$status" = 200 ] || { show_log; cat "$log.ready" >&2; fail "$role /ready answered $status, not 200"; }
  fi

  # Each role serves only its own routes (see the top of this file).
  case $role in
    api) expected='400 404' ;;
    realtime) expected='404 403' ;;
    worker) expected='404 404' ;;
  esac
  otp=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -X POST -H "Origin: $origin" \
    -H 'Content-Type: application/json' --data '{"phone":"x"}' \
    "http://127.0.0.1:$port/api/auth/otp/request" || true)
  # The key is 16 zero bytes: well formed, and nothing a secret scanner takes for a key.
  ws=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
    -H 'Origin: https://evil.example' "http://127.0.0.1:$port/ws" || true)
  if [ "$otp $ws" != "$expected" ]; then
    show_log
    fail "$role answered a code request $otp and a cross-origin upgrade $ws, not $expected"
  fi

  if [ -n "$image" ]; then
    docker stop -t 15 "$container" >/dev/null
    code=$(docker inspect -f '{{.State.ExitCode}}' "$container")
    docker logs "$container" >"$log" 2>&1
    docker rm "$container" >/dev/null
    container=
  else
    kill -TERM "$pid"
    for _ in $(seq 1 75); do running || break; sleep 0.2; done
    running && { kill -KILL "$pid"; show_log; fail "$role didn't stop within 15 s of SIGTERM"; }
    code=0
    wait "$pid" || code=$?
    pid=
  fi
  [ "$code" = 0 ] || { show_log; fail "$role exited with code $code after SIGTERM"; }

  # One grep, no pipeline: under pipefail a pipeline can pass falsely once the log is large.
  if grep -qvE '^(\{|$)' "$log"; then
    show_log
    fail "$role wrote something other than JSON log lines (a Node warning?)"
  fi
  grep -q '"msg":"stopped"' "$log" || { show_log; fail "$role didn't log a clean stop"; }

  echo "check-server: $role ok${image:+ (image $image)}"
  rm -f "$log" "$log.ready"
  log=
done
