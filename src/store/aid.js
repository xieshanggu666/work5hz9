import { defineStore } from 'pinia'
import { useCommandStore, dispatchParts, roughPath } from '@/store/command'
import { AID_TEAMS, AID_STATUS, RESOURCE_TYPES } from '@/mock/data'

/* =========================================================================
 * 跨区域互援协同模块
 *
 * 请求：外部互援队伍（兄弟市县/社会救援力量）针对本辖区灾情事件提交资源请求，
 *       同一队伍对同一事件同时只允许一张进行中的请求单（防重复提交）。
 * 审批：指挥员逐项审核配额（核准量 ≤ 申请量，可核减），核准后待调拨；
 *       不予支援可驳回（留痕终态）。
 * 执行：按核准配额就近出库（可用量 = 实物库存 − 协同预占，库存不足跨基地拆单、
 *       缺口如实反馈），生成来源「跨区互援」的派发单并回链请求单；
 *       出库即扣库存、入库存变动流水（口径「互援调拨扣减」），计入事件保障量。
 * 回执：接收方（互援队伍）确认调拨，批量签收全部在途关联派发，
 *       实收量回写事件保障量（实收口径）；挂起中的批次须续派后才能回执。
 * 终止：审批前撤销无库存影响；调拨中终止把在途余量原路回库（签收/短缺账目留档）。
 * 联动：全生命周期写入事件时间线；请求单纳入复盘录帧、seek 还原与分支对照。
 * ========================================================================= */

let aidSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const statusMeta = (v) => AID_STATUS.find((s) => s.value === v) || { label: v, color: '#9e9e9e' }
const resMeta = (t) => RESOURCE_TYPES[t] || { label: t, unit: '' }

// 进行中的状态（占用「同队伍×同事件」唯一在办名额）
const IN_FLIGHT = ['requested', 'approved', 'executing']

export const useAidStore = defineStore('aid', {
  state: () => ({
    teams: [],            // 外部互援队伍目录
    requests: [],         // 互援请求单
    currentTeamId: null,  // 当前模拟的外部队伍身份（演示提交端）
    focusRequestId: null  // 调度面板联动定位的请求单
  }),

  getters: {
    currentTeam(state) {
      return state.teams.find((t) => t.id === state.currentTeamId) || state.teams[0] || null
    },
    teamOf: (state) => (id) => state.teams.find((t) => t.id === id) || null,
    requestOf: (state) => (id) => state.requests.find((r) => r.id === id) || null,
    // 待指挥员审批
    pendingRequests: (state) => state.requests.filter((r) => r.status === 'requested'),
    // 已审批待调拨
    approvedRequests: (state) => state.requests.filter((r) => r.status === 'approved'),
    // 调拨中待回执
    executingRequests: (state) => state.requests.filter((r) => r.status === 'executing'),
    // 大屏统计
    stats() {
      return {
        pending: this.pendingRequests.length,
        approved: this.approvedRequests.length,
        executing: this.executingRequests.length,
        received: this.requests.filter((r) => r.status === 'received').length,
        total: this.requests.length
      }
    },
    // 请求单关联的派发记录（调拨进度展示）
    dispatchesOf: () => (req) => {
      const cmd = useCommandStore()
      return (req?.dispatchIds || []).map((id) => cmd.dispatches.find((d) => d.id === id)).filter(Boolean)
    }
  },

  actions: {
    _cmd() { return useCommandStore() },
    _req(id) { return this.requests.find((r) => r.id === id) },
    _log(req, text) { req.log.push({ at: nowStr(), text }) },
    _evLog(eventId, text) {
      const ev = this._cmd().events.find((e) => e.id === eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
      return ev
    },
    statusText(v) { return statusMeta(v).label },
    statusColor(v) { return statusMeta(v).color },
    resLabel(t) { return resMeta(t).label },
    resUnit(t) { return resMeta(t).unit },
    itemsText(items, key = 'qty') {
      return (items || [])
        .filter((i) => (i[key] ?? 0) > 0)
        .map((i) => `${resMeta(i.type).label} ${i[key]}${resMeta(i.type).unit}`)
        .join('、')
    },

    // 场景载入：挂载互援队伍目录，清空请求单
    load() {
      this.teams = AID_TEAMS.map((t) => ({ ...t }))
      this.requests = []
      this.currentTeamId = this.teams[0]?.id || null
      this.focusRequestId = null
    },
    // 切换模拟的外部队伍身份（演示提交端）
    switchTeam(id) {
      if (this.teams.some((t) => t.id === id)) this.currentTeamId = id
    },
    focusAid(id) { this.focusRequestId = id },

    /* ---------- 请求：外部队伍提交资源请求 ---------- */

    submitRequest({ teamId, eventId, items, reason = '' } = {}) {
      const cmd = this._cmd()
      const team = this.teams.find((t) => t.id === teamId)
      if (!team) return { ok: false, msg: '互援队伍不存在' }
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!ev) return { ok: false, msg: '请选择保障事件' }
      if (ev.status === 'closed') return { ok: false, msg: '事件已结案，不能再提交互援请求' }
      // 归并同类资源、过滤非法数量
      const merged = {}
      ;(items || []).forEach((it) => {
        const q = Math.max(0, Math.round(it.qty || 0))
        if (q > 0 && RESOURCE_TYPES[it.type]) merged[it.type] = (merged[it.type] || 0) + q
      })
      const list = Object.entries(merged).map(([type, qty]) => ({ type, qty, approved: null, sent: 0, unmet: 0 }))
      if (!list.length) return { ok: false, msg: '请至少填写一类资源的需求数量' }
      const dup = this.requests.find((r) => r.teamId === teamId && r.eventId === eventId && IN_FLIGHT.includes(r.status))
      if (dup) return { ok: false, msg: `该队伍对同一事件已有进行中的请求单（${dup.id}），请先办结或终止` }
      const req = {
        id: 'aid-' + Date.now() + '-' + ++aidSeq,
        teamId: team.id, teamName: team.name, region: team.region, contact: team.contact,
        eventId: ev.id, eventTitle: ev.title,
        items: list,
        reason: (reason || '').trim(),
        status: 'requested',
        dispatchIds: [],
        submittedAt: nowStr(),
        reviewedAt: null, reviewedBy: '', reviewNote: '',
        executedAt: null,
        receivedAt: null, receiptBy: '', receiptNote: '', receipt: null,
        rejectedAt: null, rejectReason: '',
        cancelledAt: null, cancelReason: '',
        log: []
      }
      this.requests.unshift(req)
      this._log(req, `🤝 互援请求提交：申请 ${this.itemsText(list)}，待指挥员审批`)
      this._evLog(ev.id, `🤝 跨区互援请求：${team.name}（${team.region}）申请 ${this.itemsText(list)}，待审批`)
      this.focusRequestId = req.id
      return { ok: true, request: req }
    },

    /* ---------- 审批：指挥员审核配额 / 驳回 ---------- */

    // 审核配额：quota 逐项核准（缺省按申请量核准；核准量截断到 [0, 申请量]）
    reviewRequest(id, { items = null, by = '', note = '' } = {}) {
      const req = this._req(id)
      if (!req) return { ok: false, msg: '互援请求不存在' }
      if (req.status !== 'requested') return { ok: false, msg: `当前状态（${statusMeta(req.status).label}）不能审批` }
      const quota = {}
      ;(items || []).forEach((it) => { if (it && it.type) quota[it.type] = it.qty })
      let total = 0
      req.items.forEach((it) => {
        let q = quota[it.type] != null ? Math.round(Number(quota[it.type])) : it.qty
        if (!Number.isFinite(q)) q = 0
        q = Math.max(0, Math.min(it.qty, q))
        it.approved = q
        total += q
      })
      if (total <= 0) return { ok: false, msg: '核准配额不能全为 0，不予支援请驳回' }
      req.status = 'approved'
      req.reviewedAt = nowStr()
      req.reviewedBy = (by || '').trim() || '指挥员'
      req.reviewNote = (note || '').trim()
      this._log(req, `✅ 审批通过（${req.reviewedBy}）：核准 ${this.itemsText(req.items, 'approved')}`
        + (req.reviewNote ? `，备注：${req.reviewNote}` : ''))
      this._evLog(req.eventId, `✅ 互援审批：${req.teamName} 核准 ${this.itemsText(req.items, 'approved')}，待调拨`)
      return { ok: true, request: req }
    },

    // 驳回：不予支援（留痕终态）
    rejectRequest(id, { by = '', reason = '' } = {}) {
      const req = this._req(id)
      if (!req) return { ok: false, msg: '互援请求不存在' }
      if (req.status !== 'requested') return { ok: false, msg: `当前状态（${statusMeta(req.status).label}）不能驳回` }
      req.status = 'rejected'
      req.rejectedAt = nowStr()
      req.rejectReason = (reason || '').trim() || '运力/库存不足，暂无法支援'
      req.reviewedBy = (by || '').trim() || '指挥员'
      this._log(req, `⚪ 请求驳回（${req.reviewedBy}）：${req.rejectReason}`)
      this._evLog(req.eventId, `⚪ 互援请求驳回：${req.teamName}（${req.rejectReason}）`)
      return { ok: true, request: req }
    },

    /* ---------- 执行：按核准配额调拨出库 ---------- */

    // 执行调拨：就近出库（可用量扣除协同预占），库存不足跨基地拆单、缺口如实反馈
    executeRequest(id) {
      const cmd = this._cmd()
      const req = this._req(id)
      if (!req) return { ok: false, msg: '互援请求不存在' }
      if (req.status !== 'approved') return { ok: false, msg: `当前状态（${statusMeta(req.status).label}）不能执行调拨` }
      const ev = cmd.events.find((e) => e.id === req.eventId)
      if (!ev) return { ok: false, msg: '关联事件不存在' }
      if (ev.status === 'closed') return { ok: false, msg: '事件已结案，不能执行调拨' }
      const sent = []
      req.items.forEach((it) => {
        let need = it.approved || 0
        it.sent = 0
        it.unmet = 0
        if (need <= 0) return
        // 候选基地按运输时长升序，可用量 = 实物库存 − 协同预占
        const cands = cmd.bases
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat), avail: cmd.availableMap[b.id + '|' + it.type] ?? 0 }))
          .filter((x) => x.avail > 0)
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, c.avail)
          const rec = cmd._pushDispatch(c.b.id, ev.id, it.type, take, '跨区互援')
          if (rec) {
            rec.aidRequestId = req.id
            rec.aidTeam = req.teamName
            req.dispatchIds.push(rec.id)
            sent.push(rec)
            need -= take
            it.sent += take
          }
        }
        it.unmet = need
      })
      const made = sent.reduce((s, r) => s + r.qty, 0)
      if (made <= 0) return { ok: false, msg: '各基地可用库存不足，调拨未能执行（可终止请求）' }
      req.status = 'executing'
      req.executedAt = nowStr()
      const unmetItems = req.items.filter((i) => i.unmet > 0)
      const text = `🚚 调拨执行：${sent.length} 批出库（${sent.map((r) => `${r.typeLabel}${r.qty}${r.unit}👈${r.baseName}`).join('、')}）`
        + (unmetItems.length ? `；库存不足仍缺 ${this.itemsText(unmetItems, 'unmet')}` : '')
      this._log(req, text)
      this._evLog(req.eventId, `🤝 互援调拨（${req.teamName}）：${text}`)
      return { ok: true, request: req, sent, unmet: unmetItems }
    },

    /* ---------- 回执：接收方确认调拨 ---------- */

    // 接收方确认回执：批量签收全部在途关联派发，实收量回写事件保障量
    confirmReceipt(id, { by = '', note = '' } = {}) {
      const cmd = this._cmd()
      const req = this._req(id)
      if (!req) return { ok: false, msg: '互援请求不存在' }
      if (req.status !== 'executing') return { ok: false, msg: `当前状态（${statusMeta(req.status).label}）不能回执` }
      const linked = this.dispatchesOf(req)
      const held = linked.filter((d) => d.status === 'held')
      if (held.length) return { ok: false, msg: `${held.length} 批调拨挂起中，待恢复通行续派后再回执` }
      const receiver = (by || '').trim() || req.contact || req.teamName
      let signedTotal = 0
      linked.forEach((d) => {
        if (d.status !== 'enroute') return
        const out = dispatchParts(d).outstanding
        if (out <= 0) return
        const r = cmd.signDispatch(d.id, { qty: out, receiver })
        if (r && r.ok) signedTotal += out
      })
      // 关联派发全部撤回/退回且无实收：无物可回执，应走终止
      const anyReceived = linked.some((d) => (d.signedQty || 0) > 0)
      if (signedTotal === 0 && !anyReceived) {
        return { ok: false, msg: '关联调拨均已撤回/退回，无实收可回执，请终止请求' }
      }
      const got = {}
      linked.forEach((d) => { got[d.type] = (got[d.type] || 0) + (d.signedQty || 0) })
      req.status = 'received'
      req.receivedAt = nowStr()
      req.receiptBy = receiver
      req.receiptNote = (note || '').trim()
      req.receipt = { at: req.receivedAt, by: receiver, items: got }
      const gotText = Object.entries(got).map(([t, q]) => `${resMeta(t).label} ${q}${resMeta(t).unit}`).join('、')
      this._log(req, `📨 接收方回执（${receiver}）：确认接收 ${gotText}，请求办结`
        + (req.receiptNote ? `，备注：${req.receiptNote}` : ''))
      this._evLog(req.eventId, `📨 互援回执：${req.teamName} 确认接收 ${gotText}`)
      return { ok: true, request: req, signed: signedTotal }
    },

    /* ---------- 终止：撤销请求（调拨中在途余量回库留账） ---------- */

    cancelRequest(id, { by = '', reason = '' } = {}) {
      const cmd = this._cmd()
      const req = this._req(id)
      if (!req) return { ok: false, msg: '互援请求不存在' }
      if (req.status === 'received') return { ok: false, msg: '请求已回执办结，不能终止' }
      if (req.status === 'rejected') return { ok: false, msg: '请求已驳回，不能重复操作' }
      if (req.status === 'cancelled') return { ok: false, msg: '请求已终止，不能重复操作' }
      let back = 0
      if (req.status === 'executing') {
        // 调拨中终止：关联派发的在途余量原路回库，已签收/短缺/退回账目留档
        req.dispatchIds.forEach((did) => {
          const rec = cmd.dispatches.find((d) => d.id === did)
          if (rec && rec.status !== 'withdrawn' && rec.status !== 'done') {
            back += dispatchParts(rec).outstanding
            cmd.withdrawDispatch(did)
          }
        })
      }
      req.status = 'cancelled'
      req.cancelledAt = nowStr()
      req.cancelReason = (reason || '').trim() || '指挥员终止互援调拨'
      const who = (by || '').trim() || '指挥员'
      this._log(req, `🚫 请求终止（${who}）：${req.cancelReason}` + (back > 0 ? `，在途余量 ${back} 已回库` : ''))
      this._evLog(req.eventId, `🚫 互援请求终止：${req.teamName}（${req.cancelReason}）` + (back > 0 ? `，在途余量 ${back} 已回库` : ''))
      return { ok: true, request: req, back }
    }
  }
})
