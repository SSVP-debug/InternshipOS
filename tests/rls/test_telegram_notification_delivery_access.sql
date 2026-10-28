-- test_telegram_notification_delivery_access.sql
-- The Telegram delivery ledger is an operator-only table. Regular app
-- roles must have no table privileges; service_role needs access for the
-- scheduled notifier. Run with: psql -v ON_ERROR_STOP=1 -f this_file

\set ON_ERROR_STOP on
\echo '--- Test Telegram notification delivery table access boundary ---'

do $$
declare
  rls_enabled boolean;
  rls_forced boolean;
begin
  if has_table_privilege('anon', 'public.telegram_notification_delivery', 'SELECT')
     or has_table_privilege('anon', 'public.telegram_notification_delivery', 'INSERT')
     or has_table_privilege('authenticated', 'public.telegram_notification_delivery', 'SELECT')
     or has_table_privilege('authenticated', 'public.telegram_notification_delivery', 'INSERT') then
    raise exception 'FAIL: anon/authenticated has table access to telegram_notification_delivery';
  end if;

  if not has_table_privilege('service_role', 'public.telegram_notification_delivery', 'SELECT')
     or not has_table_privilege('service_role', 'public.telegram_notification_delivery', 'INSERT') then
    raise exception 'FAIL: service_role is missing required table access';
  end if;

  select c.relrowsecurity, c.relforcerowsecurity
    into rls_enabled, rls_forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'telegram_notification_delivery';

  if rls_enabled is distinct from true or rls_forced is distinct from true then
    raise exception 'FAIL: RLS is not enabled and forced on telegram_notification_delivery';
  end if;

  raise notice 'PASS: only service_role has table privileges and RLS is enabled/forced';
end $$;
