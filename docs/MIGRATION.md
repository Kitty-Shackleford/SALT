# PostgreSQL Migration Guide

DayZ Dashboard supports PostgreSQL only. Schema initialization and pending
migrations run automatically when the backend starts.

## Before upgrading

1. Stop the backend and bot containers.
2. Create a database backup:

   ```bash
   pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" \
     -d "$POSTGRES_DB" > dayz-dashboard-backup.sql
   ```

3. Update the application code and install dependencies:

   ```bash
   npm ci
   ```

## Apply migrations

Start the backend normally. `db/schema.js` creates the schema for fresh
installations and runs each pending migration recorded in
`schema_migrations`.

```bash
docker compose up -d --build backend
docker compose logs -f backend
```

Legacy Schema V1 databases are detected at startup, but automatic conversion
is intentionally disabled because the historical redesign migration was not
data-safe on PostgreSQL. Do not bypass this guard. Preserve a `pg_dump` backup
and migrate through a separately validated import process.

## Verify

Run the PostgreSQL schema smoke test:

```bash
npm run db:smoke-test
```

Check applied migrations:

```sql
SELECT migration_name, executed_at
FROM schema_migrations
ORDER BY migration_name;
```

## Restore

If an upgrade fails, stop the application and restore the backup into a clean
PostgreSQL database:

```bash
psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" < dayz-dashboard-backup.sql
```
