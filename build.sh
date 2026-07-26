#!/usr/bin/env bash
#
# Build the static site into dist/.
#
# Replaces the previous run.php. Expands <!--#include name --> markers against
# src/partials/<name>.html and substitutes {{TITLE}} from each page's
# <!--#title ... --> line. Bash and coreutils only; no PHP, no Node, no
# package manager.
#
# Usage: ./build.sh [output-dir]     (default: dist)

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src"
ASSETS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/assets"
OUT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist}"

MAX_INCLUDE_DEPTH=8
TITLE=""

# Expand one file to stdout, recursing into includes.
# $1 = file path, $2 = current depth
expand() {
    local file="$1" depth="$2" line partial

    if (( depth > MAX_INCLUDE_DEPTH )); then
        printf 'build.sh: include depth exceeded at %s (circular include?)\n' "$file" >&2
        exit 1
    fi

    while IFS= read -r line || [[ -n $line ]]; do
        if [[ $line =~ \<!--\#include[[:space:]]+([a-zA-Z0-9_-]+)[[:space:]]*--\> ]]; then
            partial="$SRC/partials/${BASH_REMATCH[1]}.html"
            if [[ ! -f $partial ]]; then
                printf 'build.sh: %s: no such partial: %s\n' "$file" "${BASH_REMATCH[1]}" >&2
                exit 1
            fi
            expand "$partial" $(( depth + 1 ))
        elif [[ $line =~ \<!--\#title ]]; then
            :   # title directive is metadata, not output
        else
            printf '%s\n' "${line//\{\{TITLE\}\}/$TITLE}"
        fi
    done < "$file"
}

# Read the <!--#title ... --> directive from a page, if present.
read_title() {
    local line
    while IFS= read -r line || [[ -n $line ]]; do
        if [[ $line =~ \<!--\#title[[:space:]]+(.*[^[:space:]])[[:space:]]*--\> ]]; then
            printf '%s\n' "${BASH_REMATCH[1]}"
            return
        fi
    done < "$1"
    printf 'rdx\n'
}

main() {
    [[ -d $SRC/pages ]] || { echo "build.sh: missing $SRC/pages" >&2; exit 1; }

    rm -rf "$OUT"
    mkdir -p "$OUT"

    # Static files are copied flat: pages reference them as siblings.
    if [[ -d $ASSETS ]]; then
        find "$ASSETS" -type f -exec cp {} "$OUT/" \;
    fi
    cp "$SRC"/css/*.css "$OUT/"
    cp "$SRC"/js/*.js "$OUT/"
    if [[ -d $SRC/vendor ]]; then
        cp "$SRC"/vendor/* "$OUT/"
    fi

    local page name count=0
    for page in "$SRC"/pages/*.html; do
        name="$(basename "$page")"
        TITLE="$(read_title "$page")"
        expand "$page" 0 > "$OUT/$name"
        count=$(( count + 1 ))
    done

    printf 'build.sh: %d pages -> %s\n' "$count" "$OUT"
}

main "$@"
