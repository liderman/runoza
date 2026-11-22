import { sql } from "kysely";
import type { Migration } from "kysely/migration";
export const mcpOAuthMigration: Migration = {
  async up(db) {
    await sql`CREATE TABLE mcp_oauth_owners(connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,generation uuid NOT NULL DEFAULT gen_random_uuid(),revoked_at timestamptz,PRIMARY KEY(connection_id,owner_id))`.execute(
      db,
    );
    await sql`CREATE TABLE mcp_oauth_credentials(connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,ciphertext text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(connection_id,owner_id))`.execute(
      db,
    );
    await sql`CREATE TABLE mcp_oauth_flows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state_hash text NOT NULL UNIQUE,connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,ciphertext text NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes')`.execute(
      db,
    );
  },
  async down(db) {
    await sql`DROP TABLE mcp_oauth_flows,mcp_oauth_credentials,mcp_oauth_owners`.execute(
      db,
    );
  },
};
