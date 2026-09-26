/* =========================================================================
 * 现场离线动作 · 冲突原因分级与审核决策
 *
 * 冲突分级（按处置路径分四档，网关回执 / reducer 冲突账共用同一套口径）：
 *   G0 临时推迟  —— 网关不可达 / 分支未就绪 / 态势不可用：自动重试，不算业务冲突
 *   G1 现场可修正 —— 参数 / 数量类前置不满足：现场修正后「原分支重提」
 *   G2 状态已迁移 —— 重复签收 / 非法状态跳转 / 目标已终态：确认办结或修正重提
 *   G3 需指挥裁决 —— 资源争用（库存/床位/车辆不足）、跨实体冲突、并发竞态、
 *                    分支误投：走「指挥端审核回写」（重提 / 改投 / 办结 / 批注）
 *
 * 审核决策（指挥端 → 队列 + 事件时间线 + 分支复盘三面回写）：
 *   retry    退回原分支重提（动作回到 queued，仍补传回产生它的原分支）
 *   redirect 显式改投目标分支（新 clientActionId、原动作移除、留痕 movedFrom）
 *   close    审核办结（指挥端确认按现状了结，动作退出冲突列表留档）
 *   note     批注留痕（动作保持冲突态，附指挥意见供现场参考）
 * ========================================================================= */

export const CONFLICT_GRADES = {
  G0: { grade: 'G0', label: '临时推迟', advice: '网络/分支未就绪，恢复后自动重试，无需处置' },
  G1: { grade: 'G1', label: '现场可修正', advice: '按提示修正数量/参数后，在原分支重新提交' },
  G2: { grade: 'G2', label: '状态已迁移', advice: '目标状态已变化：确认是否已被覆盖办结，或修正后重提' },
  G3: { grade: 'G3', label: '需指挥裁决', advice: '涉及资源争用/并发竞态/分支归属，需指挥端审核定夺' }
}

export const REVIEW_DECISIONS = {
  retry: '退回原分支重提',
  redirect: '显式改投分支',
  close: '审核办结',
  note: '批注留痕'
}

export const REVIEW_DECISION_KINDS = Object.keys(REVIEW_DECISIONS)

// 资源争用 / 跨实体 / 分支归属：现场无法自行了结，必须指挥端裁决（G3）
const G3_REASONS = [
  'insufficient-stock', 'insufficient-beds', 'insufficient-vehicles',
  'duplicate-other', 'branch-mismatch'
]
// 参数 / 数量类：现场修正即可（G1）
const G1_REASONS = [
  'qty-invalid', 'empty-sign', 'exceeds-outstanding', 'polygon-invalid',
  'position-invalid', 'empty-order', 'person-empty', 'no-members',
  'headcount-too-small', 'source-headcount-overflow', 'missing-action-id',
  'bad-actions', 'team-id-required', 'unknown-event-type', 'unknown-field-action'
]
// 临时性：自动重试（G0）
const G0_CODES = [
  'gateway-down', 'branch-not-found', 'no-state', 'flush-failed',
  'history-unavailable', 'fetch-failed', 'network-error'
]

function reasonPrefix(reason) {
  return String(reason || '').split(':')[0]
}

// 按 reducer 冲突原因 / 网关拒绝码分级（reason 可为 'illegal-status:held' 这类带后缀形式）
export function gradeReason(reason) {
  const r = reasonPrefix(reason)
  if (G3_REASONS.includes(r)) return 'G3'
  if (G1_REASONS.includes(r)) return 'G1'
  if (G0_CODES.includes(r)) return 'G0'
  return 'G2' // 其余一律视为状态迁移类（重复/非法跳转/目标不存在或已终态）
}

// 给一条补传回执定级：{ ok, applied, code, status, msg, advisory } → 分级 + 处置建议
export function gradeConflict(result = {}) {
  const race = result.ok === true && result.applied === false // reducer 竞态：事件已入账但业务前置未满足
  let grade
  if (race) {
    // 并发竞态默认需指挥裁决；若竞态原因本身是现场可修正类则按原因定级
    const reasons = (result.advisory || []).map(gradeReason)
    grade = reasons.includes('G3') ? 'G3' : (reasons.find((g) => g !== 'G0') || 'G3')
  } else if (result.code && G0_CODES.includes(result.code)) {
    grade = 'G0'
  } else if (result.status === 400) {
    grade = 'G1'
  } else if (result.status === 404) {
    grade = 'G2'
  } else if (result.status >= 500) {
    grade = 'G0'
  } else {
    grade = gradeReason(result.code || result.msg)
  }
  const meta = CONFLICT_GRADES[grade]
  return { grade, label: meta.label, advice: meta.advice, race }
}

// 给回执对象附加分级（原地补充并返回，便于网关/现场服务透传）
export function withGrade(result) {
  const g = gradeConflict(result)
  return { ...result, grade: g.grade, gradeLabel: g.label, advice: g.advice, race: g.race }
}
