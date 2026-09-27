-- Первый этап переноса: только семейные данные одного архива.
-- Таблицы аккаунтов, сессий, настроек и фоновых заданий появятся после
-- проектирования tenant-scoped доступа. Этот файл не переключает приложение.
CREATE TABLE IF NOT EXISTS archives (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  demo boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  sqlite_schema_version integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal)
);

CREATE TABLE IF NOT EXISTS relations (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL,
  source text NOT NULL,
  target text NOT NULL,
  type text NOT NULL CHECK (type IN ('parent','spouse','adoptive_parent','step_parent','godparent','nurse','sworn_sibling','guardian')),
  note text NOT NULL DEFAULT '',
  created_by text,
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal),
  UNIQUE (archive_id, source, target, type),
  CHECK (source <> target),
  FOREIGN KEY (archive_id, source) REFERENCES people(archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, target) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS relations_target ON relations(archive_id, target);

CREATE TABLE IF NOT EXISTS photos (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal)
);

CREATE TABLE IF NOT EXISTS photo_tags (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL,
  photo_id text NOT NULL,
  person_id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal),
  FOREIGN KEY (archive_id, photo_id) REFERENCES photos(archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, person_id) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS photo_tags_person ON photo_tags(archive_id, person_id);

CREATE TABLE IF NOT EXISTS documents (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL,
  title text NOT NULL,
  title_search text NOT NULL,
  file_name text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0),
  uploaded_by text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal),
  UNIQUE (archive_id, file_name)
);

CREATE TABLE IF NOT EXISTS document_people (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  ordinal bigint NOT NULL,
  document_id text NOT NULL,
  person_id text NOT NULL,
  PRIMARY KEY (archive_id, document_id, person_id),
  UNIQUE (archive_id, ordinal),
  FOREIGN KEY (archive_id, document_id) REFERENCES documents(archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, person_id) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_people_person ON document_people(archive_id, person_id);

CREATE TABLE IF NOT EXISTS history (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  saved_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (archive_id, revision)
);
