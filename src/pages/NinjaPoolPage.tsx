import { useMemo, useRef, useState } from 'react'
import { Copy, Download, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import type { Ninja, NinjaQuality } from '@/types/ninja'
import { useNinjaStore } from '@/store/ninjaStore'
import { useSettingsStore } from '@/store/settingsStore'
import { toast } from '@/store/toastStore'
import { useDataPackStore } from '@/dataPack/store'
import { BUILT_IN_PACK_ID } from '@/dataPack/types'
import { NinjaAvatar } from '@/components/ninja/NinjaAvatar'
import { NinjaSearch } from '@/components/ninja/NinjaSearch'
import { NinjaFilter, type QualityFilter } from '@/components/ninja/NinjaFilter'
import { Dialog } from '@/components/common/Dialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { validateNinjaForm } from '@/engine/validators'
import { exportNinjaPoolJSON, parseNinjaImport, previewImport } from '@/utils/importExport'
import { copyToClipboard, downloadTextFile } from '@/utils/clipboard'
import { compareNinjaQuality, normalizeForSearch } from '@/utils/format'


interface FormState {
  id: string | null
  name: string
  aliases: string
  quality: NinjaQuality
  avatar: string
  tags: string
  sortOrder: string
  remark: string
  enabled: boolean
}

const EMPTY_FORM: FormState = { id: null, name: '', aliases: '', quality: 'A', avatar: '', tags: '', sortOrder: '', remark: '', enabled: true }

/** 忍者池管理：查看 / 搜索 / 增删改 / 批量操作 / JSON 导入（预览+模式）/ 导出 */
export default function NinjaPoolPage() {
  const ninjas = useNinjaStore((s) => s.ninjas)
  const addNinja = useNinjaStore((s) => s.addNinja)
  const updateNinja = useNinjaStore((s) => s.updateNinja)
  const removeNinja = useNinjaStore((s) => s.removeNinja)
  const setEnabled = useNinjaStore((s) => s.setEnabled)
  const removeMany = useNinjaStore((s) => s.removeMany)
  const importNinjas = useNinjaStore((s) => s.importNinjas)
  const ninjaSort = useSettingsStore((s) => s.settings.ninjaSort)

  const [search, setSearch] = useState('')
  const [quality, setQuality] = useState<QualityFilter>('ALL')
  const [seriesFilter, setSeriesFilter] = useState('ALL')
  const [tagFilter, setTagFilter] = useState('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [form, setForm] = useState<FormState | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Ninja | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<{ report: ReturnType<typeof parseNinjaImport>; preview: { added: number; updated: number; unchanged: number }; mode: 'merge' | 'replace' } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 系列 / 标签候选（来自当前池的真实值，保持筛选紧凑：仅在有数据时显示）
  const seriesOptions = useMemo(() => {
    const set = new Set<string>()
    for (const n of ninjas) for (const s of n.series ?? []) set.add(s)
    return [...set].sort()
  }, [ninjas])
  const tagOptions = useMemo(() => {
    const set = new Set<string>()
    for (const n of ninjas) for (const t of n.tags ?? []) set.add(t)
    return [...set].sort()
  }, [ninjas])

  const filtered = useMemo(() => {
    const query = normalizeForSearch(search)
    let list = ninjas
    if (query) {
      // 搜索范围：名称 / 别名 / 标签 / 系列 / 形态 / slug
      list = list.filter((n) => {
        const haystacks = [n.name, ...(n.aliases ?? []), ...(n.tags ?? []), ...(n.series ?? []), ...(n.forms ?? []), n.slug ?? '']
        return haystacks.some((text) => normalizeForSearch(text).includes(query))
      })
    }
    if (quality !== 'ALL') list = list.filter((n) => n.quality === quality)
    if (seriesFilter !== 'ALL') list = list.filter((n) => n.series?.includes(seriesFilter))
    if (tagFilter !== 'ALL') list = list.filter((n) => n.tags?.includes(tagFilter))
    return [...list].sort((a, b) => {
      if (ninjaSort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN')
      if (ninjaSort === 'releaseDate') {
        return (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999') || a.name.localeCompare(b.name, 'zh-Hans-CN')
      }
      if (ninjaSort === 'newest') {
        return (b.releaseDate ?? '0000').localeCompare(a.releaseDate ?? '0000') || a.name.localeCompare(b.name, 'zh-Hans-CN')
      }
      return compareNinjaQuality(a, b)
    })
  }, [ninjas, search, quality, seriesFilter, tagFilter, ninjaSort])

  const enabledCount = ninjas.filter((n) => n.enabled).length
  const allVisibleSelected = filtered.length > 0 && filtered.every((n) => selected.has(n.id))

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (filtered.every((n) => prev.has(n.id))) {
        const next = new Set(prev)
        filtered.forEach((n) => next.delete(n.id))
        return next
      }
      const next = new Set(prev)
      filtered.forEach((n) => next.add(n.id))
      return next
    })
  }

  // ---- 表单 ----
  const handleSaveForm = () => {
    if (!form) return
    const tags = form.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
    const aliases = form.aliases.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)
    const sortOrder = form.sortOrder.trim() === '' ? undefined : Number(form.sortOrder)
    const errors = validateNinjaForm({ name: form.name, quality: form.quality, avatar: form.avatar, tags })
    if (Number.isNaN(sortOrder)) errors.push('排序权重必须是整数')
    if (errors.length) {
      setFormErrors(errors)
      return
    }
    if (form.id) {
      updateNinja(form.id, {
        name: form.name.trim(),
        aliases: aliases.length ? aliases : undefined,
        quality: form.quality,
        avatar: form.avatar.trim(),
        tags,
        sortOrder,
        remark: form.remark,
        enabled: form.enabled,
      })
      toast('忍者已更新', 'success')
    } else {
      addNinja({
        name: form.name.trim(),
        aliases: aliases.length ? aliases : undefined,
        quality: form.quality,
        avatar: form.avatar.trim(),
        tags,
        sortOrder,
        remark: form.remark || '手动添加',
        enabled: form.enabled,
      })
      toast('忍者已添加', 'success')
    }
    setForm(null)
    setFormErrors([])
  }

  // ---- 导入：先解析预览，用户确认后才真正写入 ----
  const handleImportFile = async (file: File) => {
    const text = await file.text()
    const report = parseNinjaImport(text)
    const preview = previewImport(ninjas, report.ninjas)
    setImportPreview({ report, preview, mode: 'merge' })
  }

  const confirmImport = () => {
    if (!importPreview) return
    const { report, mode } = importPreview
    const { added, updated } = importNinjas(report.ninjas, mode)
    toast(mode === 'replace' ? `已替换忍者池（${report.ninjas.length} 名）` : `导入完成：新增 ${added}，更新 ${updated}`, 'success')
    setImportPreview(null)
  }

  const handleExport = () => {
    downloadTextFile('ninja-pool.json', exportNinjaPoolJSON(ninjas))
    toast('忍者池已导出为 ninja-pool.json', 'success')
  }

  const handleCopyPool = async () => {
    const ok = await copyToClipboard(exportNinjaPoolJSON(ninjas))
    toast(ok ? '忍者池 JSON 已复制' : '复制失败', ok ? 'success' : 'error')
  }

  const btnGhost = 'flex items-center gap-1.5 rounded border border-border-strong px-3 py-2 text-xs text-fog-300 transition-colors hover:bg-surface-2'

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16">
      <header className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-fog-100">忍者池管理</h1>
          <p className="mt-1 text-xs text-fog-600">
            共 {ninjas.length} 名忍者 · 启用 {enabledCount} 名
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setForm({ ...EMPTY_FORM }); setFormErrors([]) }} className="flex items-center gap-1.5 rounded bg-blue-team px-3 py-2 text-xs font-bold text-white transition-colors hover:brightness-110">
            <Plus size={14} /> 新增忍者
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} className={btnGhost}>
            <Upload size={14} /> 导入 JSON
          </button>
          <button type="button" onClick={handleExport} className={btnGhost}>
            <Download size={14} /> 导出
          </button>
          <button type="button" onClick={handleCopyPool} className={btnGhost}>
            <Copy size={14} /> 复制 JSON
          </button>
          <button type="button" onClick={() => setResetOpen(true)} className={btnGhost}>
            <RotateCcw size={14} /> 恢复示例池
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImportFile(file)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="mt-3 rounded border border-gold-accent/30 bg-gold-accent/5 px-3 py-2 text-[11px] leading-relaxed text-gold-accent/90">
        当前为内置示例数据（品质与标签仅供演示），并非官方完整忍者名单。真实忍者池可通过「导入 JSON」批量导入，
        头像可引用 /assets/ninjas/ 下的本地图片，格式见 public/assets/ninjas/README.md。
      </div>

      {/* 批量操作条 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-fog-400">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleSelectAll}
            aria-label="全选当前列表"
            className="h-3.5 w-3.5 accent-[#4d8dff]"
          />
          全选
        </label>
        <NinjaSearch value={search} onChange={setSearch} />
        <NinjaFilter value={quality} onChange={setQuality} />
        {(seriesOptions.length > 0 || tagOptions.length > 0) && (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded border border-border-strong px-2 py-1.5 text-xs text-fog-400 hover:bg-surface-2">
              筛选
            </summary>
            <div className="absolute left-0 z-20 mt-1 w-56 space-y-2 rounded border border-border-strong bg-ink-900 p-2.5 shadow-xl">
              {seriesOptions.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-fog-400">
                  系列
                  <select value={seriesFilter} onChange={(e) => setSeriesFilter(e.target.value)} className="flex-1 rounded border border-border-strong bg-ink-800 px-1.5 py-1 text-fog-200">
                    <option value="ALL">全部</option>
                    {seriesOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              {tagOptions.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-fog-400">
                  标签
                  <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="flex-1 rounded border border-border-strong bg-ink-800 px-1.5 py-1 text-fog-200">
                    <option value="ALL">全部</option>
                    {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              )}
            </div>
          </details>
        )}
        <select
          value={ninjaSort}
          onChange={(e) => useSettingsStore.getState().update({ ninjaSort: e.target.value as 'quality' | 'name' | 'releaseDate' | 'newest' })}
          aria-label="排序方式"
          className="rounded border border-border-strong bg-ink-800 px-2 py-1.5 text-xs text-fog-300 focus:outline-none"
        >
          <option value="quality">默认排序</option>
          <option value="name">名称</option>
          <option value="releaseDate">发布时间</option>
          <option value="newest">最近新增</option>
        </select>
      </div>
      {selected.size > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-blue-team/30 bg-blue-team/5 px-3 py-2 text-xs">
          <span className="text-fog-300">已选 {selected.size} 名</span>
          <button
            type="button"
            onClick={() => { setEnabled([...selected], true); toast('已批量启用', 'success') }}
            className="rounded border border-border-strong px-2.5 py-1 text-fog-300 hover:bg-surface-2"
          >
            批量启用
          </button>
          <button
            type="button"
            onClick={() => { setEnabled([...selected], false); toast('已批量停用', 'success') }}
            className="rounded border border-border-strong px-2.5 py-1 text-fog-300 hover:bg-surface-2"
          >
            批量停用
          </button>
          <button
            type="button"
            onClick={() => setBulkDeleteOpen(true)}
            className="rounded border border-red-team/40 px-2.5 py-1 text-red-team-soft hover:bg-red-team/10"
          >
            批量删除
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-fog-600 hover:text-fog-300">
            取消选择
          </button>
        </div>
      )}

      {/* 列表 */}
      <ul className="mt-3 space-y-1.5">
        {filtered.length === 0 && (
          <li className="rounded border border-dashed border-border-strong py-10 text-center text-sm text-fog-600">
            没有找到符合条件的忍者，尝试修改搜索关键词或筛选条件
          </li>
        )}
        {filtered.map((ninja) => (
          <li key={ninja.id} className={`flex items-center gap-3 rounded border px-3 py-2 ${selected.has(ninja.id) ? 'border-blue-team/40 bg-blue-team/5' : 'border-border-muted bg-surface-1/40'}`}>
            <input
              type="checkbox"
              checked={selected.has(ninja.id)}
              onChange={() => toggleSelect(ninja.id)}
              aria-label={`选择 ${ninja.name}`}
              className="h-3.5 w-3.5 shrink-0 accent-[#4d8dff]"
            />
            <NinjaAvatar name={ninja.name} avatar={ninja.avatar} className="h-10 w-10 shrink-0 rounded" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-fog-100">{ninja.name}</span>
                <span className="rounded border border-border-strong bg-surface-2 px-1 text-[10px] font-bold text-fog-300">{ninja.quality}</span>
                {!ninja.enabled && <span className="rounded bg-ink-500 px-1.5 text-[10px] text-fog-500">已停用</span>}
              </div>
              <p className="mt-0.5 truncate text-[11px] text-fog-600">
                {[ninja.tags.join(' / '), ninja.aliases?.length ? `别名：${ninja.aliases.join('、')}` : '', ninja.remark].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => useNinjaStore.getState().toggleEnabled(ninja.id)}
              role="switch"
              aria-checked={ninja.enabled}
              aria-label={`启用/停用 ${ninja.name}`}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${ninja.enabled ? 'bg-emerald-500/80' : 'bg-ink-500'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${ninja.enabled ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
            <button
              type="button"
              onClick={() => { setForm({ id: ninja.id, name: ninja.name, aliases: ninja.aliases?.join('、') ?? '', quality: ninja.quality, avatar: ninja.avatar ?? '', tags: ninja.tags.join('、'), sortOrder: ninja.sortOrder?.toString() ?? '', remark: ninja.remark ?? '', enabled: ninja.enabled }); setFormErrors([]) }}
              aria-label={`编辑 ${ninja.name}`}
              className="shrink-0 rounded border border-border-strong p-1.5 text-fog-400 transition-colors hover:bg-surface-2 hover:text-fog-100"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => setDeleteTarget(ninja)}
              aria-label={`删除 ${ninja.name}`}
              className="shrink-0 rounded border border-border-strong p-1.5 text-fog-400 transition-colors hover:border-red-team/50 hover:text-red-team-soft"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      {/* 新增 / 编辑表单 */}
      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? '编辑忍者' : '新增忍者'}
        footer={
          <>
            <button type="button" onClick={() => setForm(null)} className="rounded px-4 py-2 text-sm text-fog-300 hover:bg-surface-2">
              取消
            </button>
            <button type="button" onClick={handleSaveForm} className="rounded bg-blue-team px-5 py-2 text-sm font-bold text-white hover:brightness-110">
              保存
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-3">
            {formErrors.length > 0 && (
              <div className="rounded border border-red-team/40 bg-red-team/10 p-2.5 text-xs text-red-team-soft">
                {formErrors.map((e) => (
                  <p key={e}>{e}</p>
                ))}
              </div>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fog-300">忍者名称 *</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={30}
                placeholder="例如：漩涡鸣人"
                className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fog-300">别名（逗号分隔，用于搜索）</span>
              <input
                type="text"
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                placeholder="例如：秽土斑"
                className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fog-300">品质 *</span>
                <select
                  value={form.quality}
                  onChange={(e) => setForm({ ...form, quality: e.target.value as NinjaQuality })}
                  className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
                >
                  {(['S', 'A', 'B', 'C'] as const).map((q) => (
                    <option key={q} value={q}>{q}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fog-300">排序权重（小者靠前）</span>
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  placeholder="留空按品质排序"
                  className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fog-300">头像 URL（支持 /assets/ninjas/ 本地路径，留空显示占位头像）</span>
              <input
                type="text"
                value={form.avatar}
                onChange={(e) => setForm({ ...form, avatar: e.target.value })}
                placeholder="/assets/ninjas/naruto.webp 或 https://…"
                className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fog-300">标签（逗号分隔）</span>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="近战, 突进"
                className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fog-300">备注</span>
              <input
                type="text"
                value={form.remark}
                onChange={(e) => setForm({ ...form, remark: e.target.value })}
                className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 accent-[#4d8dff]"
              />
              <span className="text-xs text-fog-300">启用（停用后 BP 中不可选择）</span>
            </label>
          </div>
        )}
      </Dialog>

      {/* 导入预览：确认后才写入 */}
      <Dialog
        open={!!importPreview}
        onClose={() => setImportPreview(null)}
        title="导入预览"
        footer={
          <>
            <button type="button" onClick={() => setImportPreview(null)} className="rounded px-4 py-2 text-sm text-fog-300 hover:bg-surface-2">
              取消
            </button>
            <button
              type="button"
              disabled={!importPreview?.report.ok}
              onClick={confirmImport}
              className="rounded bg-blue-team px-5 py-2 text-sm font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认导入
            </button>
          </>
        }
      >
        {importPreview && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="rounded border border-border-muted bg-surface-2/60 p-2">
                <p className="text-fog-600">检测到</p>
                <p className="text-base font-bold text-fog-100">{importPreview.report.ninjas.length}</p>
              </div>
              <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
                <p className="text-fog-600">新增</p>
                <p className="text-base font-bold text-emerald-300">{importPreview.preview.added}</p>
              </div>
              <div className="rounded border border-gold-accent/30 bg-gold-accent/5 p-2">
                <p className="text-fog-600">更新</p>
                <p className="text-base font-bold text-gold-accent">{importPreview.preview.updated}</p>
              </div>
              <div className="rounded border border-border-muted bg-surface-2/60 p-2">
                <p className="text-fog-600">无变化</p>
                <p className="text-base font-bold text-fog-300">{importPreview.preview.unchanged}</p>
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs">
              <span className="text-fog-300">导入模式：</span>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="import-mode" checked={importPreview.mode === 'merge'} onChange={() => setImportPreview({ ...importPreview, mode: 'merge' })} className="accent-[#4d8dff]" />
                合并（按 ID 更新 / 新增）
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="import-mode" checked={importPreview.mode === 'replace'} onChange={() => setImportPreview({ ...importPreview, mode: 'replace' })} className="accent-[#ff5d5d]" />
                替换整个忍者池
              </label>
            </div>
            {importPreview.mode === 'replace' && (
              <p className="rounded border border-red-team/40 bg-red-team/10 p-2 text-xs text-red-team-soft">
                ⚠ 替换模式将删除当前忍者池中的全部数据，用导入内容整体覆盖！
              </p>
            )}

            {importPreview.report.errors.length > 0 && (
              <div>
                <p className="text-xs text-red-team-soft">以下条目有问题，将被跳过：</p>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded border border-red-team/30 bg-red-team/5 p-2 text-xs text-red-team-soft">
                  {importPreview.report.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除忍者"
        message={`确认删除“${deleteTarget?.name}”？该操作不可恢复。`}
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteTarget) {
            removeNinja(deleteTarget.id)
            toast('已删除', 'success')
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        title="批量删除忍者"
        message={`确认删除已选的 ${selected.size} 名忍者？该操作不可恢复。`}
        confirmText="全部删除"
        danger
        onConfirm={() => {
          removeMany([...selected])
          setSelected(new Set())
          toast('已批量删除', 'success')
        }}
        onClose={() => setBulkDeleteOpen(false)}
      />

      {/* 恢复示例池确认 */}
      <ConfirmDialog
        open={resetOpen}
        title="恢复默认忍者池？"
        message="当前全部忍者数据将被覆盖为内置示例池（可在操作前先导出备份）。"
        confirmText="恢复"
        danger
        onConfirm={() => {
          // v0.4：恢复默认 = 重新激活内置数据包（来源同步标记为 BUILT_IN）
          useDataPackStore.getState().activatePack(BUILT_IN_PACK_ID)
          toast('已恢复内置示例数据包', 'success')
        }}
        onClose={() => setResetOpen(false)}
      />
    </div>
  )
}
