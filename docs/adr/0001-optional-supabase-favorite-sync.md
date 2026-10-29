# ADR 0001: Optional Supabase sync for favorite links

Status: Accepted

## Context

Users want one favorite-links collection across Chrome profiles signed into different Google accounts. Chrome storage sync cannot make those separate browser identities share one collection. Existing Tab Out favorites are stored locally under quickLinkData and must continue working without a backend.

## Decision

Add optional account sync backed by Supabase Auth and one PostgreSQL JSONB document row per authenticated Tab Out user. Use the Supabase client-facing publishable/anon key only; enforce row ownership through RLS. Keep all current local storage as the immediate source for rendering and offline use. Use a JSON document with per-entity timestamps and delete tombstones plus optimistic revision-based updates.

## Consequences

- Users must create/configure a Supabase project and an independent Tab Out account.
- Only favorites/groups synchronize in the first release; other local analytics and browsing data remain local.
- A locally configured client key is public by design; data security depends on correct RLS and never exposing service-role credentials.
- Document-level merging is simpler for this model but requires bounded retries under concurrent writes; entity timestamps/tombstones prevent common update/delete resurrection races.
