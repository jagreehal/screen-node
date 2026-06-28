#!/bin/sh
# Generate the tinyproxy allowlist from ALLOW (comma-separated domains), then run.
# Each domain becomes an anchored regex so "npmjs.org" matches registry.npmjs.org
# but NOT npmjs.org.evil.com (the trailing $ prevents allowlist-suffix bypass).
set -e
ALLOW="${ALLOW:-npmjs.org,npmjs.com}"

: > /etc/tinyproxy/filter
OLDIFS="$IFS"; IFS=','
for d in $ALLOW; do
  d="$(printf '%s' "$d" | tr -d '[:space:]')"
  [ -z "$d" ] && continue
  esc="$(printf '%s' "$d" | sed 's/\./\\./g')"
  printf '(^|\\.)%s$\n' "$esc" >> /etc/tinyproxy/filter
done
IFS="$OLDIFS"

echo "egress-proxy: allowlist (default-deny otherwise):" >&2
cat /etc/tinyproxy/filter >&2

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
