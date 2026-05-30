#!/bin/sh
set -eu

extension_id="${1:-}"
browser="${2:-Chrome}"

if ! printf '%s' "$extension_id" | grep -Eq '^[a-p]{32}$'; then
  echo "ExtensionId must be a 32-character Chromium extension id using letters a-p." >&2
  exit 1
fi

case "$browser" in
  Chrome)
    manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Edge)
    manifest_dir="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    ;;
  *)
    echo "Browser must be Chrome or Edge." >&2
    exit 1
    ;;
esac

node_path="$(command -v node || true)"
if [ -z "$node_path" ]; then
  echo "Node.js is required but was not found on PATH." >&2
  exit 1
fi

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
host_path="$root/native-host/host.js"
runtime_dir="$HOME/Library/Application Support/XHSLocalArchive"
launcher_path="$runtime_dir/host.sh"
manifest_path="$manifest_dir/com.xhs_archive.host.json"

mkdir -p "$runtime_dir" "$manifest_dir"
{
  printf '%s\n' '#!/bin/sh'
  printf 'exec "%s" "%s"\n' "$node_path" "$host_path"
} > "$launcher_path"
chmod 700 "$launcher_path"

HOST_PATH="$launcher_path" EXTENSION_ID="$extension_id" "$node_path" <<'NODE' > "$manifest_path"
const manifest = {
  name: "com.xhs_archive.host",
  description: "Local archive host for XHS Archive extension",
  path: process.env.HOST_PATH,
  type: "stdio",
  allowed_origins: [`chrome-extension://${process.env.EXTENSION_ID}/`]
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE
chmod 600 "$manifest_path"

printf 'Installed native host manifest: %s\n' "$manifest_path"
printf 'Installed native host launcher: %s\n' "$launcher_path"
