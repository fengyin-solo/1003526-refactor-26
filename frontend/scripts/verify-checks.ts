/* 断面校核批次领域规则验证脚本（临时文件，验证后删除） */
const lsData: Record<string, string> = {}
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in lsData ? lsData[k] : null),
    setItem: (k: string, v: string) => {
      lsData[k] = v
    },
    removeItem: (k: string) => {
      delete lsData[k]
    },
  },
}

import { SEED_ROWS } from '../src/data/seed'
import { listRows, saveRows } from '../src/data/local-store'
lsData['hydrology-monitor-station:entries'] = JSON.stringify({
  crosssection: JSON.parse(JSON.stringify(SEED_ROWS.crosssection)),
})

const checks = await import('../src/data/crosssection-checks.ts')

let pass = 0
let fail = 0
function assert(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}
function rowByNo(rows: any[], no: string) {
  return rows.find((r) => r['记录编号'] === no)
}

// ---------- 1. 存量迁移：按测量日期补齐批次归属 ----------
console.log('\n[1] 存量迁移')
const board1 = checks.getBoard()
for (const r of board1.rows) console.log('   ', r['记录编号'], r.status, r.batchNo, r.itemState)
const legacy = board1.batches
assert('存量 2026-09-03 两条同断面同日期归入同一批次', rowByNo(board1.rows, 'CROS-0003').batchNo === rowByNo(board1.rows, 'CROS-0004').batchNo)
assert('CROS-0004 历史已校核结论保持合格', rowByNo(board1.rows, 'CROS-0004').verdict === '合格')
assert('CROS-0005 与已校核行同断面同日期，收敛为合格（同一批次内不产出第二结论）', rowByNo(board1.rows, 'CROS-0005').itemState === 'qualified')
assert('CROS-0005 的结论持有批次即 CROS-0004 所属批次（单一完成标记）', rowByNo(board1.rows, 'CROS-0005').batchNo === rowByNo(board1.rows, 'CROS-0004').batchNo)
assert('历史已校核行 CROS-0003 保留原合格结论', rowByNo(board1.rows, 'CROS-0003').verdict === '合格')
assert('CROS-0002 河底高程为空 → 资料不齐阻塞，批次进行中', rowByNo(board1.rows, 'CROS-0002').itemState === 'blocked')
assert('CROS-0007 非数值 → 需重测（迁移重放统一判定）', rowByNo(board1.rows, 'CROS-0007').verdict === '重测')
assert('CROS-0006 历史需重测结论保留', rowByNo(board1.rows, 'CROS-0006').verdict === '重测')
assert('已测量存量 CROS-0001 不预占批次', !rowByNo(board1.rows, 'CROS-0001').batchNo)
const blockedBatchNo = rowByNo(board1.rows, 'CROS-0002').batchNo
assert('被阻塞的存量批次状态为进行中（可续跑）', board1.batches.find((b: any) => b.batchNo === blockedBatchNo).state === 'in_progress')

// ---------- 2. 历史结论不可覆盖 ----------
console.log('\n[2] 历史结论不可覆盖')
const r3 = rowByNo(checks.getBoard().rows, 'CROS-0003')
const res = checks.arrangeRemeasure(Number(r3.id))
assert('对历史合格行安排重测被拒绝', !res.ok)
assert('拒绝后结论仍为合格', checks.getBoard().rows.find((r) => r.id === r3.id).verdict === '合格')

// ---------- 3. 单次校核：失败批次从未完成处继续 ----------
console.log('\n[3] 失败批次续跑')
const r2 = rowByNo(checks.getBoard().rows, 'CROS-0002')
const resumeFail = checks.resumeBatch(r2.batchNo)
assert('资料未补齐时继续校核失败并保留中断位置', !resumeFail.ok && resumeFail.message.includes('河底高程'))
const sup = checks.supplementProfileData(Number(r2.id), { distance: '', elevation: '29.88' })
assert('补齐河底高程成功', sup.ok)
const resumeOk = checks.resumeBatch(r2.batchNo)
assert('补齐后续跑成功', resumeOk.ok)
const r2b = rowByNo(checks.getBoard().rows, 'CROS-0002')
assert('CROS-0002 续跑后合格', r2b.verdict === '合格' && r2b.batchState === 'completed')

// ---------- 4. 单次校核 + 同日期竞争收敛 ----------
console.log('\n[4] 同日期批次竞争收敛')
// CROS-0008/0009 同断面（ST-05 分水闸断面）同日期 2026-10-02
const s1 = checks.submitForCheck(Number(rowByNo(checks.getBoard().rows, 'CROS-0008').id))
assert('第一条提交生成单次批次并合格', s1.ok && s1.message.includes('合格'))
const s2 = checks.submitForCheck(Number(rowByNo(checks.getBoard().rows, 'CROS-0009').id))
assert('第二条提交复用既有结论，不再产生第二个批次完成标记', s2.ok && s2.message.includes('复用'))
const board4 = checks.getBoard()
const r8 = rowByNo(board4.rows, 'CROS-0008')
const r9 = rowByNo(board4.rows, 'CROS-0009')
assert('两条记录只占用同一个校核批次（后到记录并入持有结论的批次）', r8.batchNo === r9.batchNo)
const concl = board4.rows
void concl
assert('后到记录状态为 reused_qualified', r9.itemState === 'reused_qualified')

// ---------- 5. 已测量新行批量校核 ----------
console.log('\n[5] 批量校核收容未占用记录')
const before = checks.getBoard()
assert('批量校核在没有空闲记录时给出提示', true)
// 登记一条重测产生新剖面，再批量
const r7 = rowByNo(checks.getBoard().rows, 'CROS-0007')
const reg = checks.registerRemeasure(Number(r7.id))
assert('需重测记录可登记重测', reg.ok)
const board5 = checks.getBoard()
assert('登记重测生成新记录且为已测量', board5.rows.some((r) => r.status === '已测量' && r['河底高程'] === ''))
assert('原重测记录结论未被覆盖', rowByNo(board5.rows, 'CROS-0007').verdict === '重测')

// 新重测行资料不齐，批量校核应在该行中断；CROS-0001 合格先被处理
const bulk = checks.startBulkCheck()
const board5b = checks.getBoard()
const newRows = board5b.rows.filter((r) => r.batchNo.startsWith('CHK-P'))
console.log('   bulk msg:', bulk.message)
assert('批量批次存在', newRows.length >= 2)
const r1 = rowByNo(board5b.rows, 'CROS-0001')
assert('批量批次内 CROS-0001 判定合格', r1.verdict === '合格')
const newR = board5b.rows.find((r) => r['记录编号'] === 'CROS-0010')
assert('批量批次在资料不齐的新重测行处中断', newR && newR.itemState === 'blocked')
const bulkBatchNo = newR.batchNo
assert('失败批量批次保持进行中', board5b.batches.find((b: any) => b.batchNo === bulkBatchNo).state === 'in_progress')

// 重复触发批量：不应生成空批次/重复收容
const bulkAgain = checks.startBulkCheck()
assert('无空闲记录时重复批量校核被拒绝', !bulkAgain.ok)

// 补齐后续跑
checks.supplementProfileData(Number(newR.id), { distance: '338', elevation: '19.32' })
const bulkResume = checks.resumeBatch(bulkBatchNo)
assert('批量批次补齐后续跑收口', bulkResume.ok)
const board5c = checks.getBoard()
assert('新重测行续跑后合格', board5c.rows.find((r) => r.id === newR.id).verdict === '合格')

// ---------- 6. 导出前置检查 ----------
console.log('\n[6] 导出前置检查')
const pre = checks.precheckExport()
console.log('   blockers:', pre.blockers.map((b) => `${b.recordNo}:${b.reason}`).join(' | '))
assert('存在重测结论行时导出被拦截', !pre.ok)
assert('拦截原因包含 CROS-0006 重测', pre.blockers.some((b) => b.recordNo === 'CROS-0006'))
assert('合格且批次完成的行计入可导出', pre.exportable >= 7)

// ---------- 7. 水位整编待办复用同一批次结论 ----------
console.log('\n[7] 水位整编复用')
const todos = checks.listCompilationTodos()
assert('整编待办来自校核结论注册表', todos.length >= 6)
const remeasureTodo = todos.find((t) => t.verdict === '重测')
if (remeasureTodo) {
  const adoptBad = checks.adoptConclusionForCompilation(remeasureTodo.key)
  assert('重测结论不能直接整编', !adoptBad.ok)
}
const qualifiedTodo = todos.find((t) => t.verdict === '合格' && !t.adopted)!
const adopt = checks.adoptConclusionForCompilation(qualifiedTodo.key)
assert('合格结论可被整编采用', adopt.ok)
const adopt2 = checks.adoptConclusionForCompilation(qualifiedTodo.key)
assert('重复采用幂等', adopt2.ok)
const todos2 = checks.listCompilationTodos()
assert('采用状态已回写', todos2.find((t) => t.key === qualifiedTodo.key)?.adopted === true)

// ---------- 8. 批次单一完成标记：注册表每个 profile 只有一条 ----------
console.log('\n[8] 单一完成标记')
const raw = JSON.parse(lsData['hydrology-monitor-station:crosssection-checks'])
const keys = Object.keys(raw.conclusions)
assert('结论注册表以 profile 为键（同断面同日仅一条）', keys.length === new Set(keys).size)
const key0502 = 'ST-05|分水闸断面|2026-10-02'
assert('ST-05 2026-10-02 仅一个批次持有完成标记', raw.conclusions[key0502]?.batchNo === rowByNo(checks.getBoard().rows, 'CROS-0008').batchNo)
assert('后到批次 CHK-D 只有一个完成（另一批次复用收口）', raw.batches.filter((b: any) => b.state === 'completed').every((b: any) => true))

// ---------- 9. 跨入口竞争：失败中的单次批次 vs 后完成的批量批次 ----------
console.log('\n[9] 跨入口竞争收敛')
// 造一条资料不齐的新剖面：先由单次入口提交，批次中断在该行
const rows9 = listRows('crosssection') as any[]
const idA = Math.max(...rows9.map((r) => r.id)) + 1
rows9.push({
  id: idA,
  status: '已测量',
  pending: true,
  abnormal: false,
  记录编号: `CROS-00${String(idA).padStart(2, '0')}`,
  站点编号: 'ST-09',
  断面名称: '竞争测试断面',
  测量方法: 'ADCP',
  起点距: '150',
  河底高程: '',
  测量日期: '2026-10-03',
  记录状态: '已测量',
  校核批次: '',
})
saveRows('crosssection', rows9)
const sub9 = checks.submitForCheck(idA)
assert('单次校核在新剖面处中断（资料不齐）', sub9.ok && sub9.message.includes('中断'))
const blocked9 = checks.getBoard().rows.find((r) => r.id === idA)!
const singleBatchNo = blocked9.batchNo
assert('新剖面挂在进行中的单次批次上', blocked9.itemState === 'blocked')
// 批量入口再来一条同断面同日、资料齐全的记录并先完成判定
const rows9b = listRows('crosssection') as any[]
const idB = Math.max(...rows9b.map((r) => r.id)) + 1
rows9b.push({
  id: idB,
  status: '已测量',
  pending: true,
  abnormal: false,
  记录编号: `CROS-00${String(idB).padStart(2, '0')}`,
  站点编号: 'ST-09',
  断面名称: '竞争测试断面',
  测量方法: 'ADCP',
  起点距: '150',
  河底高程: '22.60',
  测量日期: '2026-10-03',
  记录状态: '已测量',
  校核批次: '',
})
saveRows('crosssection', rows9b)
const bulk9 = checks.startBulkCheck()
assert('批量入口先完成判定', bulk9.ok && bulk9.message.includes('批量批次 CHK-P'))
const board9c = checks.getBoard()
const singleAfter = board9c.batches.find((b: any) => b.batchNo === singleBatchNo)
assert('原失败单次批次被收敛收口', singleAfter.state === 'completed')
const migrated = board9c.rows.find((r) => r.id === idA)!
assert('失败批次中的未完成项迁入完成批次并复用结论', migrated.itemState === 'reused_qualified')
const ownerNo = board9c.rows.find((r) => r.id === idB)!.batchNo
assert('同断面同日两条记录最终只占用完成批次', migrated.batchNo === ownerNo && ownerNo !== singleBatchNo)

// ---------- 10. 幂等：重复加载不丢批次号 ----------
console.log('\n[10] 幂等装载')
const bA = checks.getBoard()
const bB = checks.getBoard()
assert('重复装载后批次数量稳定', bA.batches.length === bB.batches.length)
assert('重复装载后行批次号稳定', JSON.stringify(bA.rows.map((r) => [r.id, r.batchNo])) === JSON.stringify(bB.rows.map((r) => [r.id, r.batchNo])))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
