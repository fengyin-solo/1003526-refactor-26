import type {
  BatchMember,
  CheckGate,
  CheckIntent,
  CheckVerdict,
  ProfileStatus,
} from './types'

/**
 * 断面校核的唯一判定来源。
 * 单次校核、批量校核、导出前置检查三处入口都只能调用这里的规则，
 * 不允许任何页面/接口再各自维护一套状态流转。
 */

/** 测量记录字段名（与 modules.ts 中 crosssection 的字段保持一致）。 */
export const PROFILE_FIELDS = {
  recordNo: '记录编号',
  station: '站点编号',
  section: '断面名称',
  method: '测量方法',
  distance: '起点距',
  elevation: '河底高程',
  date: '测量日期',
  status: '记录状态',
  batchNo: '校核批次',
  batchVerdict: '批次结论',
  remeasureOf: '重测来源',
} as const

export const PROFILE_STATUSES: ProfileStatus[] = ['已测量', '待校核', '已校核', '需重测']

/** 每个校核入口在不同剖面状态下允许提交的意图；undefined 表示该入口拒绝受理。 */
const GATE_MATRIX: Record<CheckGate, Partial<Record<ProfileStatus, CheckIntent>>> = {
  // 单次校核：可把未提交的原始/重测记录送入校核池，也可对在途记录出结论。
  single: {
    已测量: 'submit',
    待校核: 'pass',
    已校核: undefined,
    需重测: undefined,
  },
  // 批量校核：只处理在待校核池里的记录。
  batch: {
    已测量: undefined,
    待校核: 'pass',
    已校核: undefined,
    需重测: undefined,
  },
  // 导出前置检查：只读判定，不产生任何流转。
  export: {
    已测量: undefined,
    待校核: undefined,
    已校核: 'pass',
    需重测: undefined,
  },
}

export type GateDecision =
  | { allowed: true; intent: CheckIntent }
  | { allowed: false; reason: string }

/** 三个入口的统一闸口：给定入口与剖面状态，判定是否受理及对应意图。 */
export function decideGate(gate: CheckGate, status: string): GateDecision {
  const known = PROFILE_STATUSES.includes(status as ProfileStatus)
  if (!known) {
    return { allowed: false, reason: `记录状态「${status}」不在校核状态机内` }
  }
  const intent = GATE_MATRIX[gate][status as ProfileStatus]
  if (!intent) {
    return { allowed: false, reason: gateReason(gate, status as ProfileStatus) }
  }
  return { allowed: true, intent }
}

function gateReason(gate: CheckGate, status: ProfileStatus): string {
  if (gate === 'export') {
    return status === '已校核'
      ? ''
      : `导出要求记录已校核，当前为「${status}」`
  }
  const map: Partial<Record<ProfileStatus, string>> = {
    已测量: gate === 'single' ? '' : '仅单次校核可提交未校核记录',
    待校核: '',
    已校核: '记录已完成校核，不能重复处理',
    需重测:
      gate === 'single'
        ? '该记录已要求重测，重测由系统派生新测量记录'
        : '批量校核不处理需重测记录',
  }
  return map[status] ?? `当前状态「${status}」不允许该操作`
}

/** 合格/重测结论落到测量记录上的状态。 */
export function statusForVerdict(verdict: CheckVerdict): ProfileStatus {
  return verdict === 'pass' ? '已校核' : '需重测'
}

/** 批次成员是否已终态（不需要再处理）。 */
export function isMemberDone(member: Pick<BatchMember, 'state'>): boolean {
  return (
    member.state === 'pass' ||
    member.state === 'retest' ||
    member.state === 'reused'
  )
}

/** 批次成员是否占用了校核标的（只有 claimed 算占用，失败后仍由本批次持有以便续核）。 */
export function isMemberClaimed(member: Pick<BatchMember, 'state'>): boolean {
  return member.state === 'claimed' || member.state === 'failed'
}

/** 导出前置检查：逐行判定，返回阻断原因（空串表示通过）。 */
export function exportBlockReason(status: string, batchNo?: string): string {
  const decision = decideGate('export', status)
  if (!decision.allowed) {
    return decision.reason
  }
  if (!batchNo) {
    return '记录已校核但缺少校核批次归属，无法溯源'
  }
  return ''
}
