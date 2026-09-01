// Neon Postgres connection for Vercel serverless functions.
// The Neon integration provisions DATABASE_URL on the Vercel project.

import { neon } from '@neondatabase/serverless';

let client = null;

export function db() {
  if (!process.env.DATABASE_URL) {
    const err = new Error('DATABASE_URL is not set — attach the Neon integration to this Vercel project.');
    err.statusCode = 503;
    throw err;
  }
  if (!client) client = neon(process.env.DATABASE_URL);
  return client;
}

let migrated = false;

export async function ensureSchema() {
  if (migrated) return;
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id text PRIMARY KEY,
      title text NOT NULL DEFAULT 'Untitled survey',
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS ops (
      seq bigserial PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind text NOT NULL,
      payload jsonb NOT NULL,
      actor text NOT NULL,
      ts bigint NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS actors (
      actor text NOT NULL,
      workspace_id text NOT NULL,
      last_seen timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor, workspace_id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS ops_ws_seq ON ops (workspace_id, seq)`;
  migrated = true;
}
