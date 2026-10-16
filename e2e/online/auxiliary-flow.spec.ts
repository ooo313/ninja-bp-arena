import { createClassicContext } from '../classic-fixture'
import { expect, test, type Page } from '../classic-fixture'

async function join(page: Page, code: string, name: string, watch = false) {
  await page.goto(`/room/${code}${watch ? '?watch=1' : ''}`)
  await page.getByPlaceholder('玩家').fill(name)
  await page.getByRole('button', { name: /加入房间/ }).click()
}

async function waitForTurn(page: Page, side: '蓝' | '红', resourceLabel?: '秘卷' | '通灵') {
  const stage = resourceLabel
    ? new RegExp(`${side}方${resourceLabel}(?:禁用|选择)阶段`)
    : new RegExp(`${side}方(?:禁用|选择)阶段`)
  await expect(page.getByText(stage)).toBeVisible({ timeout: 30_000 })
}

function sidePanel(page: Page, side: '蓝' | '红') {
  return page.locator('aside').filter({ hasText: side === '蓝' ? 'BLUE · 蓝方' : 'RED · 红方' })
}

async function ninja(page: Page, side: '蓝' | '红', name: string) {
  await waitForTurn(page, side)
  const button = page.getByRole('button', { name: new RegExp(`^${name}（可选）`) })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await button.click()
  await expect(sidePanel(page, side).getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function resource(page: Page, side: '蓝' | '红', type: '秘卷' | '通灵', name: string) {
  await waitForTurn(page, side, type)
  const button = page.getByRole('button', { name: `选择${type} ${name}` })
  await expect(button).toBeVisible({ timeout: 20_000 })
  await button.click()
  await expect(sidePanel(page, side).getByText(name, { exact: true })).toBeVisible({ timeout: 20_000 })
}

test('在线 Full Loadout：BLUE / RED / Observer 使用同一 Room Snapshot', async ({ browser }) => {
  const blueContext = await createClassicContext(browser)
  const redContext = await createClassicContext(browser)
  const observerContext = await createClassicContext(browser)
  const blue = await blueContext.newPage()
  const red = await redContext.newPage()
  const observer = await observerContext.newPage()
  try {
    await blue.goto('/online')
    await blue.getByRole('combobox').first().selectOption('FULL_LOADOUT')
    await blue.getByPlaceholder('蓝方玩家').fill('Blue')
    await blue.getByRole('button', { name: /创建房间/ }).click()
    await blue.waitForURL(/\/room\/[A-HJ-KM-NP-Z2-9]{6}/)
    const code = blue.url().match(/[A-HJ-KM-NP-Z2-9]{6}$/)![0]
    await join(red, code, 'Red')
    await join(observer, code, 'Observer', true)
    await expect(blue.getByText('Red', { exact: true })).toBeVisible({ timeout: 15_000 })
    await blue.getByRole('button', { name: '开始比赛' }).click()

    await ninja(blue, '蓝', '漩涡鸣人')
    await ninja(red, '红', '宇智波佐助')
    await ninja(red, '红', '旗木卡卡西')
    await ninja(blue, '蓝', '宇智波鼬')
    await ninja(red, '红', '自来也')
    await ninja(blue, '蓝', '纲手')
    await ninja(blue, '蓝', '大蛇丸')
    await ninja(red, '红', '我爱罗')
    await ninja(red, '红', '迪达拉')
    await ninja(blue, '蓝', '蝎')

    await resource(blue, '蓝', '秘卷', '护身结界（示例）')
    await resource(red, '红', '秘卷', '炎遁卷轴（示例）')
    for (const name of ['蛤蟆伙伴（示例）', '忍犬伙伴（示例）', '蛞蝓伙伴（示例）']) await resource(blue, '蓝', '通灵', name)
    for (const name of ['忍鹰伙伴（示例）', '白蛇伙伴（示例）', '忍龟伙伴（示例）']) await resource(red, '红', '通灵', name)

    for (const page of [blue, red, observer]) {
      await expect(page.getByText('双方阵容已锁定')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('护身结界（示例）', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('忍龟伙伴（示例）', { exact: true }).first()).toBeVisible()
    }
  } finally {
    await blueContext.close()
    await redContext.close()
    await observerContext.close()
  }
})

test('Presentation View 复用房间状态且始终只读', async ({ browser }) => {
  const blueContext = await createClassicContext(browser)
  const redContext = await createClassicContext(browser)
  const displayContext = await createClassicContext(browser, { viewport: { width: 1920, height: 1080 } })
  const blue = await blueContext.newPage()
  const red = await redContext.newPage()
  const display = await displayContext.newPage()
  try {
    await blue.goto('/online')
    await blue.getByPlaceholder('蓝方玩家').fill('Blue')
    await blue.getByRole('button', { name: /创建房间/ }).click()
    await blue.waitForURL(/\/room\/[A-HJ-KM-NP-Z2-9]{6}/)
    const code = blue.url().match(/[A-HJ-KM-NP-Z2-9]{6}$/)![0]
    await join(red, code, 'Red')
    await expect(blue.getByText('Red', { exact: true })).toBeVisible({ timeout: 15_000 })
    await blue.getByRole('button', { name: '开始比赛' }).click()
    await display.goto(`/room/${code}/presentation`)
    await expect(display.getByTestId('presentation-view')).toBeVisible({ timeout: 30_000 })
    await expect(display.getByText('观战展示 · 只读')).toBeVisible()
    await expect(display.getByText('CURRENT PHASE')).toBeVisible()
    await expect(display.getByTestId('scoreboard').getByText('Blue', { exact: true })).toBeVisible()
    await expect(display.getByTestId('scoreboard').getByText('Red', { exact: true })).toBeVisible()
    await expect(display.locator('[data-resource-card]')).toHaveCount(0)
    await expect(display.getByRole('button', { name: /选择|撤销|重置|获胜/ })).toHaveCount(0)
    const size = await display.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(size.scroll).toBeLessThanOrEqual(size.client + 1)
  } finally {
    await blueContext.close()
    await redContext.close()
    await displayContext.close()
  }
})
