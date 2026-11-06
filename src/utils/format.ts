const NINJA_QUALITY_ORDER = { S: 0, A: 1, B: 2, C: 3 } as const
type NinjaSortKey = { quality: keyof typeof NINJA_QUALITY_ORDER; name: string; sortOrder?: number }

export function compareNinjaQuality(a: NinjaSortKey, b: NinjaSortKey): number {
  return NINJA_QUALITY_ORDER[a.quality] - NINJA_QUALITY_ORDER[b.quality] ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    a.name.localeCompare(b.name, 'zh-Hans-CN')
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 用于导出文件名：match-20260828-1930.json */
export function fileTimestamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** 搜索用：去空白、全角→半角、小写、NFKC 规范化（大小写 / 全半角 / 空格差异不敏感） */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** Lower score ranks first; Infinity means no match. */
export function searchRank(item: { name: string; aliases?: string[]; tags?: string[]; series?: string[]; forms?: string[] }, query: string): number {
  if (!query) return 0
  const name = normalizeForSearch(item.name)
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (item.aliases?.some((alias) => normalizeForSearch(alias) === query)) return 2
  if (item.aliases?.some((alias) => normalizeForSearch(alias).startsWith(query))) return 3
  if (name.includes(query)) return 4
  if (item.aliases?.some((alias) => normalizeForSearch(alias).includes(query))) return 5
  if ([...(item.tags ?? []), ...(item.series ?? []), ...(item.forms ?? [])].some((value) => normalizeForSearch(value).includes(query))) return 6
  return Infinity
}
