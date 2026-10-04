-- Installed only by the primary archive runtime. Its RLS scope is the
-- primary archive while the legacy catalog and settings are copied.
CREATE TABLE IF NOT EXISTS platform_config_migrations (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_upload_limits (
  id integer PRIMARY KEY CHECK (id=1),
  data text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_vk_auth_settings (
  id integer PRIMARY KEY CHECK (id=1),
  enabled integer NOT NULL CHECK (enabled IN (0,1)),
  client_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_research_categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  sort_order bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_research_categories_name
  ON platform_research_categories(lower(name));

CREATE TABLE IF NOT EXISTS platform_research_resources (
  id text PRIMARY KEY,
  category_id text NOT NULL REFERENCES platform_research_categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  description text NOT NULL,
  sort_order bigint NOT NULL,
  ai_search jsonb,
  UNIQUE(category_id,url)
);
CREATE INDEX IF NOT EXISTS platform_research_resources_category_order
  ON platform_research_resources(category_id,sort_order,id);

CREATE TABLE IF NOT EXISTS platform_config_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
