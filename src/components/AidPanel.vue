<template>
  <div class="aid-panel">
    <!-- 外部队伍提交资源请求（模拟互援队伍端） -->
    <div class="req-form">
      <div class="form-title">
        🤝 外部队伍提交资源请求
        <select class="team-switch" :value="aid.currentTeamId" @change="aid.switchTeam($event.target.value)">
          <option v-for="t in aid.teams" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </div>
      <p class="team-meta" v-if="aid.currentTeam">
        {{ aid.currentTeam.region }} · 联络 {{ aid.currentTeam.contact }} · {{ aid.currentTeam.channel }}
      </p>
      <div class="ingest-row">
        <select v-model="form.eventId">
          <option v-for="e in openEvents" :key="e.id" :value="e.id">{{ e.title }}</option>
        </select>
      </div>
      <div class="item-row" v-for="(it, i) in form.items" :key="i">
        <select v-model="it.type">
          <option v-for="(v, k) in RESOURCE_TYPES" :key="k" :value="k">{{ v.label }}</option>
        </select>
        <input type="number" min="0" v-model.number="it.qty" placeholder="数量" />
        <button class="row-del" :disabled="form.items.length <= 1" @click="form.items.splice(i, 1)">✕</button>
      </div>
      <div class="ingest-row">
        <input v-model="form.reason" placeholder="请求事由（可空）" />
        <button class="mini-btn" @click="addItem">＋ 资源</button>
        <button class="mini-btn go" :disabled="!canSubmit" @click="onSubmit">提交请求</button>
      </div>
      <p v-if="submitFb" class="fb" :class="submitFb.ok ? 'ok' : 'err'">{{ submitFb.msg }}</p>
    </div>

    <!-- 互援请求单 -->
    <div class="panel-sub">
      📨 互援请求单（{{ aid.requests.length }}）
      <span v-if="aid.stats.pending" class="sub-badge">{{ aid.stats.pending }} 待审批</span>
      <span v-if="aid.stats.executing" class="sub-badge blue">{{ aid.stats.executing }} 调拨中</span>
    </div>
    <div class="reqs">
      <div v-if="!aid.requests.length" class="tiny-empty">暂无互援请求，外部队伍可在上方提交</div>
      <div
        v-for="r in aid.requests" :key="r.id"
        class="req-card"
        :class="[r.status, { focused: aid.focusRequestId === r.id }]"
      >
        <div class="rq-head">
          <span class="rq-status" :style="{ background: aid.statusColor(r.status) }">{{ aid.statusText(r.status) }}</span>
          <strong>{{ r.teamName }}</strong>
          <span class="rq-region">{{ r.region }}</span>
        </div>
        <p class="rq-sub">保障「{{ r.eventTitle }}」 · {{ r.contact }} · {{ r.submittedAt }}<template v-if="r.reason"> · {{ r.reason }}</template></p>

        <!-- 资源明细：申请 / 核准 / 已调拨 / 缺口 -->
        <div class="rq-items">
          <div class="ri-row ri-head">
            <span>资源</span><span>申请</span><span>核准</span><span>已调拨</span><span>缺口</span>
          </div>
          <div class="ri-row" v-for="it in r.items" :key="it.type">
            <span>{{ aid.resLabel(it.type) }}</span>
            <span>{{ it.qty }}{{ aid.resUnit(it.type) }}</span>
            <span :class="{ zero: r.status !== 'requested' && !it.approved }">{{ it.approved == null ? '—' : it.approved + aid.resUnit(it.type) }}</span>
            <span>{{ r.status === 'requested' || r.status === 'approved' ? '—' : (it.sent || 0) + aid.resUnit(it.type) }}</span>
            <span :class="{ zero: !it.unmet }">{{ it.unmet ? it.unmet + aid.resUnit(it.type) : '—' }}</span>
          </div>
        </div>

        <!-- 审批表单（待审批） -->
        <template v-if="r.status === 'requested'">
          <div v-if="reviewOf[r.id]" class="mini-form">
            <p class="mf-hint">审核配额（核准量 ≤ 申请量，核减为 0 即不支援该项）</p>
            <div class="mf-quota" v-for="it in r.items" :key="it.type">
              <label>{{ aid.resLabel(it.type) }}（申请 {{ it.qty }}{{ aid.resUnit(it.type) }}）</label>
              <input type="number" min="0" :max="it.qty" v-model.number="reviewOf[r.id].quota[it.type]" />
            </div>
            <div class="mf-row">
              <input v-model="reviewOf[r.id].note" placeholder="审批备注（可空）" />
            </div>
            <div class="mf-btns">
              <button class="ok" @click="onReview(r)">✅ 通过审批</button>
              <button @click="delete reviewOf[r.id]">收起</button>
            </div>
          </div>
          <div class="rq-actions">
            <button v-if="!reviewOf[r.id]" class="act-btn review" @click="openReview(r)">📝 审核配额</button>
            <button class="act-btn reject" @click="onReject(r)">⚪ 驳回</button>
          </div>
        </template>

        <!-- 已审批待调拨 -->
        <template v-else-if="r.status === 'approved'">
          <p class="rq-note">✅ {{ r.reviewedBy }} 核准（{{ r.reviewedAt }}）<template v-if="r.reviewNote">：{{ r.reviewNote }}</template></p>
          <div class="rq-actions">
            <button class="act-btn exec" @click="onExecute(r)">🚚 执行调拨</button>
            <button class="act-btn cancel" @click="onCancel(r)">🚫 终止</button>
          </div>
        </template>

        <!-- 调拨中待回执 -->
        <template v-else-if="r.status === 'executing'">
          <div class="rq-dps">
            <p v-for="d in aid.dispatchesOf(r)" :key="d.id" class="dp-line">
              <span class="dp-dot" :class="d.status"></span>
              {{ d.typeLabel }} {{ d.qty }}{{ d.unit }}👈{{ d.baseName }}
              <em>{{ dpStatusText(d) }}</em>
            </p>
          </div>
          <div class="rq-actions">
            <button class="act-btn receipt" @click="onReceipt(r)">📨 接收方确认回执（{{ r.contact }}）</button>
            <button class="act-btn cancel" @click="onCancel(r)">🚫 终止</button>
          </div>
        </template>

        <!-- 终态 -->
        <p v-else-if="r.status === 'received'" class="rq-end ok">📨 已回执办结：{{ r.receiptBy }}（{{ r.receivedAt }}）</p>
        <p v-else-if="r.status === 'rejected'" class="rq-end">⚪ 已驳回：{{ r.rejectReason }}（{{ r.rejectedAt }}）</p>
        <p v-else-if="r.status === 'cancelled'" class="rq-end">🚫 已终止：{{ r.cancelReason }}（{{ r.cancelledAt }}）</p>

        <!-- 处置日志 -->
        <div class="rq-log">
          <p v-for="(l, i) in [...r.log].slice(-3).reverse()" :key="i">
            <span class="lg-time">{{ l.at }}</span>{{ l.text }}
          </p>
        </div>
        <p v-if="fb[r.id]" class="fb" :class="fb[r.id].ok ? 'ok' : 'err'">{{ fb[r.id].msg }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useAidStore } from '@/store/aid'
import { RESOURCE_TYPES } from '@/mock/data'

const store = useCommandStore()
const aid = useAidStore()

const form = ref({ eventId: '', items: [{ type: 'water', qty: 0 }], reason: '' })
const submitFb = ref(null)
const fb = reactive({})
const reviewOf = reactive({})

const openEvents = computed(() => store.events.filter((e) => e.status !== 'closed'))
const canSubmit = computed(() =>
  !!form.value.eventId && form.value.items.some((it) => it.qty > 0)
)
// 场景载入后默认选中第一个未结案事件
watch(openEvents, (list) => {
  if (!list.some((e) => e.id === form.value.eventId)) form.value.eventId = list[0]?.id || ''
}, { immediate: true })

function addItem() {
  const used = new Set(form.value.items.map((it) => it.type))
  const next = Object.keys(RESOURCE_TYPES).find((t) => !used.has(t)) || 'water'
  form.value.items.push({ type: next, qty: 0 })
}

function onSubmit() {
  const r = aid.submitRequest({
    teamId: aid.currentTeamId,
    eventId: form.value.eventId,
    items: form.value.items,
    reason: form.value.reason
  })
  submitFb.value = r.ok
    ? { ok: true, msg: `请求已提交（${r.request.id}），待指挥员审批` }
    : { ok: false, msg: r.msg }
  if (r.ok) form.value = { eventId: form.value.eventId, items: [{ type: 'water', qty: 0 }], reason: '' }
}

function openReview(r) {
  const quota = {}
  r.items.forEach((it) => { quota[it.type] = it.qty })
  reviewOf[r.id] = { quota, note: '' }
  delete fb[r.id]
}
function onReview(r) {
  const f = reviewOf[r.id]
  const items = r.items.map((it) => ({ type: it.type, qty: f.quota[it.type] }))
  const res = aid.reviewRequest(r.id, { items, note: f.note })
  fb[r.id] = res.ok
    ? { ok: true, msg: `审批通过，核准 ${aid.itemsText(res.request.items, 'approved')}，待执行调拨` }
    : { ok: false, msg: res.msg }
  if (res.ok) delete reviewOf[r.id]
}
function onReject(r) {
  const reason = window.prompt('驳回原因（留痕）', '运力/库存不足，暂无法支援')
  if (reason == null) return
  const res = aid.rejectRequest(r.id, { reason })
  fb[r.id] = res.ok ? { ok: true, msg: '请求已驳回并留痕' } : { ok: false, msg: res.msg }
}
function onExecute(r) {
  const res = aid.executeRequest(r.id)
  fb[r.id] = res.ok
    ? { ok: true, msg: `已调拨出库 ${res.sent.length} 批` + (res.unmet.length ? `，仍缺 ${aid.itemsText(res.unmet, 'unmet')}` : '，等待接收方回执') }
    : { ok: false, msg: res.msg }
}
function onReceipt(r) {
  const res = aid.confirmReceipt(r.id, {})
  fb[r.id] = res.ok
    ? { ok: true, msg: `回执确认，实收 ${res.signed} 单位已回写事件保障量` }
    : { ok: false, msg: res.msg }
}
function onCancel(r) {
  const reason = window.prompt('终止原因（调拨中终止将在途余量回库）', '指挥员终止互援调拨')
  if (reason == null) return
  const res = aid.cancelRequest(r.id, { reason })
  fb[r.id] = res.ok
    ? { ok: true, msg: '请求已终止' + (res.back > 0 ? `，在途余量 ${res.back} 已回库` : '') }
    : { ok: false, msg: res.msg }
}

const DP_STATUS = { enroute: '在途', held: '挂起', done: '已办结', withdrawn: '已撤回' }
function dpStatusText(d) {
  const p = dispatchParts(d)
  return `${DP_STATUS[d.status] || d.status}·实收 ${p.received}/${d.qty}${d.unit}`
}
</script>

<style scoped>
.aid-panel { display: flex; flex-direction: column; gap: 10px; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #f06292; padding-left: 8px; margin: 4px 0;
  display: flex; align-items: center; gap: 8px;
}
.sub-badge {
  background: #ffab40; color: #201200; font-size: 10px;
  padding: 1px 7px; border-radius: 8px; font-weight: 700;
}
.sub-badge.blue { background: #2f9cf5; color: #fff; }

/* 提交表单 */
.req-form { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 10px; }
.form-title {
  font-size: 11px; font-weight: 600; color: #8ba2c8; margin-bottom: 7px;
  display: flex; align-items: center; gap: 8px;
}
.team-switch {
  margin-left: auto; max-width: 55%;
  background: #0c1730; border: 1px solid rgba(240,98,146,0.4); color: #f8bbd0;
  border-radius: 6px; padding: 3px 6px; font-size: 10px;
}
.team-meta { font-size: 9px; color: #5b6f94; margin: -3px 0 7px; }
.ingest-row { display: flex; gap: 6px; margin-bottom: 6px; }
.ingest-row:last-child { margin-bottom: 0; }
.ingest-row select, .ingest-row input, .item-row select, .item-row input {
  flex: 1; min-width: 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px 8px; font-size: 11px; box-sizing: border-box;
}
.item-row { display: flex; gap: 6px; margin-bottom: 6px; }
.item-row select { flex: 1.2; }
.item-row input { flex: 1; }
.row-del {
  flex-shrink: 0; width: 26px; background: #0c1730; border: 1px solid rgba(239,83,80,0.35);
  color: #ef9a9a; border-radius: 6px; font-size: 10px; cursor: pointer;
}
.row-del:disabled { opacity: 0.35; cursor: not-allowed; }
.mini-btn {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
  font-size: 11px; border-radius: 6px; padding: 5px 12px; cursor: pointer; flex-shrink: 0;
}
.mini-btn:hover:not(:disabled) { color: #fff; border-color: #4d8dff; }
.mini-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mini-btn.go { border-color: rgba(240,98,146,0.55); color: #f8bbd0; }

/* 请求单卡片 */
.reqs { display: flex; flex-direction: column; gap: 8px; }
.req-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(240,98,146,0.3);
  border-radius: 9px; padding: 9px 10px;
}
.req-card.executing { border-color: rgba(47,156,245,0.5); box-shadow: 0 0 10px rgba(47,156,245,0.1); }
.req-card.received, .req-card.rejected, .req-card.cancelled { opacity: 0.66; border-color: rgba(120,160,220,0.15); }
.req-card.focused { box-shadow: 0 0 0 1.5px rgba(255,171,64,0.5); }
.rq-head { display: flex; align-items: center; gap: 7px; }
.rq-status { color: #fff; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.rq-head strong { color: #fff; font-size: 12px; flex: 1; min-width: 0; }
.rq-region { font-size: 9px; color: #8ba2c8; border: 1px solid rgba(120,160,220,0.25); border-radius: 4px; padding: 1px 5px; flex-shrink: 0; }
.rq-sub { font-size: 10px; color: #8ba2c8; margin: 5px 0 0; }
.rq-note { font-size: 10px; color: #7ef0c9; margin: 6px 0 0; }

/* 资源明细表 */
.rq-items { margin-top: 7px; border: 1px solid rgba(120,160,220,0.12); border-radius: 6px; overflow: hidden; }
.ri-row { display: grid; grid-template-columns: 1.3fr 1fr 1fr 1fr 1fr; font-size: 10px; color: #aebadd; }
.ri-row > span { padding: 3px 7px; white-space: nowrap; overflow: hidden; }
.ri-row.ri-head { background: rgba(12,23,48,0.9); color: #6f8cb8; font-weight: 700; }
.ri-row:not(.ri-head):nth-child(odd) { background: rgba(12,23,48,0.4); }
.ri-row .zero { color: #4a5875; }

/* 调拨批次进度 */
.rq-dps { margin-top: 7px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.dp-line { font-size: 10px; color: #8ba2c8; margin: 2px 0; display: flex; align-items: center; gap: 5px; }
.dp-line em { font-style: normal; color: #5b6f94; font-size: 9px; }
.dp-dot { width: 7px; height: 7px; border-radius: 50%; background: #2f9cf5; flex-shrink: 0; }
.dp-dot.held { background: #ffc107; }
.dp-dot.done { background: #4caf50; }
.dp-dot.withdrawn { background: #78909c; }

/* 操作按钮 */
.rq-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.act-btn {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 9px; cursor: pointer;
}
.act-btn:hover:not(:disabled) { color: #fff; border-color: #4d8dff; }
.act-btn.review { border-color: rgba(255,171,64,0.5); color: #ffcc80; }
.act-btn.reject { border-color: rgba(158,158,158,0.4); color: #b0bec5; margin-left: auto; }
.act-btn.exec { border-color: rgba(47,156,245,0.55); color: #9fc1ff; }
.act-btn.receipt { border-color: rgba(38,166,154,0.5); color: #7ef0c9; }
.act-btn.cancel { border-color: rgba(239,83,80,0.4); color: #ef9a9a; margin-left: auto; }

/* 审批迷你表单 */
.mini-form {
  margin-top: 7px; background: #0c1730; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 7px; padding: 8px;
}
.mf-hint { font-size: 10px; color: #8ba2c8; margin: 0 0 6px; }
.mf-quota { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.mf-quota label { flex: 1; font-size: 10px; color: #aebadd; }
.mf-quota input {
  width: 80px; background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 5px; padding: 4px 7px; font-size: 11px; box-sizing: border-box;
}
.mf-row { display: flex; gap: 5px; }
.mf-row input {
  flex: 1; min-width: 0; background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 5px; padding: 5px 7px; font-size: 11px; box-sizing: border-box;
}
.mf-btns { display: flex; gap: 6px; margin-top: 6px; }
.mf-btns button {
  padding: 4px 12px; font-size: 11px; border-radius: 5px; cursor: pointer;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.mf-btns button.ok { border-color: #26a69a; color: #7ef0c9; }
.mf-btns button.ok:hover { background: rgba(38,166,154,0.15); }

.rq-end { font-size: 10px; color: #b0bec5; margin: 7px 0 0; }
.rq-end.ok { color: #a5d6a7; }
.rq-log { margin-top: 7px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.rq-log p { font-size: 9px; color: #5b6f94; margin: 2px 0; }
.lg-time { color: #ffc107; font-family: monospace; margin-right: 5px; }

.fb { font-size: 10px; margin: 6px 0 0; }
.fb.ok { color: #7ef0c9; }
.fb.err { color: #ef9a9a; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
</style>
