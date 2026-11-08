-- Datasets were one jsonb row holding every sample, frame and raw source file (6-12 MB compressed, ~16 s to fetch
-- from a remote database). body now keeps only info/network/ops; the bulk parts move to gzip-compressed JSON in bytea.
-- Existing rows are rewritten by compactDatasets() in migrate.ts (gzip isn't available in SQL).
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS frames_gz bytea;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS samples_gz bytea;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS sources_gz bytea;
