#!/usr/bin/env bash
# Get a hub access token with AUTH_REQUIRED=true, headless — no browser.
#
#   hack/hub-auth-login.sh                 # print the access token
#   eval "$(hack/hub-auth-login.sh --export)"   # sets $HUB_TOKEN
#   HUB_USER=architect HUB_PASS=... hack/hub-auth-login.sh
#
# The hub's builtin OIDC provider REQUIRES PKCE — a token exchange without a
# code_verifier 400s "PKCE required", which is the single most common reason
# a hand-rolled curl against this thing fails. So: S256 challenge, auth-code
# flow, code_verifier on the exchange.
#
# The login page is a JS app, not an HTML form: /oidc/authorize 302s to
# /oidc/login?authRequestId=…, whose HTML carries
# `window.__LOGIN_CONFIG__ = {"formAction": …}`. The hub reads the
# PatternFly field ids from that POST (internal/auth/storage.go
# parseCredentials): pf-login-username-id / pf-login-password-id. A plain
# <form>, should the page ever grow one, is handled too.
#
# Access tokens live 5 minutes on a stock hub (the rig sets 8 h via
# OIDC_TOKEN_LIFESPAN). Re-run when calls start 401'ing "Token expired" —
# that is expiry, not a broken grant.
set -euo pipefail

HUB="${HUB:-http://localhost:18080}"
HUB_USER="${HUB_USER:-admin}"
HUB_PASS="${HUB_PASS:-admin}"
CLIENT_ID="${CLIENT_ID:-web-ui}"
LOGIN_USER_FIELD="${LOGIN_USER_FIELD:-pf-login-username-id}"
LOGIN_PASS_FIELD="${LOGIN_PASS_FIELD:-pf-login-password-id}"
# Must be a redirect URI the web-ui IdpClient lists LITERALLY — the hub
# rewrites its ${issuer.*} pattern with the first requested URI that matches
# it (Client.Inject), after which every other origin 400s "The requested
# redirect_uri is missing in the client configuration". hub-auth-rig.yaml
# lists this one for that reason. Nothing listens on it — we only read the
# code out of the redirect's Location header.
REDIRECT_URI="${REDIRECT_URI:-http://localhost:8080/}"

EXPORT=0
[ "${1:-}" = "--export" ] && EXPORT=1

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl required" >&2; exit 1; }

b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
VERIFIER="$(openssl rand 32 | b64url)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | b64url)"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

urlenc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

AUTHZ="$HUB/oidc/authorize?response_type=code&client_id=$(urlenc "$CLIENT_ID")&redirect_uri=$(urlenc "$REDIRECT_URI")&scope=openid&code_challenge=${CHALLENGE}&code_challenge_method=S256"

# Follow the authorize redirect to the login page. -w gives us the URL we
# ended up on, which is the POST target when the page carries no config.
PAGE_FILE="$(mktemp)"
trap 'rm -f "$JAR" "$PAGE_FILE"' EXIT
LOGIN_URL="$(curl -sS -c "$JAR" -b "$JAR" -L -o "$PAGE_FILE" -w '%{url_effective}' "$AUTHZ")" \
  || { echo "authorize request failed (is the hub up on $HUB?)" >&2; exit 1; }
if [ "$LOGIN_URL" = "$AUTHZ" ] && ! grep -q '__LOGIN_CONFIG__\|<form' "$PAGE_FILE"; then
  echo "authorize did not redirect to a login page — is the web-ui IdpClient present, and is REDIRECT_URI ($REDIRECT_URI) allowed by it?" >&2
  head -c 300 "$PAGE_FILE" >&2; echo >&2
  exit 1
fi

# Where to POST, and with which field names. Prefer the JS app's config;
# fall back to a real <form> if there is one; else the login URL itself.
# (The parser lives in a temp file: macOS bash 3.2 cannot parse a heredoc
# containing parentheses inside $(...).)
PARSER="$(mktemp)"
trap 'rm -f "$JAR" "$PAGE_FILE" "$PARSER"' EXIT
cat >"$PARSER" <<'PY'
import html.parser, json, re, sys, urllib.parse

page_file, login_url, user_field, pass_field = sys.argv[1:5]
page = open(page_file, encoding="utf-8", errors="replace").read()

m = re.search(r"__LOGIN_CONFIG__\s*=\s*(\{.*?\})\s*;?\s*</script>", page, re.S)
if m:
    try:
        cfg = json.loads(m.group(1))
    except json.JSONDecodeError:
        cfg = {}
    action = cfg.get("formAction") or login_url
    print(urllib.parse.urljoin(login_url, action)); print("post")
    print(f"{user_field}=__USER__"); print(f"{pass_field}=__PASS__")
    sys.exit(0)

class F(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.action, self.method, self.fields, self.in_form = None, "post", [], False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.in_form = True
            self.action = a.get("action") or ""
            self.method = (a.get("method") or "post").lower()
        elif tag == "input" and self.in_form:
            name = a.get("name") or a.get("id")
            if name:
                self.fields.append((name, a.get("value") or "", (a.get("type") or "text").lower()))
    def handle_endtag(self, tag):
        if tag == "form":
            self.in_form = False

f = F(); f.feed(page)
if f.action is None:
    # No config, no form: assume the hub's own field names against the login URL.
    print(login_url); print("post")
    print(f"{user_field}=__USER__"); print(f"{pass_field}=__PASS__")
    sys.exit(0)

out = []
for name, value, typ in f.fields:
    n = name.lower()
    if typ == "password" or "pass" in n:
        value = "__PASS__"
    elif typ in ("text", "email") or n in ("username", "user", "login", "email"):
        value = "__USER__"
    elif typ == "submit" and not value:
        continue
    out.append(f"{name}={value}")
print(urllib.parse.urljoin(login_url, f.action)); print(f.method); print("\n".join(out))
PY
FORM="$(python3 "$PARSER" "$PAGE_FILE" "$LOGIN_URL" "$LOGIN_USER_FIELD" "$LOGIN_PASS_FIELD")" \
  || { echo "could not work out the login form" >&2; exit 1; }

ACTION="$(printf '%s' "$FORM" | sed -n 1p)"
METHOD="$(printf '%s' "$FORM" | sed -n 2p)"
FIELDS="$(printf '%s' "$FORM" | tail -n +3)"

DATA=()
while IFS= read -r kv; do
  [ -n "$kv" ] || continue
  # Credentials go in here, not through the parser's argv.
  kv="${kv//__USER__/$HUB_USER}"
  kv="${kv//__PASS__/$HUB_PASS}"
  DATA+=(--data-urlencode "$kv")
done <<<"$FIELDS"

location_of() { awk 'tolower($1)=="location:"{print $2}' | tr -d '\r'; }

# Submit. A wrong password re-renders the login page (200, no Location).
if [ "$METHOD" = "get" ]; then
  LOCATION="$(curl -sS -c "$JAR" -b "$JAR" -o "$PAGE_FILE" -D - -G "${DATA[@]}" "$ACTION" | location_of)"
else
  LOCATION="$(curl -sS -c "$JAR" -b "$JAR" -o "$PAGE_FILE" -D - "${DATA[@]}" "$ACTION" | location_of)"
fi
[ -n "$LOCATION" ] || { echo "login was not accepted (no redirect after POST) — bad credentials for $HUB_USER?" >&2; exit 1; }

# The hub bounces through /oidc/authorize/callback?id=… before sending the
# browser to redirect_uri?code=…. Follow hops that stay on the hub by hand
# and stop at the first that leaves it — nothing listens there, and the
# code is in that Location.
for _ in 1 2 3 4 5; do
  case "$LOCATION" in
    "$HUB"/*) LOCATION="$(curl -sS -c "$JAR" -b "$JAR" -o "$PAGE_FILE" -D - "$LOCATION" | location_of)" ;;
    *) break ;;
  esac
  [ -n "$LOCATION" ] || { echo "redirect chain ended without leaving the hub" >&2; exit 1; }
done

CODE="$(printf '%s' "$LOCATION" | python3 -c 'import sys,urllib.parse;q=urllib.parse.urlparse(sys.stdin.read().strip()).query;print(urllib.parse.parse_qs(q).get("code",[""])[0])')"
[ -n "$CODE" ] || { echo "no authorization code in the final redirect ($LOCATION) — redirect_uri not registered on the IdpClient?" >&2; exit 1; }

TOKEN_JSON="$(curl -sS -c "$JAR" -b "$JAR" -X POST "$HUB/oidc/token" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$VERIFIER")"

TOKEN="$(printf '%s' "$TOKEN_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "token exchange failed: $TOKEN_JSON" >&2
  exit 1
fi

if [ "$EXPORT" = "1" ]; then
  echo "export HUB_TOKEN=$TOKEN"
else
  echo "$TOKEN"
fi
