-- Existing archives still have the original image-only CHECK from migration 015.
-- PDF/TIFF are accepted only as verified portable citation originals or as
-- document files; the photo upload endpoint keeps its image-only validator.
ALTER TABLE media_originals DROP CONSTRAINT media_originals_url_check;
ALTER TABLE media_originals ADD CONSTRAINT media_originals_url_check
  CHECK (url ~ '^/media/[a-zA-Z0-9-]+\.(jpg|png|webp|gif|tif|pdf)$');
