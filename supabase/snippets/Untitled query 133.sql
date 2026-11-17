select
  n.event_type,
  o.channel,
  o.status,
  o.attempts,
  coalesce(o.last_error_code, '—') as last_error,
  to_char(o.created_at at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI:SS') as created_local
from wellweb_private.notification_outbox o
join public.wellweb_notifications n on n.id = o.notification_id
order by o.created_at desc
limit 20;