<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">维护整编成果，围绕成果编号、整编年份、站点编号、整编类型做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="batch-panel">
      <div class="panel-title">水位整编待办 · 复用断面校核批次结论</div>
      <p class="muted-text panel-hint">
        整编不重新校核：同一断面同一测量日期已有批次结论时直接采用，重测结论须先完成重测成果。
        待采用 {{ todoStats.pending }} 项 · 已采用 {{ todoStats.adopted }} 项 · 重测阻塞 {{ todoStats.blocked }} 项
      </p>
      <table class="data-table" v-if="todos.length">
        <thead>
          <tr>
            <th>站点编号</th>
            <th>断面名称</th>
            <th>测量日期</th>
            <th>校核批次</th>
            <th>批次结论</th>
            <th>采用状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.key">
            <td>{{ todo.station }}</td>
            <td>{{ todo.section }}</td>
            <td>{{ todo.date }}</td>
            <td>{{ todo.batchNo }}</td>
            <td>
              <span class="badge" :class="todo.verdict === '合格' ? 'badge-ok' : 'badge-bad'">
                {{ todo.verdict }}
              </span>
              <span class="muted-text reason-inline">{{ todo.reason }}</span>
            </td>
            <td>
              <span v-if="todo.adopted" class="badge badge-ok">已采用 {{ todo.adoptedAt?.slice(0, 10) }}</span>
              <span v-else-if="todo.verdict === '重测'" class="badge badge-bad">待重测成果</span>
              <span v-else class="badge badge-warn">待采用</span>
            </td>
            <td>
              <button
                v-if="!todo.adopted && todo.verdict === '合格'"
                class="link"
                type="button"
                @click="adopt(todo.key)"
              >
                采用批次结论
              </button>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted-text">暂无可复用的断面校核批次结论。</p>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
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
import {
  adoptConclusionForCompilation,
  listCompilationTodos,
  type CompilationTodo,
} from '@/data/crosssection-checks'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compilation')
const columns = ["成果编号", "整编年份", "站点编号", "整编类型", "原始记录数", "整编人", "审核人", "整编状态"]
const actions = ["开始整编", "提交审核", "驳回整编"]
const statuses = ["待整编", "整编中", "待审核", "已刊印", "已驳回"]
const stats = [{"label": "待整编年度", "value": 0}, {"label": "整编中年度", "value": 0}, {"label": "已刊印成果", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const todos = ref<CompilationTodo[]>([])

const todoStats = computed(() => ({
  pending: todos.value.filter((todo) => !todo.adopted && todo.verdict === '合格').length,
  adopted: todos.value.filter((todo) => todo.adopted).length,
  blocked: todos.value.filter((todo) => !todo.adopted && todo.verdict === '重测').length,
}))

function adopt(key: string) {
  errorMessage.value = ''
  const result = adoptConclusionForCompilation(key)
  errorMessage.value = result.message
  loadTodos()
}

function loadTodos() {
  todos.value = listCompilationTodos()
}
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
  errorMessage.value = '整编成果登记入口尚未接入审批流'
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

onMounted(() => {
  reload()
  loadTodos()
})
</script>
