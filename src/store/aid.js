import { defineStore } from 'pinia'
import { useCommandStore, dispatchParts, roughPath } from '@/store/command'
import { AID_TEAMS, AID_STATUS, RESOURCE_TYPES } from '@/mock/data'

/* =========================================================================
 * 跨区域互援协同模块
 *
 * 请求：外部支援队伍（兄弟市县/省级增援/社会力量）围绕灾情事件提交资源请求
 *       （资源清单 + 事由），同类型合并入账，事件已结案不予受理。
 * 审批：指挥员逐类核定配额（可核减、缺省按请求量；超请求量截断），通过转
 *       「待调拨」；驳回留痕为终态。全部为零的核定视同未通过、须驳回。
 * 执行：按核定配额就近出库（可用量须扣除协同方案生效预占，库存不足跨基地
 *       拆单），生成「互援调拨」派发记录——实物库存即时扣减并入库存变动流水，
 *       在途量自动计入事件保障量；缺口如实挂账反馈。
 * 回执：接收方确认调拨（可同批认定短缺），按类型归集联动签收全部在途调拨
 *       单，四本账闭环后请求转「已回执」终态；挂起/撤回单不参与签收。
 * 撤销：出库前（待审批/待调拨）请求方可撤销，留痕终态。
 * 回写：库存（调拨扣减/流水）、事件保障量（实收+在途）、事件时间线、大屏
 *       统计与复盘分支（录帧/seek/分叉隔离）全程联动。
 * ========================================================================= */

let aidSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const statusMeta = (v) => AID_STATUS.find((s) => s.value === v) || { label: v, color: '#9e9e9e' }
const resLabel = (t) => RESOURCE_TYPES[t]?.label || t
const resUnit = (t) => RESOURCE_TYPES[t]?.unit || ''
const itemDesc = (list, key = 'qty') => list.map((it) => `${resLabel(it.type)} ${it[key]}${resUnit(it.type)}`).join('、')

export const useAidStore = defineStore('aid', {
  state: () => ({
    teams: [],            // 外部支援队伍目录
    requests: [],         // 互援请求单（请求—审批—执行—回执）
    focusRequestId: null  // 调度面板联动定位的请求单
  }),

  getters: {
    pendingRequests: (s) => s.requests.filter((r) => r.status === 'requested'),
    approvedRequests: (s) => s.requests.filter((r) => r.status === 'approved'),
    deliveringRequests: (s) => s.requests.filter((r) => r.status === 'delivering'),
    // 进行中（待审批 / 待调拨 / 调拨在途）
    activeRequests: (s) => s.requests.filter((r) => ['requested', 'approved', 'delivering'].includes(r.status)),
    requestOf: (s) => (id) => s.requests.find((r) => r.id === id) || null,
    teamOf: (s) => (id) => s.teams.find((t) => t.id === id) || null,
    // 大屏统计
    stats() {
      return {
        pending: this.pendingRequests.length,
        approved: this.approvedRequests.length,
        delivering: this.deliveringRequests.length,
        received: this.requests.filter((r) => r.status === 'received').length,
        total: this.requests.length
      }
    }
  },

  actions: {
    _cmd() { return useCommandStore() },
    _req(id) { return this.requests.find((r) => r.id === id) },
    _log(r, text) { r.log.push({ at: nowStr(), text }) },
    _evLog(eventId, text) {
      const ev = this._cmd().events.find((e) => e.id === eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },
    statusText(v) { return statusMeta(v).label },
    statusColor(v) { return statusMeta(v).color },

    // 场景载入：挂载外部队伍目录，清空请求单
    load() {
      this.teams = AID_TEAMS.map((t) => ({ ...t }))
      this.requests = []
      this.focusRequestId = null
    },

    /* ---------- 请求：外部队伍提交资源请求 ---------- */

    submitRequest({ teamId, eventId, items = [], reason = '' } = {}) {
      const cmd = this._cmd()
      const team = this.teamOf(teamId)
      if (!team) return { ok: false, msg: '请选择提交请求的支援队伍' }
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!ev) return { ok: false, msg: '请选择支援的灾情事件' }
      if (ev.status === 'closed') return { ok: false, msg: '事件已结案，不再受理互援请求' }
      // 合并同类资源行，过滤非法数量
      const merged = {}
      ;(Array.isArray(items) ? items : []).forEach((it) => {
        if (!it || !RESOURCE_TYPES[it.type]) return
        const q = Math.max(0, Math.round(it.qty || 0))
        if (q > 0) merged[it.type] = (merged[it.type] || 0) + q
      })
      const list = Object.entries(merged).map(([type, qty]) => ({ type, qty }))
      if (!list.length) return { ok: false, msg: '请至少填写一类有效资源及数量' }
      const req = {
        id: 'aid-' + Date.now() + '-' + ++aidSeq,
        teamId, teamName: team.name, region: team.region, contact: team.contact,
        eventId, eventTitle: ev.title,
        items: list.map((it) => ({ ...it, approved: null })), // approved：审批核定配额
        reason: (reason || '').trim(),
        status: 'requested',
        // 审批留痕
        reviewedBy: null, reviewedAt: null, reviewNote: '', rejectReason: '',
        // 执行：调拨出库明细 [{ dispatchId, baseId, baseName, type, qty }]；unmet 为库存不足缺口
        allocations: [], unmet: [],
        // 回执留痕
        receivedBy: null, receivedAt: null, receiptNote: '',
        cancelReason: '',
        createdAt: nowStr(),
        log: []
      }
      this.requests.unshift(req)
      this._log(req, `📨 互援请求提交：${team.name}（${team.region}）经「${team.channel}」请求 ${itemDesc(list)}`
        + (req.reason ? `；事由：${req.reason}` : ''))
      this._evLog(eventId, `🤝 跨区域互援请求：${team.name} 请求 ${itemDesc(list)}`)
      this.focusRequestId = req.id
      return { ok: true, request: req }
    },

    /* ---------- 审批：指挥员核定配额 / 驳回 ---------- */

    // 核定配额：quota 缺省项按请求量；超请求量截断；全部为零须走驳回
    reviewRequest(id, { quota = {}, note = '', by = '' } = {}) {
      const r = this._req(id)
      if (!r) return { ok: false, msg: '互援请求不存在' }
      if (r.status !== 'requested') return { ok: false, msg: `当前状态（${this.statusText(r.status)}）不能审批` }
      let total = 0
      r.items.forEach((it) => {
        const q = quota[it.type] != null ? Math.max(0, Math.round(quota[it.type])) : it.qty
        it.approved = Math.min(it.qty, q)
        total += it.approved
      })
      if (total <= 0) return { ok: false, msg: '核定配额不能全部为零（可驳回该请求）' }
      r.status = 'approved'
      r.reviewedBy = (by || '').trim() || '指挥员'
      r.reviewedAt = nowStr()
      r.reviewNote = (note || '').trim()
      const cut = r.items.filter((it) => it.approved < it.qty)
      this._log(r, `✅ 指挥员审批通过（${r.reviewedBy}）：核定配额 ${itemDesc(r.items, 'approved')}`
        + (cut.length ? `，核减 ${cut.map((it) => `${resLabel(it.type)} ${it.qty - it.approved}${resUnit(it.type)}`).join('、')}` : '')
        + (r.reviewNote ? `；备注：${r.reviewNote}` : ''))
      this._evLog(r.eventId, `✅ 互援请求审批通过：${r.teamName} 核定 ${itemDesc(r.items, 'approved')}`)
      return { ok: true, request: r }
    },

    rejectRequest(id, { reason = '', by = '' } = {}) {
      const r = this._req(id)
      if (!r) return { ok: false, msg: '互援请求不存在' }
      if (r.status !== 'requested') return { ok: false, msg: `当前状态（${this.statusText(r.status)}）不能驳回` }
      r.status = 'rejected'
      r.reviewedBy = (by || '').trim() || '指挥员'
      r.reviewedAt = nowStr()
      r.rejectReason = (reason || '').trim() || '统筹资源不足，暂缓支援'
      this._log(r, `⚪ 请求驳回（${r.reviewedBy}）：${r.rejectReason}`)
      this._evLog(r.eventId, `⚪ 互援请求驳回：${r.teamName}（${r.rejectReason}）`)
      return { ok: true, request: r }
    },

    /* ---------- 执行：按核定配额就近调拨出库 ---------- */

    // 就近出库（库存不足跨基地拆单），生成「互援调拨」派发并回链请求单；
    // 幂等防护：仅「待调拨」可执行；库存不足部分如实挂账（unmet），不出虚假量
    executeAid(id) {
      const r = this._req(id)
      if (!r) return { ok: false, msg: '互援请求不存在' }
      if (r.status !== 'approved') return { ok: false, msg: `当前状态（${this.statusText(r.status)}）不能执行调拨` }
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === r.eventId)
      if (!ev) return { ok: false, msg: '关联事件不存在' }
      const sent = []
      const unmet = []
      r.items.filter((it) => (it.approved ?? 0) > 0).forEach((it) => {
        let need = it.approved
        // 候选基地按运输时长升序，可用量须扣除协同方案生效预占
        const cands = cmd.bases
          .filter((b) => (cmd.availableMap[b.id + '|' + it.type] ?? 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, cmd.availableMap[c.b.id + '|' + it.type] ?? 0)
          const rec = cmd._pushDispatch(c.b.id, ev.id, it.type, take, '互援调拨')
          if (rec) {
            rec.aidId = r.id
            rec.aidTeam = r.teamName
            r.allocations.push({ dispatchId: rec.id, baseId: c.b.id, baseName: c.b.name, type: it.type, qty: take })
            sent.push(rec)
            need -= take
          }
        }
        if (need > 0) unmet.push({ type: it.type, qty: need })
      })
      if (!sent.length) return { ok: false, msg: '各基地可用库存不足，调拨未能出库' }
      r.status = 'delivering'
      r.unmet = unmet
      const made = sent.reduce((s, x) => s + x.qty, 0)
      this._log(r, `🚚 调拨执行：${sent.length} 批共 ${made} 单位出库（${sent.map((x) => `${x.typeLabel}${x.qty}${x.unit}👈${x.baseName}`).join('、')}）`
        + (unmet.length ? `；库存不足缺口 ${itemDesc(unmet)}` : ''))
      this._evLog(r.eventId, `🚚 互援调拨出库：${r.teamName} 核定物资 ${sent.length} 批在途`)
      return { ok: true, request: r, sent, unmet }
    },

    /* ---------- 回执：接收方确认调拨（联动签收在途调拨单） ---------- */

    // 按类型归集在途调拨单逐单签收；shorts 可同批认定短缺；全部调拨单办结后请求转「已回执」
    confirmReceipt(id, { by = '', note = '', shorts = {} } = {}) {
      const r = this._req(id)
      if (!r) return { ok: false, msg: '互援请求不存在' }
      if (r.status !== 'delivering') return { ok: false, msg: `当前状态（${this.statusText(r.status)}）不能回执` }
      const cmd = this._cmd()
      const receiver = (by || '').trim() || r.contact || r.teamName
      let signedTotal = 0
      let shortTotal = 0
      const types = [...new Set(r.allocations.map((a) => a.type))]
      types.forEach((type) => {
        const rows = r.allocations
          .filter((a) => a.type === type)
          .map((a) => cmd.dispatches.find((d) => d.id === a.dispatchId))
          .filter((d) => d && d.status === 'enroute')
        const outstanding = rows.reduce((s, d) => s + dispatchParts(d).outstanding, 0)
        if (outstanding <= 0) return
        let short = Math.max(0, Math.min(Math.round(shorts[type] || 0), outstanding))
        let toReceive = outstanding - short
        rows.forEach((d) => {
          const out = dispatchParts(d).outstanding
          if (out <= 0) return
          const take = Math.min(toReceive, out)
          toReceive -= take
          const sh = Math.min(short, out - take)
          short -= sh
          if (take + sh > 0) cmd.signDispatch(d.id, { qty: take, shortQty: sh, receiver })
          signedTotal += take
          shortTotal += sh
        })
      })
      r.receivedBy = receiver
      r.receivedAt = nowStr()
      r.receiptNote = (note || '').trim()
      // 全部调拨单进入终态（办结/撤回）→ 请求转「已回执」；挂起单不参与，待续派后再次回执
      const allDone = r.allocations.every((a) => {
        const d = cmd.dispatches.find((x) => x.id === a.dispatchId)
        return d && (d.status === 'done' || d.status === 'withdrawn')
      })
      if (allDone) r.status = 'received'
      this._log(r, `📥 接收方回执（${receiver}）：确认接收 ${signedTotal} 单位`
        + (shortTotal ? `，现场认定短缺 ${shortTotal} 单位` : '')
        + (r.receiptNote ? `；备注：${r.receiptNote}` : ''))
      this._evLog(r.eventId, `📥 互援回执：${r.teamName} 确认接收调拨物资${shortTotal ? `（含短缺认定 ${shortTotal}）` : ''}`)
      return { ok: true, request: r, signed: signedTotal, shortage: shortTotal, done: r.status === 'received' }
    },

    /* ---------- 撤销：出库前请求方可撤回 ---------- */

    cancelRequest(id, { reason = '' } = {}) {
      const r = this._req(id)
      if (!r) return { ok: false, msg: '互援请求不存在' }
      if (r.status !== 'requested' && r.status !== 'approved') {
        return { ok: false, msg: `当前状态（${this.statusText(r.status)}）不能撤销` }
      }
      r.status = 'cancelled'
      r.cancelReason = (reason || '').trim() || '请求方自行撤销'
      this._log(r, `🚫 请求撤销：${r.cancelReason}`)
      this._evLog(r.eventId, `🚫 互援请求撤销：${r.teamName}（${r.cancelReason}）`)
      return { ok: true, request: r }
    },

    focusRequest(id) { this.focusRequestId = id }
  }
})
