import { expect, test, type Page } from '@playwright/test'

async function startGameView(page: Page, fullLoadout = false) {
  await page.goto('/')
  const start = page.getByRole('banner').getByRole('button', { name: '开始 BP' })
  if (!(await start.isVisible())) await page.getByRole('button', { name: '菜单' }).click()
  await start.click()
  if (fullLoadout) await page.getByLabel('规则模板').selectOption('FULL_LOADOUT')
  await page.getByRole('button', { name: '开始比赛' }).click()
  await expect(page.getByRole('region', { name: '武斗赛 BP 选人界面' })).toBeVisible()
}

async function historyLength(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('ninja-bp.current_match')!).data.history.length as number)
}

async function previewAndConfirm(page: Page, type: '忍者' | '秘卷' | '通灵', name: string, otherName?: string) {
  const before = await historyLength(page)
  const search = page.getByRole('textbox', { name: `搜索${type}` })
  if (otherName) {
    await search.fill(otherName)
    await page.getByRole('gridcell', { name: `预览${type} ${otherName}`, exact: true }).click()
    expect(await historyLength(page)).toBe(before)
  }
  await search.fill(name)
  await page.getByRole('gridcell', { name: `预览${type} ${name}`, exact: true }).click()
  expect(await historyLength(page)).toBe(before)
  await expect(page.locator('.arena-step-hint')).toContainText(`已预览：${name}`)
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await expect.poll(() => historyLength(page)).toBe(before + 1)
}

test('游戏界面：三类资源先预览再确认，切换阶段清除搜索，并保留原有战斗流程', async ({ page }) => {
  await startGameView(page, true)
  await expect(page.getByRole('button', { name: '选择', exact: true })).toBeDisabled()
  await previewAndConfirm(page, '忍者', '宇智波佐助', '漩涡鸣人')
  for (const name of ['漩涡鸣人', '旗木卡卡西', '宇智波鼬', '自来也', '纲手', '大蛇丸', '我爱罗', '迪达拉', '蝎']) {
    await previewAndConfirm(page, '忍者', name)
  }
  await expect(page.getByRole('textbox', { name: '搜索秘卷' })).toHaveValue('')
  await previewAndConfirm(page, '秘卷', '炎遁卷轴（示例）', '护身结界（示例）')
  await previewAndConfirm(page, '秘卷', '护身结界（示例）')
  await expect(page.getByRole('textbox', { name: '搜索通灵' })).toHaveValue('')
  await previewAndConfirm(page, '通灵', '忍犬伙伴（示例）', '蛤蟆伙伴（示例）')
  for (const name of ['蛤蟆伙伴（示例）', '蛞蝓伙伴（示例）', '忍鹰伙伴（示例）', '白蛇伙伴（示例）', '忍龟伙伴（示例）']) {
    await previewAndConfirm(page, '通灵', name)
  }
  await expect(page.getByText('双方阵容已锁定', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '准备战斗' }).click()
  await page.getByRole('button', { name: '蓝方获胜', exact: true }).click()
  await page.getByRole('button', { name: '确认获胜', exact: true }).click()
  await page.getByRole('button', { name: '进入 Game 2', exact: true }).click()
  await expect(page.locator('.arena-toolbar')).toContainText('GAME 2')
  await expect(page.getByRole('grid', { name: '忍者资源列表' })).toBeVisible()
})

test('游戏界面：390px 预览确认及刷新可用，切换经典界面不改变比赛', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await startGameView(page)
  await previewAndConfirm(page, '忍者', '漩涡鸣人')
  const before = await historyLength(page)
  await page.reload()
  expect(await historyLength(page)).toBe(before)
  await expect(page.getByRole('region', { name: '武斗赛 BP 选人界面' })).toBeVisible()
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1)
  await page.getByRole('button', { name: '切换经典界面' }).click()
  await expect(page.locator('section[aria-live="polite"]')).toContainText('红方禁用阶段')
  expect(await historyLength(page)).toBe(before)
  await page.getByRole('button', { name: '游戏界面', exact: true }).click()
  await expect(page.getByRole('region', { name: '武斗赛 BP 选人界面' })).toBeVisible()
  expect(await historyLength(page)).toBe(before)
})
