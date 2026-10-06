CREATE INDEX IF NOT EXISTS accounts_directory_name_id
  ON accounts(lower(name) COLLATE "C",id COLLATE "C");
