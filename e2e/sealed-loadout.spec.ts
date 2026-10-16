import { expect, test, type Page } from '@playwright/test'

async function ninjaStage(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: '开始 BP' }).click()
  await page.getByLabel('规则模板').selectOption('WUDOU')
  await page.getByLabel('蓝方名称').fill('先手甲')
  await page.getByLabel('红方名称').fill('后手乙')
  await page.getByRole('button', { name: '开始比赛', exact: true }).click()
  const order = [1,2,2,1,1,2,2,1,1,2]
  let step = 0
  for (const name of ['漩涡鸣人','宇智波佐助','旗木卡卡西','宇智波鼬','自来也','纲手','大蛇丸','我爱罗','迪达拉','蝎']) {
    await expect(page.locator('.arena-step-hint')).toContainText(`${order[step++]}P ·`)
    await page.getByRole('textbox', { name: '搜索忍者' }).fill(name)
    await page.getByRole('gridcell', { name: `预览忍者 ${name}`, exact: true }).click()
    await page.getByRole('button', { name: '选择', exact: true }).click()
  }
  await expect(page.locator('.arena-step-hint')).toContainText('双方同时选择秘卷')
}
async function chooseThree(page: Page, label: '秘卷' | '通灵') {
  const names: string[] = []
  for (let i = 0; i < 3; i++) {
    const card = page.getByRole('grid', { name: `${label}资源列表` }).locator('button:not(:disabled)').first()
    names.push((await card.getAttribute('aria-label'))!.replace(`预览${label} `, ''))
    await card.click()
    await page.getByRole('button', { name: '选择', exact: true }).click()
  }
  await expect(page.getByRole('button', { name: `确认${label}`, exact: true })).toBeEnabled()
  return names
}
async function history(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('ninja-bp.current_match')!).data.history.length)
}

test('同时选择：双方完成三个秘卷才公开，然后三个通灵才公开；位置贴近忍者与选手名字', async ({ page }) => {
  await ninjaStage(page)
  const initial = await history(page)
  const names = await chooseThree(page, '秘卷')
  expect(await history(page)).toBe(initial)
  // Replace a filled slot before locking; other slots cannot duplicate it.
  await page.getByRole('button', { name: '编辑第1个秘卷', exact: true }).click()
  await expect(page.getByRole('gridcell', { name: `预览秘卷 ${names[1]}`, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '确认秘卷', exact: true }).click()
  expect(await history(page)).toBe(initial)
  await expect(page.locator('.arena-fighter-scroll[aria-label^="蓝方"][aria-label$="未公开"]')).toHaveCount(3)
  await page.reload()
  await expect(page.getByRole('button', { name: '等待对手', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '红方操作', exact: true }).click()
  await chooseThree(page, '秘卷')
  await page.getByRole('button', { name: '确认秘卷', exact: true }).click()
  await expect(page.locator('.arena-step-hint')).toContainText('双方同时选择通灵')
  expect(await history(page)).toBe(initial + 6)
  await expect(page.locator('.arena-fighter-scroll[aria-label$="未公开"]')).toHaveCount(0)
  await chooseThree(page, '通灵')
  await page.getByRole('button', { name: '确认通灵', exact: true }).click()
  expect(await history(page)).toBe(initial + 6)
  await chooseThree(page, '通灵')
  await page.getByRole('button', { name: '确认通灵', exact: true }).click()
  await expect(page.getByText('双方阵容已锁定', { exact: true })).toBeVisible()
  expect(await history(page)).toBe(initial + 12)
  await expect(page.locator('.arena-summon-slot[aria-label$="未公开"]')).toHaveCount(0)
  const positions = await page.evaluate(() => {
    const arena = document.querySelector('.game-arena')!.getBoundingClientRect()
    return {
      summonsAtTop: [...document.querySelectorAll('.arena-summon-slot')].every((el) => el.getBoundingClientRect().bottom < arena.top + arena.height * .17),
      scrollsAtNinjaBottomRight: [...document.querySelectorAll('.arena-fighter-scroll')].every((el) => { const a = el.getBoundingClientRect(), b = el.closest('.arena-fighter')!.getBoundingClientRect(); return a.left > b.left + b.width * .6 && a.top > b.top + b.height * .65 }),
    }
  })
  expect(positions).toEqual({ summonsAtTop: true, scrollsAtNinjaBottomRight: true })
  await page.getByRole('button', { name: '准备战斗', exact: true }).click()
  await expect(page.getByRole('button', { name: '蓝方获胜', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '蓝方获胜', exact: true }).click()
  await page.getByRole('button', { name: '确认获胜', exact: true }).click()
  await page.getByRole('button', { name: '进入 Game 2', exact: true }).click()
  await expect(page.locator('.arena-player-blue')).toContainText('后手乙')
  await expect(page.locator('.arena-player-red')).toContainText('先手甲')
  await expect(page.locator('.arena-toolbar')).toContainText('GAME 2 · 0 : 1')
  await page.reload()
  await expect(page.locator('.arena-player-blue')).toContainText('后手乙')
  for (const turn of [1,2,2,1,1,2]) {
    await expect(page.locator('.arena-step-hint')).toContainText(`${turn}P · 选择忍者`)
    await page.getByRole('grid', { name: '忍者资源列表' }).locator('button:not(:disabled)').first().click()
    await page.getByRole('button', { name: '选择', exact: true }).click()
  }
  for (const type of ['秘卷','通灵'] as const) {
    await chooseThree(page, type)
    await page.getByRole('button', { name: `确认${type}`, exact: true }).click()
    await chooseThree(page, type)
    await page.getByRole('button', { name: `确认${type}`, exact: true }).click()
  }
  await expect(page.locator('.arena-round-label')).toHaveText('0 : 1')
  await page.getByRole('button', { name: '准备战斗', exact: true }).click()
  await page.getByRole('button', { name: '蓝方获胜', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Game 2 蓝方获胜')
  await page.getByRole('button', { name: '确认获胜', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('后手乙获胜')
  await page.getByRole('button', { name: '进入 Game 3', exact: true }).click()
  await expect(page.locator('.arena-player-blue')).toContainText('先手甲')
  await expect(page.locator('.arena-player-red')).toContainText('后手乙')
  await expect(page.locator('.arena-step-hint')).toContainText('1P · 选择忍者')
  await expect(page.locator('.arena-toolbar')).toContainText('GAME 3 · 1 : 1')
})

test('规则设置：保存盲选模板、改为每方两个秘卷，并能切换回顺序模式', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('combobox', { name: '模板', exact: true }).selectOption('WUDOU')
  await expect(page.getByLabel('每局结束后交换左右位置与先后手')).toBeChecked()
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: '规则预览 · BO3', exact: true }) }).last()
  await expect(preview).toContainText('蓝方 PICK ×1 → 红方 PICK ×2 → 蓝方 PICK ×2 → 红方 PICK ×1')
  await expect(preview).toContainText('双方已交换左右位置')
  const scroll = page.locator('section').filter({ has: page.getByRole('heading', { name: '秘卷', exact: true }) }).last()
  await expect(page.getByRole('combobox', { name: '秘卷选择方式' })).toHaveValue('SIMULTANEOUS')
  await scroll.getByLabel('每方上场槽位').fill('2')
  await expect(page.getByRole('button', { name: '保存规则', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存规则', exact: true }).click()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ninja-bp.battle_rules')!).data)
  expect(saved.resourceDrafts[1]).toMatchObject({ slotsPerSide: 2, selectionMode: 'SIMULTANEOUS' })
  await page.reload()
  await expect(page.getByRole('combobox', { name: '秘卷选择方式' })).toHaveValue('SIMULTANEOUS')
  await page.getByRole('combobox', { name: '秘卷选择方式' }).selectOption('SEQUENTIAL')
  await expect(scroll.getByLabel('双方不可选择同一资源')).toBeEnabled()
  await page.getByRole('button', { name: '保存规则', exact: true }).click()
  const sequential = await page.evaluate(() => JSON.parse(localStorage.getItem('ninja-bp.battle_rules')!).data)
  expect(sequential.resourceDrafts[1]).toMatchObject({ slotsPerSide: 2, selectionMode: 'SEQUENTIAL' })
  await page.getByLabel('每局结束后交换左右位置与先后手').uncheck()
  await page.getByRole('button', { name: '保存规则', exact: true }).click()
  await page.reload()
  await expect(page.getByLabel('每局结束后交换左右位置与先后手')).not.toBeChecked()
})
