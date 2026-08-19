#!/usr/bin/env bash
# Stop the rig's port-forwards (hub and console). The profile is left alone.
#
#   hack/hub-auth-down.sh        # drop the port-forwards
#   minikube stop -p hub-auth    # stop the cluster, keep the disk
#   minikube delete -p hub-auth  # reclaim everything
set -euo pipefail

for pf in /tmp/hub-auth-rig-portforward.pid /tmp/hub-auth-rig-ui-portforward.pid; do
  what="hub"; [[ "$pf" == *ui* ]] && what="console"
  if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
    pid="$(cat "$pf")"
    # The pid is the reconnect loop; take its current kubectl down with it.
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$pf"
    printf '  \033[32m✓\033[0m %s port-forward stopped\n' "$what"
  else
    rm -f "$pf"
    printf '  \033[33m!\033[0m no %s port-forward running\n' "$what"
  fi
done
