#!/usr/bin/env bash
# Starts a local PocketBase for development on http://localhost:8090, applies
# pb_migrations and pb_hooks from this repo, and points the Vite dev server at it.
#
#   npm run pb          # start (or restart) it
#   RESET=1 npm run pb  # wipe local data first
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PB_VERSION="${PB_VERSION:-0.40.6}"
PB_DIR="$ROOT/.local-pocketbase"
PB_DATA="$PB_DIR/pb_data"
PB_BIN="$PB_DIR/pocketbase"
PB_URL="http://localhost:8090"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin12345678}"

case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac

mkdir -p "$PB_DIR"
if [ ! -x "$PB_BIN" ] || [ "$(cat "$PB_DIR/version" 2>/dev/null)" != "$PB_VERSION" ]; then
  echo "Downloading PocketBase v$PB_VERSION ($OS/$ARCH)..."
  curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${OS}_${ARCH}.zip" -o "$PB_DIR/pb.zip"
  unzip -o -q "$PB_DIR/pb.zip" pocketbase -d "$PB_DIR"
  rm "$PB_DIR/pb.zip"
  chmod +x "$PB_BIN"
  echo "$PB_VERSION" > "$PB_DIR/version"
fi

pkill -f "pocketbase serve.*8090" 2>/dev/null || true
sleep 1
[ -n "$RESET" ] && rm -rf "$PB_DATA"
mkdir -p "$PB_DATA"

"$PB_BIN" serve --http=0.0.0.0:8090 --dir="$PB_DATA" \
  --migrationsDir="$ROOT/pb_migrations" --hooksDir="$ROOT/pb_hooks" > "$PB_DIR/pb.log" 2>&1 &
echo "PocketBase started (PID $!), log: $PB_DIR/pb.log"

for i in $(seq 1 30); do
  curl -sf "$PB_URL/api/health" > /dev/null 2>&1 && break
  [ "$i" -eq 30 ] && { echo "PocketBase did not start. See $PB_DIR/pb.log"; exit 1; }
  sleep 1
done

"$PB_BIN" superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir="$PB_DATA" > /dev/null
echo "VITE_POCKETBASE_URL=$PB_URL" > "$ROOT/.env.development.local"

echo ""
echo "Local PocketBase ready at $PB_URL"
echo "  Admin dashboard: $PB_URL/_/  ($ADMIN_EMAIL / $ADMIN_PASSWORD)"
echo "  Now run: npm run dev"
