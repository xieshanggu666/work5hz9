// FieldOutbox 单元测试：分支隔离 / 补传固定回原分支 / 冲突重提 branch-mismatch /
// 显式改投留痕 / 旧版无分支队列迁移到 main / 崩溃流水恢复
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FieldOutbox, DEFAULT_BRANCH } from '../lib/fieldOutbox.js'

let failed = 0
let passed = 0
const assert = (cond, msg) => {
  if (cond) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg) }
}
const assertEq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`)

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-outbox-'))
}

const SIM = 'sim-1'
const TEAM = 'team-1'
const BR = 'br-a'

function hlc(ts, l = 0) { return ts.toString(16).padStart(12, '0') + '-' + l.toString(16).padStart(6, '0') }

console.log('— 1. 入队即固定分支；查询按分支隔离 —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'a1', kind: 'reportPosition', lat: 1, hlc: hlc(1000) }, { branchId: 'main' })
  ob.enqueue(SIM, TEAM, { clientActionId: 'a2', kind: 'reportPosition', lat: 2, hlc: hlc(2000) }, { branchId: BR })
  assertEq(ob.pending(SIM, TEAM, 'main').length, 1, '主干 1 条')
  assertEq(ob.pending(SIM, TEAM, BR).length, 1, 'B 分支 1 条')
  assertEq(ob.pending(SIM, TEAM, 'main')[0].branchId, 'main', '记录盖 main')
  assertEq(ob.pending(SIM, TEAM, BR)[0].branchId, BR, '记录盖 br-a')
  // HLC 按分支独立推进（离线时钟互不干扰）
  ob.tick(SIM, TEAM, 'main')
  ob.tick(SIM, TEAM, BR)
  const branches = ob.listBranches(SIM, TEAM).map((b) => b.branchId)
  assert(branches.includes('main') && branches.includes(BR), '分支索引含两个分支')
  // 队伍隔离
  assertEq(ob.pending(SIM, 'other', 'main').length, 0, '别的队伍为空')
}

console.log('— 2. 补传固定回原分支：mark/find 跨分支落账 —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'a1', kind: 'reportPosition', hlc: hlc(1000) }, { branchId: BR })
  // 不传分支也能按 id 找到并落回原分支（模拟在途同步期间切换了视角）
  assertEq(ob.find(SIM, TEAM, 'a1').branchId, BR, '跨分支按 id 找到')
  ob.mark(SIM, TEAM, 'a1', { status: 'acked', result: { ok: true } })
  assertEq(ob.pending(SIM, TEAM, BR).length, 0, '回执写回原分支，B 无待发')
  assertEq(ob.list(SIM, TEAM, BR)[0].status, 'acked', 'B 分支状态 acked')
  assertEq(ob.list(SIM, TEAM, 'main').length, 0, '主干仍为空（未串账）')
}

console.log('— 3. 冲突重提不允许换分支：branch-mismatch —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'c1', kind: 'ackWarning', hlc: hlc(1000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'c1', { status: 'conflict', result: { ok: false, msg: '重复签收' } })
  let threw = null
  try {
    ob.enqueue(SIM, TEAM, { clientActionId: 'c1', kind: 'ackWarning' }, { branchId: 'main' })
  } catch (e) { threw = e }
  assert(threw && threw.status === 409 && threw.code === 'branch-mismatch', '改分支重提抛 branch-mismatch')
  assertEq(threw?.actual, BR, '错误带实际固定分支')
  // 回原分支重提允许
  const r = ob.enqueue(SIM, TEAM, { clientActionId: 'c1', kind: 'ackWarning', role: 'commander' }, { branchId: BR })
  assert(!r.duplicated && r.action.status === 'queued', '回原分支重提转 queued')
  assertEq(r.action.result, null, '重提清空冲突回执')
  // 已终态（acked）的动作任何分支都不可改
  ob.mark(SIM, TEAM, 'c1', { status: 'acked' })
  const dup = ob.enqueue(SIM, TEAM, { clientActionId: 'c1', kind: 'ackWarning' }, { branchId: BR })
  assert(dup.duplicated, '已闭环动作同 id 幂等返回')
}

console.log('— 4. 显式改投：新 id、留痕 movedFrom、原动作移除 —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'm1', kind: 'reportPosition', lat: 9, hlc: hlc(1000) }, { branchId: 'main' })
  ob.mark(SIM, TEAM, 'm1', { status: 'conflict' })
  const moved = ob.requeueForBranch(SIM, TEAM, 'm1', BR, { lat: 10 })
  assertEq(moved.branchId, BR, '新动作落在 B 分支')
  assert(moved.clientActionId !== 'm1', '生成新 clientActionId')
  assertEq(moved.movedFrom.branchId, 'main', '留痕来源分支')
  assertEq(moved.lat, 10, 'patch 生效')
  assertEq(ob.list(SIM, TEAM, 'main').length, 0, '原分支动作已移除')
  assertEq(ob.pending(SIM, TEAM, BR).length, 1, '新分支待发 1 条')
}

console.log('— 5. pendingAcrossBranches：补传按原分支分组 —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'g1', kind: 'reportPosition', hlc: hlc(1000) }, { branchId: 'main' })
  ob.enqueue(SIM, TEAM, { clientActionId: 'g2', kind: 'reportPosition', hlc: hlc(2000) }, { branchId: BR })
  ob.enqueue(SIM, TEAM, { clientActionId: 'g3', kind: 'reportPosition', hlc: hlc(3000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'g3', { status: 'conflict' })
  const all = ob.pendingAcrossBranches(SIM, TEAM)
  assertEq(all.length, 2, '两个分支有待发组')
  const only = ob.pendingAcrossBranches(SIM, TEAM, BR)
  assertEq(only.length, 1, '只看 B 分支时 1 组')
  assertEq(only[0].actions.length, 1, '冲突项不算 pending（g3 不在）')
}

console.log('— 6. 旧版队列迁移：<team>/queue.jsonl → <team>/main/queue.jsonl —')
{
  const root = tmpRoot()
  const teamDir = path.join(root, SIM, TEAM)
  fs.mkdirSync(teamDir, { recursive: true })
  const row = {
    op: 'upsert',
    action: {
      clientActionId: 'old-1', kind: 'registerTeam', simId: SIM, teamId: TEAM,
      hlc: hlc(500), at: '08:00', status: 'queued', attempts: 0,
      queuedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', result: null
    }
  }
  fs.writeFileSync(path.join(teamDir, 'queue.jsonl'), JSON.stringify(row) + '\n')
  fs.writeFileSync(path.join(teamDir, 'clock.json'), JSON.stringify({ ts: 123, l: 7 }))
  const ob = new FieldOutbox(root)
  assertEq(ob.pending(SIM, TEAM, DEFAULT_BRANCH).length, 1, '旧动作迁入 main')
  assertEq(ob.pending(SIM, TEAM, DEFAULT_BRANCH)[0].branchId, 'main', '旧动作补盖 branchId')
  assert(!fs.existsSync(path.join(teamDir, 'queue.jsonl')), '旧 queue.jsonl 已移走')
  assert(fs.existsSync(path.join(teamDir, 'main', 'queue.jsonl')), '新位置存在')
  assert(fs.existsSync(path.join(teamDir, 'main', 'clock.json')), '时钟迁入 main')
  // 幂等：再来一次（新 main 已存在）不报错、不重复
  const ob2 = new FieldOutbox(root)
  assertEq(ob2.pending(SIM, TEAM, 'main').length, 1, '二次启动无重复迁移')
}

console.log('— 7. 崩溃恢复：分支流水重建内存索引（含 remove） —')
{
  const root = tmpRoot()
  let ob = new FieldOutbox(root)
  ob.enqueue(SIM, TEAM, { clientActionId: 'r1', kind: 'reportPosition', hlc: hlc(1000) }, { branchId: BR })
  ob.enqueue(SIM, TEAM, { clientActionId: 'r2', kind: 'reportPosition', hlc: hlc(2000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'r1', { status: 'acked' })
  ob.remove(SIM, TEAM, 'r1')
  ob = new FieldOutbox(root)
  assertEq(ob.list(SIM, TEAM, BR).length, 1, '重启后只剩 r2（upsert/remove 流水重建）')
  assertEq(ob.list(SIM, TEAM, BR)[0].clientActionId, 'r2', '保留正确动作')
}

console.log('— 8. listTeams 汇总带分支分组 —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, 't1', { clientActionId: 't1a', kind: 'reportPosition', hlc: hlc(1) }, { branchId: 'main' })
  ob.enqueue(SIM, 't1', { clientActionId: 't1b', kind: 'reportPosition', hlc: hlc(2) }, { branchId: BR })
  ob.enqueue(SIM, 't2', { clientActionId: 't2a', kind: 'reportPosition', hlc: hlc(3) }, { branchId: 'main' })
  const teams = ob.listTeams(SIM)
  const t1 = teams.find((t) => t.teamId === 't1')
  assertEq(t1.total, 2, 't1 总计 2')
  assertEq(t1.branches.length, 2, 't1 有两个分支分组')
  assertEq(teams.find((t) => t.teamId === 't2').total, 1, 't2 总计 1')
}

console.log('— 9. 原分支重提 retry：快速失败沿用原 id；竞态入账派生 attemptId —')
{
  const ob = new FieldOutbox(tmpRoot())
  // 快速失败（未产生事件）：重提沿用原 id，不派生 attemptId
  ob.enqueue(SIM, TEAM, { clientActionId: 'ff-1', kind: 'ackWarning', hlc: hlc(1000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'ff-1', { status: 'conflict', result: { ok: false, code: 'duplicate-ack', msg: '重复签收' } })
  const r1 = ob.retry(SIM, TEAM, 'ff-1', { by: '现场' })
  assertEq(r1.status, 'queued', '快速失败冲突重提回 queued')
  assertEq(r1.attemptId ?? null, null, '未入账动作重提不派生 attemptId')
  assertEq(r1.retryCount, 1, '重提计数 1')
  assertEq(r1.branchId, BR, '重提固定在原分支')
  assertEq(ob.pending(SIM, TEAM, BR).length, 1, '原分支重新待发')
  // reducer 竞态（事件已入账）：重提派生 attemptId 避免与已入账事件 id 碰撞
  ob.enqueue(SIM, TEAM, { clientActionId: 'rc-1', kind: 'signDispatch', hlc: hlc(2000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'rc-1', { status: 'conflict', result: { ok: true, applied: false, advisory: ['exceeds-outstanding'] } })
  const r2 = ob.retry(SIM, TEAM, 'rc-1')
  assertEq(r2.attemptId, 'rc-1~r1', '竞态动作重提派生 attemptId')
  ob.mark(SIM, TEAM, 'rc-1', { status: 'conflict', result: { ok: true, applied: false, advisory: ['exceeds-outstanding'] } })
  const r3 = ob.retry(SIM, TEAM, 'rc-1')
  assertEq(r3.attemptId, 'rc-1~r2', '再次重提 attemptId 递增')
  // 非冲突态重提幂等（不动状态）
  ob.mark(SIM, TEAM, 'rc-1', { status: 'acked' })
  const r4 = ob.retry(SIM, TEAM, 'rc-1')
  assertEq(r4.status, 'acked', '已闭环动作重提幂等不动')
  assertEq(ob.retry(SIM, TEAM, 'nope'), null, '不存在动作返回 null')
}

console.log('— 10. 审核办结 close / 批注 annotate / 改投溯源 findByMovedFrom —')
{
  const ob = new FieldOutbox(tmpRoot())
  ob.enqueue(SIM, TEAM, { clientActionId: 'cl-1', kind: 'signDispatch', hlc: hlc(1000) }, { branchId: 'main' })
  ob.mark(SIM, TEAM, 'cl-1', { status: 'conflict', result: { ok: false, msg: '超量' } })
  const closed = ob.close(SIM, TEAM, 'cl-1', { by: '王指挥', note: '按现状办结' })
  assertEq(closed.status, 'closed', '审核办结状态 closed')
  assertEq(closed.review.by, '王指挥', '办结留痕审核人')
  assertEq(ob.pending(SIM, TEAM, 'main').length, 0, '办结动作不再待发')
  const br = ob.listBranches(SIM, TEAM).find((b) => b.branchId === 'main')
  assertEq(br.closed, 1, '分支统计含 closed 计数')
  // 批注：保持冲突态 + 留痕
  ob.enqueue(SIM, TEAM, { clientActionId: 'nt-1', kind: 'ackWarning', hlc: hlc(2000) }, { branchId: 'main' })
  ob.mark(SIM, TEAM, 'nt-1', { status: 'conflict' })
  const noted = ob.annotate(SIM, TEAM, 'nt-1', { by: '王指挥', note: '请核实后重报' })
  assertEq(noted.status, 'conflict', '批注后仍冲突态')
  assertEq(noted.review.note, '请核实后重报', '批注内容落账')
  // 改投溯源：重复审核按 movedFrom 找到新动作
  ob.enqueue(SIM, TEAM, { clientActionId: 'mv-1', kind: 'reportPosition', hlc: hlc(3000) }, { branchId: 'main' })
  ob.mark(SIM, TEAM, 'mv-1', { status: 'conflict' })
  const moved = ob.requeueForBranch(SIM, TEAM, 'mv-1', BR)
  const traced = ob.findByMovedFrom(SIM, TEAM, 'mv-1')
  assertEq(traced?.clientActionId, moved.clientActionId, 'findByMovedFrom 溯源到新动作')
  assertEq(ob.findByMovedFrom(SIM, TEAM, 'nope'), null, '无溯源返回 null')
  // prune：closed 与 acked 一样按完成态清理，冲突保留
  for (let i = 0; i < 5; i++) {
    ob.enqueue(SIM, TEAM, { clientActionId: `pz-${i}`, kind: 'reportPosition', hlc: hlc(4000 + i) }, { branchId: BR })
    ob.mark(SIM, TEAM, `pz-${i}`, { status: i % 2 ? 'closed' : 'acked' })
  }
  const removed = ob.prune(SIM, TEAM, BR, 2)
  assert(removed > 0, 'prune 清理完成态（含 closed）')
  assert(ob.list(SIM, TEAM, BR).some((a) => a.status === 'conflict' || a.clientActionId === moved.clientActionId), '冲突/改投项不被清理')
}

console.log('— 11. 崩溃恢复：closed / attemptId / review 从流水重建 —')
{
  const root = tmpRoot()
  let ob = new FieldOutbox(root)
  ob.enqueue(SIM, TEAM, { clientActionId: 'z-1', kind: 'signDispatch', hlc: hlc(1000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'z-1', { status: 'conflict', result: { ok: true, applied: false } })
  ob.retry(SIM, TEAM, 'z-1', { by: '现场' })
  ob.enqueue(SIM, TEAM, { clientActionId: 'z-2', kind: 'ackWarning', hlc: hlc(2000) }, { branchId: BR })
  ob.mark(SIM, TEAM, 'z-2', { status: 'conflict' })
  ob.close(SIM, TEAM, 'z-2', { by: '王指挥', note: '办结' })
  ob = new FieldOutbox(root)
  const z1 = ob.get(SIM, TEAM, BR, 'z-1')
  assertEq(z1.status, 'queued', '重启后重提状态恢复 queued')
  assertEq(z1.attemptId, 'z-1~r1', '重启后 attemptId 恢复')
  const z2 = ob.get(SIM, TEAM, BR, 'z-2')
  assertEq(z2.status, 'closed', '重启后办结状态恢复')
  assertEq(z2.review.by, '王指挥', '重启后审核留痕恢复')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
