// 跨区域互援协同：外部队伍提交资源请求 → 指挥员审核配额 → 执行调拨（扣库存/计保障量）
// → 接收方确认回执 → 终止/驳回留痕 → 回写库存/事件保障量/大屏 → 复盘录帧与分支隔离
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useWarningStore } from '@/store/warning'
import { useAidStore } from '@/store/aid'
import { useReplayStore, installReplayRecorder } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const rp = useRepairStore()
const wn = useWarningStore()
const aid = useAidStore()
const replay = useReplayStore()
cmd.loadScenario('s1')
tr.load()
rb.load()
rp.load()
wn.load()
aid.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}
const ev = (id) => cmd.events.find((e) => e.id === id)
const base = (id) => cmd.bases.find((b) => b.id === id)
const tl = (id) => ev(id).timeline.map((t) => t.text).join('\n')

console.log('— 场景载入：互援队伍目录就绪，无请求单 —')
assert(aid.teams.length === 4, '互援队伍目录 4 支（消防/蓝天/民兵/舟桥）')
assert(aid.currentTeam.id === 'at-1', '默认模拟身份为德阳消防')
assert(aid.requests.length === 0, '初始无请求单')
const s0 = aid.stats
assert(s0.pending === 0 && s0.executing === 0 && s0.total === 0, '大屏统计初始为零')

console.log('— 提交校验：非法队伍/事件/空明细/同类归并 —')
assert(!aid.submitRequest({ teamId: 'at-x', eventId: 'ev-001', items: [{ type: 'water', qty: 10 }] }).ok, '非法队伍被拒')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-x', items: [{ type: 'water', qty: 10 }] }).ok, '非法事件被拒')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'water', qty: 0 }] }).ok, '空数量明细被拒')
const sub = aid.submitRequest({
  teamId: 'at-1', eventId: 'ev-001',
  items: [{ type: 'water', qty: 300 }, { type: 'water', qty: 200 }, { type: 'food', qty: 300 }],
  reason: '江油驻点补给告急'
})
assert(sub.ok && sub.request.status === 'requested', '请求提交成功，待审批')
assert(sub.request.items.length === 2 && sub.request.items[0].qty === 500, '同类资源归并（水 300+200=500）')
assert(tl('ev-001').includes('跨区互援请求'), '事件时间线回写互援请求')
assert(aid.stats.pending === 1, '大屏统计：待审批 1')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'tent', qty: 10 }] }).ok, '同队伍同事件重复提交被拦截')
assert(aid.submitRequest({ teamId: 'at-2', eventId: 'ev-001', items: [{ type: 'tent', qty: 10 }] }).ok, '不同队伍不受在办名额限制')
aid.cancelRequest(aid.requests[0].id, { reason: '测试清理' })

console.log('— 审批：配额核减截断 + 状态流转 —')
const q1 = sub.request
assert(!aid.executeRequest(q1.id).ok, '待审批状态不能执行调拨')
const rev = aid.reviewRequest(q1.id, { items: [{ type: 'water', qty: 600 }], note: '水按申请量核准' })
assert(rev.ok && q1.status === 'approved', '审批通过转待调拨')
assert(q1.items[0].approved === 500, '核准量截断到申请量（600→500）')
assert(q1.items[1].approved === 300, '未填项按申请量核准（食品 300）')
assert(q1.reviewNote === '水按申请量核准', '审批备注留痕')
assert(tl('ev-001').includes('互援审批'), '事件时间线回写审批')
assert(!aid.reviewRequest(q1.id, {}).ok, '重复审批被拦截')
assert(!aid.rejectRequest(q1.id, {}).ok, '已审批不能驳回')

console.log('— 执行调拨：就近出库 + 库存回写 + 事件保障量 —')
const w0 = base('rb-2').stock.water
const f0 = base('rb-2').stock.food
const mv0 = cmd.stockMovements.length
const exe = aid.executeRequest(q1.id)
assert(exe.ok && exe.sent.length === 2, '调拨执行出库 2 批')
assert(q1.status === 'executing', '状态转调拨中·待回执')
assert(base('rb-2').stock.water === w0 - 500, '就近基地（绵阳库）饮用水扣减 500')
assert(base('rb-2').stock.food === f0 - 300, '就近基地食品扣减 300')
assert(exe.sent.every((d) => d.source === '跨区互援' && d.aidRequestId === q1.id && d.aidTeam === q1.teamName), '派发单回链互援请求')
const aidMoves = cmd.stockMovements.slice(mv0)
assert(aidMoves.length === 2 && aidMoves.every((m) => m.kind === 'aid' && m.label === '互援调拨扣减'), '库存变动流水按「互援调拨扣减」入账')
assert((cmd.sentMap['ev-001']?.water || 0) >= 500 && (cmd.sentMap['ev-001']?.food || 0) >= 300, '事件保障量（实收+在途）已计入')
assert(tl('ev-001').includes('互援调拨'), '事件时间线回写调拨执行')
assert(!aid.executeRequest(q1.id).ok, '重复执行被拦截')
assert(aid.stats.executing === 1, '大屏统计：调拨中 1')

console.log('— 回执：接收方确认 + 实收回写保障量 —')
const rc = aid.confirmReceipt(q1.id, {})
assert(rc.ok && rc.signed === 800, '回执批量签收 800 单位（水500+食品300）')
assert(q1.status === 'received' && q1.receiptBy === '李队长', '状态转已回执，默认接收方为队伍联络人')
assert(q1.receipt.items.water === 500 && q1.receipt.items.food === 300, '回执明细按类型汇总')
assert(cmd.dispatches.filter((d) => d.aidRequestId === q1.id).every((d) => d.status === 'done'), '关联派发全部办结')
assert((cmd.receivedMap['ev-001']?.water || 0) >= 500, '事件保障量实收口径回写')
assert(tl('ev-001').includes('互援回执'), '事件时间线回写回执')
assert(!aid.confirmReceipt(q1.id).ok, '重复回执被拦截')
assert(!aid.reviewRequest(q1.id, {}).ok, '已回执不能审批')
assert(!aid.executeRequest(q1.id).ok, '已回执不能执行')
assert(!aid.cancelRequest(q1.id).ok, '已回执不能终止')

console.log('— 驳回：留痕终态 —')
const q2 = aid.submitRequest({ teamId: 'at-2', eventId: 'ev-002', items: [{ type: 'medical', qty: 100 }] }).request
const rj = aid.rejectRequest(q2.id, { reason: '本地医疗储备紧张' })
assert(rj.ok && q2.status === 'rejected' && q2.rejectReason === '本地医疗储备紧张', '驳回留痕')
assert(tl('ev-002').includes('互援请求驳回'), '事件时间线回写驳回')
assert(!aid.reviewRequest(q2.id, {}).ok, '已驳回不能审批')
assert(!aid.cancelRequest(q2.id).ok, '已驳回不能重复终结')

console.log('— 审批后事件结案：执行拦截；已审批终止无库存影响 —')
const q3 = aid.submitRequest({ teamId: 'at-3', eventId: 'ev-003', items: [{ type: 'tent', qty: 100 }] }).request
aid.reviewRequest(q3.id, {})
cmd.advanceStatus('ev-003', 'closed')
const exeClosed = aid.executeRequest(q3.id)
assert(!exeClosed.ok && exeClosed.msg.includes('结案'), '事件已结案执行调拨被拦截')
const tent0 = base('rb-2').stock.tent
const cc = aid.cancelRequest(q3.id, { reason: '事件结案终止' })
assert(cc.ok && cc.back === 0 && q3.status === 'cancelled', '已审批终止（未出库无回库量）')
assert(base('rb-2').stock.tent === tent0, '终止未出库请求不影响库存')
assert(!aid.submitRequest({ teamId: 'at-3', eventId: 'ev-003', items: [{ type: 'tent', qty: 10 }] }).ok, '已结案事件不能提交请求')

console.log('— 调拨中终止：在途余量回库留账 —')
const q4 = aid.submitRequest({ teamId: 'at-4', eventId: 'ev-001', items: [{ type: 'vehicle', qty: 10 }] }).request
aid.reviewRequest(q4.id, {})
const v0 = base('rb-2').stock.vehicle
aid.executeRequest(q4.id)
assert(base('rb-2').stock.vehicle === v0 - 10, '车辆出库扣减 10')
const cx = aid.cancelRequest(q4.id, { reason: '道路中断暂缓支援' })
assert(cx.ok && cx.back === 10, '终止回库在途 10 辆')
assert(base('rb-2').stock.vehicle === v0, '库存已回补')
const d4 = cmd.dispatches.find((d) => d.aidRequestId === q4.id)
assert(d4.status === 'withdrawn' && d4.withdrawnQty === 10, '关联派发撤回留账')
assert(q4.status === 'cancelled', '状态转已终止')
assert(!aid.cancelRequest(q4.id).ok, '重复终止被拦截')

console.log('— 库存不足：跨基地拆单 + 缺口如实反馈 —')
const q5 = aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'tent', qty: 20000 }] }).request
aid.reviewRequest(q5.id, {})
const exe5 = aid.executeRequest(q5.id)
assert(exe5.ok && exe5.sent.length === 4, '帐篷跨 4 基地拆单出库')
assert(q5.items[0].sent === 12000 && q5.items[0].unmet === 8000, '已调拨 12000、缺口 8000 如实反馈')
assert(base('rb-1').stock.tent === 0 && base('rb-2').stock.tent === 0 && base('rb-5').stock.tent === 0, '各基地帐篷库存清零')
assert(exe5.unmet.length === 1 && exe5.unmet[0].unmet === 8000, '返回未满足缺口')
aid.cancelRequest(q5.id, { reason: '测试清理' })
assert(base('rb-1').stock.tent === 6000 && base('rb-2').stock.tent === 3000, '终止后帐篷库存回补')

console.log('— 挂起阻断回执，续派后放行 —')
const q6 = aid.submitRequest({ teamId: 'at-2', eventId: 'ev-001', items: [{ type: 'food', qty: 100 }] }).request
aid.reviewRequest(q6.id, {})
aid.executeRequest(q6.id)
const d6 = cmd.dispatches.find((d) => d.aidRequestId === q6.id)
cmd.holdDispatch(d6.id, 'blk-x')
const rcBlocked = aid.confirmReceipt(q6.id, {})
assert(!rcBlocked.ok && rcBlocked.msg.includes('挂起'), '挂起中回执被拦截')
cmd.resumeDispatch(d6.id)
const rcOk = aid.confirmReceipt(q6.id, {})
assert(rcOk.ok && q6.status === 'received', '续派后回执放行')

console.log('— 大屏统计口径 —')
const st = aid.stats
assert(st.total === 7, '请求单累计 7 张（含驳回/终止留痕）')
assert(st.received === 2 && st.pending === 0 && st.executing === 0, '已回执 2、无待批/调拨中')

console.log('— 复盘集成：互援动作录帧 + seek 还原 + 分支隔离 —')
cmd.loadScenario('s1')
tr.load(); rb.load(); rp.load(); wn.load(); aid.load()
installReplayRecorder()
replay.begin()
const r1 = aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'water', qty: 200 }] }).request
aid.reviewRequest(r1.id, {})
aid.executeRequest(r1.id)
aid.confirmReceipt(r1.id, {})
const aidFrames = replay.frames.filter((f) => f.category === 'aid')
assert(aidFrames.length === 4, '互援动作沉淀 4 帧（提交/审批/执行/回执）')
assert(aidFrames[0].title.includes('互援') && aidFrames[3].title.includes('回执'), '帧标题描述互援动作')
replay.seek(0)
assert(aid.requests.length === 0 && base('rb-2').stock.water === 9000, 'seek 回基线：请求单与库存还原')
replay.seek(replay.frames.length - 1)
assert(aid.requests.length === 1 && aid.requests[0].status === 'received', 'seek 回最新：请求单与回执状态还原')
assert(replay.currentLogs.some((l) => l.source === 'aid'), '帧内互援日志已汇总')
assert(replay.currentDiff.statusChanges.some((c) => c.text.includes('互援请求')), '帧差异含互援状态变化')

console.log('— 分支隔离：分叉后驳回不影响主干 —')
replay.seek(1) // 提交请求之后
const bId = replay.resumeHere({ name: '驳回演练' })
aid.rejectRequest(aid.requests[0].id, { reason: '分支演练：不予支援' })
assert(aid.requests[0].status === 'rejected', '分叉分支上驳回请求')
replay.switchBranch('main')
assert(aid.requests[0].status === 'received', '主干末端仍为已回执（分支隔离）')
replay.switchBranch(bId)
assert(aid.requests[0].status === 'rejected', '切回分叉分支仍为已驳回')
replay.openCompare('main', bId)
const cmp = replay.compareResult
assert(cmp && cmp.groups.some((g) => g.dim === '跨区互援'), '分支对照含「跨区互援」维度')
replay.exitToLive()

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
