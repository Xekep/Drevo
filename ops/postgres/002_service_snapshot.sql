-- Complete, loss-checked staging of service rows. The application must not
-- use these shadow tables as its live repositories: service APIs still use
-- SQLite until each access path has a scoped PostgreSQL implementation.
CREATE TABLE IF NOT EXISTS service_snapshot_tables (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  name text NOT NULL,
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (archive_id, name)
);

CREATE TABLE IF NOT EXISTS service_snapshot_rows (
  archive_id text NOT NULL,
  table_name text NOT NULL,
  ordinal bigint NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (archive_id, table_name, ordinal),
  FOREIGN KEY (archive_id, table_name)
    REFERENCES service_snapshot_tables(archive_id, name) ON DELETE CASCADE
);
