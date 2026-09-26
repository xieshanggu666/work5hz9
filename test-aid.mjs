// 跨区域互援协同：外部队伍提交资源请求 → 指挥员审核配额/驳回 → 按配额执行调拨（回写库存/事件保障量）
// → 接收方确认回执（联动签收四本账闭环）→ 撤销 → 大屏统计 → 复盘录帧/seek 还原/分支隔离
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts } from '@/store/command'
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

console.log('— 场景载入：外部队伍目录就绪，无互援请求 —')
assert(aid.teams.length === 4, '挂载 4 支外部支援队伍')
assert(aid.teams[0].name === '德阳市消防救援支队' && aid.teams[0].region === '德阳市', '队伍元数据就绪')
assert(aid.requests.length === 0, '初始无互援请求')
const s0 = aid.stats
assert(s0.pending === 0 && s0.delivering === 0 && s0.received === 0 && s0.total === 0, '大屏统计初始为零')

console.log('— 请求提交：参数校验 + 同类资源合并 —')
assert(!aid.submitRequest({}).ok, '缺队伍/事件的提交被拒')
assert(!aid.submitRequest({ teamId: 'at-x', eventId: 'ev-001', items: [{ type: 'water', qty: 10 }] }).ok, '非法队伍被拒')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-x', items: [{ type: 'water', qty: 10 }] }).ok, '非法事件被拒')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [] }).ok, '空清单被拒')
assert(!aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'water', qty: 0 }, { type: 'nope', qty: 5 }] }).ok, '无有效资源行被拒')
const sub1 = aid.submitRequest({
  teamId: 'at-1', eventId: 'ev-001',
  items: [{ type: 'water', qty: 100 }, { type: 'food', qty: 200 }, { type: 'water', qty: 50 }],
  reason: '队伍携行给养不足'
})
assert(sub1.ok, '互援请求提交成功')
const r1 = sub1.request
assert(r1.items.length === 2 && r1.items.find((i) => i.type === 'water').qty === 150, '同类资源合并入账（水 100+50=150）')
assert(r1.status === 'requested' && r1.teamName === '德阳市消防救援支队', '请求进入待审批状态')
assert(tl('ev-001').includes('跨区域互援请求'), '事件时间线回写互援请求')
assert(aid.focusRequestId === r1.id, '面板联动定位新请求')
assert(aid.stats.pending === 1 && aid.stats.total === 1, '大屏统计：待审批 1')

console.log('— 审批：指挥员核定配额（超量截断/缺省按请求量） —')
assert(!aid.reviewRequest('aid-x', {}).ok, '非法请求审批被拒')
const rv1 = aid.reviewRequest(r1.id, { quota: { water: 999 }, note: '按统筹能力核定', by: '指挥长老周' })
assert(rv1.ok && r1.status === 'approved', '审批通过转待调拨')
assert(r1.items.find((i) => i.type === 'water').approved === 150, '配额超请求量截断为 150')
assert(r1.items.find((i) => i.type === 'food').approved === 200, '缺省项按请求量核定')
assert(r1.reviewedBy === '指挥长老周' && r1.reviewNote === '按统筹能力核定', '审批人/备注留痕')
assert(tl('ev-001').includes('互援请求审批通过'), '事件时间线回写审批')
assert(!aid.reviewRequest(r1.id, {}).ok, '重复审批被拦截')
assert(!aid.rejectRequest(r1.id, {}).ok, '已审批不能再驳回')

console.log('— 执行调拨：就近出库 + 回写库存/事件保障量 —')
const w0 = base('rb-2').stock.water
const f0 = base('rb-2').stock.food
const mv0 = cmd.stockMovements.length
const ex1 = aid.executeAid(r1.id)
assert(ex1.ok && ex1.sent.length === 2, '调拨执行出库 2 批')
assert(r1.status === 'delivering', '请求转调拨在途')
assert(base('rb-2').stock.water === w0 - 150, '就近基地（绵阳库）饮用水扣减 150')
assert(base('rb-2').stock.food === f0 - 200, '就近基地食品扣减 200')
assert(ex1.sent.every((d) => d.source === '互援调拨' && d.aidId === r1.id && d.eventId === 'ev-001'), '派发记录来源「互援调拨」并回链请求单')
assert(cmd.stockMovements.length === mv0 + 2 && cmd.stockMovements.slice(-2).every((m) => m.kind === 'aid'), '库存变动流水记「互援调拨出库」')
assert(cmd.sentMap['ev-001'].water === 150 && cmd.sentMap['ev-001'].food === 200, '在途量计入事件保障量')
assert(r1.allocations.length === 2 && r1.unmet.length === 0, '调拨明细入账、无缺口')
assert(tl('ev-001').includes('互援调拨出库'), '事件时间线回写调拨')
assert(!aid.executeAid(r1.id).ok, '重复执行被拦截（幂等）')
assert(!aid.cancelRequest(r1.id).ok, '在途中不能撤销')
assert(aid.stats.delivering === 1, '大屏统计：调拨在途 1')

console.log('— 回执：接收方确认调拨，联动签收闭环 —')
const rc1 = aid.confirmReceipt(r1.id, { by: '李队长', note: '物资点验无误' })
assert(rc1.ok && rc1.signed === 350 && rc1.done, '回执确认接收 350 单位，请求办结')
assert(r1.status === 'received' && r1.receivedBy === '李队长', '请求转已回执（终态）')
assert(ex1.sent.every((d) => d.status === 'done' && d.signedQty === d.qty), '在途调拨单全部签收办结')
assert(cmd.receivedMap['ev-001'].water === 150 && cmd.receivedMap['ev-001'].food === 200, '实收口径回写事件保障量')
assert(tl('ev-001').includes('互援回执'), '事件时间线回写回执')
assert(!aid.confirmReceipt(r1.id, {}).ok, '重复回执被拦截')
assert(!aid.cancelRequest(r1.id).ok, '已回执不能撤销')
assert(aid.stats.received === 1 && aid.stats.delivering === 0, '大屏统计：已回执 1、在途归零')

console.log('— 驳回：留痕终态 + 全部操作幂等拦截 —')
const r2 = aid.submitRequest({ teamId: 'at-2', eventId: 'ev-002', items: [{ type: 'medical', qty: 100 }] }).request
const rj = aid.rejectRequest(r2.id, { reason: '本地医疗储备优先保障本级', by: '指挥长老周' })
assert(rj.ok && r2.status === 'rejected' && r2.rejectReason.includes('医疗储备'), '请求驳回留痕')
assert(tl('ev-002').includes('互援请求驳回'), '事件时间线回写驳回')
assert(!aid.reviewRequest(r2.id, {}).ok, '已驳回不能再审批')
assert(!aid.rejectRequest(r2.id, {}).ok, '重复驳回被拦截')
assert(!aid.executeAid(r2.id).ok, '已驳回不能执行调拨')
assert(!aid.confirmReceipt(r2.id, {}).ok, '已驳回不能回执')
assert(!aid.cancelRequest(r2.id, {}).ok, '已驳回不能撤销')

console.log('— 撤销：出库前可撤（待审批/待调拨），留痕终态 —')
const r3 = aid.submitRequest({ teamId: 'at-3', eventId: 'ev-001', items: [{ type: 'tent', qty: 50 }] }).request
assert(aid.cancelRequest(r3.id, { reason: '队伍任务调整' }).ok && r3.status === 'cancelled', '待审批请求可撤销')
assert(r3.cancelReason === '队伍任务调整', '撤销原因留痕')
const r4 = aid.submitRequest({ teamId: 'at-3', eventId: 'ev-001', items: [{ type: 'tent', qty: 60 }] }).request
aid.reviewRequest(r4.id, {})
assert(aid.cancelRequest(r4.id, {}).ok && r4.status === 'cancelled', '待调拨请求可撤销（尚未出库）')
assert(!aid.cancelRequest(r4.id, {}).ok, '重复撤销被拦截')
assert(!aid.executeAid(r4.id).ok, '已撤销不能执行调拨')

console.log('— 回执短缺：同批认定短缺，缺口挂账 —')
const r5 = aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'water', qty: 200 }] }).request
aid.reviewRequest(r5.id, {})
const ex5 = aid.executeAid(r5.id)
assert(ex5.ok && ex5.sent.length === 1, '短缺用例调拨出库 1 批')
const rc5 = aid.confirmReceipt(r5.id, { shorts: { water: 30 } })
assert(rc5.ok && rc5.signed === 170 && rc5.shortage === 30, '回执签收 170、认定短缺 30')
const d5 = ex5.sent[0]
assert(d5.signedQty === 170 && d5.shortQty === 30 && d5.status === 'done', '调拨单四本账闭环（实收 170/短缺 30）')
assert(cmd.shortageMap['ev-001'].water === 30, '短缺缺口回写事件（待补派）')
assert(r5.status === 'received', '含短缺回执后请求仍办结')

console.log('— 库存不足：按可用量出库，缺口如实挂账 —')
const r6 = aid.submitRequest({ teamId: 'at-2', eventId: 'ev-001', items: [{ type: 'medical', qty: 99999 }] }).request
aid.reviewRequest(r6.id, {})
const ex6 = aid.executeAid(r6.id)
const medTotal = 12000 + 5000 + 8000 + 1000 + 4000
assert(ex6.ok && ex6.unmet.length === 1 && ex6.unmet[0].qty === 99999 - medTotal, '医疗物资全基地扫货，缺口挂账')
assert(r6.status === 'delivering' && r6.unmet.length === 1, '请求在途并记录缺口')
assert(cmd.bases.every((b) => (b.stock.medical || 0) === 0), '各基地医疗库存清零（不出虚假量）')
const rc6 = aid.confirmReceipt(r6.id, {})
assert(rc6.ok && rc6.done && r6.status === 'received', '大额调拨回执办结')
assert(!aid.executeAid(r6.id).ok, '已回执不能再执行')

console.log('— 大屏统计口径 —')
const st = aid.stats
assert(st.total === 6, '累计 6 单互援请求')
assert(st.pending === 0 && st.delivering === 0, '无待审批/在途')
assert(st.received === 3, '已回执 3 单（含短缺/大额）')

console.log('— 复盘集成：互援动作录帧 + seek 还原 + 分支隔离 —')
cmd.loadScenario('s1')
tr.load(); rb.load(); rp.load(); wn.load(); aid.load()
installReplayRecorder()
replay.begin()
const q1 = aid.submitRequest({ teamId: 'at-1', eventId: 'ev-001', items: [{ type: 'water', qty: 100 }], reason: '驰援江油' }).request
aid.reviewRequest(q1.id, {})
aid.executeAid(q1.id)
const aidFrames = replay.frames.filter((f) => f.category === 'aid')
assert(aidFrames.length === 3, '互援动作沉淀 3 帧（请求/审批/调拨）')
assert(aidFrames[0].title.includes('互援请求') && aidFrames[2].title.includes('调拨'), '帧标题描述互援动作')
assert(replay.frames[replay.frames.length - 1].logs.some((l) => l.source === 'aid'), '帧内互援日志已汇总')
const wBase = base('rb-2').stock.water
const execIdx = replay.frames.length - 1

// 分叉：从「调拨在途」节点分出回执方案
replay.seek(execIdx)
const forkId = replay.resumeHere({ name: '互援回执方案' })
assert(typeof forkId === 'string' && replay.branchCount === 2, '分叉生成互援回执分支')
const rcFork = aid.confirmReceipt(q1.id, { by: '李队长' })
assert(rcFork.ok && aid.requestOf(q1.id).status === 'received', '分叉分支上回执办结')
assert(cmd.receivedMap['ev-001'].water === 100, '分叉分支实收保障量回写')
assert(replay.branchById(forkId).frames.length === execIdx + 2, '回执帧只入分叉分支')

// 切回主干：请求仍在途，库存/保障量互不影响
replay.switchBranch('main')
assert(aid.requestOf(q1.id).status === 'delivering', '主干上请求仍调拨在途（分支隔离）')
assert((cmd.receivedMap['ev-001'] || {}).water == null, '主干无实收保障量（分叉回执不污染）')
assert(base('rb-2').stock.water === wBase, '主干库存保持调拨后水位')
const mainReqFrames = replay.frames.filter((f) => f.category === 'aid').length
assert(mainReqFrames === 3, '主干互援帧序列未被分叉动作污染')

// 主干上驳回该请求？——已在途不可驳，改走回执；再切回分叉核对独立状态
replay.switchBranch(forkId)
assert(aid.requestOf(q1.id).status === 'received', '分叉分支末端保持已回执')
assert(cmd.dispatches.find((d) => d.aidId === q1.id).status === 'done', '分叉分支调拨单已办结')

// seek 精确还原：回基线请求清空，回分叉末端状态还原
replay.enterReview(0, forkId)
assert(aid.requests.length === 0, 'seek 回基线：互援请求还原为空')
replay.seek(replay.frames.length - 1)
assert(aid.requestOf(q1.id)?.status === 'received', 'seek 回分叉末端：请求已回执还原')
replay.exitToLive()

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
