/**
 * 断面校核批次领域模型
 *
 * 单次校核、批量校核、导出前置检查共用这里的同一份判定与状态规则：
 * - 唯一归属：同一断面（断面名称+站点编号）同一测量日期只能占用一个校核批次；
 * - 竞争收敛：同 profile 若出现两个批次，先完成的批次写入唯一结论（单一完成标记），
 *   后到批次只能复用结论，不能再给出第二份结论；
 * - 结论不可覆盖：历史「合格 / 重测」结论永久保留，安排重测、后到批次都不能改写，
 *   重测以「重测登记」生成新剖面记录的方式处理；
 * - 失败续跑：批次在某条资料不齐处中断，状态保留为进行中，继续校核只处理未完成项。
 */

import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

export const CROSSSECTION_KEY = 'crosssection'

const SECTION_FIELD = '断面名称'
const STATION_FIELD = '站点编号'
const DATE_FIELD = '测量日期'
const DISTANCE_FIELD = '起点距'
const ELEVATION_FIELD = '河底高程'
const RECORD_NO_FIELD = '记录编号'
const LEGACY_STATUS_FIELD = '记录状态'
const BATCH_NO_FIELD = '校核批次'

export const ROW_STATUS = {
  measured: '已测量',
  pending: '待校核',
  qualified: '已校核',
  remeasure: '需重测',
} as const

/** 校核判定结论。合格 / 重测 是终态，会写入结论注册表；资料不齐只阻塞、不是结论。 */
export type CheckVerdict = '合格' | '重测'
export type BatchKind = 'single' | 'bulk' | 'legacy'
export type BatchState = 'in_progress' | 'completed'

export type ItemState =
  | 'pending' // 待校核（未判定）
  | 'blocked' // 资料不齐，批次在此中断
  | 'qualified' // 本批次判定合格
  | 'remeasure' // 本批次判定需重测
  | 'reused_qualified' // 复用他批次的合格结论
  | 'reused_remeasure' // 复用他批次的重测结论

/** 单一判定结果：判定规则对单次、批量、导出检查三处完全一致。 */
export type InspectionOutcome =
  | { kind: 'verdict'; verdict: CheckVerdict; reason: string }
  | { kind: 'blocked'; reason: string }

export type CheckItem = {
  rowId: number
  state: ItemState
  reason: string
}

export type CheckBatch = {
  id: number
  batchNo: string
  kind: BatchKind
  state: BatchState
  blocker: string
  items: CheckItem[]
  createdAt: string
  completedAt: string | null
}

type Conclusion = {
  /** 竞争收敛后的唯一完成标记：首个写入结论的批次。 */
  batchNo: string
  verdict: CheckVerdict
  reason: string
  concludedAt: string
  source: 'single' | 'bulk' | 'legacy'
  adoptedByCompilation: string | null
}

export type CheckStore = {
  version: number
  seq: number
  batches: CheckBatch[]
  conclusions: Record<string, Conclusion>
}

const CHECK_STORAGE_KEY = 'hydrology-monitor-station:crosssection-checks'
const STORE_VERSION = 1

// ---------- 存取 ----------

function nowText(): string {
  return new Date().toISOString()
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function persistStore(store: CheckStore): void {
  if (isBrowser()) {
    window.localStorage.setItem(CHECK_STORAGE_KEY, JSON.stringify(store))
  }
}

function persistCrossSection(rows: EntryRow[]): void {
  saveRows(CROSSSECTION_KEY, rows)
}

/** 同一断面 + 同一测量日期 = 同一个校核竞争单元（profile）。 */
export function profileKeyOf(row: Pick<EntryRow, string> | EntryRow): string {
  const station = String(row[STATION_FIELD] ?? '').trim()
  const section = String(row[SECTION_FIELD] ?? '').trim()
  const date = String(row[DATE_FIELD] ?? '').trim()
  return `${station}|${section}|${date}`
}

function nextBatchNo(store: CheckStore, kind: BatchKind, date = ''): string {
  store.seq += 1
  const seqText = String(store.seq).padStart(3, '0')
  if (kind === 'legacy') {
    return `CHK-HIS-${date.split('-').join('')}`
  }
  const prefix = kind === 'single' ? 'CHK-D' : 'CHK-P'
  return `${prefix}-${seqText}`
}

// ---------- 统一判定规则（单次 / 批量 / 导出共用这一份） ----------

function asNumber(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (text === '') {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : NaN
}

/**
 * 资料判定（唯一一份）：
 * 1. 起点距或河底高程缺失（空）→ 资料不齐，批次中断，补齐后可从未完成处继续；
 * 2. 起点距或河底高程无法解析为数值 → 重测结论（数据不可用，补录也救不回来）；
 * 3. 两项均为有效数值 → 合格。
 */
export function inspectProfile(row: Pick<EntryRow, string>): InspectionOutcome {
  const distance = asNumber(row[DISTANCE_FIELD])
  const elevation = asNumber(row[ELEVATION_FIELD])
  if (distance === null || elevation === null) {
    const missing = [
      distance === null ? DISTANCE_FIELD : '',
      elevation === null ? ELEVATION_FIELD : '',
    ]
      .filter(Boolean)
      .join('、')
    return { kind: 'blocked', reason: `资料不齐：缺少${missing}` }
  }
  if (Number.isNaN(distance) || Number.isNaN(elevation)) {
    return { kind: 'verdict', verdict: '重测', reason: '起点距或河底高程无法解析为有效数值，数据不可用' }
  }
  return { kind: 'verdict', verdict: '合格', reason: '起点距、河底高程均为有效数值，断面成果可用' }
}

// ---------- 批次 / 结论维护 ----------

function isUnresolved(state: ItemState): boolean {
  return state === 'pending' || state === 'blocked'
}

function itemStateForVerdict(verdict: CheckVerdict, reused: boolean): ItemState {
  if (verdict === '合格') {
    return reused ? 'reused_qualified' : 'qualified'
  }
  return reused ? 'reused_remeasure' : 'remeasure'
}

export function itemIsVerdict(state: ItemState): CheckVerdict | null {
  if (state === 'qualified' || state === 'reused_qualified') {
    return '合格'
  }
  if (state === 'remeasure' || state === 'reused_remeasure') {
    return '重测'
  }
  return null
}

/**
 * 把结论落到竞争单元：
 * - 注册表已有结论（已被别的批次完成）→ 不覆盖，当前项迁到持有结论的批次做复用项，
 *   从原批次摘除（同断面同日只能占用一个校核批次）；
 * - 注册表没有结论 → 由本批次完成写入（唯一完成标记），其余批次的同 profile
 *   未完成项全部迁入本批次做复用项，空出的批次自动收口。
 * 返回当前项最终状态（调用方据此更新被迁移的 item 引用）。
 */
function applyVerdict(
  store: CheckStore,
  batch: CheckBatch,
  key: string,
  verdict: CheckVerdict,
  reason: string,
): ItemState {
  const existing = store.conclusions[key]
  const resolvedAt = nowText()
  if (existing) {
    moveReusedItem(store, batch, existing.batchNo, key, verdict)
    return itemStateForVerdict(existing.verdict, existing.batchNo !== batch.batchNo)
  }

  store.conclusions[key] = {
    batchNo: batch.batchNo,
    verdict,
    reason,
    concludedAt: resolvedAt,
    source: batch.kind === 'single' ? 'single' : batch.kind === 'bulk' ? 'bulk' : 'legacy',
    adoptedByCompilation: null,
  }

  // 竞争收敛：同日期其它批次的未完成项迁入完成批次，只复用结论、不再另占批次。
  for (const other of store.batches) {
    if (other.batchNo === batch.batchNo) {
      continue
    }
    moveReusedItem(store, other, batch.batchNo, key, verdict)
  }
  return itemStateForVerdict(verdict, false)
}

/** 把 source 批次中属于该 profile 的未完成项迁到 owner 批次标记复用，并清理空壳批次。 */
function moveReusedItem(
  store: CheckStore,
  source: CheckBatch,
  ownerBatchNo: string,
  key: string,
  verdict: CheckVerdict,
): void {
  if (source.batchNo === ownerBatchNo) {
    return
  }
  const owner = findBatch(store, ownerBatchNo)
  const rows = listRows(CROSSSECTION_KEY)
  const moving: CheckItem[] = []
  source.items = source.items.filter((item) => {
    const row = rows.find((entry) => entry.id === item.rowId)
    const sameProfile = row && profileKeyOf(row) === key
    if (sameProfile && isUnresolved(item.state)) {
      moving.push(item)
      return false
    }
    return true
  })
  for (const item of moving) {
    item.state = itemStateForVerdict(verdict, true)
    item.reason = `后到记录复用批次 ${ownerBatchNo} 的校核结论：${verdict}`
    if (owner && !owner.items.some((entry) => entry.rowId === item.rowId)) {
      owner.items.push(item)
    }
  }
  closeBatchIfDone(store, source)
  if (owner) {
    closeBatchIfDone(store, owner)
  }
}

function batchHasUnresolved(batch: CheckBatch): boolean {
  return batch.items.some((item) => isUnresolved(item.state))
}

/** 批次内所有项都离开待校核/资料不齐即收口；复用项也算完成（只认唯一完成标记）。 */
function closeBatchIfDone(store: CheckStore, batch: CheckBatch): void {
  if (batch.state === 'in_progress' && !batchHasUnresolved(batch)) {
    batch.state = 'completed'
    batch.blocker = ''
    batch.completedAt = nowText()
  }
}

function findBatch(store: CheckStore, batchNo: string): CheckBatch | undefined {
  return store.batches.find((batch) => batch.batchNo === batchNo)
}

function itemOfRow(store: CheckStore, rowId: number): { batch: CheckBatch; item: CheckItem } | null {
  for (const batch of store.batches) {
    const item = batch.items.find((entry) => entry.rowId === rowId)
    if (item) {
      return { batch, item }
    }
  }
  return null
}

function makeBatch(
  store: CheckStore,
  kind: BatchKind,
  items: CheckItem[],
  date = '',
  createdAt = nowText(),
): CheckBatch {
  const batch: CheckBatch = {
    id: store.batches.length + 1,
    batchNo: nextBatchNo(store, kind, date),
    kind,
    state: 'in_progress',
    blocker: '',
    items,
    createdAt,
    completedAt: null,
  }
  store.batches.push(batch)
  return batch
}

// ---------- 行状态同步 ----------

const ROW_STATE_TEXT: Record<ItemState, string> = {
  pending: ROW_STATUS.pending,
  blocked: ROW_STATUS.pending,
  qualified: ROW_STATUS.qualified,
  remeasure: ROW_STATUS.remeasure,
  reused_qualified: ROW_STATUS.qualified,
  reused_remeasure: ROW_STATUS.remeasure,
}

/** 行状态由批次项推导，保证页面状态与批次收敛结果永远一致。 */
export function rowStatusOf(state: ItemState | null): string {
  return state ? ROW_STATE_TEXT[state] : ROW_STATUS.measured
}

function syncRow(
  rows: EntryRow[],
  rowId: number,
  batch: CheckBatch | null,
  state: ItemState | null,
): void {
  const target = rows.find((entry) => entry.id === rowId)
  if (!target) {
    return
  }
  target.status = rowStatusOf(state)
  target[LEGACY_STATUS_FIELD] = target.status
  target[BATCH_NO_FIELD] = batch ? batch.batchNo : ''
  const verdict = state ? itemIsVerdict(state) : null
  target.pending = !verdict
  target.abnormal = verdict === '重测'
}

function syncAllRows(store: CheckStore, rows: EntryRow[]): void {
  for (const row of rows) {
    const hit = itemOfRow(store, Number(row.id))
    syncRow(rows, Number(row.id), hit ? hit.batch : null, hit ? hit.item.state : null)
  }
}

// ---------- 存量迁移：按测量日期补齐批次归属 ----------

function migrateLegacy(store: CheckStore, rows: EntryRow[]): void {
  // 已测量（未提交）的存量记录不预占批次——批次从「提交校核」开始，与新记录同规则。
  const eligible = rows.filter((row) => String(row.status) !== ROW_STATUS.measured)
  if (eligible.length === 0) {
    return
  }

  // 同一测量日期归并为一个历史批次；同断面同日期天然落在同批次，从源头杜绝竞争。
  const byDate = new Map<string, EntryRow[]>()
  for (const row of eligible) {
    const date = String(row[DATE_FIELD] ?? '').trim() || '未知日期'
    const group = byDate.get(date) ?? []
    group.push(row)
    byDate.set(date, group)
  }

  const createdAt = nowText()
  for (const [date, group] of byDate) {
    // 同日期组内先处理已带历史结论的行（已校核优先于需重测），
    // 保证同断面同日期的重复行收敛到原结论，而不是被后判定的行覆盖。
    const legacyRank: Record<string, number> = {
      [ROW_STATUS.qualified]: 0,
      [ROW_STATUS.remeasure]: 1,
    }
    group.sort(
      (a, b) =>
        (legacyRank[String(a.status)] ?? 2) - (legacyRank[String(b.status)] ?? 2) ||
        Number(a.id) - Number(b.id),
    )
    const items: CheckItem[] = []
    const batch = makeBatch(store, 'legacy', items, date, createdAt)
    for (const row of group) {
      const key = profileKeyOf(row)
      const legacyStatus = String(row.status)
      let state: ItemState
      if (legacyStatus === ROW_STATUS.qualified) {
        // 历史已校核：保持原结论合格，不允许后续动作覆盖。
        state = applyVerdict(store, batch, key, '合格', '历史已校核，迁移保留原合格结论')
      } else if (legacyStatus === ROW_STATUS.remeasure) {
        // 历史重测结论同样保留（原结果不被覆盖），并作为重测登记依据。
        state = applyVerdict(store, batch, key, '重测', '历史校核结论为需重测，迁移保留原结论')
      } else {
        const outcome = inspectProfile(row)
        if (outcome.kind === 'blocked') {
          state = 'blocked'
          if (!batch.blocker) {
            batch.blocker = outcome.reason
          }
        } else {
          state = applyVerdict(store, batch, key, outcome.verdict, outcome.reason)
        }
      }
      items.push({ rowId: Number(row.id), state, reason: itemReason(store, key, state, batch) })
    }
    closeBatchIfDone(store, batch)
  }
}

function itemReason(store: CheckStore, key: string, state: ItemState, batch: CheckBatch): string {
  const verdict = itemIsVerdict(state)
  if (verdict) {
    const conclusion = store.conclusions[key]
    if (conclusion && conclusion.batchNo !== batch.batchNo) {
      return `复用批次 ${conclusion.batchNo} 的校核结论：${conclusion.verdict}`
    }
    return conclusionOf(store, key)?.reason ?? ''
  }
  return state === 'blocked' ? batch.blocker : ''
}

function conclusionOf(store: CheckStore, key: string): Conclusion | undefined {
  return store.conclusions[key]
}

// ---------- Store 初始化（幂等，兼容旧 localStorage 与 reset） ----------

let memoryStore: CheckStore | null = null

function loadStore(): { store: CheckStore; rows: EntryRow[] } {
  let store: CheckStore | null = null
  if (isBrowser()) {
    const raw = window.localStorage.getItem(CHECK_STORAGE_KEY)
    if (raw) {
      try {
        store = JSON.parse(raw) as CheckStore
      } catch {
        store = null
      }
    }
  } else if (memoryStore) {
    store = memoryStore
  }

  let mutated = false
  if (!store || store.version !== STORE_VERSION) {
    store = { version: STORE_VERSION, seq: 0, batches: [], conclusions: {} }
    const fresh = listRows(CROSSSECTION_KEY)
    migrateLegacy(store, fresh)
    syncAllRows(store, fresh)
    mutated = true
  } else {
    // 行集合始终取当前缓存：跨模块（reset / 重测登记后外部写入）改动后不持有旧引用。
    const rows = listRows(CROSSSECTION_KEY)
    // 自愈：reset / 手工改写后出现的未归属存量（待校核/已校核/需重测但无批次项），
    // 仍按测量日期补齐归属，保证「旧批次号丢失」不会再次发生。
    const boundIds = new Set(
      store.batches.flatMap((batch) => batch.items.map((item) => item.rowId)),
    )
    const orphans = rows.filter(
      (row) =>
        !boundIds.has(Number(row.id)) &&
        String(row.status) !== ROW_STATUS.measured,
    )
    if (orphans.length > 0) {
      migrateLegacy(store, orphans)
      syncAllRows(store, rows)
      mutated = true
    }
  }

  const rows = listRows(CROSSSECTION_KEY)
  if (mutated) {
    persistStore(store)
    persistCrossSection(rows)
  }
  if (!isBrowser()) {
    memoryStore = store
  }
  return { store, rows }
}

function commit(store: CheckStore, rows: EntryRow[]): void {
  syncAllRows(store, rows)
  persistStore(store)
  persistCrossSection(rows)
}

// ---------- 查询视图 ----------

export type CrossSectionView = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | ItemState | BatchState | null
  itemState: ItemState | null
  batchNo: string
  batchState: BatchState | null
  blocker: string
  reason: string
  verdict: CheckVerdict | null
}

export type BatchView = {
  batchNo: string
  kind: BatchKind
  state: BatchState
  blocker: string
  createdAt: string
  completedAt: string | null
  total: number
  qualified: number
  remeasure: number
  pending: number
  blocked: number
  reused: number
}

export type CrossSectionBoard = {
  rows: CrossSectionView[]
  batches: BatchView[]
  stats: { measuredMonth: number; pending: number; remeasure: number }
}

function toView(store: CheckStore, rows: EntryRow[], row: EntryRow): CrossSectionView {
  const hit = itemOfRow(store, Number(row.id))
  const verdict = hit ? itemIsVerdict(hit.item.state) : null
  return {
    ...row,
    itemState: hit ? hit.item.state : null,
    batchNo: hit ? hit.batch.batchNo : String(row[BATCH_NO_FIELD] ?? ''),
    batchState: hit ? hit.batch.state : null,
    blocker: hit && hit.item.state === 'blocked' ? hit.batch.blocker : '',
    reason: hit ? hit.item.reason : '',
    verdict,
  }
}

function batchProgress(batch: CheckBatch): BatchView {
  const count = (predicate: (item: CheckItem) => boolean) =>
    batch.items.filter(predicate).length
  return {
    batchNo: batch.batchNo,
    kind: batch.kind,
    state: batch.state,
    blocker: batch.blocker,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    total: batch.items.length,
    qualified: count((item) => item.state === 'qualified'),
    remeasure: count((item) => item.state === 'remeasure'),
    pending: count((item) => item.state === 'pending'),
    blocked: count((item) => item.state === 'blocked'),
    reused: count((item) => item.state === 'reused_qualified' || item.state === 'reused_remeasure'),
  }
}

export function getBoard(filters: Record<string, string> = {}): CrossSectionBoard {
  const { store, rows } = loadStore()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const matched = rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
  const monthPrefix = new Date().toISOString().slice(0, 7)
  return {
    rows: matched.map((row) => toView(store, rows, row)),
    batches: store.batches.map(batchProgress),
    stats: {
      measuredMonth: rows.filter((row) =>
        String(row[DATE_FIELD] ?? '').startsWith(monthPrefix),
      ).length,
      pending: rows.filter((row) => {
        const hit = itemOfRow(store, Number(row.id))
        return hit ? isUnresolved(hit.item.state) : false
      }).length,
      remeasure: rows.filter((row) => {
        const hit = itemOfRow(store, Number(row.id))
        return hit ? itemIsVerdict(hit.item.state) === '重测' : false
      }).length,
    },
  }
}

// ---------- 批次执行 ----------

type RunSummary = { processed: number; qualified: number; remeasure: number; blockedAt: string }

/**
 * 推进一个进行中批次：只处理未完成项（失败批次从未完成处继续）。
 * 遇到资料不齐立即中断并保留批次现场；已有唯一结论的同 profile 直接复用。
 */
function advanceBatch(store: CheckStore, rows: EntryRow[], batch: CheckBatch): RunSummary {
  const summary: RunSummary = { processed: 0, qualified: 0, remeasure: 0, blockedAt: '' }
  batch.blocker = ''
  // 判定过程中条目可能被收敛逻辑迁进/迁出本批次，遍历快照避免跳过或重复处理。
  for (const item of [...batch.items]) {
    if (!batch.items.includes(item)) {
      // 已被迁入持有结论的批次（复用项），不再由本批次处理。
      continue
    }
    if (!isUnresolved(item.state)) {
      continue
    }
    const row = rows.find((entry) => entry.id === item.rowId)
    if (!row) {
      continue
    }
    const key = profileKeyOf(row)
    const outcome = inspectProfile(row)
    if (outcome.kind === 'blocked') {
      item.state = 'blocked'
      item.reason = outcome.reason
      batch.blocker = outcome.reason
      summary.blockedAt = String(row[RECORD_NO_FIELD] ?? row.id)
      break
    }
    item.state = applyVerdict(store, batch, key, outcome.verdict, outcome.reason)
    item.reason =
      item.state === 'reused_qualified' || item.state === 'reused_remeasure'
        ? `复用批次 ${store.conclusions[key]?.batchNo ?? ''} 的校核结论：${outcome.verdict}`
        : outcome.reason
    summary.processed += 1
    if (outcome.verdict === '合格') {
      summary.qualified += 1
    } else {
      summary.remeasure += 1
    }
  }
  closeBatchIfDone(store, batch)
  return summary
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

// ---------- 对外动作 ----------

/** 提交校核（单次校核入口）：已在批次的不重复处理；已有结论直接复用，不新建批次。 */
export function submitForCheck(rowId: number): ActionResult {
  const { store, rows } = loadStore()
  const row = rows.find((entry) => Number(entry.id) === rowId)
  if (!row) {
    return fail('没有找到该断面测量记录')
  }
  const key = profileKeyOf(row)
  const existingConclusion = store.conclusions[key]
  const hit = itemOfRow(store, rowId)

  if (hit) {
    const verdict = itemIsVerdict(hit.item.state)
    if (verdict) {
      return ok(
        `该剖面已有批次 ${hit.batch.batchNo} 的${verdict}结论，提交校核不重复处理`,
      )
    }
    // 未完成项：跑本批次，可能在资料不齐处中断。
    const summary = advanceBatch(store, rows, hit.batch)
    commit(store, rows)
    return summary.blockedAt
      ? ok(`批次在记录 ${summary.blockedAt} 处中断：${hit.batch.blocker}，补齐资料后可继续`)
      : ok(`已并入批次 ${hit.batch.batchNo} 完成校核`)
  }

  if (existingConclusion) {
    // 后到记录不另立批次（同断面同日只能占用一个校核批次）：
    // 直接作为复用项挂到持有结论的批次上，批次完成状态不变。
    const owner = findBatch(store, existingConclusion.batchNo)
    if (owner) {
      owner.items.push({
        rowId,
        state: itemStateForVerdict(existingConclusion.verdict, true),
        reason: `后到记录复用批次 ${existingConclusion.batchNo} 的校核结论：${existingConclusion.verdict}`,
      })
    }
    commit(store, rows)
    return ok(`该测量日期已有批次 ${existingConclusion.batchNo} 完成校核，复用其${existingConclusion.verdict}结论`)
  }

  const batch = makeBatch(store, 'single', [{ rowId, state: 'pending', reason: '' }])
  const summary = advanceBatch(store, rows, batch)
  commit(store, rows)
  if (summary.blockedAt) {
    return ok(`单次校核批次 ${batch.batchNo} 在记录 ${summary.blockedAt} 处中断：${batch.blocker}`)
  }
  const verdict = store.conclusions[key]?.verdict ?? '合格'
  return ok(`单次校核批次 ${batch.batchNo} 完成，结论：${verdict}`)
}

/** 确认校核（继续单次批次）：失败批次从未完成处继续。 */
export function confirmCheck(rowId: number): ActionResult {
  const { store, rows } = loadStore()
  const hit = itemOfRow(store, rowId)
  if (!hit) {
    return fail('该记录尚未提交校核，请先提交校核')
  }
  if (hit.batch.state === 'completed') {
    return fail(`批次 ${hit.batch.batchNo} 已完成，结论无需重复确认`)
  }
  if (hit.batch.kind === 'bulk') {
    return fail(`该记录属于批量批次 ${hit.batch.batchNo}，请在批次面板中继续校核`)
  }
  const summary = advanceBatch(store, rows, hit.batch)
  commit(store, rows)
  if (summary.blockedAt) {
    return fail(`批次仍在记录 ${summary.blockedAt} 处中断：${hit.batch.blocker}，请先补齐资料`)
  }
  return ok(`批次 ${hit.batch.batchNo} 已继续校核并完成`)
}

/** 安排重测：仅对未判定项生效；历史已校核结论保持原结论，不允许覆盖。 */
export function arrangeRemeasure(rowId: number): ActionResult {
  const { store, rows } = loadStore()
  const row = rows.find((entry) => Number(entry.id) === rowId)
  if (!row) {
    return fail('没有找到该断面测量记录')
  }
  const key = profileKeyOf(row)
  const existing = store.conclusions[key]
  if (existing) {
    return fail(
      `该剖面已有批次 ${existing.batchNo} 的「${existing.verdict}」结论，重测不能覆盖原结果，请对「需重测」记录登记重测`,
    )
  }
  const hit = itemOfRow(store, rowId)
  if (!hit || !isUnresolved(hit.item.state)) {
    return fail('只有待校核（含资料不齐）的记录可以安排重测')
  }
  hit.item.state = applyVerdict(store, hit.batch, key, '重测', '校核人判定安排重测')
  hit.item.reason = '校核人判定安排重测'
  hit.batch.blocker = ''
  closeBatchIfDone(store, hit.batch)
  commit(store, rows)
  return ok(`已安排重测，批次 ${hit.batch.batchNo} 记录重测结论`)
}

/** 批量校核：收容所有已测量/待校核且未占用批次的记录，已有结论的日期直接复用。 */
export function startBulkCheck(): ActionResult {
  const { store, rows } = loadStore()
  const boundIds = new Set(
    store.batches.flatMap((batch) => batch.items.map((item) => item.rowId)),
  )
  const freeRows = rows.filter(
    (row) => !boundIds.has(Number(row.id)) && String(row.status) !== ROW_STATUS.remeasure,
  )
  if (freeRows.length === 0) {
    return fail('没有待校核的断面记录：全部已占用批次或已有结论')
  }
  const items: CheckItem[] = freeRows.map((row) => ({
    rowId: Number(row.id),
    state: 'pending' as ItemState,
    reason: '',
  }))
  const batch = makeBatch(store, 'bulk', items)
  const summary = advanceBatch(store, rows, batch)
  commit(store, rows)
  if (summary.blockedAt) {
    return ok(
      `批量批次 ${batch.batchNo} 已处理 ${summary.processed} 条，在记录 ${summary.blockedAt} 处中断（${batch.blocker}），可从未完成处继续`,
    )
  }
  return ok(
    `批量批次 ${batch.batchNo} 完成：合格 ${summary.qualified} 条，重测 ${summary.remeasure} 条，其余复用既有结论`,
  )
}

/** 继续批量批次：失败续跑，已完成项跳过，只处理未完成项。 */
export function resumeBatch(batchNo: string): ActionResult {
  const { store, rows } = loadStore()
  const batch = findBatch(store, batchNo)
  if (!batch) {
    return fail(`没有找到批次 ${batchNo}`)
  }
  if (batch.state === 'completed') {
    return fail(`批次 ${batchNo} 已完成`)
  }
  const unresolvedBefore = batch.items.filter((item) => isUnresolved(item.state)).length
  const summary = advanceBatch(store, rows, batch)
  commit(store, rows)
  if (summary.blockedAt) {
    return fail(
      `批次 ${batchNo} 在记录 ${summary.blockedAt} 处中断（${batch.blocker}），剩余 ${batch.items.filter((item) => isUnresolved(item.state)).length} 条未完成，请补齐资料后继续`,
    )
  }
  return ok(
    `批次 ${batchNo} 续跑完成：本次处理 ${unresolvedBefore} 条未完成项，批次已收口`,
  )
}

/** 补齐资料（资料不齐中断后的恢复入口）。 */
export function supplementProfileData(
  rowId: number,
  patch: { distance?: string; elevation?: string },
): ActionResult {
  const { store, rows } = loadStore()
  const row = rows.find((entry) => Number(entry.id) === rowId)
  if (!row) {
    return fail('没有找到该断面测量记录')
  }
  const hit = itemOfRow(store, rowId)
  if (!hit || hit.item.state !== 'blocked') {
    return fail('只有资料不齐、批次中断的记录需要补录')
  }
  if (patch.distance !== undefined && patch.distance.trim() !== '') {
    row[DISTANCE_FIELD] = patch.distance.trim()
  }
  if (patch.elevation !== undefined && patch.elevation.trim() !== '') {
    row[ELEVATION_FIELD] = patch.elevation.trim()
  }
  const outcome = inspectProfile(row)
  if (outcome.kind === 'blocked') {
    commit(store, rows)
    return fail(outcome.reason)
  }
  // 补齐后仍不直接判：批次继续校核时从未完成处统一判定，保持单一入口。
  hit.item.state = 'pending'
  hit.item.reason = '资料已补齐，等待批次继续校核'
  if (hit.batch.items.every((item) => item.state !== 'blocked')) {
    hit.batch.blocker = ''
  }
  commit(store, rows)
  return ok(`资料已补齐，批次 ${hit.batch.batchNo} 可继续校核`)
}

/** 重测登记：针对需重测剖面生成一条新测量记录（新剖面，原结论原样保留、不覆盖）。 */
export function registerRemeasure(rowId: number): ActionResult {
  const { store, rows } = loadStore()
  const row = rows.find((entry) => Number(entry.id) === rowId)
  if (!row) {
    return fail('没有找到该断面测量记录')
  }
  const hit = itemOfRow(store, rowId)
  if (!hit || itemIsVerdict(hit.item.state) !== '重测') {
    return fail('只有结论为需重测的记录可以登记重测')
  }
  const maxId = rows.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0)
  const nextNo = `CROS-${String(maxId + 1).padStart(4, '0')}`
  const today = new Date().toISOString().slice(0, 10)
  const fresh: EntryRow = {
    id: maxId + 1,
    status: ROW_STATUS.measured,
    pending: true,
    abnormal: false,
    [RECORD_NO_FIELD]: nextNo,
    [STATION_FIELD]: String(row[STATION_FIELD] ?? ''),
    [SECTION_FIELD]: String(row[SECTION_FIELD] ?? ''),
    测量方法: String(row['测量方法'] ?? ''),
    [DISTANCE_FIELD]: '',
    [ELEVATION_FIELD]: '',
    [DATE_FIELD]: today,
    [LEGACY_STATUS_FIELD]: ROW_STATUS.measured,
    [BATCH_NO_FIELD]: '',
  }
  rows.push(fresh)
  commit(store, rows)
  return ok(`已为重测剖面登记新测量记录 ${nextNo}（测量日期 ${today}），原记录结论保持不变`)
}

// ---------- 导出前置检查（复用同一份判定） ----------

export type ExportPrecheck = {
  ok: boolean
  exportable: number
  blockers: { recordNo: string; reason: string }[]
}

export function precheckExport(): ExportPrecheck {
  const { store, rows } = loadStore()
  const blockers: { recordNo: string; reason: string }[] = []
  let exportable = 0
  for (const row of rows) {
    const recordNo = String(row[RECORD_NO_FIELD] ?? row.id)
    const hit = itemOfRow(store, Number(row.id))
    if (!hit) {
      blockers.push({ recordNo, reason: '尚未提交校核' })
      continue
    }
    if (hit.batch.state !== 'completed') {
      blockers.push({
        recordNo,
        reason: `所属批次 ${hit.batch.batchNo} 未完成（${hit.batch.blocker || '存在未完成项'}）`,
      })
      continue
    }
    const verdict = itemIsVerdict(hit.item.state)
    if (!verdict) {
      blockers.push({ recordNo, reason: '尚无校核结论' })
      continue
    }
    if (verdict === '重测') {
      blockers.push({ recordNo, reason: '校核结论为需重测，重测成果确认前不得导出' })
      continue
    }
    // 合格行再跑一次统一判定做闸口复核，规则与单次/批量完全一致。
    const outcome = inspectProfile(row)
    if (outcome.kind === 'blocked') {
      blockers.push({ recordNo, reason: outcome.reason })
      continue
    }
    if (outcome.verdict === '重测') {
      blockers.push({ recordNo, reason: outcome.reason })
      continue
    }
    exportable += 1
  }
  return { ok: blockers.length === 0, exportable, blockers }
}

export function exportCrossSectionCsv(): { filename: string; content: string } {
  const { rows } = loadStore()
  const header = [
    '编号',
    RECORD_NO_FIELD,
    STATION_FIELD,
    SECTION_FIELD,
    '测量方法',
    DISTANCE_FIELD,
    ELEVATION_FIELD,
    DATE_FIELD,
    BATCH_NO_FIELD,
    LEGACY_STATUS_FIELD,
    '当前状态',
  ]
  const valueFields = [
    RECORD_NO_FIELD,
    STATION_FIELD,
    SECTION_FIELD,
    '测量方法',
    DISTANCE_FIELD,
    ELEVATION_FIELD,
    DATE_FIELD,
    BATCH_NO_FIELD,
    LEGACY_STATUS_FIELD,
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, ...valueFields.map((field) => row[field] ?? ''), row.status].join(','),
    )
  }
  return { filename: '断面测量-清单.csv', content: `﻿${lines.join('\n')}` }
}

// ---------- 水位整编待办：复用同一批次结论 ----------

export type CompilationTodo = {
  key: string
  station: string
  section: string
  date: string
  verdict: CheckVerdict
  batchNo: string
  reason: string
  adopted: boolean
  adoptedAt: string | null
}

export function listCompilationTodos(): CompilationTodo[] {
  const { store } = loadStore()
  return Object.entries(store.conclusions)
    .map(([key, conclusion]) => {
      const [station, section, date] = key.split('|')
      return {
        key,
        station,
        section,
        date,
        verdict: conclusion.verdict,
        batchNo: conclusion.batchNo,
        reason: conclusion.reason,
        adopted: conclusion.adoptedByCompilation !== null,
        adoptedAt: conclusion.adoptedByCompilation,
      }
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.batchNo.localeCompare(b.batchNo)))
}

/** 整编直接采用批次结论；只允许采用合格结论，重测结论提示先完成重测。 */
export function adoptConclusionForCompilation(key: string): ActionResult {
  const { store } = loadStore()
  const conclusion = store.conclusions[key]
  if (!conclusion) {
    return fail('该剖面尚无校核结论可采用')
  }
  if (conclusion.verdict === '重测') {
    return fail(`批次 ${conclusion.batchNo} 结论为重测，请先完成重测成果校核，不能直接整编`)
  }
  if (conclusion.adoptedByCompilation) {
    return ok(`已采用批次 ${conclusion.batchNo} 的合格结论，无需重复采用`)
  }
  conclusion.adoptedByCompilation = nowText()
  persistStore(store)
  return ok(`水位整编已采用批次 ${conclusion.batchNo} 的合格结论`)
}

/** 供其它模块确认某断面某日是否已有可复用的合格结论。 */
export function reusableConclusion(
  station: string,
  section: string,
  date: string,
): { batchNo: string; verdict: CheckVerdict; adopted: boolean } | null {
  const { store } = loadStore()
  const key = `${station.trim()}|${section.trim()}|${date.trim()}`
  const conclusion = store.conclusions[key]
  if (!conclusion) {
    return null
  }
  return {
    batchNo: conclusion.batchNo,
    verdict: conclusion.verdict,
    adopted: conclusion.adoptedByCompilation !== null,
  }
}

export function resetCrossSectionChecks(): void {
  if (isBrowser()) {
    window.localStorage.removeItem(CHECK_STORAGE_KEY)
  }
  memoryStore = null
  // 重新装载时按种子数据执行存量迁移。
  const rows = listRows(CROSSSECTION_KEY)
  const store: CheckStore = { version: STORE_VERSION, seq: 0, batches: [], conclusions: {} }
  migrateLegacy(store, rows)
  syncAllRows(store, rows)
  persistStore(store)
  saveRows(CROSSSECTION_KEY, rows)
}
