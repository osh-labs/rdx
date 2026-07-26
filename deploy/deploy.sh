#!/usr/bin/env bash
#
# Build and publish to the local nginx root.
#
# Run this on the instance itself. There is nothing to compile and no
# credentials involved -- the whole app is static files, and every Reddit
# request happens in your browser, not here.
#
# Usage: ./deploy/deploy.sh [target-dir]      (default: /var/www/rdx)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-/var/www/rdx}"

cd "$REPO"

echo "==> Building"
./build.sh

echo "==> Publishing to $TARGET"
if [[ ! -d $TARGET ]]; then
    echo "    $TARGET does not exist; create it first:" >&2
    echo "      sudo mkdir -p $TARGET && sudo chown \"\$USER\" $TARGET" >&2
    exit 1
fi

# --delete so files removed from the build disappear from the server too.
rsync -a --delete "$REPO/dist/" "$TARGET/"

echo "==> Done. $(find "$TARGET" -type f | wc -l) files in $TARGET"
echo
echo "    If this is a first run, publish it over Tailscale with:"
echo "      sudo tailscale serve --bg --https=443 http://127.0.0.1:8080"
echo
echo "    Then register the redirect URI shown on the login page at"
echo "      https://www.reddit.com/prefs/apps   (app type: installed app)"
