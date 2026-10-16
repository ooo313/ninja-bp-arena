import { expect, test, type Page } from './classic-fixture'

const ninjaGames = [
  ['漩涡鸣人', '宇智波佐助', '旗木卡卡西', '宇智波鼬', '自来也', '纲手', '大蛇丸', '我爱罗', '迪达拉', '蝎'],
  ['干柿鬼鲛', '油女志乃', '药师兜', '静音', '李洛克', '天天'],
  ['奈良鹿丸', '秋道丁次', '山中井野', '犬冢牙', '飞段', '角都'],
]
const scrolls = ['护身结界（示例）', '炎遁卷轴（示例）']
const summons = ['蛤蟆伙伴（示例）', '忍犬伙伴（示例）', '蛞蝓伙伴（示例）', '忍鹰伙伴（示例）', '白蛇伙伴（示例）', '忍龟伙伴（示例）']

async function draftGame(page: Page, game: number) {
  for (const name of ninjaGames[game - 1]) await page.getByRole('button', { name: new RegExp(`^${name}（可选）`) }).click()
  await expect(page.getByRole('tab', { name: /秘卷 · 当前/ })).toBeVisible()
  for (const name of scrolls) await page.getByRole('button', { name: new RegExp(`^选择秘卷 ${name}`) }).click()
  await expect(page.getByRole('tab', { name: /通灵 · 当前/ })).toBeVisible()
  for (const name of summons) await page.getByRole('button', { name: new RegExp(`^选择通灵 ${name}`) }).click()
  await expect(page.locator('section[aria-live="polite"]')).toContainText('双方阵容已锁定')
  await expect(page.getByText('护身结界（示例）', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '进入比赛' }).click()
}

test('Full Loadout BO3 completes 2:1 with persisted Ninja bans and reusable auxiliary resources', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: '开始 BP' }).click()
  await page.getByLabel('规则模板').selectOption('FULL_LOADOUT')
  await page.getByRole('button', { name: '开始比赛' }).click()

  for (const game of [1, 2, 3]) {
    await draftGame(page, game)
    await page.getByRole('button', { name: game === 2 ? '红方获胜' : '蓝方获胜' }).click()
    await page.getByRole('button', { name: '确认获胜' }).click()
    if (game < 3) {
      await page.getByRole('button', { name: `进入 Game ${game + 1}` }).click()
      await expect(page.getByRole('button', { name: /漩涡鸣人（已禁用）/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /自来也（已使用）/ })).toBeVisible()
    }
  }

  await expect(page.getByTestId('scoreboard')).toContainText('2:1')
  await expect(page.locator('body')).toContainText('蓝方胜利')
  await expect(page.getByRole('button', { name: '重新开始' })).toBeVisible()
})
