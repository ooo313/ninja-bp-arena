import { json, handleOptions } from '../_shared/http.ts'
import { serviceClient, getUserFromRequest } from '../_shared/supabase.ts'

/**
 * POST /functions/v1/room-join
 * 通过房间码加入房间（席位唯一性由数据库部分唯一索引保证）。
 * body: { code: string, seat: 'AUTO' | 'BLUE' | 'RED' | 'OBSERVER', displayName: string }
 *
 * - 再次调用（刷新 / 重连）若已是成员：幂等返回现有席位，不重复占席
 * - 加入尝试（无论成败）按 auth user 做服务端限速：60 秒最多 15 次
 */
const MAX_BODY_BYTES = 8 * 1024
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 15
/** 单房间观战者上限：防止 room_members 无限增长（BLUE/RED 不受影响） */
const MAX_OBSERVERS_PER_ROOM = 50

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handleOptions()
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const admin = serviceClient()
    const user = await getUserFromRequest(admin, req)
    if (!user) return json({ error: 'NOT_AUTHENTICATED', message: '请先进入在线模式' }, 401)

    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE', message: '请求体积超出限制' }, 413)
    const body = JSON.parse(rawBody) as { code?: unknown; seat?: unknown; displayName?: unknown }

    const code = String(body.code ?? '').trim().toUpperCase()
    const seat = String(body.seat ?? 'AUTO')
    const displayName = String(body.displayName ?? '').trim() || '玩家'

    if (code.length < 4 || code.length > 8) {
      return json({ error: 'INVALID_CODE', message: '房间号格式不正确' }, 400)
    }
    if (displayName.length < 1 || displayName.length > 20) {
      return json({ error: 'INVALID_DISPLAY_NAME', message: '显示名称需要 1~20 个字符' }, 400)
    }
    if (!['AUTO', 'BLUE', 'RED', 'OBSERVER'].includes(seat)) {
      return json({ error: 'INVALID_SEAT', message: '席位参数不正确' }, 400)
    }

    // ---- 服务端限速：无论房间码对错，每次尝试都计数 ----
    const { error: attemptError } = await admin
      .from('action_attempts')
      .insert({ user_id: user.id, action_type: 'JOIN_ROOM' })
    if (attemptError) return json({ error: 'DB_ERROR', message: attemptError.message }, 500)

    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()
    const { count: recentAttempts } = await admin
      .from('action_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('action_type', 'JOIN_ROOM')
      .gt('attempted_at', windowStart)
    if ((recentAttempts ?? 0) > RATE_LIMIT_MAX) {
      return json({ error: 'RATE_LIMITED', message: '尝试过于频繁，请稍后再试' }, 429)
    }
    // 顺带清理一小时前的旧记录，防止表无限增长
    if ((recentAttempts ?? 0) % 5 === 1) {
      await admin
        .from('action_attempts')
        .delete()
        .lt('attempted_at', new Date(Date.now() - 3600_000).toISOString())
    }

    // ---- 房间校验 ----
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id, code, status, expires_at')
      .eq('code', code)
      .maybeSingle()
    if (roomError) return json({ error: 'DB_ERROR', message: roomError.message }, 500)
    if (!room) return json({ error: 'ROOM_NOT_FOUND', message: '房间不存在，请核对房间号' }, 404)
    if (room.status === 'CLOSED') return json({ error: 'ROOM_CLOSED', message: '房间已关闭' }, 410)
    if (room.expires_at !== 'infinity' && Date.parse(room.expires_at as string) <= Date.now()) {
      return json({ error: 'ROOM_EXPIRED', message: '房间已过期' }, 410)
    }

    // ---- 幂等：已是成员则返回现有席位（刷新 / 断线重连不重复占席）----
    const { data: existing } = await admin
      .from('room_members')
      .select('seat')
      .eq('room_id', room.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (existing) {
      await admin
        .from('room_members')
        .update({ last_seen_at: new Date().toISOString(), display_name: displayName })
        .eq('room_id', room.id)
        .eq('user_id', user.id)
      return json({ roomId: room.id, code: room.code, seat: existing.seat, rejoined: true })
    }

    // ---- 席位协商：请求优先，被占或 AUTO 时挑空位，都满则观战 ----
    const { data: members } = await admin.from('room_members').select('seat').eq('room_id', room.id)
    const taken = new Set((members ?? []).map((m) => m.seat as string))
    const observerCount = (members ?? []).filter((m) => m.seat === 'OBSERVER').length

    let resolved: 'BLUE' | 'RED' | 'OBSERVER'
    if (seat === 'OBSERVER') {
      resolved = 'OBSERVER'
    } else if ((seat === 'BLUE' || seat === 'RED') && !taken.has(seat)) {
      resolved = seat
    } else {
      resolved = !taken.has('BLUE') ? 'BLUE' : !taken.has('RED') ? 'RED' : 'OBSERVER'
    }
    if (resolved === 'OBSERVER' && observerCount >= MAX_OBSERVERS_PER_ROOM) {
      return json({ error: 'ROOM_OBSERVER_LIMIT', message: '该房间观战人数已满' }, 400)
    }

    const { error: insertError } = await admin.from('room_members').insert({
      room_id: room.id,
      user_id: user.id,
      seat: resolved,
      display_name: displayName,
    })
    if (insertError) {
      if (insertError.code === '23505') {
        return json({ error: 'SEAT_TAKEN', message: '该阵营刚被占用，请选择其他阵营' }, 409)
      }
      return json({ error: 'DB_ERROR', message: insertError.message }, 500)
    }

    return json({ roomId: room.id, code: room.code, seat: resolved, rejoined: false })
  } catch (err) {
    return json({ error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }, 500)
  }
})
