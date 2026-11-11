-- One shared configuration for every archive, outside archive RLS.
CREATE TABLE IF NOT EXISTS platform_chronicle_settings (
  id integer PRIMARY KEY CHECK (id=1),
  version integer NOT NULL CHECK (version>0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object')
);
