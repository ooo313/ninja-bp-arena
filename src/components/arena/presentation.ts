import type { DraftResource, DraftResourceType, MatchState, Side } from '@bp-core'
import { getCurrentGame, getPlayerResourceState, getResourceDraftRules } from '@bp-core'
import catalogData from '@/data/arenaCatalog.json'

interface ArenaArt { name: string; portrait: string; icon: string; localPortrait?: string; localIcon?: string }
const catalog = catalogData as Record<string, ArenaArt>
const normalize = (name: string) => name.replace(/[\s「」『』（）()]/g, '')
const byName = new Map(Object.values(catalog).map((item) => [normalize(item.name), item]))
export const arenaAsset = (name: string) => `${import.meta.env.BASE_URL}assets/arena/${name}`
export function resourceArt(resource: Pick<DraftResource, 'id' | 'name'>): ArenaArt | undefined {
  return catalog[resource.id] ?? byName.get(normalize(resource.name))
}
export function displaySlots(match: MatchState, side: Side, resourceType: DraftResourceType, banning: boolean): Array<string | null> {
  const draft = getResourceDraftRules(match.rule).find((item) => item.resourceType === resourceType)
  const game = getCurrentGame(match)
  const state = getPlayerResourceState(side === 'BLUE' ? game.blue : game.red, resourceType)
  const confirmed = banning ? state.bans : state.picks
  const count = banning ? draft?.sequence.filter((step) => step.side === side && step.action === 'BAN').reduce((sum, step) => sum + step.count, 0) ?? 0 : draft?.slotsPerSide ?? 0
  return Array.from({ length: Math.max(confirmed.length, count, 1) }, (_, index) => confirmed[index] ?? null)
}
export function pageItems<T>(items: T[], page: number, size = 26): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(Math.max(0, page), pages - 1)
  return { items: items.slice(current * size, (current + 1) * size), page: current, pages }
}
