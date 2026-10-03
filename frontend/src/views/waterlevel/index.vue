<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="compilation-box">
      <h3 class="compilation-title">水位整编待办（复用断面校核批次结论）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>水位记录</th>
            <th>站点编号</th>
            <th>日期</th>
            <th>断面</th>
            <th>复用批次</th>
            <th>整编结论</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.recordNo">
            <td>{{ todo.recordNo }}</td>
            <td>{{ todo.station }}</td>
            <td>{{ todo.date }}</td>
            <td>{{ todo.section }}</td>
            <td>{{ todo.batchNo ?? '—' }}</td>
            <td :class="`todo-state-${todo.state}`">{{ todo.message }}</td>
          </tr>
        </tbody>
      </table>
    </section>

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
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  ensureLedger,
  waterlevelCompilationTodos,
  type CompilationTodo,
} from '@/data/crosssection/store'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "水位变幅", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日采集数", "value": 0}, {"label": "超警戒站次", "value": 0}, {"label": "待审核记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const todos = ref<CompilationTodo[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水位记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    ensureLedger()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = waterlevelCompilationTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.compilation-box {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.compilation-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.todo-state-ready {
  color: #067647;
}

.todo-state-retest {
  color: #b42318;
}

.todo-state-open,
.todo-state-none {
  color: var(--muted);
}
</style>
