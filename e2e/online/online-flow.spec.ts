import { createClassicContext } from '../classic-fixture'
import { expect, test, type BrowserContext, type Page } from '../classic-fixture'

/**
 * 在线集成：完整用户流程（双 BrowserContext 模拟两名玩家 + 观战者）。
 * 同一场景内保持三个 Context 存活；重连 = 同一 Context 关闭 Page 再打开
 * （匿名会话在 Context Storage 中保持，身份不丢失）。
 *
 * 必须连接 Supabase Local / 测试项目运行（npm run test:online）。
 */

let roomCode = ''

async function createRoom(page: Page, displayName: string) {
  await page.goto('/online')
  await page.getByText('比赛规则（当前模板）').waitFor()
  await page.getByPlaceholder('蓝方玩家').fill(displayName)
  await page.getByRole('button', { name: /创建房间/ }).click()
  await page.waitForURL(/\/room\/[A-HJ-KM-NP-Z2-9]{6}/, { timeout: 20000 })
  roomCode = page.url().match(/[A-HJ-KM-NP-Z2-9]{6}$/)![0]
}

async function joinRoom(page: Page, code: string, displayName: string, watch = false) {
  await page.goto(`/room/${code}${watch ? '?watch=1' : ''}`)
  await page.getByPlaceholder('玩家').fill(displayName)
  await page.getByRole('button', { name: /加入房间/ }).click()
  await page.waitForTimeout(1200)
}

/**
 * 点击并确认「忍者已进入我方槽位」。
 * 确认信号 = 玩家面板（aside）中出现该忍者名字：
 * 该面板在 BP 进行中 / 阵容锁定 / 比赛进行中各阶段都持续渲染，
 * 因此每局最后一手（选择后网格消失）也能正确确认。
 * 整体重试以消化 revision 冲突 / Realtime 滞后 / 重渲染闪烁。
 */
async function clickNinja(page: Page, name: string, _expectLabel?: string) {
  void _expectLabel
  await expect(async () => {
    const slot = page.locator('aside').getByText(name, { exact: true }).first()
    if ((await slot.count()) > 0 && (await slot.isVisible())) return  // 已入槽
    const card = page.getByRole('button', { name: new RegExp(`^${name}（可选）`) })
    if ((await card.count()) === 0) {
      const stage = await page.locator('section[aria-live="polite"]').textContent()
      throw new Error(`${name} 卡片未渲染。阶段: ${stage?.slice(0, 80)}`)
    }
    await card.click()
    await page.waitForTimeout(600)
    throw new Error(`${name} 待确认，重试`)
  }).toPass({ timeout: 45000 })
}

/** 非当前方的卡片必须锁定、说明原因，且点击不能改变比赛状态。 */
async function expectNinjaLockedForWrongTurn(page: Page, name: string, waitingSide: '蓝' | '红') {
  const card = page.getByRole('button', { name: `${name}（可选）—等待${waitingSide}方选择` })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toHaveAttribute('aria-disabled', 'true')
  await expect(card).toBeDisabled()
  await expect(card).toHaveAttribute('title', new RegExp(`等待${waitingSide}方选择`))
  await expect(page.getByText(new RegExp(`${waitingSide}方禁用阶段`))).toBeVisible()
  await expect(card).toHaveAttribute('aria-disabled', 'true')
}

async function clickButton(page: Page, text: string) {
  await page.getByRole('button', { name: text, exact: true }).click()
}


test.describe.serial('在线 BO3 全流程', () => {
  let ctxBlue: BrowserContext
  let ctxRed: BrowserContext
  let ctxObserver: BrowserContext
  let blue: Page
  let red: Page
  let observer: Page

  test('创建房间 + 双方加入 + 观战加入 + Host 开始', async ({ browser }) => {
    ctxBlue = await createClassicContext(browser)
    ctxRed = await createClassicContext(browser)
    ctxObserver = await createClassicContext(browser)
    blue = await ctxBlue.newPage()
    red = await ctxRed.newPage()
    observer = await ctxObserver.newPage()

    await createRoom(blue, '张三')
    await expect(blue.getByText('WAITING ROOM')).toBeVisible()
    await expect(blue.getByText('张三').first()).toBeVisible()

    await joinRoom(red, roomCode, '李四')
    // Host 侧实时看到红方加入（无需刷新）
    await expect(blue.getByText('李四')).toBeVisible({ timeout: 15000 })
    await joinRoom(observer, roomCode, '观众', true)
    await expect(blue.getByText(/观战：1 人/)).toBeVisible({ timeout: 15000 })

    // Host 开始比赛
    await clickButton(blue, '开始比赛')
    await expect(blue.getByText(/蓝方禁用阶段/)).toBeVisible({ timeout: 20000 })
    await expect(red.getByText(/蓝方禁用阶段/)).toBeVisible({ timeout: 20000 })
    await expect(observer.getByText(/蓝方禁用阶段/)).toBeVisible({ timeout: 20000 })

    // 名字进入比赛（§58）：阵容面板显示服务端填充的名称
    await expect(blue.locator('main').getByText('张三').first()).toBeVisible({ timeout: 10000 })
    await expect(red.locator('main').getByText('李四').first()).toBeVisible({ timeout: 10000 })
  })

  test('回合权限：红方在蓝方回合被锁定，蓝方正常 Ban', async () => {
    await expectNinjaLockedForWrongTurn(red, '漩涡鸣人', '蓝')
    await clickNinja(blue, '漩涡鸣人', '已禁用')
    await expect(blue.getByRole('button', { name: /漩涡鸣人（已禁用）/ })).toBeVisible({ timeout: 15000 })
    // 三端实时同步
    await expect(red.getByRole('button', { name: /漩涡鸣人（已禁用）/ })).toBeVisible({ timeout: 15000 })
    await expect(observer.getByRole('button', { name: /漩涡鸣人（已禁用）/ })).toBeVisible({ timeout: 15000 })
    // RED reloads during its own turn and receives the authoritative revision.
    await red.reload()
    await expect(red.getByText(/红方禁用阶段/)).toBeVisible({ timeout: 20_000 })
    const blueRevision = await blue.evaluate(() => (window as unknown as { __nja: { getState: () => { revision: number } } }).__nja.getState().revision)
    const redRevision = await red.evaluate(() => (window as unknown as { __nja: { getState: () => { revision: number } } }).__nja.getState().revision)
    expect(redRevision).toBe(blueRevision)
  })

  test('撤销请求：蓝方申请 → 红方实时收到 → 确认 → 双方回退', async () => {
    // 蓝方已经 Ban 了漩涡鸣人；申请撤销
    await clickButton(blue, '申请撤销')
    // 红方实时收到横幅并接受
    await expect(red.getByText(/蓝方请求撤销上一步/)).toBeVisible({ timeout: 15000 })
    await red.getByRole('button', { name: '接受' }).click()
    // 双方同时回退：漩涡鸣人重新可选
    await expect(blue.getByRole('button', { name: /漩涡鸣人（可选）/ })).toBeVisible({ timeout: 15000 })
    await expectNinjaLockedForWrongTurn(red, '漩涡鸣人', '蓝')

    // 再执行不同忍者
    const beforeRevision = await blue.evaluate(() => (window as unknown as { __nja: { getState: () => { revision: number } } }).__nja.getState().revision)
    await blue.getByRole('button', { name: /^宇智波佐助（可选）/ }).evaluate((element) => {
      const button = element as HTMLButtonElement
      button.click()
      button.click()
    })
    await expect(blue.getByRole('button', { name: /宇智波佐助（已禁用）/ })).toBeVisible({ timeout: 15000 })
    const afterRevision = await blue.evaluate(() => (window as unknown as { __nja: { getState: () => { revision: number } } }).__nja.getState().revision)
    expect(afterRevision).toBe(beforeRevision + 1)
  })

  test('Game1 完整 BP + 蓝胜', async () => {
    // 红2 蓝1 Ban
    await clickNinja(red, '旗木卡卡西', '已禁用')
    await expect(blue.getByRole('button', { name: /旗木卡卡西（已禁用）/ })).toBeVisible({ timeout: 15000 })
    await clickNinja(red, '宇智波鼬', '已禁用')
    await clickNinja(blue, '波风水门', '已禁用')
    // Pick：红1 蓝2 红2 蓝1
    await clickNinja(red, '自来也', '红方已选')
    await clickNinja(blue, '纲手', '蓝方已选')
    await clickNinja(blue, '大蛇丸', '蓝方已选')
    await clickNinja(red, '我爱罗', '红方已选')
    await clickNinja(red, '迪达拉', '红方已选')
    await clickNinja(blue, '蝎', '蓝方已选')
    await expect(blue.getByText(/双方阵容已锁定/)).toBeVisible({ timeout: 15000 })

    await clickButton(blue, '进入比赛')
    await expect(blue.getByText(/本局比赛进行中/).first()).toBeVisible({ timeout: 15000 })
    await expect(red.getByText(/本局比赛进行中/).first()).toBeVisible({ timeout: 15000 })
    await clickButton(blue, '蓝方获胜')
    await clickButton(blue, '确认获胜')
    // Host 弹出本局结果；进入 Game 2
    await clickButton(blue, '进入 Game 2')
    await expect(blue.getByText(/红方(禁用|选择)阶段/)).toBeVisible({ timeout: 15000 })
    await expect(red.getByText(/红方(禁用|选择)阶段/)).toBeVisible({ timeout: 15000 })
    await expect(blue.getByTestId('scoreboard')).toContainText('1:0')
  })

  test('Game2：Ban 保持、Game1 出场 USED，红方胜', async () => {
    // Ban 保持（本流中蓝方 Ban 的是佐助：鸣人被撤销后改 Ban 佐助）
    await expect(blue.getByRole('button', { name: /宇智波佐助（已禁用）/ })).toBeVisible()
    // Game1 出场忍者 USED（两端一致）
    await expect(blue.getByRole('button', { name: /自来也（已使用）/ })).toBeVisible()
    await expect(red.getByRole('button', { name: /纲手（已使用）/ })).toBeVisible()
    // Game2 Pick：红1 蓝2 红2 蓝1
    await clickNinja(red, '干柿鬼鲛', '红方已选')
    await clickNinja(blue, '油女志乃', '蓝方已选')
    await clickNinja(blue, '药师兜', '蓝方已选')
    await clickNinja(red, '静音', '红方已选')
    await clickNinja(red, '李洛克', '红方已选')
    await clickNinja(blue, '天天', '蓝方已选')
    await expect(blue.getByText(/双方阵容已锁定/)).toBeVisible({ timeout: 15000 })
    await clickButton(blue, '进入比赛')
    await expect(blue.getByText(/本局比赛进行中/).first()).toBeVisible({ timeout: 15000 })
    await clickButton(blue, '红方获胜')
    await clickButton(blue, '确认获胜')
    await clickButton(blue, '进入 Game 3')
    await expect(blue.getByTestId('scoreboard')).toContainText('1:1')
  })

  test('Game3 与最终 2:1', async () => {
    // Game3 Pick：红1 蓝2 红2 蓝1
    await clickNinja(red, '奈良鹿丸', '红方已选')
    await clickNinja(blue, '秋道丁次', '蓝方已选')
    await clickNinja(blue, '山中井野', '蓝方已选')
    await clickNinja(red, '犬冢牙', '红方已选')
    await clickNinja(red, '飞段', '红方已选')
    await clickNinja(blue, '角都', '蓝方已选')
    await expect(blue.getByText(/双方阵容已锁定/)).toBeVisible({ timeout: 15000 })
    await clickButton(blue, '进入比赛')
    await clickButton(blue, '蓝方获胜')
    await clickButton(blue, '确认获胜')
    // 最终：三方看到一致结果
    await expect(blue.locator('body')).toContainText('蓝方胜利')
    await expect(red.locator('body')).toContainText('蓝方胜利')
    await expect(observer.locator('body')).toContainText('蓝方胜利')
    await expect(blue.getByTestId('scoreboard')).toContainText('2:1')
    await expect(red.getByTestId('scoreboard')).toContainText('2:1')
  })

  test('保存 Replay → 显式发布 → 新 Context 只读打开 → 撤销失效', async ({ browser }) => {
    await blue.getByRole('button', { name: '保存 Replay' }).click()
    await blue.getByRole('button', { name: '分享', exact: true }).click()
    const dialog = blue.getByRole('dialog')
    await expect(dialog).toContainText('玩家显示名会出现在')
    await dialog.getByRole('button', { name: '确认发布' }).click()
    const link = await dialog.getByLabel('分享链接').inputValue()
    expect(link).toMatch(/\/share\/[A-Za-z0-9_-]{32,64}$/)

    const publicContext = await createClassicContext(browser)
    const publicPage = await publicContext.newPage()
    await publicPage.goto(link)
    await expect(publicPage.getByText('用户分享的 BP 记录').first()).toBeVisible({ timeout: 20_000 })
    await expect(publicPage.getByText('张三').first()).toBeVisible()
    await expect(publicPage.getByText('李四').first()).toBeVisible()
    await expect(publicPage.getByRole('button', { name: /进入比赛|确认获胜|选择忍者/ })).toHaveCount(0)
    await publicContext.close()

    await dialog.getByRole('button', { name: '撤销' }).click()
    const revokedContext = await createClassicContext(browser)
    const revokedPage = await revokedContext.newPage()
    await revokedPage.goto(link)
    await expect(revokedPage.getByText('该分享已失效')).toBeVisible({ timeout: 20_000 })
    await revokedContext.close()
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toBeHidden()
  })

  test('Host 关闭房间，其他成员看到关闭状态', async () => {
    await blue.getByRole('button', { name: /关闭房间/ }).click()
    await blue.getByRole('button', { name: '关闭房间' }).last().click()
    await expect(blue.locator('body')).toContainText('房间已关闭')
    // RED 刷新后显示已关闭
    await red.reload()
    await expect(red.locator('body')).toContainText('房间已关闭', { timeout: 15000 })
    await ctxBlue.close()
    await ctxRed.close()
    await ctxObserver.close()
  })
})
