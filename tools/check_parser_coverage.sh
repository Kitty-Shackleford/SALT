#!/usr/bin/env bash
set -euo pipefail

# Re-run key checks used by parser_coverage_report.md
# Usage: ./tools/check_parser_coverage.sh

PGPASS=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
run_sql() {
  docker-compose exec -T -e PGPASSWORD="$PGPASS" postgres \
    psql -v ON_ERROR_STOP=1 -U dayz-dashboard -d dayz-dashboard -c "$1"
}

echo "\n== Public tables (schema) =="
run_sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"

echo "\n== Kill events null-rate (last 30d) =="
run_sql "SELECT 'kill_events.killer_identity_id' AS column, count(*) FILTER (WHERE killer_identity_id IS NULL) AS nulls, count(*) AS total FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.killer_gamertag', count(*) FILTER (WHERE killer_gamertag IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.killer_position', count(*) FILTER (WHERE killer_position IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.victim_identity_id', count(*) FILTER (WHERE victim_identity_id IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.victim_gamertag', count(*) FILTER (WHERE victim_gamertag IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.victim_position', count(*) FILTER (WHERE victim_position IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.weapon', count(*) FILTER (WHERE weapon IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.distance', count(*) FILTER (WHERE distance IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.log_source', count(*) FILTER (WHERE log_source IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.server_id', count(*) FILTER (WHERE server_id IS NULL), count(*) FROM kill_events WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'kill_events.timestamp (all_rows)', count(*) FILTER (WHERE timestamp IS NULL), count(*) FROM kill_events"

echo "\n== Economy transactions null-rate (last 30d) =="
run_sql "SELECT 'economy_transactions.identity_id' AS column, count(*) FILTER (WHERE identity_id IS NULL) AS nulls, count(*) AS total FROM economy_transactions WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'economy_transactions.transaction_type', count(*) FILTER (WHERE transaction_type IS NULL), count(*) FROM economy_transactions WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'economy_transactions.amount', count(*) FILTER (WHERE amount IS NULL), count(*) FROM economy_transactions WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'economy_transactions.balance_after', count(*) FILTER (WHERE balance_after IS NULL), count(*) FROM economy_transactions WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'economy_transactions.server_id', count(*) FILTER (WHERE server_id IS NULL), count(*) FROM economy_transactions WHERE timestamp >= now() - INTERVAL '30 days' UNION ALL SELECT 'economy_transactions.timestamp (all_rows)', count(*) FILTER (WHERE timestamp IS NULL), count(*) FROM economy_transactions"

echo "\n== Loot despawn (last 30d) =="
run_sql "SELECT count(*) FROM loot_despawn_events WHERE created_at >= now() - INTERVAL '30 days';"

echo "\n== Quick grep: parser functions and INSERTs =="
# Show locations of major parser functions and where inserts happen
rg --hidden --no-ignore -n "parseKillEvents|parseCleanupEvents|parseADMLog|parseRPTLog|saveKillEvents|saveCleanupEvents|INSERT INTO kill_events|INSERT INTO loot_despawn_events|INSERT INTO economy_transactions" || true

echo "\n== Script complete =="
