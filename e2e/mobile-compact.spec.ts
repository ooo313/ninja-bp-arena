import { expect, test } from './classic-fixture'

test.use({ viewport: { width: 375, height: 667 } })

test('375×667 Full Loadout stays usable through Ninja and Scroll picks', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '菜单' }).click()
  await page.getByRole('banner').getByRole('button', { name: '开始 BP' }).click()
  await page.getByLabel('规则模板').selectOption('FULL_LOADOUT')
  await page.getByRole('button', { name: '开始比赛' }).click()
  await expect(page.locator('section[aria-live="polite"]')).toContainText('GAME 1')
  for (const name of ['漩涡鸣人', '宇智波佐助', '旗木卡卡西', '宇智波鼬', '自来也', '纲手', '大蛇丸', '我爱罗', '迪达拉', '蝎']) {
    await page.getByRole('button', { name: new RegExp(`^${name}（可选）`) }).click()
  }
  await expect(page.getByRole('tab', { name: /秘卷 · 当前/ })).toBeVisible()
  await page.getByRole('button', { name: /选择秘卷 护身结界（示例）/ }).click()
  await page.getByRole('button', { name: /BLUE/ }).first().click()
  await expect(page.locator('aside:visible')).toHaveCount(2)
  await expect(page.locator('aside:visible').first()).toContainText('护身结界（示例）')
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1)
})
