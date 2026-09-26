// 现场离线动作冲突处置闭环 · 五服务真实 HTTP 集成测试
// 覆盖：冲突原因分级（G0-G3）、指挥端冲突工作台（队列+冲突账）、
//       原分支重提（retry，竞态动作派生 attemptId 防幂等碰撞）、显式改投（requeue）、
//       指挥端审核回写（note/retry/redirect/close → 队列 + 事件时间线 + 分支复盘三面同步）、
//       审核幂等（重复改投不重复生效）、branch-mismatch 防误投
import {
  startAll, stopAll, waitAll, sleep, call, GW, POST, FLD, ING,
  TPORTS, restartService, cleanupData
} from './helpers.js'

let failed = 0
let passed = 0
const assert = (cond, msg) => {
  if (cond) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg) }
}
const assertEq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`)
const j = (r) => r.body

async function stateOf(simId, branchId = 'main') {
  const r = await GW(`/sims/${simId}/state?branch=${encodeURIComponent(branchId)}`)
  if (r.status !== 200) throw new Error('state fetch failed ' + r.status)
  return r.body.state
}
function hlc(ts, l = 0) { return ts.toString(16).padStart(12, '0') + '-' + l.toString(16).padStart(6, '0') }

async function main() {
  cleanupData()
  startAll()
  await waitAll()
  console.log('— 五服务就绪：冲突处置闭环集成测试 —')

  const SIM = 'sim-review'
  const TEAM = 'team-r1'
  const t0 = Date.now()
  let r = await POST('/sims', { id: SIM, name: '冲突处置闭环推演', scenarioId: 's1', clientId: 'cmdr' })
  assertEq(r.status, 200, '创建推演')

  // 准备：派发食品 100（签收冲突用）+ 红色预警（签收冲突用）+ 队伍注册
  r = await POST(`/sims/${SIM}/commands/dispatchResource`, { clientId: 'cmdr', baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100 })
  assertEq(r.status, 200, '指挥员派发食品 100')
  let st = await stateOf(SIM)
  const dpId = st.dispatches.find((d) => d.type === 'food').id
  r = await POST(`/sims/${SIM}/commands/issueWarning`, {
    clientId: 'cmdr', warningId: 'w-r1', title: '冲突测试红色预警', level: 'red',
    dedupeKey: 'rv:red', eventId: 'ev-001', targets: ['field', 'commander']
  })
  assertEq(r.status, 200, '发布预警')
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/register`, { name: '闭环测试队', capabilities: ['repair'] })
  assertEq(r.status, 200, '队伍注册并同步')

  /* ============ 1. 制造分级冲突：G1 超签 / G2 重复签收 ============ */
  console.log('\n— 1. 冲突原因分级：G1 现场可修正 / G2 状态已迁移 —')
  // 先成功签收一次预警（field 角色），再制造重复签收冲突
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions`, {
    actions: [
      { clientActionId: 'ok-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-r1', role: 'field', by: '闭环测试队', at: '09:00', hlc: hlc(t0 + 1000) },
      { clientActionId: 'g1-1', kind: 'signDispatch', teamId: TEAM, dispatchId: dpId, qty: 150, receiver: '李现场', at: '09:05', hlc: hlc(t0 + 2000) },
      { clientActionId: 'g2-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-r1', role: 'field', by: '张现场', at: '09:10', hlc: hlc(t0 + 3000) }
    ]
  })
  assertEq(r.status, 200, '入队 1 条正常 + 2 条冲突动作')
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/sync`, {})
  assertEq(j(r).synced, 1, '仅正常动作补传成功')
  st = await stateOf(SIM)
  assertEq(st.warnings.find((w) => w.id === 'w-r1').acks.field.by, '闭环测试队', '首次签收生效')

  // 指挥端冲突工作台：队列冲突带分级
  r = await GW(`/sims/${SIM}/field/conflicts`)
  assertEq(r.status, 200, '冲突工作台可拉取')
  const queue1 = j(r).queue
  assertEq(queue1.length, 2, '工作台列出 2 条队列冲突')
  const g1 = queue1.find((a) => a.clientActionId === 'g1-1')
  const g2 = queue1.find((a) => a.clientActionId === 'g2-1')
  assertEq(g1.gradeInfo.grade, 'G1', '超量签收分级 G1（现场可修正）')
  assertEq(g2.gradeInfo.grade, 'G2', '重复签收分级 G2（状态已迁移）')
  assert(!!g1.gradeInfo.advice, '分级带处置建议')
  assert(!!j(r).grades.G3, '工作台返回分级口径说明')

  /* ============ 2. 审核-批注：队列留痕 + 复盘入账 + 事件时间线 ============ */
  console.log('\n— 2. 指挥端审核（批注）：队列/时间线/复盘三面回写 —')
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'g1-1',
    decision: 'note', note: '超量部分请核减后重报', by: '王指挥'
  })
  assertEq(r.status, 200, '批注审核受理')
  assertEq(j(r).decision, 'note', '回执带决策')
  assertEq(j(r).queue.action.status, 'conflict', '批注后动作保持冲突态')
  assertEq(j(r).queue.action.review.note, '超量部分请核减后重报', '批注落到队列动作')
  st = await stateOf(SIM)
  assertEq(st.conflictReviews.length, 1, '审核入复盘账 conflictReviews')
  assertEq(st.conflictReviews[0].decision, 'note', '复盘账记录批注决策')
  assertEq(st.conflictReviews[0].grade, 'G1', '复盘账带冲突分级')
  const ev1 = st.events.find((e) => e.id === 'ev-001')
  assert(ev1.timeline.some((x) => x.text.includes('🧭 指挥端审核现场冲突动作 g1-1')), '审核回写灾情事件时间线')
  // 时间轴帧包含审核节点
  r = await GW(`/sims/${SIM}/timeline`)
  assert(j(r).frames.some((f) => f.title.includes('指挥端审核现场冲突')), '审核进入回放时间轴')

  /* ============ 3. 审核-退回重提：状态未变仍冲突；预警升级后重提闭环 ============ */
  console.log('\n— 3. 审核（退回原分支重提）：未解除前置仍冲突，解除后闭环 —')
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'g2-1', decision: 'retry', note: '请重试签收', by: '王指挥'
  })
  assertEq(r.status, 200, '退回重提受理')
  assertEq(j(r).queue.action.status, 'conflict', '重复签收前置未解除：重提后仍冲突')
  // 指挥员升级预警 → 签收清空 → 同一动作重提即可闭环
  r = await POST(`/sims/${SIM}/commands/upgradeWarning`, { clientId: 'cmdr', warningId: 'w-r1', level: 'orange' })
  // 红色→橙色？等级无效方向不管，只要升级事件清空签收；red→orange 属降级也允许（level 不同即可）
  assertEq(r.status, 200, '预警调级清空签收')
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'g2-1', decision: 'retry', note: '签收已重置，请重提', by: '王指挥'
  })
  assertEq(r.status, 200, '二次退回重提受理')
  assertEq(j(r).queue.action.status, 'acked', '前置解除后重提闭环（acked）')
  st = await stateOf(SIM)
  assertEq(st.warnings.find((w) => w.id === 'w-r1').acks.field.by, '张现场', '重提的签收最终生效')
  assertEq(st.conflictReviews.filter((x) => x.clientActionId === 'g2-1').length, 2, '同一动作两次审核均留痕')

  /* ============ 4. 审核-办结：队列闭环 + 冲突账标记（reducer 竞态链路） ============ */
  console.log('\n— 4. 审核（办结）：队列闭环；reducer 冲突账被审核标记 —')
  // 模拟 reducer 竞态：直接经采集服务追加入账但业务守恒拒绝的事件（id 以动作 id 为前缀）
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions`, {
    actions: [{ clientActionId: 'rc-1', kind: 'reportPosition', teamId: TEAM, lng: 104.75, lat: 31.6, at: '09:20', hlc: hlc(t0 + 4000) }]
  })
  assertEq(r.status, 200, 'rc-1 入队（待发）')
  const huge = 10 ** 9
  r = await ING('POST', `/sims/${SIM}/branches/main/events`, {
    clientId: TEAM,
    events: [{ id: 'rc-1#0', type: 'resource.dispatched', payload: { baseId: 'rb-3', eventId: 'ev-001', type: 'medical', qty: huge }, at: '09:21' }]
  })
  await ING('POST', '/flush', { simId: SIM, branchId: 'main' })
  st = await stateOf(SIM)
  const ledgerEntry = st.conflicts.find((c) => c.eventId === 'rc-1#0')
  assert(!!ledgerEntry && ledgerEntry.reason === 'insufficient-stock', '竞态冲突入 reducer 冲突账')
  // 冲突工作台冲突账带分级（G3 资源争用）
  r = await GW(`/sims/${SIM}/field/conflicts`)
  const led1 = j(r).ledger.find((c) => c.eventId === 'rc-1#0')
  assertEq(led1.grade, 'G3', '库存争用冲突账分级 G3（需指挥裁决）')
  assertEq(led1.clientActionId, 'rc-1', '冲突账按事件 id 前缀关联动作')
  // 审核办结：队列关闭 + 冲突账标记 + 复盘留痕
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'rc-1',
    decision: 'close', note: '并发超扣已按守恒拒绝，现场无需重报', by: '王指挥'
  })
  assertEq(r.status, 200, '办结审核受理')
  assertEq(j(r).queue.action.status, 'closed', '队列动作审核办结')
  st = await stateOf(SIM)
  const marked = st.conflicts.find((c) => c.eventId === 'rc-1#0')
  assert(!!marked.review && marked.review.decision === 'close', '冲突账条目被审核标记')
  assert(st.conflictReviews.some((x) => x.clientActionId === 'rc-1' && x.decision === 'close'), '办结审核入复盘账')
  // 冲突工作台不再列出已办结动作
  r = await GW(`/sims/${SIM}/field/conflicts`)
  assert(!j(r).queue.some((a) => a.clientActionId === 'rc-1'), '办结动作退出冲突工作台')

  /* ============ 5. 审核-改投：跨分支显式改投并在目标分支生效 ============ */
  console.log('\n— 5. 审核（显式改投）：动作改投目标分支并生效，原分支留痕 —')
  // 分叉 B 分支，并在 B 上发布仅 B 存在的预警
  r = await POST(`/sims/${SIM}/fork`, { clientId: 'cmdr-b', name: 'B方案' })
  assertEq(r.status, 200, '分叉 B 分支')
  const BR = j(r).branch.id
  r = await POST(`/sims/${SIM}/commands/issueWarning?branch=${BR}`, {
    clientId: 'cmdr', warningId: 'w-br', title: '仅B分支预警', level: 'yellow',
    dedupeKey: 'br:yellow', eventId: 'ev-001', targets: ['field'], branchId: BR
  })
  assertEq(r.status, 200, 'B 分支发布预警')
  // 现场在主干误签收该预警 → 冲突（主干无此预警）
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions?branch=main`, {
    actions: [{ clientActionId: 'mv-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-br', role: 'field', by: '闭环测试队', at: '09:30', hlc: hlc(t0 + 5000) }]
  })
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/sync?branch=main`, {})
  r = await GW(`/sims/${SIM}/field/conflicts`)
  const mv = j(r).queue.find((a) => a.clientActionId === 'mv-1')
  assert(!!mv && mv.status === 'conflict', '主干误签收产生冲突')
  assertEq(mv.gradeInfo.grade, 'G2', '预警不存在分级 G2')
  // 指挥端审核改投到 B 分支
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'mv-1',
    decision: 'redirect', targetBranchId: BR, note: '该预警属于B方案分支', by: '王指挥'
  })
  assertEq(r.status, 200, '改投审核受理')
  const movedId = j(r).review.newClientActionId
  assert(!!movedId && movedId !== 'mv-1', '改投生成新动作 id')
  assertEq(j(r).review.targetBranchId, BR, '审核事件带目标分支')
  assertEq(j(r).queue.action.status, 'acked', '改投动作在 B 分支补传生效')
  // 原分支队列已移除，B 分支留痕 movedFrom
  r = await FLD('GET', `/sims/${SIM}/teams/${TEAM}/outbox?branch=main`)
  assert(!j(r).actions.some((a) => a.clientActionId === 'mv-1'), '原分支动作已移除')
  r = await FLD('GET', `/sims/${SIM}/teams/${TEAM}/outbox?branch=${BR}`)
  const moved = j(r).actions.find((a) => a.clientActionId === movedId)
  assert(!!moved && moved.movedFrom?.clientActionId === 'mv-1', 'B 分支新动作留痕 movedFrom')
  assertEq(moved.movedFrom.branchId, 'main', 'movedFrom 记录来源分支')
  // B 分支态势：预警已签收；主干复盘账有改投记录
  const stB = await stateOf(SIM, BR)
  assertEq(stB.warnings.find((w) => w.id === 'w-br').acks.field.by, '闭环测试队', '改投动作在 B 分支生效')
  st = await stateOf(SIM)
  const rvRedirect = st.conflictReviews.find((x) => x.clientActionId === 'mv-1')
  assert(!!rvRedirect && rvRedirect.decision === 'redirect' && rvRedirect.targetBranchId === BR, '改投审核入原分支复盘账')
  // 审核幂等：对同一原动作再次改投 → 不重复改投、不重复记事件
  const reviewsBefore = st.conflictReviews.length
  r = await POST(`/sims/${SIM}/field/conflicts/review`, {
    clientId: 'cmdr', teamId: TEAM, clientActionId: 'mv-1',
    decision: 'redirect', targetBranchId: BR, note: '重复审核', by: '王指挥'
  })
  assertEq(r.status, 200, '重复改投仍受理（幂等）')
  assertEq(j(r).alreadyApplied, true, '识别已改投，不重复执行')
  st = await stateOf(SIM)
  assertEq(st.conflictReviews.length, reviewsBefore, '重复审核不重复记复盘账')

  /* ============ 6. 原分支重提（现场侧端点）与防误投 ============ */
  console.log('\n— 6. 现场侧原分支重提端点 + branch-mismatch 防误投 —')
  // 制造新冲突：签收不存在预警
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions`, {
    actions: [{ clientActionId: 'rt-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-nope', role: 'field', by: '闭环测试队', at: '09:40', hlc: hlc(t0 + 6000) }]
  })
  await FLD('POST', `/sims/${SIM}/teams/${TEAM}/sync`, {})
  r = await FLD('GET', `/sims/${SIM}/teams/${TEAM}/outbox?status=conflict`)
  assert(j(r).actions.some((a) => a.clientActionId === 'rt-1'), 'rt-1 冲突落账')
  // 同 id 改分支重提被拒
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions?branch=${BR}`, {
    actions: [{ clientActionId: 'rt-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-nope', role: 'field' }]
  })
  assertEq(r.status, 409, '同 id 改分支重提被 branch-mismatch 拒绝')
  assertEq(j(r).code, 'branch-mismatch', '错误码 branch-mismatch')
  // 现场侧原分支重提端点：回到 queued 并立即补传（预警仍不存在 → 仍冲突，但流程走通）
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions/rt-1/retry`, { by: '闭环测试队' })
  assertEq(r.status, 200, '现场侧重提端点受理')
  assertEq(j(r).action.status, 'conflict', '目标仍不存在：重提后如实回冲突')
  assertEq(j(r).action.retryCount, 1, '重提计数')
  // 现场侧显式改投端点：改投到 B 分支（B 上也没有 w-nope → 仍冲突，验证改投链路）
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions/rt-1/requeue`, { branchId: BR })
  assertEq(r.status, 200, '现场侧改投端点受理')
  assert(j(r).action.clientActionId !== 'rt-1', '改投生成新 id')
  assertEq(j(r).action.branchId, BR, '改投落在目标分支')

  /* ============ 7. 离线包携带审核结论 + 复盘 seek 还原 ============ */
  console.log('\n— 7. 离线包审核回写 + 分支复盘 seek 还原 —')
  r = await GW(`/sims/${SIM}/field/bundle?teamId=${TEAM}`)
  const reviews = j(r).bundle.reviews
  assert(Array.isArray(reviews) && reviews.some((x) => x.clientActionId === 'g1-1' && x.decision === 'note'), '离线包携带本队审核结论（批注）')
  assert(reviews.some((x) => x.clientActionId === 'mv-1' && x.decision === 'redirect'), '离线包携带改投结论')
  // 复盘：seek 到首次审核之前 → 无审核账；当前末端 → 全量审核账
  st = await stateOf(SIM)
  const total = st.conflictReviews.length
  assert(total >= 5, `复盘账累计 ${total} 条审核（≥5）`)
  r = await GW(`/sims/${SIM}/timeline`)
  const firstReview = j(r).frames.find((f) => f.title.includes('指挥端审核现场冲突'))
  const past = j(await GW(`/sims/${SIM}/state?atSeq=${Math.max(0, firstReview.seq - 1)}`)).state
  assertEq((past.conflictReviews || []).length, 0, 'seek 到首次审核前：无审核账（精确还原）')
  // 帧间差异包含审核维度
  r = await GW(`/sims/${SIM}/diff?atSeq=${firstReview.seq}`)
  assert(j(r).diff.statusChanges.some((x) => x.icon === '🧭'), '帧间差异列出审核状态变化')

  /* ============ 8. 现场服务崩溃：冲突/审核状态从流水恢复 ============ */
  console.log('\n— 8. 崩溃恢复：冲突与审核办结状态不丢 —')
  await restartService('field', 300)
  r = await FLD('GET', `/sims/${SIM}/teams/${TEAM}/outbox?branch=main`)
  const rc1 = j(r).actions.find((a) => a.clientActionId === 'rc-1')
  assert(!!rc1 && rc1.status === 'closed', '崩溃重启后审核办结状态恢复')
  assert(!!rc1.review && rc1.review.by === '王指挥', '审核留痕（审核人）恢复')
  r = await FLD('GET', `/sims/${SIM}/field-conflicts`)
  assert(j(r).conflicts.every((a) => !!a.gradeInfo?.grade), '恢复后冲突清单仍带分级')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  stopAll()
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1) })
