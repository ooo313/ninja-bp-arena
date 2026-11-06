-- Unlimited series stay open until the host closes them.
create function public.set_unlimited_room_expiry()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.match_state -> 'rule' -> 'bestOf' = '0'::jsonb then
    new.expires_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

create trigger set_unlimited_room_expiry
before insert on public.rooms
for each row execute function public.set_unlimited_room_expiry();
