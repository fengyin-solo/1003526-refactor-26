<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">
          单次校核、批量校核、导出前置检查共用一份判定：同一断面同一测量日期只占用一个校核批次，
          同日期竞争收敛为唯一完成标记，后到批次复用结论，历史已校核结论保持不变。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" @click="runBulk">批量校核</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="rule-panel">
      <strong>统一判定规则（单次 / 批量 / 导出共用）</strong>
      <ul>
        <li>起点距、河底高程均为有效数值 → 合格，批次写入唯一完成标记；</li>
        <li>任一值缺失（空）→ 资料不齐，批次在该条中断，补齐资料后从未完成处继续；</li>
        <li>任一值无法解析为数值 → 需重测；重测结论与合格结论均不可覆盖，重测走「登记重测」生成新剖面；</li>
        <li>同断面同测量日期若被多个批次碰到，先完成的批次定结论，后到批次只复用，不重复处理。</li>
      </ul>
    </div>

    <div class="batch-panel">
      <div class="panel-title">校核批次（共 {{ batches.length }} 个）</div>
      <table class="data-table" v-if="batches.length">
        <thead>
          <tr>
            <th>批次号</th>
            <th>类型</th>
            <th>状态</th>
            <th>合格</th>
            <th>重测</th>
            <th>复用</th>
            <th>待校核</th>
            <th>资料不齐</th>
            <th>中断位置 / 操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.batchNo">
            <td>{{ batch.batchNo }}</td>
            <td>{{ kindText(batch.kind) }}</td>
            <td>
              <span class="badge" :class="batch.state === 'completed' ? 'badge-ok' : 'badge-warn'">
                {{ batch.state === 'completed' ? '已完成' : '进行中' }}
              </span>
            </td>
            <td>{{ batch.qualified }}</td>
            <td>{{ batch.remeasure }}</td>
            <td>{{ batch.reused }}</td>
            <td>{{ batch.pending }}</td>
            <td>{{ batch.blocked }}</td>
            <td>
              <template v-if="batch.state === 'completed'">
                <span class="muted-text">已收口</span>
              </template>
              <template v-else>
                <span v-if="batch.blocker" class="error-text">中断：{{ batch.blocker }}</span>
                <button class="link" type="button" @click="resume(batch.batchNo)">继续校核</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted-text">暂无校核批次，提交校核或批量校核后自动生成。</p>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <th>校核说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            <span class="badge" :class="badgeClass(row.itemState)">{{ row.status }}</span>
          </td>
          <td class="reason-cell">
            <span v-if="row.blocker" class="error-text">{{ row.blocker }}</span>
            <span v-else-if="row.reason" class="muted-text">{{ row.reason }}</span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runRowAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无断面测量数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条断面测量记录</span>
      <span v-if="errorMessage" :class="errorMessage.startsWith('已') ? 'ok-text' : 'error-text'">
        {{ errorMessage }}
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  arrangeRemeasure,
  confirmCheck,
  exportCrossSectionCsv,
  getBoard,
  precheckExport,
  registerRemeasure,
  resumeBatch,
  startBulkCheck,
  submitForCheck,
  supplementProfileData,
  type BatchKind,
  type BatchView,
  type CrossSectionView,
  type ItemState,
} from '@/data/crosssection-checks'
import type { ActionResult } from '@/data/types'

const columns = [
  '记录编号',
  '站点编号',
  '断面名称',
  '测量方法',
  '起点距',
  '河底高程',
  '测量日期',
  '校核批次',
]
const filterFields = ['记录编号', '站点编号', '断面名称']
const statuses = ['已测量', '待校核', '已校核', '需重测']

const rows = ref<CrossSectionView[]>([])
const batches = ref<BatchView[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const statCards = ref([
  { label: '本月测量次数', value: 0 },
  { label: '待校核记录', value: 0 },
  { label: '需重测记录', value: 0 },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function kindText(kind: BatchKind): string {
  return kind === 'single' ? '单次校核' : kind === 'bulk' ? '批量校核' : '存量补齐'
}

function badgeClass(state: ItemState | null): string {
  if (state === 'qualified' || state === 'reused_qualified') {
    return 'badge-ok'
  }
  if (state === 'remeasure' || state === 'reused_remeasure') {
    return 'badge-bad'
  }
  if (state === 'blocked') {
    return 'badge-warn'
  }
  return 'badge-idle'
}

/** 行级动作由统一状态规则推导，而不是页面各写一套。 */
function actionsFor(row: CrossSectionView): string[] {
  switch (row.itemState) {
    case null:
      return ['提交校核']
    case 'pending':
      return row.batchState === 'completed'
        ? []
        : ['安排重测', ...(row.batchNo.startsWith('CHK-D') ? ['确认校核'] : [])]
    case 'blocked':
      return ['补齐资料', '安排重测']
    case 'remeasure':
    case 'reused_remeasure':
      return ['登记重测']
    case 'qualified':
    case 'reused_qualified':
    default:
      return []
  }
}

function applyResult(result: ActionResult): void {
  errorMessage.value = result.message
  reload()
}

function runRowAction(action: string, row: CrossSectionView): void {
  const id = Number(row.id)
  switch (action) {
    case '提交校核':
      applyResult(submitForCheck(id))
      break
    case '确认校核':
      applyResult(confirmCheck(id))
      break
    case '安排重测':
      applyResult(arrangeRemeasure(id))
      break
    case '登记重测':
      applyResult(registerRemeasure(id))
      break
    case '补齐资料': {
      const distance = window.prompt('补录起点距（留空表示不修改）', String(row['起点距'] ?? ''))
      if (distance === null) {
        return
      }
      const elevation = window.prompt('补录河底高程（留空表示不修改）', String(row['河底高程'] ?? ''))
      if (elevation === null) {
        return
      }
      applyResult(supplementProfileData(id, { distance, elevation }))
      break
    }
    default:
      errorMessage.value = `未支持的动作：${action}`
  }
}

function runBulk(): void {
  applyResult(startBulkCheck())
}

function resume(batchNo: string): void {
  applyResult(resumeBatch(batchNo))
}

function exportRows(): void {
  const precheck = precheckExport()
  if (!precheck.ok) {
    const detail = precheck.blockers
      .slice(0, 5)
      .map((item) => `${item.recordNo}（${item.reason}）`)
      .join('；')
    const more = precheck.blockers.length > 5 ? ` 等 ${precheck.blockers.length} 条` : ''
    errorMessage.value = `导出前置检查未通过：${detail}${more}`
    return
  }
  const { filename, content } = exportCrossSectionCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  errorMessage.value = `导出前置检查通过，${precheck.exportable} 条合格记录已导出`
}

function openCreate(): void {
  errorMessage.value = '断面测量记录登记入口尚未接入审批流'
}

function resetFilters(): void {
  filters.value = {}
  reload()
}

function reload(): void {
  errorMessage.value = ''
  const board = getBoard(filters.value)
  rows.value = board.rows
  batches.value = board.batches
  statCards.value = [
    { label: '本月测量次数', value: board.stats.measuredMonth },
    { label: '待校核记录', value: board.stats.pending },
    { label: '需重测记录', value: board.stats.remeasure },
  ]
}

onMounted(reload)
</script>
