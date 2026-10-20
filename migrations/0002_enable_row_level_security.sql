-- Supabase exposes every table in the "public" schema through an auto-generated REST API
-- (PostgREST), reachable with the project's public "anon" key. This service talks to Postgres
-- directly and never uses that API, so lock the table: with row-level security enabled and NO
-- policies, the API roles (anon, authenticated) can neither read nor write any row.
--
-- The service's own connection is unaffected: it uses the table owner, which bypasses RLS.
-- (On a plain Postgres, such as the local Docker database, this is simply a no-op safeguard.)
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
