-- 0001_extensions.sql
-- Phase 0 / Day 1 — base extensions required by later migrations.
-- Safe to run on a real Supabase project (these extensions ship enabled by
-- default there) and on a plain local Postgres used for CI/local testing.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
