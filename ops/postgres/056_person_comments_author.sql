-- Account data export reads the current user's comments within each archive
-- in id order. The existing person index cannot serve the author predicate.
CREATE INDEX IF NOT EXISTS person_comments_author
  ON person_comments(archive_id, author_id, id);
