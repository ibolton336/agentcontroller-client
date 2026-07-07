#!/usr/bin/env bash
# Stop the demo's local processes (shim + ui). The cluster is untouched —
# use `minikube stop` for that, and `kubectl delete agentruns -n
# konveyor-agents <name>` for runs you created.
set -uo pipefail

for name in hub-shim ui; do
  pidfile="/tmp/demo-$name.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    # npm wraps the real server: kill children FIRST — killing the parent
    # first reparents them to init and they survive pkill -P.
    pkill -P "$pid" >/dev/null 2>&1 || true
    if kill "$pid" >/dev/null 2>&1; then
      echo "stopped $name (pid $pid)"
    else
      echo "$name (pid $pid) was not running"
    fi
    rm -f "$pidfile"
  else
    echo "$name: no pidfile — nothing to stop"
  fi
done
