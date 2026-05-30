#!/bin/sh
set -eu

browser="${1:-All}"
remove_generated="${2:-}"
runtime_dir="$HOME/Library/Application Support/XHSLocalArchive"
launcher_path="$runtime_dir/host.sh"

remove_manifest() {
  path="$1"
  if [ -f "$path" ]; then
    rm -f "$path"
    printf 'Removed native host manifest: %s\n' "$path"
  else
    printf 'Native host manifest absent: %s\n' "$path"
  fi
}

case "$browser" in
  Chrome)
    remove_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xhs_archive.host.json"
    ;;
  Edge)
    remove_manifest "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.xhs_archive.host.json"
    ;;
  All)
    remove_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xhs_archive.host.json"
    remove_manifest "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.xhs_archive.host.json"
    ;;
  *)
    echo "Browser must be Chrome, Edge, or All." >&2
    exit 1
    ;;
esac

if [ "$remove_generated" = "--remove-launcher" ]; then
  rm -f "$launcher_path"
  printf 'Removed native host launcher: %s\n' "$launcher_path"
fi
