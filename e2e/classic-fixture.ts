import { test as base, type Browser, type BrowserContext } from '@playwright/test'
import { STORAGE_SCHEMA_VERSION } from '../src/utils/storage'

/** Existing regressions exercise the supported classic view. Game view has its own specs. */
function seedClassicView(version: number) {
  const key = 'ninja-bp.bp_settings'
  if (localStorage.getItem(key)) return
  localStorage.setItem(key, JSON.stringify({
    __v: version,
    data: { bpView: 'classic', soundEnabled: false, animationsEnabled: false, ninjaSort: 'quality', firstUseTipSeen: false },
  }))
}

export async function createClassicContext(browser: Browser, options?: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await browser.newContext(options)
  await context.addInitScript(seedClassicView, STORAGE_SCHEMA_VERSION)
  return context
}

export const test = base.extend<{ classicView: void }>({
  classicView: [async ({ context }, use) => {
    await context.addInitScript(seedClassicView, STORAGE_SCHEMA_VERSION)
    await use()
  }, { auto: true }],
})

export { expect, type Page, type BrowserContext } from '@playwright/test'
