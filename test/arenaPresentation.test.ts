import { describe, expect, it } from 'vitest'
import { createMatch, startMatch, selectNinja } from '../supabase/functions/_shared/bp-core/bpEngine'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE } from '../src/data/defaultRules'
import { displaySlots, pageItems, resourceArt } from '../src/components/arena/presentation'

describe('game layout presentation without changing rules', () => {
  it('derives ban slots from the existing rule and preserves the match', () => {
    const match = startMatch(createMatch(DEFAULT_RULE))
    const before = structuredClone(match)
    expect(displaySlots(match, 'BLUE', 'NINJA', true)).toEqual([null, null])
    expect(displaySlots(match, 'RED', 'NINJA', true)).toEqual([null, null])
    expect(match).toEqual(before)
  })
  it('shows only confirmed selections in the slots', () => {
    const match = startMatch(createMatch(DEFAULT_RULE))
    const result = selectNinja(match, 'ninja-a', { id: 'ninja-a', enabled: true })
    expect(result.ok).toBe(true)
    expect(displaySlots(result.state!, 'BLUE', 'NINJA', true)).toEqual(['ninja-a', null])
    expect(displaySlots(match, 'BLUE', 'NINJA', true)).toEqual([null, null])
  })
  it('uses existing scroll and summon slot counts', () => {
    const match = startMatch(createMatch(FULL_LOADOUT_DEMO_RULE))
    expect(displaySlots(match, 'BLUE', 'SECRET_SCROLL', false)).toEqual([null])
    expect(displaySlots(match, 'RED', 'SUMMON', false)).toEqual([null, null, null])
  })
  it('mounts at most one page and clamps page indices after filtering', () => {
    const items = Array.from({ length: 455 }, (_, i) => i)
    expect(pageItems(items, 0).items).toHaveLength(26)
    expect(pageItems(items, 99)).toMatchObject({ page: 17, pages: 18 })
    expect(pageItems(items, -1).page).toBe(0)
    expect(pageItems([], 9)).toEqual({ items: [], page: 0, pages: 1 })
    expect(pageItems(items.slice(0, 3), 17).items).toEqual([0, 1, 2])
  })
  it('finds official portraits by ID and leaves unknown custom resources alone', () => {
    expect(resourceArt({ id: 'hyrz-ninja-90183', name: '千手扉间「秽土转生」' })).toMatchObject({ name: '千手扉间「秽土转生」' })
    expect(resourceArt({ id: 'custom-1', name: '我的自定义角色' })).toBeUndefined()
  })
})
