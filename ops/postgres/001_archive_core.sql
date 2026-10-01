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
  type text NOT NULL CHECK (type IN ('parent','spouse','adoptive_parent','foster_parent','presumed_parent','step_parent','godparent','nurse','sworn_sibling','guardian','twin')),
  note text NOT NULL DEFAULT '',
  twin_kind text CHECK (twin_kind IS NULL OR (type='twin' AND twin_kind IN ('identical','fraternal','unknown'))),
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
  annotations text NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(annotations::jsonb) = 'array'),
  event_links text NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(event_links::jsonb) = 'array'),
  pages text NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pages::jsonb) = 'array'),
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

CREATE TABLE IF NOT EXISTS person_comments (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id bigint NOT NULL,
  person_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL DEFAULT '',
  created_ms bigint NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  PRIMARY KEY (archive_id, id),
  FOREIGN KEY (archive_id, person_id) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS person_comments_person ON person_comments(archive_id, person_id, id DESC);
