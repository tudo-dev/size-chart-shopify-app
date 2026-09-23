#!/bin/sh
set -e

# The database lives in the mounted data folder; make sure it exists.
mkdir -p "$(dirname "${DATABASE_URL:-/app/data/db.sqlite}")"

echo "Running database migrations..."
pnpm exec drizzle-kit migrate

echo "Starting Tudoholic Size Charts..."
exec node ./.output/server/index.mjs --port "${PORT:-3000}" --hostname "${HOST:-0.0.0.0}"
