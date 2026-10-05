-- One-time cluster bootstrap, run as a superuser (locally) or the RDS master user (Terraform).
-- Creates the two roles the application uses:
--   teeth_owner  owns the schema and runs migrations; never used by the running API.
--   teeth_app    the API's runtime role: no BYPASSRLS, no ownership, so row-level security
--                always applies and it cannot alter or drop tables.
-- Passwords here are local-development values; deployed environments set them from Secrets Manager.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teeth_owner') THEN
    CREATE ROLE teeth_owner LOGIN PASSWORD 'teeth_owner_dev' NOSUPERUSER NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teeth_app') THEN
    CREATE ROLE teeth_app LOGIN PASSWORD 'teeth_app_dev' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

SELECT 'CREATE DATABASE teeth OWNER teeth_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'teeth') \gexec
-- Separate database for the automated test suite (it resets its schema on every run).
SELECT 'CREATE DATABASE teeth_test OWNER teeth_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'teeth_test') \gexec

\connect teeth
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE teeth TO teeth_app;

\connect teeth_test
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT CONNECT ON DATABASE teeth_test TO teeth_app;
