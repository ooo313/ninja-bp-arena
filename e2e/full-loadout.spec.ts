import { expect, test } from './classic-fixture'

async function pickNinja(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

test('Full Loadout Demo：Ninja → 秘卷 → 有序通灵 → 记录赛果，比赛快照不受数据包修改影响', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: '开始 BP' }).click()
  await page.getByLabel('规则模板').selectOption('FULL_LOADOUT')
  await page.getByRole('button', { name: '开始比赛' }).click()

  for (const name of ['漩涡鸣人', '宇智波佐助', '旗木卡卡西', '宇智波鼬', '自来也', '纲手', '大蛇丸', '我爱罗', '迪达拉', '蝎']) {
    await pickNinja(page, name)
  }
  await expect(page.locator('section[aria-live="polite"]')).toContainText('蓝方秘卷选择阶段')
  await page.getByRole('button', { name: /选择秘卷 护身结界（示例）/ }).click()

  // 修改当前全局数据包；进行中比赛仍使用创建时快照。
  await page.goto('/data')
  await page.getByRole('button', { name: '停用 护身结界（示例）' }).click()
  await page.goto('/bp')
  await expect(page.getByText('护身结界（示例）', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: /选择秘卷 炎遁卷轴（示例）/ }).click()
  for (const name of ['蛤蟆伙伴（示例）', '忍犬伙伴（示例）', '蛞蝓伙伴（示例）', '忍鹰伙伴（示例）', '白蛇伙伴（示例）', '忍龟伙伴（示例）']) {
    await page.getByRole('button', { name: new RegExp(`选择通灵 ${name}`) }).click()
  }
  await expect(page.locator('section[aria-live="polite"]')).toContainText('双方阵容已锁定')
  await page.getByRole('button', { name: '进入比赛' }).click()
  await page.getByRole('button', { name: '蓝方获胜' }).click()
  await page.getByRole('button', { name: '确认获胜' }).click()
  await expect(page.getByRole('dialog')).toContainText('蓝方秘卷')
  await expect(page.getByRole('dialog')).toContainText('蓝方通灵')
})
