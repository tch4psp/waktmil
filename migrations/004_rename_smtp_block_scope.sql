UPDATE blocked_sources SET scope = 'ingest' WHERE scope = 'smtp';
ALTER TABLE blocked_sources DROP CONSTRAINT blocked_sources_scope_check;
ALTER TABLE blocked_sources ADD CONSTRAINT blocked_sources_scope_check CHECK (scope IN ('web', 'ingest', 'both'));
