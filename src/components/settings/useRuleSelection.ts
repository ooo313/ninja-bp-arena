import { useState } from 'react'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE } from '@/data/defaultRules'
import { useSettingsStore } from '@/store/settingsStore'

export function useRuleSelection() {
  const customRule = useSettingsStore((state) => state.customRule)
  const savedRules = useSettingsStore((state) => state.savedRules)
  const [selected, select] = useState('CURRENT')
  const options = [
    { id: 'CURRENT', label: customRule ? '当前自定义规则 · ' + customRule.name : '当前规则 · ' + DEFAULT_RULE.name, rule: customRule ?? DEFAULT_RULE },
    { id: 'FULL_LOADOUT', label: 'Full Loadout Demo（示例）', rule: FULL_LOADOUT_DEMO_RULE },
    { id: 'WUDOU', label: '武斗完整阵容（同时盲选）', rule: WUDOU_LOADOUT_RULE },
    ...savedRules.map((rule) => ({ id: rule.id, label: rule.name, rule })),
  ]
  const current = options.find((item) => item.id === selected) ?? options[0]
  return { options, selected: current.id, select, rule: current.rule }
}
