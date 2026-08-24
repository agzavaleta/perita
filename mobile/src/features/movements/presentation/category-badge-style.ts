const CATEGORY_BADGE_STYLES = [
  "border-rose-200 bg-rose-50 text-rose-700",
  "border-amber-200 bg-amber-50 text-amber-800",
  "border-emerald-200 bg-emerald-50 text-emerald-700",
  "border-sky-200 bg-sky-50 text-sky-700",
  "border-violet-200 bg-violet-50 text-violet-700",
  "border-slate-200 bg-slate-50 text-slate-700",
] as const

export function categoryBadgeClassName(categoryKey: string) {
  let hash = 0
  for (const character of categoryKey) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  }
  return CATEGORY_BADGE_STYLES[hash % CATEGORY_BADGE_STYLES.length]
}
