import { expect, test, type Page } from '@playwright/test'

async function join(page: Page, code: string, name: string, watch = false) {
  await page.goto(`/room/${code}${watch ? '?watch=1' : ''}`)
  await page.getByPlaceholder('玩家').fill(name)
  await page.getByRole('button', { name: /加入房间/ }).click()
}
async function ninja(page: Page, name: string) {
  const search = page.getByRole('textbox', { name: '搜索忍者' })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill(name)
  const card = page.getByRole('gridcell', { name: `预览忍者 ${name}`, exact: true })
  await expect(card).toBeEnabled({ timeout: 20_000 })
  await card.click()
  const response = page.waitForResponse((response) => response.url().includes('/functions/v1/room-command') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '选择', exact: true }).click()
  expect((await response).ok()).toBe(true)
  await expect(page.locator('.arena-step-hint')).not.toContainText('正在确认', { timeout: 20_000 })
}
async function fillGroup(page: Page, label: '秘卷' | '通灵') {
  const grid = page.getByRole('grid', { name: `${label}资源列表` })
  await expect(grid).toBeVisible({ timeout: 20_000 })
  for (let i = 0; i < 3; i++) {
    const card = grid.locator('button:not(:disabled)').first()
    await expect(card).toBeEnabled({ timeout: 20_000 })
    await card.click()
    await page.getByRole('button', { name: '选择', exact: true }).click()
  }
}

test('在线同时盲选：双方同阶段操作，单方提交不可见，重连恢复自己的选择，双方确认后统一公开', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const [blue, red, observer] = await Promise.all(contexts.map((context) => context.newPage()))
  try {
    await blue.goto('/online')
    await blue.getByRole('combobox', { name: '房间规则模板' }).selectOption('WUDOU')
    await blue.getByPlaceholder('蓝方玩家').fill('盲选蓝')
    await blue.getByRole('button', { name: /创建房间/ }).click()
    await blue.waitForURL(/\/room\/[A-HJ-KM-NP-Z2-9]{6}/)
    const code = blue.url().split('/').pop()!
    await join(red, code, '盲选红')
    await join(observer, code, '盲选观众', true)
    await expect(blue.getByText('盲选红', { exact: true })).toBeVisible({ timeout: 20_000 })
    await blue.getByRole('button', { name: '开始比赛', exact: true }).click()
    for (const [page, name] of [[blue,'漩涡鸣人'],[red,'宇智波佐助'],[red,'旗木卡卡西'],[blue,'宇智波鼬'],[red,'自来也'],[blue,'纲手'],[blue,'大蛇丸'],[red,'我爱罗'],[red,'迪达拉'],[blue,'蝎']] as const) await ninja(page, name)
    await fillGroup(red, '秘卷')
    await fillGroup(blue, '秘卷')
    await blue.getByRole('button', { name: '确认秘卷', exact: true }).click()
    await expect(blue.getByRole('button', { name: '等待对手', exact: true })).toBeDisabled({ timeout: 20_000 })
    await expect(red.locator('.arena-fighter-scroll[aria-label^="蓝方"][aria-label$="未公开"]')).toHaveCount(3)
    await expect(observer.locator('.arena-fighter-scroll[aria-label$="未公开"]')).toHaveCount(6)
    await blue.reload()
    await expect(blue.getByRole('button', { name: '等待对手', exact: true })).toBeDisabled({ timeout: 20_000 })
    await red.getByRole('button', { name: '确认秘卷', exact: true }).click()
    for (const page of [blue,red,observer]) {
      await expect(page.locator('.arena-step-hint')).toContainText('双方同时选择通灵', { timeout: 20_000 })
      await expect(page.locator('.arena-fighter-scroll[aria-label$="未公开"]')).toHaveCount(0)
    }
    await fillGroup(blue, '通灵')
    await fillGroup(red, '通灵')
    // Actual overlapping HTTP submissions exercise the server's retry/CAS path.
    await Promise.all([blue.getByRole('button', { name: '确认通灵', exact: true }).click(), red.getByRole('button', { name: '确认通灵', exact: true }).click()])
    for (const page of [blue,red,observer]) {
      await expect(page.getByText('双方阵容已锁定', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.arena-summon-slot[aria-label$="未公开"]')).toHaveCount(0)
    }
    await expect(observer.getByRole('button', { name: '准备战斗', exact: true })).toBeDisabled()
  } finally { for (const context of contexts) await context.close() }
})
