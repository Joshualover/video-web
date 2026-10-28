// src/lib/playback-recovery.js 的单元测试（纯决策器，注入假时钟）
import assert from 'node:assert/strict'
import {
  PlaybackRecovery,
  classifyError,
  DEFAULT_RECOVERY_POLICY,
  VHS_ERROR_NETWORK,
  VHS_ERROR_DECODE,
  VHS_ERROR_SRC_NOT_SUPPORTED,
  VHS_ERROR_ABORT
} from '../src/lib/playback-recovery.js'

// ---- 错误分类 ----
assert.equal(classifyError(VHS_ERROR_NETWORK), 'network')
assert.equal(classifyError(VHS_ERROR_DECODE), 'media')
assert.equal(classifyError(VHS_ERROR_ABORT), 'abort')
// SRC_NOT_SUPPORTED 按 message 细分：清单拉取失败（网络类，值得重试）vs 格式硬失败
assert.equal(classifyError(VHS_ERROR_SRC_NOT_SUPPORTED, 'Request timed out'), 'network')
assert.equal(classifyError(VHS_ERROR_SRC_NOT_SUPPORTED, 'HTTP 503'), 'network')
assert.equal(classifyError(VHS_ERROR_SRC_NOT_SUPPORTED, 'Unsupported codec found'), 'hard')
assert.equal(classifyError(VHS_ERROR_SRC_NOT_SUPPORTED, 'DEMUXER_ERROR_COULD_NOT_OPEN'), 'hard')
assert.equal(classifyError(VHS_ERROR_SRC_NOT_SUPPORTED), 'media') // 无 message：保守按媒体类走恢复预算
assert.equal(classifyError(999), 'hard') // 未知码直通换源
assert.equal(classifyError(undefined), 'hard')

// ---- 网络失败：指数退避、预算耗尽换源 ----
{
  const r = new PlaybackRecovery()
  const d1 = r.onNetworkFailure(1000)
  assert.equal(d1.action, 'retry')
  assert.equal(d1.route, 'same')
  assert.equal(d1.delayMs, 800)
  assert.equal(d1.attempt, 1)

  const d2 = r.onNetworkFailure(3000)
  assert.equal(d2.action, 'retry') // 第 2 次起切换路由
  assert.equal(d2.route, 'switch')
  assert.equal(d2.delayMs, 1600)

  const d3 = r.onNetworkFailure(6000)
  assert.equal(d3.action, 'retry')
  assert.equal(d3.route, 'switch')
  assert.equal(d3.delayMs, 3200)

  const d4 = r.onNetworkFailure(9000)
  assert.equal(d4.action, 'switch-source') // 预算（3）耗尽
  r.dispose()
}

// ---- markHealthy：静默窗外的成功清零计数；窗内不清零 ----
{
  const r = new PlaybackRecovery()
  r.onNetworkFailure(1000) // 第 1 次，lastActionAt=1000
  r.markHealthy(1500) // 距动作仅 500ms（<3s 静默窗）→ 不清零
  assert.equal(r.networkRetries, 1)
  const d = r.onNetworkFailure(2000)
  assert.equal(d.attempt, 2) // 计数继续累积而不是被噪声抹掉
  r.markHealthy(20500) // 播了一会儿，超出静默窗 → 清零
  assert.equal(r.networkRetries, 0)
  const d2 = r.onNetworkFailure(30000)
  assert.equal(d2.attempt, 1)
  r.dispose()
}

// ---- 退避封顶 ----
{
  const r = new PlaybackRecovery({ baseDelayMs: 5000, maxDelayMs: 8000 })
  assert.equal(r.onNetworkFailure(0).delayMs, 5000) // attempt1: 5000
  assert.equal(r.onNetworkFailure(10000).delayMs, 8000) // attempt2: 10000 → 封顶 8000
  r.dispose()
}

// ---- 媒体失败：预算更小，同样能走到换源 ----
{
  const r = new PlaybackRecovery()
  const m1 = r.onMediaFailure(0) // 单次调用取字段，别重复触发计数
  assert.equal(m1.action, 'retry')
  assert.equal(m1.route, 'same')
  assert.equal(m1.attempt, 1)
  assert.equal(r.onMediaFailure(5000).attempt, 2)
  assert.equal(r.onMediaFailure(9000).action, 'switch-source') // 预算（2）耗尽
  r.dispose()
}

// ---- 硬失败直通换源 ----
{
  const r = new PlaybackRecovery()
  assert.equal(r.onPlayerError({ code: VHS_ERROR_SRC_NOT_SUPPORTED, message: 'unsupported mimeType for source' }).action, 'switch-source')
  // 没有任何可辨识特征的 SRC_NOT_SUPPORTED → 按 media 走恢复预算（不卡死、耗尽也能换源）
  const r2 = new PlaybackRecovery()
  assert.equal(r2.onPlayerError({ code: VHS_ERROR_SRC_NOT_SUPPORTED, message: 'no supported source' }).action, 'retry')
  r.dispose()
  r2.dispose()
}

// ---- abort 忽略（换源/换集时的正常中断不该算失败）----
{
  const r = new PlaybackRecovery()
  assert.equal(r.onPlayerError({ code: VHS_ERROR_ABORT }).action, 'ignore')
  assert.equal(r.networkRetries, 0)
  r.dispose()
}

// ---- dispose 后一切静默；schedule 的定时器被清 ----
{
  const r = new PlaybackRecovery()
  let fired = false
  r.schedule(() => { fired = true }, 5)
  r.dispose()
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(fired, false)
  assert.equal(r.onNetworkFailure(0).action, 'ignore')
  assert.equal(r.onPlayerError({ code: VHS_ERROR_NETWORK }).action, 'ignore')
}

// ---- schedule 正常触发 ----
{
  const r = new PlaybackRecovery()
  let count = 0
  r.schedule(() => { count += 1 }, 5)
  await new Promise((res) => setTimeout(res, 40))
  assert.equal(count, 1)
  r.dispose()
}

assert.equal(DEFAULT_RECOVERY_POLICY.maxNetworkRetries, 3)

console.log('playback-recovery: all assertions passed')
