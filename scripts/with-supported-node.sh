#!/usr/bin/env bash

set -euo pipefail

preferred_version="22.12.0"
nvm_root="${NVM_DIR:-$HOME/.nvm}/versions/node"

is_supported_node() {
  local node_bin="$1"
  local version major minor patch

  [ -x "$node_bin" ] || return 1
  version="$($node_bin -p 'process.versions.node' 2>/dev/null)" || return 1
  IFS=. read -r major minor patch <<EOF
$version
EOF

  case "$major" in
    20) [ "$minor" -ge 19 ] ;;
    22) [ "$minor" -ge 12 ] ;;
    24|25|26|27|28|29) return 0 ;;
    *) return 1 ;;
  esac
}

current_node="$(command -v node 2>/dev/null || true)"
if [ -n "$current_node" ] && is_supported_node "$current_node"; then
  exec "$@"
fi

preferred_node="$nvm_root/v$preferred_version/bin/node"
selected_node=""

if is_supported_node "$preferred_node"; then
  selected_node="$preferred_node"
else
  best_weight=-1
  for candidate in "$nvm_root"/v*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if ! is_supported_node "$candidate"; then
      continue
    fi

    version="$($candidate -p 'process.versions.node')"
    IFS=. read -r major minor patch <<EOF
$version
EOF
    weight=$((major * 1000000 + minor * 1000 + patch))
    if [ "$weight" -gt "$best_weight" ]; then
      selected_node="$candidate"
      best_weight="$weight"
    fi
  done
fi

if [ -z "$selected_node" ]; then
  cat >&2 <<EOF
RTSVR requires Node >=20.19, >=22.12, or >=24.
No compatible Node installation was found under $nvm_root.
Install Node $preferred_version with: nvm install $preferred_version
EOF
  exit 1
fi

selected_bin_dir="$(dirname "$selected_node")"
export PATH="$selected_bin_dir:$PATH"
echo "RTSVR: using Node $($selected_node --version) from $selected_bin_dir" >&2
exec "$@"

