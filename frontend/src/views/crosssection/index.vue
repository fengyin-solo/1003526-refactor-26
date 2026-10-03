<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">
          以「站点 + 断面 + 测量日期」为校核标的，单次校核、批量校核、导出前置检查共用同一套判定；
          同一标的同一日期只占用一个校核批次，后到批次复用结论，重测追加新记录且保留原批次号。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="createBatch">批量校核待校核池</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待校核记录</span>
        <strong class="stat-value">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已校核（合格）</span>
        <strong class="stat-value">{{ stats.passed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">需重测记录</span>
        <strong class="stat-value">{{ stats.retest }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在途/失败批次</span>
        <strong class="stat-value">{{ stats.openBatches }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div v-if="preflight && !preflight.ok" class="preflight-box">
      <strong>导出前置检查未通过（{{ preflight.blockers.length }}/{{ preflight.total }}）：</strong>
      <ul>
        <li v-for="blocker in preflight.blockers" :key="blocker.rowId">
          {{ blocker.recordNo }}（{{ blocker.status }}）— {{ blocker.reason }}
        </li>
      </ul>
    </div>
    <div v-else-if="exportOk" class="preflight-box ok">
      导出前置检查通过：全部 {{ preflight?.total ?? 0 }} 条记录均已校核、批次归属可溯源，已开始下载。
    </div>

    <h3 class="section-title">校核批次</h3>
    <table class="data-table batch-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>来源</th>
          <th>状态</th>
          <th>进度</th>
          <th>复用</th>
          <th>断点</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in batchViews" :key="view.batch.id">
          <td>{{ view.batch.batchNo }}</td>
          <td>{{ sourceLabel(view.batch.source) }}</td>
          <td>{{ batchStateLabel(view.batch.state) }}</td>
          <td>{{ view.done }}/{{ view.total }}（{{ view.progress }}%）</td>
          <td>{{ view.reused }}</td>
          <td>{{ view.failed }}<template v-if="cursorMember(view.batch)"> · {{ cursorMember(view.batch)!.recordNo }}</template></td>
          <td class="row-actions">
            <template v-if="view.batch.state !== 'completed'">
              <button class="link" type="button" @click="resume(view.batch.id, 'pass')">
                续核合格
              </button>
              <button class="link" type="button" @click="resume(view.batch.id, 'retest')">
                续核重测
              </button>
              <button
                v-if="cursorMember(view.batch)"
                class="link danger"
                type="button"
                @click="markFailed(view.batch.id, cursorMember(view.batch)!.rowId)"
              >
                模拟中断
              </button>
            </template>
            <span v-else class="muted-text">已完成</span>
          </td>
        </tr>
        <tr v-if="!batchViews.length">
          <td colspan="7" class="empty-state">暂无校核批次，可从待校核记录发起单次或批量校核</td>
        </tr>
      </tbody>
    </table>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in rowActions(row)" :key="action.key">
              <button
                class="link"
                :class="{ danger: action.tone === 'danger' }"
                type="button"
                @click="runRowAction(action, row)"
              >
                {{ action.label }}
              </button>
            </template>
            <span v-if="!rowActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无断面测量数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条断面测量记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  conclude,
  ensureLedger,
  failMember,
  listBatches,
  openCheckBatch,
  preflightExport,
  resumeBatch,
  submitSingle,
  type BatchView,
} from '@/data/crosssection/store'
import type { CheckBatch, CheckVerdict, ExportBlocker } from '@/data/crosssection/types'

const columns = [
  '记录编号',
  '站点编号',
  '断面名称',
  '测量方法',
  '测量日期',
  '校核批次',
  '批次结论',
  '重测来源',
]
const statuses = ['已测量', '待校核', '已校核', '需重测']
const filterFields = ['记录编号', '站点编号', '断面名称']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const batchViews = ref<BatchView[]>([])
const preflight = ref<{ ok: boolean; blockers: ExportBlocker[]; total: number } | null>(null)
const exportOk = ref(false)

const stats = computed(() => ({
  pending: rows.value.filter((row) => row.status === '待校核').length,
  passed: rows.value.filter((row) => row.status === '已校核').length,
  retest: rows.value.filter((row) => row.status === '需重测').length,
  openBatches: batchViews.value.filter((view) => view.batch.state !== 'completed').length,
}))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

interface RowAction {
  key: string
  label: string
  tone?: 'danger'
  batchId?: string
}

function batchOfRow(row: EntryRow): CheckBatch | undefined {
  const view = batchViews.value.find((item) =>
    item.batch.members.some((member) => member.rowId === Number(row.id)),
  )
  return view?.batch
}

function actionableBatch(row: EntryRow): CheckBatch | undefined {
  const batch = batchOfRow(row)
  if (!batch || batch.state === 'completed') {
    return undefined
  }
  const member = batch.members.find((item) => item.rowId === Number(row.id))
  if (!member) {
    return undefined
  }
  // 只有批次游标处（含失败断点）的成员可在单次入口处理。
  const cursor = batch.members[batch.cursor]
  if (cursor && cursor.rowId === member.rowId) {
    return batch
  }
  return undefined
}

function rowActions(row: EntryRow): RowAction[] {
  if (row.status === '已测量') {
    return [{ key: 'submit', label: '提交校核' }]
  }
  const batch = actionableBatch(row)
  if (row.status === '待校核' && batch) {
    return [
      { key: 'pass', label: '单次校核合格', batchId: batch.id },
      { key: 'retest', label: '判定需重测', tone: 'danger', batchId: batch.id },
    ]
  }
  return []
}

function sourceLabel(source: CheckBatch['source']): string {
  return source === 'single' ? '单次校核' : source === 'batch' ? '批量校核' : '存量回填'
}

function batchStateLabel(state: CheckBatch['state']): string {
  return state === 'completed' ? '已完成' : state === 'failed' ? '中断（可续核）' : '在途'
}

function cursorMember(batch: CheckBatch) {
  return batch.members[batch.cursor] &&
    (batch.members[batch.cursor].state === 'claimed' ||
      batch.members[batch.cursor].state === 'failed')
    ? batch.members[batch.cursor]
    : undefined
}

function resetFilters() {
  filters.value = {}
  reload()
}

function notify(message: string) {
  errorMessage.value = message
}

function createBatch() {
  const result = openCheckBatch()
  notify(result.message)
  reload()
}

function resume(batchId: string, verdict: CheckVerdict) {
  const result = resumeBatch(batchId, verdict)
  notify(result.message)
  reload()
}

function markFailed(batchId: string, rowId: number) {
  const result = failMember(batchId, rowId, '校核过程中断（模拟）')
  notify(result.message)
  reload()
}

function runRowAction(action: RowAction, row: EntryRow) {
  exportOk.value = false
  let result
  if (action.key === 'submit') {
    result = submitSingle(Number(row.id))
  } else if (action.key === 'pass' && action.batchId) {
    result = conclude(action.batchId, 'pass', Number(row.id))
  } else if (action.key === 'retest' && action.batchId) {
    result = conclude(action.batchId, 'retest', Number(row.id))
  } else {
    result = { ok: false, message: '当前记录没有可执行的校核动作' }
  }
  notify(result.message)
  reload()
}

function exportRows() {
  exportOk.value = false
  const check = preflightExport()
  preflight.value = check
  if (!check.ok) {
    notify('导出前置检查未通过，请先处理未校核/需重测记录')
    reload()
    return
  }
  downloadEntries('crosssection')
  exportOk.value = true
}

function reload() {
  ensureLedger()
  try {
    const payload = listEntries('crosssection', filters.value)
    rows.value = payload.items
    total.value = payload.total
    batchViews.value = listBatches()
    if (!preflight.value || preflight.value.ok) {
      preflight.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  margin: 16px 0 8px;
  font-size: 15px;
}

.batch-table {
  margin-bottom: 16px;
}

.preflight-box {
  background: #fef3f2;
  border: 1px solid #fda29b;
  color: #b42318;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}

.preflight-box.ok {
  background: #ecfdf3;
  border-color: #73e2a3;
  color: #067647;
}

.preflight-box ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.muted-text {
  color: var(--muted);
  font-size: 12px;
}

.link.danger {
  color: #b42318;
}
</style>
