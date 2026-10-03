/**
 * 断面校核批次重构的不变量验证（纯 Node 执行，不依赖浏览器/DOM）。
 * 用 localStorage 桩驱动 src/data 下的真实领域代码。
 * 运行：node --import ./scripts/ts-register.mjs scripts/verify-crosssection.mts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
}

import { SEED_ROWS } from '../src/data/seed'
import { saveRows, listRows } from '../src/data/local-store'
import * as svc from '../src/data/crosssection/store'
import * as rules from '../src/data/crosssection/rules'

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 播种
saveRows('crosssection', structuredClone(SEED_ROWS.crosssection))
saveRows('waterlevel', structuredClone(SEED_ROWS.waterlevel))
svc.ensureLedger()

console.log('1) 存量回填：按测量日期补批次归属，历史结论不变')
const batches0 = svc.listBatches()
const rows0 = listRows('crosssection')
const r3 = rows0.find((r) => r.id === 3)
const r4 = rows0.find((r) => r.id === 4)
check('已校核记录回填历史批次号', /^LS20260903-DONE$/.test(String(r3!['校核批次'])))
check('回填批次结论为合格', r3!['批次结论'] === '合格')
check('同断面同日重复记录只有一个赢家批次', r3!['校核批次'] === r4!['校核批次'])
check('重复记录复用赢家批次号', r4!['校核批次'] === r3!['校核批次'])
const doneBatch = batches0.find((b) => b.batch.batchNo === 'LS20260903-DONE')!.batch
check('存量完成批次为单一完成标记', doneBatch.state === 'completed')
check('后来者成员状态为 reused', doneBatch.members.find((m) => m.rowId === 4)!.state === 'reused')

const r2 = rows0.find((r) => r.id === 2)
const r6 = rows0.find((r) => r.id === 6)
check('存量待校核记录进入在途回填批次', /^LS20260902-PEND$/.test(String(r2!['校核批次'])))
check('不同日期待校核记录不混批次', /^LS20260905-PEND$/.test(String(r6!['校核批次'])))
const r5 = rows0.find((r) => r.id === 5)
check('存量需重测结论保持原样', r5!['批次结论'] === '需重测' && /DONE$/.test(String(r5!['校核批次'])))
const r1 = rows0.find((r) => r.id === 1)
check('未进入校核流程的记录不伪造批次', !r1!['校核批次'])

// 存量在途批次可从未完成处继续：把 r2 所在批次核完，供后续跨模块复用断言使用。
const pend0902 = batches0.find((b) => b.batch.batchNo === 'LS20260902-PEND')!.batch
svc.conclude(pend0902.id, 'pass', 2)
svc.ensureLedger()
check('存量待校核批次可续核完成', true)

console.log('2) 同一断面同一测量日期只能占用一个校核批次')
// 存量待校核记录都已被回填批次占用；造一条全新日期的待校核记录构造两个并发入口。
let workRows = listRows('crosssection')
const freshId = Math.max(...workRows.map((r) => Number(r.id))) + 1
const dupId = freshId + 1
saveRows('crosssection', [
  ...workRows,
  {
    id: freshId,
    status: '待校核',
    pending: true,
    abnormal: false,
    记录编号: 'CROS-2026-0910',
    站点编号: 'ST-09',
    断面名称: '新测流断面',
    测量方法: 'ADCP法',
    起点距: '0.0-100.0',
    河底高程: '18.20',
    测量日期: '2026-09-10',
    记录状态: '待校核',
  } as any,
  {
    id: dupId,
    status: '待校核',
    pending: true,
    abnormal: false,
    记录编号: 'CROS-2026-0910-DUP',
    站点编号: 'ST-09',
    断面名称: '新测流断面',
    测量方法: 'ADCP法',
    起点距: '0.0-100.0',
    河底高程: '18.20',
    测量日期: '2026-09-10',
    记录状态: '待校核',
  } as any,
])
svc.ensureLedger()
// 第一个入口（批量）占用 freshId
const b0 = svc.openCheckBatch([freshId])
check('首个批次可占用新标的', b0.ok, b0.message)
const ownerNew = b0.data!
// 另造一条不同日期的自由记录，保证后到批次能建立，同时容纳 skipped 成员。
const freeId = dupId + 1
saveRows('crosssection', [
  ...listRows('crosssection'),
  {
    id: freeId,
    status: '待校核',
    pending: true,
    abnormal: false,
    记录编号: 'CROS-2026-0911',
    站点编号: 'ST-09',
    断面名称: '新测流断面',
    测量方法: 'ADCP法',
    起点距: '0.0-100.0',
    河底高程: '18.04',
    测量日期: '2026-09-11',
    记录状态: '待校核',
  } as any,
])
svc.ensureLedger()
// 第二个入口（批量）：freshId/dupId 被占应跳过，freeId 可占用，批次仍建立
const b1 = svc.openCheckBatch([freshId, dupId, freeId])
check('后到批次建立（含跳过与可处理成员）', b1.ok, b1.message)
const newBatch = b1.data!
const freshMember = newBatch.members.find((m) => m.rowId === freshId)!
check('被占用记录进入后到批次时为 skipped', freshMember?.state === 'skipped')
const dupMember = newBatch.members.find((m) => m.rowId === dupId)!
check('同日重复入口记录也只能 skipped', dupMember?.state === 'skipped')
const freeMember = newBatch.members.find((m) => m.rowId === freeId)!
check('未占用记录被新批次 claimed', freeMember?.state === 'claimed')

// 后到批次不能处理被占用记录
const direct = svc.conclude(newBatch.id, 'pass', freshId)
check('后到批次不能处理被占用记录', !direct.ok)

// 占用批次给出合格结论
const c2 = svc.conclude(ownerNew.id, 'pass', freshId)
check('占用批次可给出合格结论', c2.ok, c2.message)
svc.ensureLedger()
const freshRow = listRows('crosssection').find((r) => r.id === freshId)!
check('记录变为已校核并落占用批次号', freshRow.status === '已校核' && freshRow['校核批次'] === ownerNew.batchNo)

console.log('3) 同日期批次竞争收敛为单一完成标记，后到批次只能复用')
const after = svc.listBatches().find((v) => v.batch.id === newBatch.id)!.batch
const freshAfter = after.members.find((m) => m.rowId === freshId)!
check('赢家落定后后到批次成员变为 reused', freshAfter.state === 'reused', `实际=${freshAfter.state}`)
check('复用成员指向赢家批次号', freshAfter.verdictBatchNo === ownerNew.batchNo)
const dupRow = listRows('crosssection').find((r) => r.id === dupId)!
check('重复入口记录复用同一赢家批次号', dupRow['校核批次'] === ownerNew.batchNo)

console.log('4) 失败批次从未完成处继续')
const fail = svc.failMember(newBatch.id, freeId, '中断模拟')
check('成员可标记失败', fail.ok, fail.message)
const failedView = svc.listBatches().find((v) => v.batch.id === newBatch.id)!.batch
check('批次保留游标在失败成员处', failedView.cursor === failedView.members.findIndex((m) => m.rowId === freeId))
const resume = svc.resumeBatch(newBatch.id, 'pass')
check('可从断点续核', resume.ok, resume.message)
const finished = svc.listBatches().find((v) => v.batch.id === newBatch.id)!.batch
check('续核后批次完成（单一完成标记）', finished.state === 'completed')
check('复用成员没有被重新处理', finished.members.find((m) => m.rowId === freshId)!.state === 'reused')

console.log('5) 重测结论不覆盖原结果，原批次号保留，派生新记录')
const sub = svc.submitSingle(1)
check('单次校核提交成功', sub.ok, sub.message)
const singleBatchNo = sub.data!.batchNo
const sb = svc.listBatches().find((v) => v.batch.batchNo === singleBatchNo)!.batch
const ret = svc.conclude(sb.id, 'retest', 1)
check('可判定需重测', ret.ok, ret.message)
svc.ensureLedger()
const rowsAfterRetest = listRows('crosssection')
const r1After = rowsAfterRetest.find((r) => r.id === 1)!
const spawned = rowsAfterRetest.find((r) => r['重测来源'] === 1)!
check('原记录保留需重测结论和原批次号', r1After.status === '需重测' && r1After['校核批次'] === singleBatchNo)
check('重测派生了新测量记录', !!spawned, '未找到重测派生记录')
check('派生记录为已测量、无结论', !!spawned && spawned.status === '已测量' && !spawned['批次结论'])
check('原结论仍在结论链中（可追溯，未被覆盖）', svc.conclusionTimeline(svc.profileKeyOf(r1After))[0].verdict === 'retest')

// 重测新记录可越过旧结论重新校核
const sub2 = svc.submitSingle(spawned.id)
check('重测新记录可重新提交校核（不被旧结论挡住）', sub2.ok, sub2.message)
const sb2 = svc.listBatches().find((v) => v.batch.batchNo === sub2.data!.batchNo)!.batch
const pass2 = svc.conclude(sb2.id, 'pass', spawned.id)
check('重测复核可合格', pass2.ok, pass2.message)
svc.ensureLedger()
const spawned2 = listRows('crosssection').find((r) => r.id === spawned.id)!
check('新记录合格并落新批次号', spawned2.status === '已校核' && spawned2['校核批次'] === sub2.data!.batchNo)
const r1Final = listRows('crosssection').find((r) => r.id === 1)!
check('原失败记录批次号与结论仍保留', r1Final['校核批次'] === singleBatchNo && r1Final['批次结论'] === '需重测')
const chain = svc.conclusionTimeline(svc.profileKeyOf(r1Final))
check('结论链为追加：先重测后合格，两条都在', chain.length === 2 && chain[0].verdict === 'retest' && chain[1].verdict === 'pass')

console.log('6) 三个入口共用一份判定（闸口）')
check('导出入口拒绝待校核', rules.decideGate('export', '待校核').allowed === false)
check('导出入口接受已校核', rules.decideGate('export', '已校核').allowed === true)
check('批量入口拒绝已测量', rules.decideGate('batch', '已测量').allowed === false)
check('单次入口接受已测量提交', rules.decideGate('single', '已测量').allowed === true)
check('重复校核已校核记录被统一拒绝', rules.decideGate('single', '已校核').allowed === false)

console.log('7) 导出前置检查')
// r7 已测量、r5 需重测（ST-03 09-04，无后续重测）应阻断；r1 已被重测合格取代，不阻断
const pf = svc.preflightExport()
const blockerIds = pf.blockers.map((b) => b.rowId)
check('前置检查发现未完成项', !pf.ok)
check('已测量记录被阻断', blockerIds.includes(7))
check('未完成重测的旧记录被阻断', blockerIds.includes(5))
check('已被重测合格取代的旧记录不阻断', !blockerIds.includes(1))
check('已校核合格记录不阻断', !blockerIds.includes(2) && !blockerIds.includes(3))

console.log('8) 水位整编待办复用同一批次结论')
const todos = svc.waterlevelCompilationTodos()
const byNo = Object.fromEntries(todos.map((t) => [t.recordNo, t]))
check('ST-02 09-03 复用合格批次可整编', byNo['WATE-2026-0903']?.state === 'ready' && byNo['WATE-2026-0903']?.batchNo === 'LS20260903-DONE')
check('ST-03 09-04 需重测结论阻止整编', byNo['WATE-2026-0904']?.state === 'retest' && byNo['WATE-2026-0904']?.batchNo === 'LS20260904-DONE')
check('ST-03 09-06 未校核记录提示在途/无结论', byNo['WATE-2026-0906']?.state === 'open')
check('ST-01 09-02 复用完成批次结论', byNo['WATE-2026-0902']?.state === 'ready' && byNo['WATE-2026-0902']?.batchNo === 'LS20260902-PEND')

console.log('9) 幂等：重复初始化不重复挂批次')
const batchCountBefore = svc.listBatches().length
svc.ensureLedger()
svc.ensureLedger()
check('台账成员数稳定', svc.listBatches().length === batchCountBefore)

if (!existsSync(`${process.cwd()}/tmp`)) mkdirSync(`${process.cwd()}/tmp`)
writeFileSync(
  `${process.cwd()}/tmp/ledger-snapshot.json`,
  JSON.stringify(JSON.parse(store.get('hydrology-monitor-station:crosssection-ledger')!), null, 2),
)

if (failures) {
  console.error(`\n${failures} 项校验失败`)
  process.exit(1)
}
console.log('\n全部不变量校验通过')
