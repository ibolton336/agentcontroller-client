#!/bin/sh
# Serve this testbed as a read-only git repo that sandbox pods can clone:
#
#   git://192.168.65.254:9418/rhdh-upgrade-testbed
#
# 192.168.65.254 is host.minikube.internal as seen from the docker-driver
# node; pods don't inherit the node's /etc/hosts, so the Agent CR default
# uses the IP directly. Snapshots the tracked files into a throwaway repo
# under $BASE so the daemon never exports this checkout's real .git.
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)
BASE=${BASE:-/tmp/rhdh-testbed-serve}

rm -rf "$BASE/rhdh-upgrade-testbed"
mkdir -p "$BASE/rhdh-upgrade-testbed"
cp "$SRC/.rhdh-upgrade-helper.yaml" "$SRC"/*.yaml "$SRC/README.md" "$BASE/rhdh-upgrade-testbed/"

cd "$BASE/rhdh-upgrade-testbed"
git init -q -b main
git add -A
git -c user.email=testbed@local -c user.name=testbed commit -qm "testbed snapshot"

echo "serving git://<host>:9418/rhdh-upgrade-testbed (Ctrl-C to stop)"
exec git daemon --export-all --base-path="$BASE" --port=9418 --reuseaddr --verbose
