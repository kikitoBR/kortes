-- Live streams are clipped as they happen, so their source rows use type 'live'
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_type_check;
ALTER TABLE sources DROP CONSTRAINT IF EXISTS check_source_type;
ALTER TABLE sources ADD CONSTRAINT check_source_type CHECK (type IN ('youtube', 'video_url', 'live'));
