#!/usr/bin/env bash
# One-command build: compiles the Swift AX helper and builds the TypeScript MCP server.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building Swift Accessibility helper..."
( cd "$here/helper" && swift build -c release )

echo "==> Installing and building the MCP server..."
( cd "$here/server" && npm install && npm run build )

cat <<EOF

✅ Build complete.

  Server entrypoint : $here/server/dist/index.js
  Helper binary     : $here/helper/.build/release/notes-ax-helper

Next steps:
  1. Grant your MCP client app Full Disk Access + Accessibility
     (System Settings → Privacy & Security).
  2. Add the server to your client config, pointing at the server entrypoint above.

See docs/USING-WITH-CLAUDE.md for exact steps.
EOF
