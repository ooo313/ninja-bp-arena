import { expect, test, type Page } from './classic-fixture'

/**
 * E2E 测试辅助：
 * 点击忍者卡片（aria-label 前缀匹配）、按文本点击按钮、读取阶段文本。
 */

export async function startMatch(page: Page, blue = '小明', red = '小王') {
  await page.goto('/')
  const navBtn = page.getByRole('banner').getByRole('button', { name: '开始 BP' })
  // 移动端导航在汉堡菜单里
  if (!(await navBtn.isVisible())) {
    await page.getByRole('button', { name: '菜单' }).click()
  }
  await navBtn.click()
  await page.getByPlaceholder('蓝方').fill(blue)
  await page.getByPlaceholder('红方').fill(red)
  await page.getByRole('button', { name: '开始比赛' }).click()
  await expect(page).toHaveURL(/\/bp$/)
  await expect(page.getByText('蓝方禁用阶段 · 请选择 1 名忍者')).toBeVisible()
}

export async function clickNinja(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

export async function clickButton(page: Page, text: string) {
  await page.getByRole('button', { name: text, exact: true }).click()
}

export async function phaseText(page: Page) {
  const stage = page.locator('section[aria-live="polite"]')
  return stage.locator('p').last().innerText()
}

export { expect, test }
