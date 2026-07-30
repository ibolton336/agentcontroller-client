#!/usr/bin/env bash
# Attach a GitHub push credential to the coolstore application on the demo
# Hub. Run this yourself — the token must not travel through a chat session.
#
# The harness clones and pushes using the `source`-kind Hub identity attached
# to the application it resolves from APP_ID. Without it the run gets all the
# way to the final push and dies with:
#   "final push: authentication required: No anonymous write access."
#
# Usage:
#   export GITHUB_PAT='ghp_...'        # needs `repo` scope on ibolton336/coolstore
#   ./add-git-identity.sh [github-username] [app-id]
#
# Equivalent UI path, if you would rather show it live to a product owner:
#   tackle2-ui -> Administration -> Credentials -> Create new
#     Type "Source control", User/Password, then attach it on the
#     application's edit form under "Credentials -> Source".
set -euo pipefail

GITHUB_USER=${1:-ibolton336}
# NO default app id: two demo clusters share this script and their Hubs
# disagree (ROKS: coolstore=1, dylan-mta: coolstore=2). Pass it explicitly.
APP_ID=${2:?"pass the coolstore app id as arg 2 (ROKS hub: 1, dylan-mta hub: 2)"}
NS=konveyor-tackle
PORT=${PORT:-18099}

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "GITHUB_PAT is not set. Export it first (it is never echoed)." >&2
  exit 1
fi

oc -n "$NS" port-forward svc/tackle-hub "$PORT:8080" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null' EXIT
sleep 4
HUB="http://127.0.0.1:$PORT"

id=$(GITHUB_USER="$GITHUB_USER" python3 -c "
import json,os,sys
print(json.dumps({'kind':'source','name':'github-push',
  'description':'GitHub PAT for the coolstore fork',
  'user':os.environ['GITHUB_USER'],'password':os.environ['GITHUB_PAT']}))
" | curl -s -X POST "$HUB/identities" -H 'content-type: application/json' -d @- \
   | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "created identity id=$id"

# Re-PUT the application with the identity attached. The Hub replaces the
# whole identities list, so send the full object.
# BUGFIX 2026-07-30: ID= must precede python3 (env var), not trail it (argv) —
# the trailing form raised KeyError and sent a broken body (PUT 400).
# BUGFIX 2026-07-30 (2): the association MUST carry role:'source' — the harness
# resolves creds via GET /applications/{id}/identities?filter=role='source'
# (association role, not identity kind). A bare {id} association matches
# nothing and the final push goes anonymous. (The Indirect fallback needs
# the identity to be default:true instead.)
curl -s "$HUB/applications/$APP_ID" \
  | ID="$id" python3 -c "
import sys,json,os
a=json.load(sys.stdin)
a['identities']=[{'id':int(os.environ['ID']),'role':'source'}]
json.dump(a,sys.stdout)
" \
  | curl -s -X PUT "$HUB/applications/$APP_ID" -H 'content-type: application/json' -d @- \
      -o /dev/null -w "application $APP_ID updated: %{http_code}\n"

curl -s "$HUB/applications/$APP_ID" | python3 -c "
import sys,json
a=json.load(sys.stdin)
print('app:', a['name'], '| repo:', (a.get('repository') or {}).get('url'))
print('identities:', [i.get('name') for i in (a.get('identities') or [])])
"
