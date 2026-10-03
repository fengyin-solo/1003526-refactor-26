/**
 * 断面校核批次领域模型。
 *
 * 设计要点（对应重构约束）：
 * - 同一断面（站点 + 断面名称）同一测量日期为一个「校核标的」profileKey，全系统唯一；
 * - 一个 profileKey 同一时刻只允许被一个校核批次「占用（claimed）」，其它批次只能「复用（reused）」结果；
 * - 校核结论只追加（append-only），重测产生新测量记录与新结论，绝不覆盖原结论、不丢原批次号；
 * - 批次逐条推进，失败成员可从未完成处继续，已完成/复用成员不重跑；
 * - 水位整编等其它模块通过 profileKey 复用同一份结论，不另建判定。
 */

/** 校核结论：合格 / 需重测。 */
export type CheckVerdict = 'pass' | 'retest'

/** 剖面测量记录状态。 */
export type ProfileStatus = '已测量' | '待校核' | '已校核' | '需重测'

/** 校核入口：单次校核、批量校核、导出前置检查共用同一套规则。 */
export type CheckGate = 'single' | 'batch' | 'export'

/** 校核动作意图，规则表只认这三种，入口差异由 gate 表达。 */
export type CheckIntent = 'submit' | 'pass' | 'retest'

/** 批次成员在某一批次内的处理状态。 */
export type MemberState =
  | 'claimed' // 已被本批次占用，尚未处理
  | 'pass' // 本批次给出合格结论
  | 'retest' // 本批次给出需重测结论，并已派生重测记录
  | 'reused' // 同标的已有完成结论，本批次直接复用，不再处理
  | 'failed' // 本批次处理失败，可从此处继续
  | 'skipped' // 建批时该标的被其它在途批次占用，未进入本批次

/** 批次整体状态。 */
export type BatchState = 'open' | 'completed' | 'failed'

/**
 * 批次成员。memberKey 是「批次 + 剖面」的唯一归属；
 * 同一 profileKey 可以作为 reused 成员出现在后到批次里，
 * 但全系统至多有一个成员对它处于 claimed（占用）。
 */
export interface BatchMember {
  memberKey: string
  profileKey: string
  /** 被占用/复用时对应的测量记录 id。 */
  rowId: number
  recordNo: string
  state: MemberState
  /** 结论来源批次号：reused 时指向赢家批次，本批次完成时与 batchNo 相同。 */
  verdict?: CheckVerdict
  verdictBatchNo?: string
  conclusionId?: string
  /** 处理失败原因（failed 时填写），用于断点续核。 */
  failReason?: string
  /** 结论/复用落定时间。 */
  at?: string
  /** 该成员是否由重测派生的新测量记录。 */
  remeasureOf?: number
}

/** 校核批次。 */
export interface CheckBatch {
  id: string
  batchNo: string
  source: 'single' | 'batch' | 'legacy'
  state: BatchState
  createdAt: string
  finishedAt?: string
  /** 逐成员处理游标：已处理到的下标，失败后续核从这里开始。 */
  cursor: number
  members: BatchMember[]
}

/** 单条结论视图（由批次台账重建，原始数据不冗余存放）。 */
export interface ConclusionView {
  profileKey: string
  verdict: CheckVerdict
  batchNo: string
  source: CheckBatch['source']
  rowId: number
  recordNo: number | string
  at: string
  conclusionId: string
}

/** 导出前置检查的单行结果。 */
export interface ExportBlocker {
  rowId: number
  recordNo: string
  status: string
  reason: string
}

/** 挂在断面测量记录上的批次归属字段（由台账回填，不允许页面直接改）。 */
export interface BatchAttribution {
  校核批次?: string
  批次结论?: '合格' | '需重测'
  重测来源?: number
}
