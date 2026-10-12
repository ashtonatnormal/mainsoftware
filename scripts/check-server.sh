#!/usr/bin/env bash
# Start-up check for the server (T2, docs/TECH-SPEC.md). Node runs the server's .ts source with
# no build step, so typecheck and tests passing doesn't prove it starts: an import Node can't
# resolve, or syntax it can't strip, only shows when Node loads the file. For each role (api,
# realtime, worker) this starts the server, waits for /health, expects /ready to answer 200,
# sends SIGTERM and expects a clean exit within 15 s, with nothing but JSON log lines written
# (a Node warning would show up as plain text).
#
#   scripts/check-server.sh               runs apps/server's source with plain Node
#   IMAGE=hearth-server scripts/check-server.sh
#                                         runs the production image instead (Docker)
#
# Both read their settings from .env.example (ENV_FILE to change it), so the dependencies it
# names must be up: `docker compose up -d --wait` starts them. EXPECT_READY=0 skips the /ready
# check, for running without them.
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
if curl -fsS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
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
    (cd apps/server && ROLE=$role PORT=$port exec node --env-file="../../$env_file" src/main.ts) >"$log" 2>&1 &
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
  for _ in $(seq 1 100); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
      up=1
      break
    fi
    running || { show_log; fail "$role exited before answering /health"; }
    sleep 0.2
  done
  [ -n "$up" ] || { show_log; fail "$role didn't answer /health within 20 s"; }

  if [ "$expect_ready" = 1 ]; then
    status=$(curl -sS -o "$log.ready" -w '%{http_code}' "http://127.0.0.1:$port/ready" || true)
    [ "$status" = 200 ] || { show_log; cat "$log.ready" >&2; fail "$role /ready answered $status, not 200"; }
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

  if grep -v '^{' "$log" | grep -q .; then
    show_log
    fail "$role wrote something other than JSON log lines (a Node warning?)"
  fi
  grep -q '"msg":"stopped"' "$log" || { show_log; fail "$role didn't log a clean stop"; }

  echo "check-server: $role ok${image:+ (image $image)}"
  rm -f "$log" "$log.ready"
  log=
done
