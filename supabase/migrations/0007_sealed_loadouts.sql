-- Private selections never enter rooms, room_commands, Presence or Realtime.
create table public.room_loadout_submissions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  phase_key text not null,
  side text not null check (side in ('BLUE','RED')),
  user_id uuid not null references auth.users(id) on delete cascade,
  command_id uuid not null,
  resource_type text not null check (resource_type in ('SECRET_SCROLL','SUMMON')),
  resource_ids jsonb not null check (jsonb_typeof(resource_ids) = 'array' and jsonb_array_length(resource_ids) between 1 and 12),
  created_at timestamptz not null default now(),
  primary key(room_id, phase_key, side),
  unique(room_id, user_id, command_id)
);
alter table public.room_loadout_submissions enable row level security;
revoke all on public.room_loadout_submissions from public, anon, authenticated;
grant select on public.room_loadout_submissions to authenticated;
grant all on public.room_loadout_submissions to service_role;
create policy own_loadout_only on public.room_loadout_submissions for select to authenticated
using (user_id = auth.uid() and exists (
  select 1 from public.room_members m where m.room_id = room_loadout_submissions.room_id and m.user_id = auth.uid() and m.seat = room_loadout_submissions.side
));

-- Both submitters serialize on the room row. If the second read missed the first
-- submission, retry validation in Edge; never commit a partial public loadout.
create function public.commit_room_loadout(
  p_room_id uuid, p_expected_revision bigint, p_expected_match jsonb,
  p_phase_key text, p_user_id uuid, p_side text, p_command_id uuid,
  p_resource_type text, p_resource_ids jsonb,
  p_opponent_command_id uuid, p_revealed_match jsonb
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms%rowtype;
  v_mine public.room_loadout_submissions%rowtype;
  v_other public.room_loadout_submissions%rowtype;
  v_revision bigint;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status <> 'ACTIVE' or v_room.expires_at <= now() then raise exception 'ROOM_NOT_ACTIVE'; end if;
  if not exists(select 1 from public.room_members where room_id = p_room_id and user_id = p_user_id and seat = p_side and seat in ('BLUE','RED')) then raise exception 'NOT_PERMITTED'; end if;
  select * into v_mine from public.room_loadout_submissions where room_id = p_room_id and phase_key = p_phase_key and side = p_side;
  if found then
    if v_mine.user_id <> p_user_id or v_mine.command_id <> p_command_id or v_mine.resource_ids <> p_resource_ids or v_mine.resource_type <> p_resource_type then raise exception 'LOADOUT_LOCKED'; end if;
    return v_room.revision;
  end if;
  if v_room.revision <> p_expected_revision or v_room.match_state <> p_expected_match then raise exception 'REVISION_CONFLICT'; end if;
  select * into v_other from public.room_loadout_submissions where room_id = p_room_id and phase_key = p_phase_key and side <> p_side;
  if v_other.command_id is distinct from p_opponent_command_id then raise exception 'REVISION_CONFLICT'; end if;
  if (v_other.command_id is not null) <> (p_revealed_match is not null) then raise exception 'INVALID_REVEAL'; end if;
  insert into public.room_loadout_submissions(room_id,phase_key,side,user_id,command_id,resource_type,resource_ids)
    values(p_room_id,p_phase_key,p_side,p_user_id,p_command_id,p_resource_type,p_resource_ids);
  update public.rooms set
    match_state = coalesce(p_revealed_match, match_state),
    revision = revision + 1,
    pending_action = null
    where id = p_room_id returning revision into v_revision;
  return v_revision;
end;
$$;
revoke all on function public.commit_room_loadout(uuid,bigint,jsonb,text,uuid,text,uuid,text,jsonb,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.commit_room_loadout(uuid,bigint,jsonb,text,uuid,text,uuid,text,jsonb,uuid,jsonb) to service_role;
