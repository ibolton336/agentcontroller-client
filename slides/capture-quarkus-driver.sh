#!/bin/bash
# Follows AgentWorkloadRun coolstore-quarkus-demo-2 and captures UI stills/clips
# at every stage transition. Writes to slides/assets/quarkus-demo/.
set -u
cd "$(dirname "$0")"
RUN=coolstore-quarkus-demo-2
NS=konveyor-agents
OUT=assets/quarkus-demo
mkdir -p "$OUT"

# Wait for playwright to be importable (npm install may still be running).
for i in $(seq 1 60); do
  node -e "require('playwright')" 2>/dev/null && break
  sleep 10
done
node -e "require('playwright')" 2>/dev/null || { echo "playwright never became ready"; exit 1; }
echo "playwright ready"

cap() { node capture-quarkus.js "$@" || echo "capture failed: $*"; }

last_stage="${1:-}"
n="${2:-0}"
for i in $(seq 1 240); do
  line=$(kubectl get agentworkloadrun $RUN -n $NS -o jsonpath='{.status.phase}/{.status.currentStage}' 2>/dev/null)
  phase=${line%%/*}; stage=${line##*/}
  echo "$(date +%H:%M:%S) phase=$phase stage=$stage"
  if [ -n "$stage" ] && [ "$stage" != "$last_stage" ]; then
    n=$((n+1))
    echo ">>> stage transition: $last_stage -> $stage"
    cap shot "/workload-runs" "$OUT/$(printf %02d $n)-workload-runs-list-$stage.png"
    cap shot "/workload-runs/$RUN" "$OUT/$(printf %02d $n)-workload-detail-$stage.png"
    sleep 20   # let the stage pod produce some console output first
    cap shot "/agent-runs/$RUN-$stage" "$OUT/$(printf %02d $n)-console-$stage.png" 6000
    cap clip "/agent-runs/$RUN-$stage" "$OUT/$(printf %02d $n)-console-$stage.webm" 15
    last_stage="$stage"
  fi
  case "$phase" in
    Succeeded|Failed)
      n=$((n+1))
      cap shot "/workload-runs/$RUN" "$OUT/$(printf %02d $n)-workload-detail-final-$phase.png" 5000
      cap shot "/workload-runs" "$OUT/$(printf %02d $n)-workload-runs-list-final.png"
      cap shot "https://github.com/ibolton336/coolstore/tree/quarkus-migration-demo-2" "$OUT/$(printf %02d $n)-github-branch.png" 5000
      cap shot "https://github.com/ibolton336/coolstore/compare/main...quarkus-migration-demo-2" "$OUT/$(printf %02d $n)-github-compare.png" 6000
      echo "FINAL: $phase"
      break
      ;;
  esac
  sleep 15
done
ls -la "$OUT"
