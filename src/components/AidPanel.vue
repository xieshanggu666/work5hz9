<template>
  <div class="aid-panel">
    <!-- 外部队伍提交资源请求 -->
    <div class="aid-form">
      <div class="form-title">📨 外部队伍提交资源请求（跨区域互援）</div>
      <div class="grid">
        <div class="field">
          <label>支援队伍</label>
          <select v-model="form.teamId">
            <option v-for="t in aid.teams" :key="t.id" :value="t.id">{{ t.name }}（{{ t.region }}）</option>
          </select>
        </div>
        <div class="field">
          <label>支援事件</label>
          <select v-model="form.eventId">
            <option v-for="e in openEvents" :key="e.id" :value="e.id">{{ e.title }}</option>
          </select>
        </div>
      </div>
      <div class="items" v-for="(it, i) in form.items" :key="i">
        <select v-model="it.type">
          <option v-for="(v, k) in RESOURCE_TYPES" :key="k" :value="k">{{ v.label }}</option>
        </select>
        <input type="number" min="0" v-model.number="it.qty" placeholder="数量" />
        <button class="row-del" :disabled="form.items.length <= 1" @click="form.items.splice(i, 1)">✕</button>
      </div>
      <div class="row-add">
        <button class="mini-btn" @click="form.items.push({ type: 'water', qty: 0 })">＋ 添加资源行</button>
      </div>
      <div class="field">
        <input v-model="form.reason" placeholder="申请事由（可空）" />
      </div>
      <button class="aid-btn" :disabled="!canSubmit" @click="onSubmit">📨 提交互援请求</button>
      <p v-if="submitFb" class="fb" :class="submitFb.ok ? 'ok' : 'err'">{{ submitFb.msg }}</p>
    </div>

    <!-- 互援请求单 -->
    <div class="panel-sub">
      🤝 互援请求单（{{ aid.requests.length }}）
      <span v-if="aid.stats.pending" class="sub-badge">{{ aid.stats.pending }} 待审批</span>
      <span v-if="aid.stats.delivering" class="sub-badge blue">{{ aid.stats.delivering }} 在途</span>
    </div>
    <div class="reqs">
      <div v-if="!aid.requests.length" class="tiny-empty">暂无互援请求，外部队伍可经联动平台提交</div>
      <div
        v-for="r in aid.requests" :key="r.id"
        class="req-card"
        :class="[r.status, { focused: aid.focusRequestId === r.id }]"
      >
        <div class="rq-head">
          <span class="rq-team">🤝 {{ r.teamName }}</span>
          <span class="rq-status" :style="{ color: aid.statusColor(r.status) }">{{ aid.statusText(r.status) }}</span>
        </div>
        <p class="rq-sub">{{ r.region }} · 联系人 {{ r.contact }} → 支援「{{ r.eventTitle }}」 · {{ r.createdAt }}</p>
        <p v-if="r.reason" class="rq-reason">事由：{{ r.reason }}</p>

        <!-- 请求清单 + 核定配额 -->
        <div class="rq-items">
          <span v-for="it in r.items" :key="it.type" class="rq-chip" :class="{ cut: it.approved != null && it.approved < it.qty }">
            {{ resLabel(it.type) }} {{ it.approved != null ? it.approved + '/' : '' }}{{ it.qty }}{{ resUnit(it.type) }}
          </span>
        </div>

        <!-- 审批留痕 -->
        <p v-if="r.reviewedBy" class="rq-review">
          {{ r.status === 'rejected' ? '⚪ 驳回' : '✅ 审批' }}：{{ r.reviewedBy }} · {{ r.reviewedAt }}
          <template v-if="r.reviewNote">｜{{ r.reviewNote }}</template>
          <template v-if="r.rejectReason">｜{{ r.rejectReason }}</template>
        </p>

        <!-- 调拨明细 -->
        <div v-if="r.allocations.length" class="rq-alloc">
          <p v-for="a in r.allocations" :key="a.dispatchId">
            🚚 {{ resLabel(a.type) }} {{ a.qty }}{{ resUnit(a.type) }}👈{{ a.baseName }}
            <em :class="allocStatus(a).cls">{{ allocStatus(a).text }}</em>
          </p>
          <p v-if="r.unmet.length" class="rq-unmet">⚠ 库存不足缺口：{{ unmetDesc(r.unmet) }}</p>
        </div>

        <!-- 回执留痕 -->
        <p v-if="r.receivedBy" class="rq-receipt">📥 回执：{{ r.receivedBy }} · {{ r.receivedAt }}<template v-if="r.receiptNote">｜{{ r.receiptNote }}</template></p>
        <p v-if="r.status === 'cancelled'" class="rq-end">🚫 已撤销：{{ r.cancelReason }}</p>

        <!-- 状态机操作 -->
        <div class="rq-actions">
          <template v-if="r.status === 'requested'">
            <button class="act-btn approve" @click="openReview(r)">✅ 审核配额</button>
            <button class="act-btn reject" @click="onReject(r)">⚪ 驳回</button>
            <button class="act-btn cancel" @click="onCancel(r)">撤销</button>
          </template>
          <template v-else-if="r.status === 'approved'">
            <button class="act-btn execute" @click="onExecute(r)">🚚 执行调拨</button>
            <button class="act-btn cancel" @click="onCancel(r)">撤销</button>
          </template>
          <template v-else-if="r.status === 'delivering'">
            <button class="act-btn receipt" @click="openReceipt(r)">📥 接收方回执</button>
          </template>
        </div>

        <!-- 审批表单：指挥员逐类核定配额 -->
        <div v-if="reviewOf[r.id]" class="mini-form">
          <p class="mf-hint">核定配额（≤ 请求量；全部为零请改用驳回）</p>
          <div class="mf-row" v-for="it in r.items" :key="it.type">
            <label class="mf-lab">{{ resLabel(it.type) }}（请求 {{ it.qty }}{{ resUnit(it.type) }}）</label>
            <input type="number" min="0" :max="it.qty" v-model.number="reviewOf[r.id].quota[it.type]" />
          </div>
          <div class="mf-row">
            <input v-model="reviewOf[r.id].note" placeholder="审批备注（可空）" />
          </div>
          <div class="mf-btns">
            <button class="ok" @click="onReview(r)">通过并核定</button>
            <button @click="delete reviewOf[r.id]">取消</button>
          </div>
        </div>

        <!-- 回执表单：接收方确认调拨（可同批认定短缺） -->
        <div v-if="receiptOf[r.id]" class="mini-form">
          <p class="mf-hint">确认接收（在途量自动签收；可同批认定短缺）</p>
          <div class="mf-row" v-for="a in receiptTypes(r)" :key="a">
            <label class="mf-lab">{{ resLabel(a) }} 短缺（可空）</label>
            <input type="number" min="0" v-model.number="receiptOf[r.id].shorts[a]" placeholder="0" />
          </div>
          <div class="mf-row">
            <input v-model="receiptOf[r.id].by" :placeholder="'接收人（缺省 ' + r.contact + '）'" />
            <input v-model="receiptOf[r.id].note" placeholder="回执备注（可空）" />
          </div>
          <div class="mf-btns">
            <button class="ok" @click="onReceipt(r)">确认回执</button>
            <button @click="delete receiptOf[r.id]">取消</button>
          </div>
        </div>

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
import { ref, computed, reactive } from 'vue'
import { useCommandStore, dispatchParts } from '@/store/command'
import { useAidStore } from '@/store/aid'
import { RESOURCE_TYPES } from '@/mock/data'

const store = useCommandStore()
const aid = useAidStore()

const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const openEvents = computed(() => store.events.filter((e) => e.status !== 'closed'))

/* ---------- 提交请求 ---------- */
const form = ref({ teamId: aid.teams[0]?.id || '', eventId: '', items: [{ type: 'water', qty: 0 }], reason: '' })
const submitFb = ref(null)
const canSubmit = computed(() =>
  !!form.value.teamId && !!form.value.eventId && form.value.items.some((it) => it.qty > 0)
)
function onSubmit() {
  const r = aid.submitRequest({
    teamId: form.value.teamId,
    eventId: form.value.eventId,
    items: form.value.items,
    reason: form.value.reason
  })
  submitFb.value = r.ok
    ? { ok: true, msg: `请求已提交（${r.request.items.length} 类资源），待指挥员审核配额` }
    : { ok: false, msg: r.msg }
  if (r.ok) form.value = { teamId: form.value.teamId, eventId: form.value.eventId, items: [{ type: 'water', qty: 0 }], reason: '' }
}

/* ---------- 审批 / 驳回 / 撤销 ---------- */
const reviewOf = reactive({})
const receiptOf = reactive({})
const fb = reactive({})

function openReview(r) {
  const quota = {}
  r.items.forEach((it) => { quota[it.type] = it.qty })
  reviewOf[r.id] = { quota, note: '' }
  delete fb[r.id]
}
function onReview(r) {
  const f = reviewOf[r.id]
  const res = aid.reviewRequest(r.id, { quota: f.quota, note: f.note })
  fb[r.id] = res.ok
    ? { ok: true, msg: `已核定配额：${r.items.map((it) => `${resLabel(it.type)} ${it.approved}`).join('、')}，待执行调拨` }
    : { ok: false, msg: res.msg }
  if (res.ok) delete reviewOf[r.id]
}
function onReject(r) {
  const res = aid.rejectRequest(r.id, {})
  fb[r.id] = res.ok ? { ok: true, msg: '已驳回该互援请求（留痕）' } : { ok: false, msg: res.msg }
}
function onCancel(r) {
  const res = aid.cancelRequest(r.id, {})
  fb[r.id] = res.ok ? { ok: true, msg: '请求已撤销' } : { ok: false, msg: res.msg }
}

/* ---------- 执行调拨 ---------- */
function onExecute(r) {
  const res = aid.executeAid(r.id)
  fb[r.id] = res.ok
    ? {
        ok: true,
        msg: `已出库 ${res.sent.length} 批共 ${res.sent.reduce((s, x) => s + x.qty, 0)} 单位`
          + (res.unmet.length ? `，缺口 ${unmetDesc(res.unmet)}` : '')
      }
    : { ok: false, msg: res.msg }
}

/* ---------- 回执 ---------- */
function receiptTypes(r) {
  return [...new Set(r.allocations.map((a) => a.type))]
}
function openReceipt(r) {
  const shorts = {}
  receiptTypes(r).forEach((t) => { shorts[t] = 0 })
  receiptOf[r.id] = { shorts, by: '', note: '' }
  delete fb[r.id]
}
function onReceipt(r) {
  const f = receiptOf[r.id]
  const res = aid.confirmReceipt(r.id, { by: f.by, note: f.note, shorts: f.shorts })
  fb[r.id] = res.ok
    ? {
        ok: true,
        msg: `回执确认：接收 ${res.signed} 单位` + (res.shortage ? `，认定短缺 ${res.shortage}` : '')
          + (res.done ? '，请求办结' : '（部分调拨单未办结，请求仍在途）')
      }
    : { ok: false, msg: res.msg }
  if (res.ok) delete receiptOf[r.id]
}

/* ---------- 展示辅助 ---------- */
function allocStatus(a) {
  const d = store.dispatches.find((x) => x.id === a.dispatchId)
  if (!d) return { text: '', cls: '' }
  if (d.status === 'done') return { text: '✅ 已办结', cls: 'ok' }
  if (d.status === 'withdrawn') return { text: '🚫 已撤回', cls: 'warn' }
  if (d.status === 'held') return { text: '⏸ 挂起', cls: 'warn' }
  const p = dispatchParts(d)
  return { text: `在途 ${p.inTransit}${d.unit}`, cls: '' }
}
const unmetDesc = (unmet) => unmet.map((u) => `${resLabel(u.type)} ${u.qty}${resUnit(u.type)}`).join('、')
</script>

<style scoped>
.aid-panel { display: flex; flex-direction: column; gap: 10px; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #7986cb; padding-left: 8px; margin: 6px 0;
  display: flex; align-items: center; gap: 6px;
}
.sub-badge {
  font-size: 9px; padding: 1px 6px; border-radius: 6px;
  background: rgba(255, 171, 64, 0.18); color: #ffcc80;
}
.sub-badge.blue { background: rgba(79, 195, 247, 0.18); color: #4fc3f7; }

.aid-form { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 12px; }
.form-title { font-size: 12px; font-weight: 600; color: #8ba2c8; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input, .items select, .items input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 8px; font-size: 12px;
  box-sizing: border-box;
}
.items { display: flex; gap: 6px; margin-bottom: 6px; }
.items select { flex: 1.4; }
.items input { flex: 1; }
.row-del {
  width: 30px; flex-shrink: 0; background: transparent;
  border: 1px solid rgba(239,83,80,0.4); color: #ef9a9a;
  border-radius: 7px; cursor: pointer; font-size: 11px;
}
.row-del:disabled { opacity: 0.3; cursor: not-allowed; }
.row-add { margin-bottom: 8px; }
.mini-btn {
  background: transparent; border: 1px dashed rgba(120,160,220,0.35);
  color: #8ea1c4; font-size: 11px; border-radius: 6px; padding: 4px 10px; cursor: pointer;
}
.mini-btn:hover { color: #fff; border-color: #4d8dff; }
.aid-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #3949ab, #7986cb);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: all 0.2s;
}
.aid-btn:hover:not(:disabled) { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(121,134,203,0.4); }
.aid-btn:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }

.reqs { display: flex; flex-direction: column; gap: 8px; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
.req-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.req-card.focused { border-color: rgba(121,134,203,0.6); box-shadow: 0 0 0 1px rgba(121,134,203,0.35); }
.req-card.received { opacity: 0.75; border-color: rgba(76,175,80,0.3); }
.req-card.rejected, .req-card.cancelled { opacity: 0.65; }
.rq-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rq-team { color: #dbe4f3; font-size: 12px; font-weight: 700; }
.rq-status { font-size: 11px; font-weight: 700; flex-shrink: 0; }
.rq-sub { font-size: 10px; color: #8ba2c8; margin: 4px 0 0; }
.rq-reason { font-size: 10px; color: #aebadd; margin: 3px 0 0; }
.rq-items { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.rq-chip {
  font-size: 10px; background: #0c1730; border: 1px solid rgba(121,134,203,0.35);
  color: #c5cae9; padding: 2px 6px; border-radius: 4px;
}
.rq-chip.cut { border-color: rgba(255,152,0,0.45); color: #ffcc80; }
.rq-review { font-size: 10px; color: #8ba2c8; margin: 5px 0 0; }
.rq-alloc { margin-top: 5px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.rq-alloc p { font-size: 10px; color: #8ba2c8; margin: 2px 0 0; }
.rq-alloc em { font-style: normal; color: #7ea8e8; margin-left: 4px; }
.rq-alloc em.ok { color: #7ef0c9; }
.rq-alloc em.warn { color: #ffcc80; }
.rq-unmet { color: #ffab91 !important; }
.rq-receipt { font-size: 10px; color: #7ef0c9; margin: 5px 0 0; }
.rq-end { font-size: 10px; color: #9e9e9e; margin: 5px 0 0; }

.rq-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.act-btn {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.act-btn:hover { color: #fff; border-color: #4d8dff; }
.act-btn.approve { border-color: rgba(38,166,154,0.45); color: #7ef0c9; }
.act-btn.approve:hover { background: rgba(38,166,154,0.15); }
.act-btn.execute { border-color: rgba(79,195,247,0.5); color: #4fc3f7; }
.act-btn.execute:hover { background: rgba(79,195,247,0.12); }
.act-btn.receipt { border-color: rgba(126,240,201,0.45); color: #7ef0c9; }
.act-btn.receipt:hover { background: rgba(38,166,154,0.15); }
.act-btn.reject { border-color: rgba(158,158,158,0.4); color: #bdbdbd; }
.act-btn.cancel { border-color: rgba(239,83,80,0.4); color: #ef5350; margin-left: auto; }
.act-btn.cancel:hover { background: rgba(239,83,80,0.12); }

.mini-form {
  margin-top: 7px; background: #0c1730; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 7px; padding: 8px;
}
.mf-hint { font-size: 10px; color: #8ba2c8; margin: 0 0 6px; }
.mf-row { display: flex; gap: 5px; align-items: center; margin-bottom: 5px; }
.mf-lab { font-size: 10px; color: #8ba2c8; width: 55%; flex-shrink: 0; }
.mf-row input {
  flex: 1; min-width: 0;
  background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 5px; padding: 5px 7px; font-size: 11px; box-sizing: border-box;
}
.mf-btns { display: flex; gap: 6px; margin-top: 6px; }
.mf-btns button {
  padding: 4px 12px; font-size: 11px; border-radius: 5px; cursor: pointer;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.mf-btns button.ok { border-color: #26a69a; color: #7ef0c9; }
.mf-btns button.ok:hover { background: rgba(38,166,154,0.15); }

.rq-log { margin-top: 6px; border-top: 1px dashed rgba(120,160,220,0.12); padding-top: 4px; }
.rq-log p { font-size: 9px; color: #5b6f94; margin: 2px 0 0; }
.lg-time { color: #7ea8e8; margin-right: 5px; }
.fb { font-size: 10px; margin: 5px 0 0; }
.fb.ok { color: #7ef0c9; }
.fb.err { color: #ef9a9a; }
</style>
