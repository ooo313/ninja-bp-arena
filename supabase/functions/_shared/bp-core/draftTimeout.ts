import { canSelectResource, getPhase, selectResource } from './bpEngine.ts'
import { getResourcesByType, type BattleResources } from './resourceRegistry.ts'
import { checkSealedChoice, getSealedDraft, revealSealedLoadouts, type PrivateLoadout } from './sealedLoadout.ts'
import type { DraftResourceBase, EngineResult, MatchState, Side } from './types.ts'

export const DRAFT_TIMEOUT_GRACE_MS = 3_000

export interface DraftTimeoutChoices {
  resourceId?: string
  resourceIds?: (string | null)[]
}

export function completeTimedOutStep(
  match: MatchState,
  pool: Pick<DraftResourceBase, 'id' | 'enabled' | 'deprecated'>[],
  preferredId: string | undefined,
  now: number,
): EngineResult {
  const phase = getPhase(match)
  if (!phase.side || !phase.resourceType || phase.sequenceComplete) return { ok: false, reason: '当前没有待选择的步骤' }
  const type = phase.resourceType
  let state = match
  for (let i = 0; i < phase.remainingInStep; i++) {
    const preferred = i === 0 ? pool.find((item) => item.id === preferredId) : undefined
    const available = (item: typeof pool[number]) => canSelectResource(state, type, item.id, item).allowed
    const item = preferred && available(preferred) ? preferred : pool.find(available)
    if (!item) return { ok: false, reason: '资源池没有足够的可用资源' }
    const result = selectResource(state, type, item.id, item, { now })
    if (!result.ok || !result.state) return result
    state = result.state
  }
  return { ok: true, state }
}

export function fillTimedOutLoadout(match: MatchState, side: Side, resources: BattleResources, preferred: (string | null)[]): string[] {
  const phase = getSealedDraft(match)
  if (!phase) return []
  const type = phase.resourceType
  const selected: string[] = []
  const slots = Array.from({ length: phase.count }, (_, i) => {
    const id = preferred[i]
    if (!id || !checkSealedChoice(match, side, type, id, resources, selected).allowed) return null
    selected.push(id)
    return id
  })
  const pool = getResourcesByType(resources, type)
  return slots.map((id) => {
    if (id) return id
    const item = pool.find((candidate) => checkSealedChoice(match, side, type, candidate.id, resources, selected).allowed)
    if (item) selected.push(item.id)
    return item?.id ?? ''
  })
}

export function completeTimedOutLoadouts(
  match: MatchState,
  resources: BattleResources,
  submitted: Partial<Record<Side, PrivateLoadout>>,
  preferred: Partial<Record<Side, (string | null)[]>>,
  now: number,
  commandIds: Record<Side, string>,
): EngineResult {
  const phase = getSealedDraft(match)
  if (!phase) return { ok: false, reason: '当前不是同时选择阶段' }
  const choices = {} as Record<Side, string[]>
  for (const side of ['BLUE', 'RED'] as const) {
    const locked = submitted[side]
    choices[side] = locked?.phase_key === phase.key
      ? locked.resource_ids
      : fillTimedOutLoadout(match, side, resources, preferred[side] ?? [])
  }
  return revealSealedLoadouts(match, choices, resources, now, commandIds)
}
