import path from 'node:path'
import { expect, test } from './classic-fixture'

test('Data Pack 导入预览、应用与恢复内置包', async ({ page }) => {
  await page.goto('/data')
  await expect(page.getByRole('heading', { name: '数据包管理' })).toBeVisible()
  await expect(page.getByText('忍界 BP 示例数据（Demo）').first()).toBeVisible()

  await page.getByRole('button', { name: '导入数据包' }).click()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /JSON Bundle/ }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(path.resolve(process.cwd(), 'examples/ninja-data-pack.json'))

  await expect(page.getByRole('heading', { name: '数据包更新预览' })).toBeVisible()
  await expect(page.getByText('新增 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '应用更新' }).click()

  await expect(page).toHaveURL(/\/ninjas$/)
  await expect(page.getByText('蓝方示例忍者')).toBeVisible()
  await expect(page.getByText('红方示例忍者')).toBeVisible()

  await page.goto('/data')
  await expect(page.getByText('最小可导入示例包').first()).toBeVisible()
  await page.getByRole('button', { name: '恢复默认' }).click()
  await expect(page.getByText('忍界 BP 示例数据（Demo）').first()).toBeVisible()
  await expect(page.getByText('28 名忍者').first()).toBeVisible()

  // 手工改动变为 CUSTOM；切到内置包后仍能切回，不会丢失用户数据。
  await page.goto('/ninjas')
  await page.getByRole('switch', { name: '启用/停用 漩涡鸣人' }).click()
  await page.goto('/data')
  await expect(page.getByText('用户自定义数据').first()).toBeVisible()
  await page.getByRole('button', { name: '恢复默认' }).click()
  const customRow = page.getByText('用户自定义数据', { exact: true }).locator('..').locator('..')
  await customRow.getByRole('button', { name: '启用' }).click()
  await page.goto('/ninjas')
  await expect(page.getByRole('switch', { name: '启用/停用 漩涡鸣人' })).toHaveAttribute('aria-checked', 'false')
})
