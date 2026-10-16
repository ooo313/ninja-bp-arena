import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { NavBar } from '@/components/common/NavBar'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { ToastHost } from '@/components/common/Toast'
import { useSettingsStore } from '@/store/settingsStore'
import { useDataPackStore } from '@/dataPack/store'

/** 应用外壳：导航 + 路由出口 + 全局 Toast + 免责声明 */
export default function App() {
  const location = useLocation()
  const animationsEnabled = useSettingsStore((s) => s.settings.animationsEnabled)
  const isFocusedView = location.pathname === '/bp' || location.pathname.startsWith('/room/')

  // v0.4 数据包引导：v2 用户迁移分类 + 激活包与生效池对齐（幂等）；
  // 随后按「每天最多一次」的频率静默检查远程包更新（只提示，不自动应用）
  useEffect(() => {
    const packStore = useDataPackStore.getState()
    packStore.init()
    if (!packStore.updateState.autoCheckEnabled) return
    for (const pack of useDataPackStore.getState().installedPacks) {
      if (pack.origin === 'URL' && pack.remoteUrl) {
        void useDataPackStore.getState().checkRemoteUpdate(pack.remoteUrl)
      }
    }
  }, [])

  return (
    <div className={`flex min-h-screen flex-col ${animationsEnabled ? '' : 'fx-off'}`}>
      <ErrorBoundary>
        {!isFocusedView && <NavBar />}
        <div className="flex-1">
          <Outlet />
        </div>
        {!isFocusedView && <footer className="border-t border-ink-700 px-4 py-4 text-center text-[11px] leading-relaxed text-fog-600">
          忍界 BP · Ninja BP Arena —— 本工具为玩家制作的非官方赛事 BP 辅助工具，与游戏官方无隶属或合作关系。
          <br className="hidden sm:block" />
          内置忍者与规则均为示例，可自行导入与配置。
        </footer>}
      </ErrorBoundary>
      <ToastHost />
    </div>
  )
}
