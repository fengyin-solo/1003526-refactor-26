import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  PROFILE_FIELDS,
  PROFILE_STATUSES,
  decideGate,
  exportBlockReason,
  isMemberDone,
  statusForVerdict,
} from './rules'
import type {
  BatchMember,
  CheckBatch,
  CheckGate,
  CheckVerdict,
  ConclusionView,
  ExportBlocker,
  MemberState,
} from './types'

const MODULE_KEY = 'crosssection'
const LEDGER_KEY = 'hydrology-monitor-station:crosssection-ledger'
const LEDGER_VERSION = 1

interface LedgerState {
  version: number
  migratedAt: string
  batchSeq: number
  batches: CheckBatch[]
}

export interface ServiceResult<T = undefined> {
  ok: boolean
  message: string
  data?: T
}

export interface CompilationTodo {
  recordNo: string
  station: string
  date: string
  section: string
  state: 'ready' | 'retest' | 'open' | 'none'
  verdict?: CheckVerdict
  batchNo?: string
  message: string
}

// ---- 纯函数工具：标的键、台账读写、占用/赢家查询 ------------------------------

/** 校核标的键：同一站点同一断面同一测量日期，全系统唯一。 */
export function profileKeyOf(row: EntryRow): string {
  const station = String(row[PROFILE_FIELDS.station] ?? '').trim()
  const section = String(row[PROFILE_FIELDS.section] ?? '').trim()
  const date = String(row[PROFILE_FIELDS.date] ?? '').trim()
  return `${station}|${section}|${date}`
}

function nowText(): string {
  return new Date().toISOString()
}

function nextBatchNo(ledger: LedgerState): string {
  ledger.batchSeq += 1
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `JC${day}-${String(ledger.batchSeq).padStart(3, '0')}`
}

function readLedger(): LedgerState {
  const fallback = (): LedgerState => migrate(createEmptyLedger())
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback()
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    const ledger = migrate(createEmptyLedger())
    persist(ledger)
    return ledger
  }
  try {
    const parsed = JSON.parse(raw) as LedgerState
    if (parsed.version !== LEDGER_VERSION) {
      const ledger = migrate(parsed)
      persist(ledger)
      return ledger
    }
    return parsed
  } catch {
    const ledger = fallback()
    persist(ledger)
    return ledger
  }
}

function createEmptyLedger(): LedgerState {
  return { version: LEDGER_VERSION, migratedAt: '', batchSeq: 0, batches: [] }
}

function persist(ledger: LedgerState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
  }
}

function commit(ledger: LedgerState): void {
  persist(ledger)
  reconcileRows(ledger)
}

/** 成员键按「批次 + 标的 + 记录行」唯一：同一批次允许同时持有同标的的
 * 赢家成员与复用成员（存量同日重复记录即此情况），不能只按标的去重。 */
function memberKey(batchId: string, profileKey: string, rowId: number): string {
  return `${batchId}#${profileKey}#${rowId}`
}

/** 全系统范围内某标的当前的占用者（claimed/failed 成员），至多一个。 */
function findClaim(
  ledger: LedgerState,
  profileKey: string,
  excludeBatchId?: string,
): { batch: CheckBatch; member: BatchMember } | undefined {
  for (const batch of ledger.batches) {
    if (excludeBatchId && batch.id === excludeBatchId) {
      continue
    }
    const member = batch.members.find(
      (item) =>
        item.profileKey === profileKey &&
        (item.state === 'claimed' || item.state === 'failed'),
    )
    if (member) {
      return { batch, member }
    }
  }
  return undefined
}

/** 该标的当前生效的赢家结论：结论按时间追加，重测后的新结论成为生效结论，
 * 原结论仍保留在批次台账中，不被覆盖。 */
function findWinner(
  ledger: LedgerState,
  profileKey: string,
): { batch: CheckBatch; member: BatchMember } | undefined {
  const winners: { batch: CheckBatch; member: BatchMember }[] = []
  for (const batch of ledger.batches) {
    if (batch.state !== 'completed' || !batch.finishedAt) {
      continue
    }
    for (const member of batch.members) {
      if (
        member.profileKey === profileKey &&
        (member.state === 'pass' || member.state === 'retest') &&
        member.verdict
      ) {
        winners.push({ batch, member })
      }
    }
  }
  winners.sort(
    (a, b) =>
      String(b.member.at ?? b.batch.finishedAt ?? '').localeCompare(
        String(a.member.at ?? a.batch.finishedAt ?? ''),
      ) || b.batch.createdAt.localeCompare(a.batch.createdAt),
  )
  return winners[0]
}

/** 重测派生的新测量记录：它是失败结论之后的合法续核，不应被旧结论复用挡住。 */
function isRemeasureRecord(row: EntryRow): boolean {
  const source = row[PROFILE_FIELDS.remeasureOf]
  return source !== undefined && source !== '' && Number(source) > 0
}

/** 批次内已落定结论的成员（迁移时同批次多条同标的记录据此复用首个结论）。 */
function findSettledInBatch(
  batch: CheckBatch,
  profileKey: string,
): { batch: CheckBatch; member: BatchMember } | undefined {
  const member = batch.members.find(
    (item) =>
      item.profileKey === profileKey &&
      (item.state === 'pass' || item.state === 'retest'),
  )
  return member ? { batch, member } : undefined
}

/** 在两个赢家候选中取结论时间更新的一个（重测新结论覆盖生效性，不删除旧结论）。 */
function newerWinner(
  a: { batch: CheckBatch; member: BatchMember } | undefined,
  b: { batch: CheckBatch; member: BatchMember },
): { batch: CheckBatch; member: BatchMember } {
  if (!a) {
    return b
  }
  const atA = String(a.member.at ?? a.batch.finishedAt ?? a.batch.createdAt)
  const atB = String(b.member.at ?? b.batch.finishedAt ?? b.batch.createdAt)
  return atB.localeCompare(atA) >= 0 ? b : a
}

/** 该标的全部已落定结论（追加链，重测结论排在后面，原结论与批次号保留）。 */
export function conclusionTimeline(profileKey: string): ConclusionView[] {
  const ledger = readLedger()
  const views: (ConclusionView & { sortAt: string })[] = []
  for (const batch of ledger.batches) {
    for (const member of batch.members) {
      if (
        member.profileKey === profileKey &&
        (member.state === 'pass' || member.state === 'retest') &&
        member.verdict
      ) {
        views.push({
          profileKey,
          verdict: member.verdict,
          batchNo: member.verdictBatchNo ?? batch.batchNo,
          source: batch.source,
          rowId: member.rowId,
          recordNo: member.recordNo,
          at: member.at ?? batch.finishedAt ?? batch.createdAt,
          conclusionId: member.conclusionId ?? '',
          sortAt: member.at ?? batch.finishedAt ?? batch.createdAt,
        })
      }
    }
  }
  return views
    .sort((a, b) => a.sortAt.localeCompare(b.sortAt))
    .map(({ sortAt: _sortAt, ...rest }) => rest)
}

// ---- 存量回填：按测量日期为存量剖面补齐批次归属 -------------------------------

/**
 * 存量迁移（幂等）：
 * - 已校核记录：按「测量日期」归并成历史批次（LS 批次号），结论保持原样；
 * - 待校核记录：同日期归并成在途历史批次，仍保持待校核，可从未完成处继续；
 * - 已测量/需重测记录：原本就不在校核流程内，不挂批次，避免伪造归属；
 * - 已有归属（校核批次字段或台账已有成员）的记录一律不重挂，旧批次号不丢。
 */
function migrate(ledger: LedgerState): LedgerState {
  const rows = listRows(MODULE_KEY)
  if (!rows.length) {
    ledger.migratedAt = nowText()
    return ledger
  }
  const knownKeys = new Set<string>()
  for (const batch of ledger.batches) {
    for (const member of batch.members) {
      knownKeys.add(`${member.profileKey}@${member.rowId}`)
    }
  }

  const tagged = rows.filter(
    (row) => String(row[PROFILE_FIELDS.batchNo] ?? '').trim() !== '',
  )
  // 仅由旧版本页面标记过批次号、但台账里没有批次实体时，补一个只读历史批次。
  for (const row of tagged) {
    const key = `${profileKeyOf(row)}@${row.id}`
    if (knownKeys.has(key)) {
      continue
    }
    const batchNo = String(row[PROFILE_FIELDS.batchNo])
    const date = String(row[PROFILE_FIELDS.date] ?? '').slice(0, 10)
    const batch = ensureLegacyBatch(ledger, batchNo, 'completed', date)
    const verdict: CheckVerdict = row.status === '需重测' ? 'retest' : 'pass'
    settleMember(batch, {
      memberKey: memberKey(batch.id, profileKeyOf(row), Number(row.id)),
      profileKey: profileKeyOf(row),
      rowId: Number(row.id),
      recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
      state: verdict === 'pass' ? 'pass' : 'retest',
      verdict,
      verdictBatchNo: batchNo,
      conclusionId: `${batch.id}#${row.id}`,
      at: batch.finishedAt ?? nowText(),
    })
    knownKeys.add(key)
  }

  const pending = rows.filter((row) => {
    const key = `${profileKeyOf(row)}@${row.id}`
    return row.status === '待校核' && !knownKeys.has(key)
  })
  const groups = new Map<string, EntryRow[]>()
  for (const row of pending) {
    const date = String(row[PROFILE_FIELDS.date] ?? '').slice(0, 10)
    const list = groups.get(date) ?? []
    list.push(row)
    groups.set(date, list)
  }
  for (const [date, list] of groups) {
    const day = date.replace(/-/g, '') || '00000000'
    const batchNo = `LS${day}-PEND`
    const batch = ensureLegacyBatch(ledger, batchNo, 'open', date)
    for (const row of list) {
      const key = profileKeyOf(row)
      const state: MemberState = findClaim(ledger, key, batch.id)
        ? 'skipped'
        : 'claimed'
      attachMember(batch, {
        memberKey: memberKey(batch.id, key, Number(row.id)),
        profileKey: key,
        rowId: Number(row.id),
        recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
        state,
      })
    }
    refreshCursor(batch)
  }

  const checked = rows.filter((row) => {
    const key = `${profileKeyOf(row)}@${row.id}`
    return (
      (row.status === '已校核' || row.status === '需重测') &&
      String(row[PROFILE_FIELDS.batchNo] ?? '').trim() === '' &&
      !knownKeys.has(key)
    )
  })
  const doneGroups = new Map<string, EntryRow[]>()
  for (const row of checked) {
    const date = String(row[PROFILE_FIELDS.date] ?? '').slice(0, 10)
    const list = doneGroups.get(date) ?? []
    list.push(row)
    doneGroups.set(date, list)
  }
  for (const [date, list] of doneGroups) {
    const day = date.replace(/-/g, '') || '00000000'
    const batchNo = `LS${day}-DONE`
    const batch = ensureLegacyBatch(ledger, batchNo, 'completed', date)
    // 同标的多条记录只保留首个结论，后来者复用，历史结论不被覆盖。
    for (const row of list.sort((a, b) => Number(a.id) - Number(b.id))) {
      const key = profileKeyOf(row)
      const winner =
        findWinner(ledger, key) ?? findSettledInBatch(batch, key)
      const verdict: CheckVerdict = row.status === '需重测' ? 'retest' : 'pass'
      if (winner) {
        attachMember(batch, {
          memberKey: memberKey(batch.id, key, Number(row.id)),
          profileKey: key,
          rowId: Number(row.id),
          recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
          state: 'reused',
          verdict: winner.member.verdict,
          verdictBatchNo: winner.batch.batchNo,
          conclusionId: winner.member.conclusionId,
          at: batch.finishedAt,
        })
      } else {
        settleMember(batch, {
          memberKey: memberKey(batch.id, key, Number(row.id)),
          profileKey: key,
          rowId: Number(row.id),
          recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
          state: verdict === 'pass' ? 'pass' : 'retest',
          verdict,
          verdictBatchNo: batchNo,
          conclusionId: `${batch.id}#${row.id}`,
          at: batch.finishedAt ?? nowText(),
        })
      }
    }
  }

  if (!ledger.migratedAt) {
    ledger.migratedAt = nowText()
  }
  return ledger
}

function ensureLegacyBatch(
  ledger: LedgerState,
  batchNo: string,
  state: CheckBatch['state'],
  date: string,
): CheckBatch {
  const existing = ledger.batches.find((batch) => batch.batchNo === batchNo)
  if (existing) {
    return existing
  }
  const stamp = `${date}T00:00:00.000Z`
  const batch: CheckBatch = {
    id: `legacy:${batchNo}`,
    batchNo,
    source: 'legacy',
    state,
    createdAt: stamp,
    cursor: 0,
    members: [],
    ...(state === 'completed' ? { finishedAt: stamp } : {}),
  }
  ledger.batches.push(batch)
  return batch
}

function attachMember(batch: CheckBatch, member: BatchMember): void {
  if (!batch.members.some((item) => item.memberKey === member.memberKey)) {
    batch.members.push(member)
  }
}

function settleMember(batch: CheckBatch, member: BatchMember): void {
  const index = batch.members.findIndex(
    (item) => item.memberKey === member.memberKey,
  )
  if (index >= 0) {
    batch.members[index] = member
  } else {
    batch.members.push(member)
  }
}

function refreshCursor(batch: CheckBatch): void {
  if (batch.state === 'completed') {
    batch.cursor = batch.members.length
    return
  }
  const firstOpen = batch.members.findIndex(
    (member) => !isMemberDone(member) && member.state !== 'skipped',
  )
  batch.cursor = firstOpen < 0 ? batch.members.length : firstOpen
}

// ---- 行数据与台账对账：批次归属、结论状态全部以台账为准回写 ----------------------

function reconcileRows(ledger: LedgerState): EntryRow[] {
  const rows = listRows(MODULE_KEY)
  const byRow = new Map<number, { batch: CheckBatch; member: BatchMember }>()
  for (const batch of ledger.batches) {
    for (const member of batch.members) {
      byRow.set(member.rowId, { batch, member })
    }
  }
  const next = rows.map((row) => {
    const hit = byRow.get(Number(row.id))
    if (!hit) {
      return row
    }
    const { batch, member } = hit
    const updated: EntryRow = { ...row }
    if (member.state === 'pass' || member.state === 'retest') {
      const status = statusForVerdict(member.verdict ?? 'pass')
      updated.status = status
      updated[PROFILE_FIELDS.status] = status
      updated.pending = false
      updated.abnormal = member.verdict === 'retest'
      updated[PROFILE_FIELDS.batchNo] = member.verdictBatchNo ?? batch.batchNo
      updated[PROFILE_FIELDS.batchVerdict] =
        member.verdict === 'pass' ? '合格' : '需重测'
    } else if (member.state === 'reused') {
      const status = statusForVerdict(member.verdict ?? 'pass')
      updated.status = status
      updated[PROFILE_FIELDS.status] = status
      updated.pending = false
      updated.abnormal = member.verdict === 'retest'
      updated[PROFILE_FIELDS.batchNo] = member.verdictBatchNo ?? ''
      updated[PROFILE_FIELDS.batchVerdict] =
        member.verdict === 'pass' ? '合格' : '需重测'
    } else if (member.state === 'skipped') {
      updated.status = '待校核'
      updated[PROFILE_FIELDS.status] = '待校核'
      updated.pending = true
      updated.abnormal = false
    } else {
      // claimed / failed：在途
      updated.status = '待校核'
      updated[PROFILE_FIELDS.status] = '待校核'
      updated.pending = true
      updated.abnormal = member.state === 'failed'
      updated[PROFILE_FIELDS.batchNo] = batch.batchNo
      delete updated[PROFILE_FIELDS.batchVerdict]
    }
    if (member.remeasureOf) {
      updated[PROFILE_FIELDS.remeasureOf] = member.remeasureOf
    }
    return updated
  })
  saveRows(MODULE_KEY, next)
  return next
}

// ---- 批次生命周期：建批、占用收敛、逐成员处理、断点续核 ------------------------

interface Snapshot {
  ledger: LedgerState
  rows: EntryRow[]
}

function snapshot(): Snapshot {
  return { ledger: readLedger(), rows: listRows(MODULE_KEY) }
}

function makeBatch(
  ledger: LedgerState,
  source: CheckBatch['source'],
): CheckBatch {
  const batch: CheckBatch = {
    id: `batch:${ledger.batchSeq + 1}:${Date.now()}`,
    batchNo: nextBatchNo(ledger),
    source,
    state: 'open',
    createdAt: nowText(),
    cursor: 0,
    members: [],
  }
  ledger.batches.push(batch)
  return batch
}

/** 把一条记录纳入批次：有赢家则复用、被在途批次占用则跳过、否则占用。
 * 重测派生的新记录（id 大于旧结论对应记录）是续核，不被旧结论复用挡住。 */
function admit(batch: CheckBatch, ledger: LedgerState, row: EntryRow): BatchMember {
  const key = profileKeyOf(row)
  const existing = batch.members.find((member) => member.rowId === Number(row.id))
  if (existing) {
    return existing
  }
  const winner = findWinner(ledger, key)
  const isFreshRemeasure =
    isRemeasureRecord(row) && winner ? Number(row.id) > winner.member.rowId : false
  if (winner && !isFreshRemeasure) {
    const member: BatchMember = {
      memberKey: memberKey(batch.id, key, Number(row.id)),
      profileKey: key,
      rowId: Number(row.id),
      recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
      state: 'reused',
      verdict: winner.member.verdict,
      verdictBatchNo: winner.batch.batchNo,
      conclusionId: winner.member.conclusionId,
      at: nowText(),
    }
    attachMember(batch, member)
    return member
  }
  const claim = findClaim(ledger, key, batch.id)
  const state: MemberState = claim ? 'skipped' : 'claimed'
  const member: BatchMember = {
    memberKey: memberKey(batch.id, key, Number(row.id)),
    profileKey: key,
    rowId: Number(row.id),
    recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
    state,
  }
  attachMember(batch, member)
  return member
}

/** 单次校核 · 提交校核：把一条已测量记录送入新的单次批次（被占用/有结论则拒绝）。 */
export function submitSingle(rowId: number): ServiceResult<{ batchNo: string }> {
  return singleMutation(rowId, 'single', 'submit', () => {
    const { ledger, rows } = snapshot()
    const row = rows.find((item) => Number(item.id) === rowId)
    if (!row) {
      return { ok: false, message: `没有找到编号为 ${rowId} 的断面测量记录` }
    }
    const key = profileKeyOf(row)
    const winner = findWinner(ledger, key)
    const freshRemeasure =
      isRemeasureRecord(row) && winner ? Number(row.id) > winner.member.rowId : false
    if (winner && !freshRemeasure) {
      return {
        ok: false,
        message: '该断面当日已有校核结论，请直接复用，不能重复送校核',
      }
    }
    const claim = findClaim(ledger, key)
    if (claim && !freshRemeasure) {
      return {
        ok: false,
        message: `该断面当日已被批次 ${claim.batch.batchNo} 占用，等待其完成后自动复用结果`,
      }
    }
    const batch = makeBatch(ledger, 'single')
    admit(batch, ledger, row)
    refreshCursor(batch)
    commit(ledger)
    return {
      ok: true,
      message: `已提交校核，占用批次 ${batch.batchNo}`,
      data: { batchNo: batch.batchNo },
    }
  })
}

/** 批量校核 · 建批：把待校核池中的记录收敛进一个批次；
 * 已被在途批次占用的记为 skipped（赢家落定后自动复用），其余占用或复用。 */
export function openCheckBatch(rowIds?: number[]): ServiceResult<CheckBatch> {
  return singleMutation(undefined, 'batch', 'submit', () => {
    const { ledger, rows } = snapshot()
    const pool = rows.filter((row) => {
      if (row.status !== '待校核') {
        return false
      }
      return !rowIds || rowIds.includes(Number(row.id))
    })
    if (!pool.length) {
      return { ok: false, message: '没有可纳入批量校核的待校核记录' }
    }
    const batch = makeBatch(ledger, 'batch')
    let skipped = 0
    for (const row of pool) {
      const member = admit(batch, ledger, row)
      if (member.state === 'skipped') {
        skipped += 1
      }
    }
    const actionable = batch.members.filter(
      (member) => member.state !== 'skipped' && member.state !== 'reused',
    )
    if (!actionable.length && !batch.members.some((m) => m.state === 'reused')) {
      // 全被在途批次占用：撤销空批次
      ledger.batches = ledger.batches.filter((item) => item.id !== batch.id)
      ledger.batchSeq -= 1
      return {
        ok: false,
        message: `选中的 ${skipped} 条记录均被其它在途批次占用，本批次无可处理项`,
      }
    }
    refreshCursor(batch)
    commit(ledger)
    return {
      ok: true,
      message:
        `批次 ${batch.batchNo} 已建立，纳入 ${batch.members.length} 条` +
        (skipped ? `；${skipped} 条被在途批次占用已跳过` : ''),
      data: batch,
    }
  })
}

/** 单次/批量共用：对某批次的下一个未完成成员给出结论。 */
export function conclude(
  batchId: string,
  verdict: CheckVerdict,
  rowId?: number,
): ServiceResult {
  return singleMutation(rowId, 'batch', 'pass', () => {
    const { ledger } = snapshot()
    const batch = ledger.batches.find((item) => item.id === batchId)
    if (!batch) {
      return { ok: false, message: '校核批次不存在' }
    }
    if (batch.state === 'completed') {
      return { ok: false, message: `批次 ${batch.batchNo} 已完成，结论不可更改` }
    }
    const isOpen = (item: BatchMember) =>
      item.state === 'claimed' || item.state === 'failed'
    // 只能处理批次游标处（含失败断点）的成员；skipped/reused/已终态一律不受理。
    const cursorMember = batch.members[batch.cursor]
    let member: BatchMember | undefined
    if (cursorMember && isOpen(cursorMember)) {
      member = cursorMember
    } else {
      member = batch.members.find(isOpen)
    }
    if (!member) {
      return { ok: false, message: '批次内没有可处理的成员' }
    }
    if (rowId !== undefined && member.rowId !== rowId) {
      // 指定记录不是当前可处理成员：它要么被别的批次占用，要么不在游标处。
      const target = batch.members.find((item) => item.rowId === rowId)
      if (target && target.state === 'skipped') {
        return {
          ok: false,
          message: '该记录被其它在途批次占用，本批次只能在结论落定后复用',
        }
      }
      if (target && target.state === 'reused') {
        return { ok: false, message: '该记录已复用赢家结论，无需再处理' }
      }
      return { ok: false, message: '该记录当前不在可处理位置，请等待批次处理到该处' }
    }
    applyVerdict(ledger, batch, member, verdict)
    commit(ledger)
    return {
      ok: true,
      message:
        verdict === 'pass'
          ? `批次 ${batch.batchNo}：${member.recordNo} 校核合格`
          : `批次 ${batch.batchNo}：${member.recordNo} 需重测，已派生重测记录`,
    }
  })
}

/** 标记某成员处理失败：批次停在该处，已完成结论保留，之后可续核。 */
export function failMember(batchId: string, rowId: number, reason: string): ServiceResult {
  const { ledger } = snapshot()
  const batch = ledger.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: '校核批次不存在' }
  }
  const member = batch.members.find((item) => item.rowId === rowId)
  if (!member || isMemberDone(member) || member.state === 'skipped' || member.state === 'reused') {
    return { ok: false, message: '该成员已结束，不能标记失败' }
  }
  member.state = 'failed'
  member.failReason = reason || '校核处理中断'
  batch.state = 'failed'
  refreshCursor(batch)
  commit(ledger)
  return {
    ok: true,
    message: `批次 ${batch.batchNo} 在 ${member.recordNo} 处中断，可从未完成处继续`,
  }
}

/** 批次推进：在途批次从游标处处理下一个未完成成员；失败批次即从断点继续。 */
export function resumeBatch(
  batchId: string,
  verdict: CheckVerdict,
): ServiceResult {
  const { ledger } = snapshot()
  const batch = ledger.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: '校核批次不存在' }
  }
  if (batch.state === 'completed') {
    return { ok: false, message: `批次 ${batch.batchNo} 已完成，无需续核` }
  }
  const isOpen = (member: BatchMember) =>
    member.state === 'failed' || member.state === 'claimed'
  const member =
    batch.members[batch.cursor] && isOpen(batch.members[batch.cursor])
      ? batch.members[batch.cursor]
      : batch.members.find(isOpen)
  if (!member) {
    return { ok: false, message: '批次内没有待处理成员' }
  }
  const fromBreak = member.state === 'failed'
  applyVerdict(ledger, batch, member, verdict)
  commit(ledger)
  return {
    ok: true,
    message:
      verdict === 'pass'
        ? `批次 ${batch.batchNo}${fromBreak ? ' 已从断点续核' : ''}，${member.recordNo} 合格`
        : `批次 ${batch.batchNo}${fromBreak ? ' 已从断点续核' : ''}，${member.recordNo} 需重测`,
  }
}

function applyVerdict(
  ledger: LedgerState,
  batch: CheckBatch,
  member: BatchMember,
  verdict: CheckVerdict,
): void {
  const at = nowText()
  member.state = verdict === 'pass' ? 'pass' : 'retest'
  member.verdict = verdict
  member.verdictBatchNo = batch.batchNo
  member.conclusionId = `${batch.id}#${member.rowId}#${at}`
  member.at = at
  delete member.failReason

  if (verdict === 'retest') {
    spawnRemeasure(ledger, member)
  }

  // 先落定本批次的完成状态（单一完成标记），再以刚落定的结论为赢家收敛竞争批次。
  const openMember = batch.members.find(
    (item) => !isMemberDone(item) && item.state !== 'skipped',
  )
  if (!openMember) {
    batch.state = 'completed'
    batch.finishedAt = at
  } else if (batch.state === 'failed') {
    batch.state = 'open'
  }
  refreshCursor(batch)

  // 收敛：本批次成为赢家后，其它在途批次里同标的的占用/跳过全部复用本结论，
  // 同日期批次竞争只保留一个完成标记。
  converge(ledger, member.profileKey, { batch, member })
}

/** 收敛同标的竞争：赢家一旦落定，后来批次只能复用，不允许再占用/重算。
 * directWinner 是本次刚落定的结论（批次可能此刻才完成，findWinner 尚未纳入）。 */
function converge(
  ledger: LedgerState,
  profileKey: string,
  directWinner?: { batch: CheckBatch; member: BatchMember },
): void {
  const stored = findWinner(ledger, profileKey)
  const winner =
    directWinner &&
    (directWinner.member.state === 'pass' || directWinner.member.state === 'retest')
      ? newerWinner(stored, directWinner)
      : stored
  if (!winner) {
    return
  }
  for (const batch of ledger.batches) {
    if (batch.id === winner.batch.id) {
      continue
    }
    for (const member of batch.members) {
      if (member.profileKey !== profileKey) {
        continue
      }
      if (member.state === 'claimed' || member.state === 'failed' || member.state === 'skipped') {
        member.state = 'reused'
        member.verdict = winner.member.verdict
        member.verdictBatchNo = winner.batch.batchNo
        member.conclusionId = winner.member.conclusionId
        member.at = nowText()
        delete member.failReason
      }
    }
    refreshCursor(batch)
    if (
      batch.state !== 'completed' &&
      !batch.members.some((item) => !isMemberDone(item) && item.state !== 'skipped')
    ) {
      batch.state = 'completed'
      batch.finishedAt = nowText()
    }
  }
}

/** 重测：原记录与原批次结论保留，追加一条同断面同日期的重测测量记录。 */
function spawnRemeasure(ledger: LedgerState, member: BatchMember): void {
  const rows = listRows(MODULE_KEY)
  const source = rows.find((row) => Number(row.id) === member.rowId)
  if (!source) {
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const suffix = String(nextId).padStart(2, '0')
  const clone: EntryRow = {
    ...source,
    id: nextId,
    status: '已测量',
    pending: true,
    abnormal: false,
  }
  clone[PROFILE_FIELDS.recordNo] = `${String(source[PROFILE_FIELDS.recordNo] ?? 'R')}-R${suffix}`
  clone[PROFILE_FIELDS.status] = '已测量'
  clone[PROFILE_FIELDS.remeasureOf] = member.rowId
  delete clone[PROFILE_FIELDS.batchNo]
  delete clone[PROFILE_FIELDS.batchVerdict]
  saveRows(MODULE_KEY, [...rows, clone])
  member.remeasureOf = nextId
}

// ---- 统一闸口包装：三个入口都先过 rules.ts 的判定 -----------------------------

function singleMutation<T>(
  rowId: number | undefined,
  gate: CheckGate,
  _intent: CheckVerdict | 'submit',
  fn: () => ServiceResult<T>,
): ServiceResult<T> {
  if (rowId !== undefined && gate !== 'batch') {
    const rows = listRows(MODULE_KEY)
    const row = rows.find((item) => Number(item.id) === rowId)
    if (row) {
      const decision = decideGate(gate, String(row.status))
      if (!decision.allowed) {
        return { ok: false, message: decision.reason }
      }
    }
  }
  return fn()
}

// ---- 查询视图：批次列表、待校核池、导出前置检查、跨模块复用 --------------------

export interface BatchView {
  batch: CheckBatch
  total: number
  done: number
  open: number
  reused: number
  failed: number
  progress: number
}

export function listBatches(): BatchView[] {
  const ledger = readLedger()
  reconcileRows(ledger)
  return [...ledger.batches]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((batch) => {
      const actionable = batch.members.filter(
        (member) => member.state !== 'skipped' && member.state !== 'reused',
      )
      const done = actionable.filter(isMemberDone).length
      const failed = batch.members.filter((member) => member.state === 'failed').length
      const reused = batch.members.filter((member) => member.state === 'reused').length
      const open = actionable.filter((member) => !isMemberDone(member)).length
      return {
        batch,
        total: actionable.length,
        done,
        open,
        reused,
        failed,
        progress: actionable.length ? Math.round((done / actionable.length) * 100) : 100,
      }
    })
}

export function pendingPool(): EntryRow[] {
  const ledger = readLedger()
  reconcileRows(ledger)
  return listRows(MODULE_KEY).filter((row) => row.status === '待校核')
}

/** 导出前置检查：只放行「已校核 + 批次归属可溯源 + 生效结论合格」的记录；
 * 已被后续重测取代的旧记录不再阻断，但仍保留原结论可溯源。 */
export function preflightExport(): { ok: boolean; blockers: ExportBlocker[]; total: number } {
  const ledger = readLedger()
  reconcileRows(ledger)
  const rows = listRows(MODULE_KEY)
  const blockers: ExportBlocker[] = []
  for (const row of rows) {
    const batchNo = String(row[PROFILE_FIELDS.batchNo] ?? '')
    const winner = findWinner(ledger, profileKeyOf(row))
    const supersededByPass =
      winner &&
      winner.member.verdict === 'pass' &&
      Number(winner.member.rowId) !== Number(row.id)
    // 已被后续重测合格取代的旧记录：保留原结论可溯源，但不再阻断导出。
    if (supersededByPass) {
      continue
    }
    let reason = exportBlockReason(String(row.status), batchNo)
    if (!reason && row[PROFILE_FIELDS.batchVerdict] === '需重测') {
      reason = '记录结论为需重测，完成重测校核前不得导出'
    }
    if (reason) {
      blockers.push({
        rowId: Number(row.id),
        recordNo: String(row[PROFILE_FIELDS.recordNo] ?? row.id),
        status: String(row.status),
        reason,
      })
    }
  }
  return { ok: blockers.length === 0, blockers, total: rows.length }
}

/** 复用同一批次结论：按水位记录的站点 + 日期匹配断面校核结论。 */
export function getVerdictForStationDate(
  station: string,
  date: string,
): CompilationTodo {
  const ledger = readLedger()
  reconcileRows(ledger)
  const day = String(date).slice(0, 10)
  const rows = listRows(MODULE_KEY).filter(
    (row) =>
      String(row[PROFILE_FIELDS.station] ?? '').trim() === station.trim() &&
      String(row[PROFILE_FIELDS.date] ?? '').slice(0, 10) === day,
  )
  if (!rows.length) {
    return {
      recordNo: '—',
      station,
      date: day,
      section: '—',
      state: 'none',
      message: '当日无断面校核记录',
    }
  }
  const keys = Array.from(new Set(rows.map((row) => profileKeyOf(row))))
  for (const key of keys) {
    const winner = findWinner(ledger, key)
    const claim = findClaim(ledger, key)
    const sample = rows.find((row) => profileKeyOf(row) === key)!
    if (winner) {
      if (winner.member.verdict === 'retest') {
        return {
          recordNo: winner.member.recordNo,
          station,
          date: day,
          section: String(sample[PROFILE_FIELDS.section] ?? ''),
          state: 'retest',
          verdict: 'retest',
          batchNo: winner.batch.batchNo,
          message: `批次 ${winner.batch.batchNo} 结论为需重测，重测校核通过前不得整编`,
        }
      }
      return {
        recordNo: winner.member.recordNo,
        station,
        date: day,
        section: String(sample[PROFILE_FIELDS.section] ?? ''),
        state: 'ready',
        verdict: 'pass',
        batchNo: winner.batch.batchNo,
        message: `复用断面校核批次 ${winner.batch.batchNo} 的合格结论，可整编`,
      }
    }
    if (claim) {
      return {
        recordNo: claim.member.recordNo,
        station,
        date: day,
        section: String(sample[PROFILE_FIELDS.section] ?? ''),
        state: 'open',
        batchNo: claim.batch.batchNo,
        message: `断面校核批次 ${claim.batch.batchNo} 尚未完成，待结论落定`,
      }
    }
  }
  const first = rows[0]
  return {
    recordNo: String(first[PROFILE_FIELDS.recordNo] ?? '—'),
    station,
    date: day,
    section: String(first[PROFILE_FIELDS.section] ?? '—'),
    state: 'open',
    message: '断面测量尚未提交校核',
  }
}

/** 水位整编待办：水位记录逐条挂接同日同站的断面校核结论。 */
export function waterlevelCompilationTodos(): CompilationTodo[] {
  const rows = listRows('waterlevel')
  return rows.map((row) => {
    const station = String(row['站点编号'] ?? '').trim()
    const date = String(row['观测时间'] ?? '').slice(0, 10)
    const todo = getVerdictForStationDate(station, date)
    return {
      ...todo,
      recordNo: String(row['记录编号'] ?? row.id),
    }
  })
}

/** 确保台账已基于存量数据完成回填，并把批次归属回写到测量记录。 */
export function ensureLedger(): LedgerState {
  const ledger = readLedger()
  reconcileRows(ledger)
  return ledger
}

/** 重置断面模块时同步清空台账，下一次读取会基于种子数据重新回填。 */
export function resetLedger(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(LEDGER_KEY)
  }
  ensureLedger()
}

export { PROFILE_FIELDS, PROFILE_STATUSES }
