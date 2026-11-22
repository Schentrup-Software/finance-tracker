#!/bin/sh
# Starts PocketBase as the TrueNAS "apps" user (PUID/PGID, 568 by default).
#
# Started as root (the default), it first makes sure the data folder exists and
# belongs to that user, so a dataset with the wrong owner (or a path Docker had
# to create) doesn't stop the app. Started as another user, it checks the
# folder is writable and says so plainly if it isn't.
set -e

DATA="${PB_DATA_DIR:-/pb/pb_data}"
PUID="${PUID:-568}"
PGID="${PGID:-568}"

mkdir -p "$DATA" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  if ! chown -R "$PUID:$PGID" "$DATA" 2>/dev/null; then
    echo "finance-tracker: couldn't change the owner of $DATA to $PUID:$PGID (the dataset's ACL may not allow it)." >&2
  fi
  if ! su-exec "$PUID:$PGID" sh -c "touch '$DATA/.write-test' && rm -f '$DATA/.write-test'"; then
    echo "finance-tracker: user $PUID can't write to $DATA. Give the 'apps' user (ID $PUID) read/write access" >&2
    echo "finance-tracker: to the dataset in TrueNAS (Datasets > your dataset > Permissions), then start the app again." >&2
    exit 1
  fi
  echo "finance-tracker: starting PocketBase as $PUID:$PGID, data in $DATA"
  exec su-exec "$PUID:$PGID" "$@"
fi

if ! (touch "$DATA/.write-test" && rm -f "$DATA/.write-test") 2>/dev/null; then
  echo "finance-tracker: user $(id -u) can't write to $DATA. Give that user read/write access to the dataset," >&2
  echo "finance-tracker: or remove the 'user:' line from the app's YAML so the container can fix the owner itself." >&2
  exit 1
fi
echo "finance-tracker: starting PocketBase as $(id -u), data in $DATA"
exec "$@"
