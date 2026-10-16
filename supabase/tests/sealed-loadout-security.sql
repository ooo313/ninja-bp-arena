-- Isolated rollback-only checks for private drafts and atomic publication.
begin;
insert into auth.users(id) values ('70000000-0000-0000-0000-000000000001'),('70000000-0000-0000-0000-000000000002'),('70000000-0000-0000-0000-000000000003');
insert into public.rooms(id,code,host_user_id,status,match_state,pool,revision,expires_at)
values('70000000-0000-0000-0000-000000000004','BPTEST','70000000-0000-0000-0000-000000000001','ACTIVE','{"updatedAt":1,"history":[]}', '[]',0,'2999-01-01');
insert into public.room_members(room_id,user_id,seat,display_name) values
('70000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000001','BLUE','Blue'),
('70000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000002','RED','Red'),
('70000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000003','OBSERVER','Observer');

select public.commit_room_loadout('70000000-0000-0000-0000-000000000004',0,'{"updatedAt":1,"history":[]}', 'phase1','70000000-0000-0000-0000-000000000001','BLUE','70000000-0000-0000-0000-000000000005','SECRET_SCROLL','["secret-blue-1","secret-blue-2","secret-blue-3"]',null,null);
do $$ begin
  if (select revision from public.rooms where id='70000000-0000-0000-0000-000000000004') <> 1 then raise exception 'Private submit did not advance revision'; end if;
  if (select match_state from public.rooms where id='70000000-0000-0000-0000-000000000004') <> '{"updatedAt":1,"history":[]}'::jsonb then raise exception 'Private submit leaked into public match'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"70000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004') <> 1 then raise exception 'Owner cannot restore own selection'; end if;
  begin
    update public.room_loadout_submissions set resource_ids='[]' where room_id='70000000-0000-0000-0000-000000000004';
    raise exception 'Client updated a locked submission';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004';
    raise exception 'Client deleted a locked submission';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.room_loadout_submissions(room_id,phase_key,side,user_id,command_id,resource_type,resource_ids) values('70000000-0000-0000-0000-000000000004','attack','RED','70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000008','SUMMON','["x"]');
    raise exception 'Client inserted a submission';
  exception when insufficient_privilege then null; end;
  begin
    perform public.commit_room_loadout('70000000-0000-0000-0000-000000000004',1,'{}','attack','70000000-0000-0000-0000-000000000001','BLUE','70000000-0000-0000-0000-000000000008','SUMMON','["x"]',null,null);
    raise exception 'Client invoked service-only RPC';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"70000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
do $$ begin
  if exists(select 1 from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004') then raise exception 'Opponent can read hidden loadout'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"70000000-0000-0000-0000-000000000003","role":"authenticated"}',true);
do $$ begin
  if exists(select 1 from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004') then raise exception 'Observer can read hidden loadout'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"70000000-0000-0000-0000-000000000009","role":"authenticated"}',true);
do $$ begin
  if exists(select 1 from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004') then raise exception 'Outsider can read hidden loadout'; end if;
end $$;
reset role;

-- Retry must be idempotent. A stale concurrent submission must roll back.
select public.commit_room_loadout('70000000-0000-0000-0000-000000000004',0,'{"updatedAt":1,"history":[]}', 'phase1','70000000-0000-0000-0000-000000000001','BLUE','70000000-0000-0000-0000-000000000005','SECRET_SCROLL','["secret-blue-1","secret-blue-2","secret-blue-3"]',null,null);
do $$ begin
  begin
    perform public.commit_room_loadout('70000000-0000-0000-0000-000000000004',0,'{"updatedAt":1,"history":[]}', 'phase1','70000000-0000-0000-0000-000000000002','RED','70000000-0000-0000-0000-000000000006','SECRET_SCROLL','["red1","red2","red3"]','70000000-0000-0000-0000-000000000005','{"revealed":true}');
    raise exception 'Stale CAS was accepted';
  exception when raise_exception then
    if sqlerrm <> 'REVISION_CONFLICT' then raise; end if;
  end;
  if (select count(*) from public.room_loadout_submissions where room_id='70000000-0000-0000-0000-000000000004') <> 1 then raise exception 'Conflict left a partial private write'; end if;
end $$;
select public.commit_room_loadout('70000000-0000-0000-0000-000000000004',1,'{"updatedAt":1,"history":[]}', 'phase1','70000000-0000-0000-0000-000000000002','RED','70000000-0000-0000-0000-000000000006','SECRET_SCROLL','["red1","red2","red3"]','70000000-0000-0000-0000-000000000005','{"revealed":true,"blue":["secret-blue-1","secret-blue-2","secret-blue-3"],"red":["red1","red2","red3"]}');
do $$ declare m jsonb; begin
  select match_state into m from public.rooms where id='70000000-0000-0000-0000-000000000004';
  if m->>'revealed' <> 'true' or jsonb_array_length(m->'blue') <> 3 or jsonb_array_length(m->'red') <> 3 then raise exception 'Reveal was not atomic'; end if;
  if (select revision from public.rooms where id='70000000-0000-0000-0000-000000000004') <> 2 then raise exception 'Retry duplicated a commit'; end if;
  raise notice 'CHECK-PASS: private loadout RLS, service-only writes, idempotency, CAS rollback, atomic reveal';
end $$;
rollback;
