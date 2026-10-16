-- ============================================================================
-- RLS / 安全策略验证脚本
-- 运行方式：psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f <本文件>
--   （npm run test:db）
-- 任何断言失败都会 RAISE EXCEPTION 使 psql 非零退出；
-- 每条断言的 PASS 通过 NOTICE 在日志中可见。
-- ============================================================================

-- 建房间与成员（service role 路径，与 Edge Function 一致）
do $setup$
declare
  u_host uuid := gen_random_uuid();
  u_red uuid := gen_random_uuid();
begin
  perform set_config('role', 'service_role', true);
  perform public.create_room_transaction(
    u_host, 'BLUE', '房主', '{"demo": true}'::jsonb,
    '[{"id":"n1","enabled":true}]'::jsonb
  );
  insert into public.room_members (room_id, user_id, seat, display_name)
  values (
    (select id from public.rooms order by created_at desc limit 1),
    u_red, 'RED', '红方'
  );
  raise notice 'SETUP-PASS: 房间与成员已创建';
end $setup$;

-- 1 成员能读自己所在房间
do $t1$
declare u_host uuid;
        v_room uuid;
begin
  u_host := (select user_id from public.room_members where seat = 'BLUE' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_host::text, 'role', 'authenticated')::text, true);
  select id into v_room from public.rooms limit 1;
  if v_room is null then
    raise exception '成员不能读取房间';
  end if;
  raise notice 'CHECK-PASS: 成员可以读取自己所在房间';
end $t1$;

-- 2 非成员读不到房间
do $t2$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
  declare v_room uuid;
  begin
    select id into v_room from public.rooms limit 1;
    if v_room is not null then
      raise exception '非成员居然能读取房间';
    end if;
  end;
  raise notice 'CHECK-PASS: 非成员不能读取房间';
end $t2$;

-- 3 成员能读花名册
do $t3$
declare u_red uuid;
        v_room uuid;
        n int;
begin
  u_red := (select user_id from public.room_members where seat = 'RED' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_red::text, 'role', 'authenticated')::text, true);
  select id into v_room from public.rooms limit 1;
  select count(*) into n from public.room_members where room_id = v_room;
  if n < 2 then
    raise exception '成员读取花名册不足 2 人（实际 %）', n;
  end if;
  raise notice 'CHECK-PASS: 成员可以读取花名册';
end $t3$;

-- 4 非成员读不到花名册
do $t4$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
  declare n int;
  begin
    select count(*) into n from public.room_members
      where room_id = coalesce((select id from public.rooms limit 1), gen_random_uuid());
    if n <> 0 then
      raise exception '非成员读取到花名册（% 条）', n;
    end if;
  end;
  raise notice 'CHECK-PASS: 非成员不能读取花名册';
end $t4$;

-- 5 RED 直接改 seat：表级 UPDATE 已 REVOKE 或 RLS 拦截
do $t5$
declare u_red uuid;
        v_room uuid;
begin
  u_red := (select user_id from public.room_members where seat = 'RED' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_red::text, 'role', 'authenticated')::text, true);
  select id into v_room from public.rooms limit 1;
  begin
    update public.room_members set seat = 'BLUE' where room_id = v_room and user_id = u_red;
    if found then
      raise exception 'RED 直接 UPDATE seat 成功（共 % 行）', found::int;
    end if;
    raise notice 'CHECK-PASS: RED 不能直接 UPDATE seat（0 行）';
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: RED 不能直接 UPDATE seat（权限拒绝）';
  end;
end $t5$;

-- 6 客户端 UPDATE rooms.match_state：拦截
do $t6$
declare u_host uuid;
        v_room uuid;
begin
  u_host := (select user_id from public.room_members where seat = 'BLUE' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_host::text, 'role', 'authenticated')::text, true);
  select id into v_room from public.rooms limit 1;
  begin
    update public.rooms set match_state = '{"hacked": true}'::jsonb where id = v_room;
    if found then
      raise exception '客户端直接 UPDATE match_state 成功';
    end if;
    raise notice 'CHECK-PASS: 客户端不能 UPDATE match_state（0 行）';
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能 UPDATE match_state（权限拒绝）';
  end;
end $t6$;

-- 7 客户端 INSERT rooms：拒绝
do $t7$
declare u_host uuid;
begin
  u_host := (select user_id from public.room_members where seat = 'BLUE' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_host::text, 'role', 'authenticated')::text, true);
  begin
    insert into public.rooms (code, host_user_id, status, match_state, pool)
    values ('HACK99', u_host, 'WAITING', '{"x":1}'::jsonb, '[]'::jsonb);
    raise exception '客户端直接 INSERT rooms 成功';
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能 INSERT rooms（权限拒绝）';
  end;
end $t7$;

-- 8 客户端 INSERT room_commands：拒绝
do $t8$
declare u_host uuid;
        v_room uuid;
begin
  u_host := (select user_id from public.room_members where seat = 'BLUE' limit 1);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_host::text, 'role', 'authenticated')::text, true);
  select id into v_room from public.rooms limit 1;
  begin
    insert into public.room_commands (command_id, room_id, command_type, status)
    values (gen_random_uuid(), v_room, 'SELECT_NINJA', 'APPLIED');
    raise exception '客户端直接 INSERT room_commands 成功';
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能 INSERT room_commands（权限拒绝）';
  end;
end $t8$;

-- 9 CAS RPC：EXECUTE 只授予 service_role
do $t9$
begin
  if has_function_privilege(
       'authenticated',
       'public.apply_room_state_cas(uuid,bigint,uuid,uuid,text,jsonb,jsonb,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'authenticated 仍可执行 CAS RPC';
  end if;
  if not has_function_privilege(
       'service_role',
       'public.apply_room_state_cas(uuid,bigint,uuid,uuid,text,jsonb,jsonb,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'service_role 不能执行 CAS RPC';
  end if;
  raise notice 'CHECK-PASS: CAS RPC 仅 service_role 可执行';
end $t9$;

-- 10 create_room_transaction RPC：仅 service_role（v0.5 为 7 参，末两参默认 null）
do $t10$
begin
  if has_function_privilege(
       'authenticated',
       'public.create_room_transaction(uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'authenticated 仍可执行创建房间 RPC';
  end if;
  if not has_function_privilege(
       'service_role',
       'public.create_room_transaction(uuid,text,text,jsonb,jsonb,jsonb,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'service_role 不能执行创建房间 RPC';
  end if;
  raise notice 'CHECK-PASS: 创建房间 RPC 仅 service_role 可执行';
end $t10$;

-- 11 v0.3.2 幂等唯一约束：UNIQUE(room_id, user_id, command_id)，command_id 不再全局唯一
do $t11$
declare
  v_room_a uuid;
  v_room_b uuid;
  v_cmd uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
begin
  perform set_config('role', 'service_role', true);
  v_room_a := (select id from public.rooms order by created_at desc limit 1);
  perform public.create_room_transaction(
    gen_random_uuid(), 'RED', '他房', '{"demo": true}'::jsonb, '[]'::jsonb
  );
  v_room_b := (select id from public.rooms order by created_at desc limit 1);

  insert into public.room_commands (command_id, room_id, user_id, command_type, status)
  values (v_cmd, v_room_a, v_user, 'START_MATCH', 'APPLIED');

  -- 同 (room, user, command)：唯一冲突
  begin
    insert into public.room_commands (command_id, room_id, user_id, command_type, status)
    values (v_cmd, v_room_a, v_user, 'START_MATCH', 'APPLIED');
    raise exception '同 (room_id,user_id,command_id) 居然可以重复插入';
  exception when unique_violation then
    raise notice 'CHECK-PASS: (room_id,user_id,command_id) 唯一约束生效';
  end;

  -- 同 command_id 在另一房间另一用户：允许存在（范围化幂等），
  -- 跨房间 / 跨用户复用判定由 Edge Function 完成，数据库层不再全局唯一
  insert into public.room_commands (command_id, room_id, user_id, command_type, status)
  values (v_cmd, v_room_b, gen_random_uuid(), 'START_MATCH', 'REJECTED');
  raise notice 'CHECK-PASS: command_id 不再全局唯一（跨房间可各自存在）';

  delete from public.room_commands where command_id = v_cmd;
  delete from public.rooms where id = v_room_b;
end $t11$;

-- 12 v0.3.2 通用限速表 action_attempts（join_attempts 已演化）
do $t12$
declare v_col text;
begin
  if to_regclass('public.join_attempts') is not null then
    raise exception 'join_attempts 应已演化（重命名）为 action_attempts';
  end if;
  if to_regclass('public.action_attempts') is null then
    raise exception '缺少 action_attempts 限速表（0002 迁移未应用？）';
  end if;
  select column_name into v_col from information_schema.columns
    where table_schema = 'public' and table_name = 'action_attempts' and column_name = 'action_type';
  if v_col is null then
    raise exception 'action_attempts 缺少 action_type 列';
  end if;
  raise notice 'CHECK-PASS: action_attempts 限速表（含 action_type）已就绪';
end $t12$;

-- 13 v0.4.0 数据包元数据：rooms.data_pack_metadata 列 + RPC 事务写入
do $t13$
declare
  v_room uuid;
  v_meta jsonb := jsonb_build_object(
    'packId', 'test-pack',
    'schemaVersion', 1,
    'packVersion', '2026.09.1',
    'checksum', 'sha256:' || repeat('a', 64)
  );
begin
  perform set_config('role', 'service_role', true);
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rooms' and column_name = 'data_pack_metadata'
  ) then
    raise exception 'rooms 缺少 data_pack_metadata 列（0003 迁移未应用？）';
  end if;

  select room_id into v_room from public.create_room_transaction(
    gen_random_uuid(), 'BLUE', '元数据房主', '{"demo": "v4"}'::jsonb, '[{"id":"n1","enabled":true}]'::jsonb, v_meta
  );
  if (select data_pack_metadata from public.rooms where id = v_room) <> v_meta then
    raise exception 'create_room_transaction 未写入 data_pack_metadata';
  end if;
  raise notice 'CHECK-PASS: rooms.data_pack_metadata 由创建 RPC 事务写入';

  delete from public.rooms where id = v_room;
end $t13$;

-- 14 v0.5.0 完整资源快照：列存在、RPC 原子写入、结构约束生效
do $t14$
declare
  v_room uuid;
  v_snapshot jsonb := '{"ninjas":[{"id":"n1","name":"N1","enabled":true,"quality":"A"}],"secretScrolls":[{"resourceType":"SECRET_SCROLL","id":"s1","name":"S1","enabled":true}],"summons":[{"resourceType":"SUMMON","id":"m1","name":"M1","enabled":true}]}'::jsonb;
begin
  perform set_config('role', 'service_role', true);
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rooms' and column_name = 'resource_snapshot'
  ) then
    raise exception 'rooms 缺少 resource_snapshot 列（0005 迁移未应用？）';
  end if;
  select room_id into v_room from public.create_room_transaction(
    gen_random_uuid(), 'BLUE', '资源快照房主', '{"demo":"v5"}'::jsonb,
    '[{"id":"n1","enabled":true}]'::jsonb, null, v_snapshot
  );
  if (select resource_snapshot from public.rooms where id = v_room) <> v_snapshot then
    raise exception 'create_room_transaction 未写入 resource_snapshot';
  end if;
  raise notice 'CHECK-PASS: rooms.resource_snapshot 由创建 RPC 事务写入';
  delete from public.rooms where id = v_room;
end $t14$;

-- 15 v0.7.0 Replay 分享表：仅 service role 可读写，客户端 INSERT/UPDATE/DELETE/SELECT 均不可绕过
do $t15$
declare
  v_user uuid := gen_random_uuid();
  v_token text := repeat('A', 32);
  v_count int;
begin
  if to_regclass('public.replay_shares') is null then
    raise exception '缺少 replay_shares（0006 migration 未应用？）';
  end if;
  perform set_config('role', 'service_role', true);
  insert into public.replay_shares (share_token, created_by, replay_data, replay_checksum, source_match_id)
  values (v_token, v_user, '{"schemaVersion":1}'::jsonb, 'sha256:' || repeat('a', 64), 'security-test');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  begin
    insert into public.replay_shares (share_token, created_by, replay_data, replay_checksum, source_match_id)
    values (repeat('B', 32), v_user, '{}'::jsonb, 'sha256:' || repeat('b', 64), 'attack');
    raise exception 'authenticated 直接 INSERT replay_shares 成功';
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能直接 INSERT replay_shares';
  end;
  begin
    update public.replay_shares set status = 'REVOKED' where share_token = v_token;
    if found then raise exception 'authenticated 直接 UPDATE replay_shares 成功'; end if;
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能直接 UPDATE replay_shares';
  end;
  begin
    delete from public.replay_shares where share_token = v_token;
    if found then raise exception 'authenticated 直接 DELETE replay_shares 成功'; end if;
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能直接 DELETE replay_shares';
  end;
  begin
    select count(*) into v_count from public.replay_shares where share_token = v_token;
    if v_count <> 0 then raise exception 'authenticated 直接 SELECT replay_shares 成功'; end if;
  exception when insufficient_privilege then
    raise notice 'CHECK-PASS: 客户端不能直接 SELECT replay_shares';
  end;

  perform set_config('role', 'service_role', true);
  delete from public.replay_shares where share_token = v_token;
  raise notice 'CHECK-PASS: replay_shares 最小权限与 service role 路径正常';
end $t15$;

do $done$
begin
  raise notice 'ALL-DB-SECURITY-CHECKS-PASSED';
end $done$;

\ir sealed-loadout-security.sql
