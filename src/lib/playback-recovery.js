// HLS/媒体播放错误恢复策略——纯决策器，不碰播放器实例。
// 思路参考 LibreTV 的 playback-recovery 模块，按其语义重写（AGPL 不复制代码），
// 并把输入从 hls.js 事件流适配到 video.js（error 事件 + error().code）。
//
// 解决的问题：现状是「一次失败 → 回退直连一次 → 立刻换源」，没有任何重试预算：
//  偶发网络抖动（CDN 单跳超时、分片 5xx）本可退避重试恢复，却直接换源，
//  换源要重拉详情/重新起播，用户感知是「动不动就跳线路」。
// 反过来，真·硬失败（格式不支持、清单解析坏）重试没有意义，应直通换源。
//
// 计数语义（关键）：「连续失败次数」。播放链路恢复（loadeddata/playing/时间前进）
// 即 markHealthy() 清零；但动作后有 3s 静默窗，窗内的成功不清零——
// 防止重试成功瞬间的噪声把计数抹掉，让偶发抖动不被误判成「源已死」，
// 而源站彻底挂掉时计数持续累积并最终触发换源。
//
// 决策动作（由调用方执行）：
//  retry(route)：退避 N ms 后重试——route='same' 以原路由重载；
//    route='switch' 优先切换传输路由（本项目：代理↔浏览器直连），
//    没有另一条路可走时执行方同样退化为原路重载
//  switch-source：重试预算耗尽 → 换线路
//  ignore：非致命或已处置

/** video.js MediaError.code 常量（W3C 规范值） */
export const VHS_ERROR_ABORT = 20 // 播放器主动中断（换源时常见）——不作为失败
export const VHS_ERROR_NETWORK = 19 // MEDIA_ERR_NETWORK：下载中断/被拒
export const VHS_ERROR_DECODE = 3 // MEDIA_ERR_DECODE：解码失败
export const VHS_ERROR_SRC_NOT_SUPPORTED = 4 // 清单/格式不支持、源已下架

/** message 含这些特征 → SRC_NOT_SUPPORTED 实际是「清单拉取失败」（网络类），值得退避重试 */
const MANIFEST_NETWORK_HINTS = /timed?[\s-]?out|network|unavailable|5\d{2}/i
/** message 含这些特征 → 真正的格式/解析硬失败，重试无意义 */
const HARD_FAIL_HINTS = /codec|parse|demux|unsupported|mimeType|container|decrypt/i

export const DEFAULT_RECOVERY_POLICY = {
  maxNetworkRetries: 3, // 连续网络失败的最大退避重试次数
  maxMediaRecoveries: 2, // 解码/媒体类失败的最大恢复次数
  baseDelayMs: 800, // 退避基值，按 2^(n-1) 递增
  maxDelayMs: 8000 // 退避上限
}

export function classifyError(code, message = '') {
  const msg = String(message || '')
  if (code === VHS_ERROR_ABORT) return 'abort'
  if (code === VHS_ERROR_NETWORK) return 'network'
  if (code === VHS_ERROR_DECODE) return 'media'
  if (code === VHS_ERROR_SRC_NOT_SUPPORTED) {
    // video.js 把「清单请求失败」也归到 SRC_NOT_SUPPORTED：按 message 再分一档
    if (MANIFEST_NETWORK_HINTS.test(msg)) return 'network'
    if (HARD_FAIL_HINTS.test(msg)) return 'hard'
    return 'media' // 兜底按媒体类处理（有恢复预算、耗尽也能换源，不会卡死）
  }
  return 'hard' // 未知错误码：没有重试价值，直接走换源路径
}

export class PlaybackRecovery {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...policy }
    this.networkRetries = 0
    this.mediaRecoveries = 0
    this.lastActionAt = 0
    this.disposed = false
    this.timers = new Set()
  }

  /** 播放链路健康的信号（loadeddata / playing / currentTime 前进）：静默窗外的成功清零计数 */
  markHealthy(now = Date.now()) {
    if (this.disposed) return
    if (this.lastActionAt && now - this.lastActionAt < 3000) return
    this.networkRetries = 0
    this.mediaRecoveries = 0
  }

  /** 连续失败（stall 计时到点视为一次网络类失败）→ 恢复决策 */
  onNetworkFailure(now = Date.now()) {
    if (this.disposed) return { action: 'ignore', reason: '已销毁' }
    if (this.networkRetries >= this.policy.maxNetworkRetries) {
      return { action: 'switch-source', reason: '连续网络失败，重试预算耗尽' }
    }
    this.networkRetries += 1
    this.lastActionAt = now
    const attempt = this.networkRetries
    const delay = Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs)
    // 第 2 次起切换传输路由：一次失败可能只是某条路由不通
    return {
      action: 'retry',
      route: attempt >= 2 ? 'switch' : 'same',
      delayMs: delay,
      attempt,
      reason: `网络失败第 ${attempt} 次，${delay}ms 后重试`
    }
  }

  /** 媒体/解码/来源异常 → 恢复决策 */
  onMediaFailure(now = Date.now()) {
    if (this.disposed) return { action: 'ignore', reason: '已销毁' }
    if (this.mediaRecoveries >= this.policy.maxMediaRecoveries) {
      return { action: 'switch-source', reason: '连续解码/来源异常，恢复预算耗尽' }
    }
    this.mediaRecoveries += 1
    this.lastActionAt = now
    const attempt = this.mediaRecoveries
    const delay = Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs)
    return {
      action: 'retry',
      route: 'same',
      delayMs: delay,
      attempt,
      reason: `媒体异常第 ${attempt} 次，${delay}ms 后重载`
    }
  }

  /** 硬失败（格式/解析）→ 直通换源 */
  onHardFailure() {
    if (this.disposed) return { action: 'ignore', reason: '已销毁' }
    this.lastActionAt = Date.now()
    return { action: 'switch-source', reason: '格式/解析硬失败' }
  }

  /** 统一入口：video.js error 事件 → 决策 */
  onPlayerError(error, now = Date.now()) {
    if (this.disposed) return { action: 'ignore', reason: '已销毁' }
    const kind = classifyError(error?.code, error?.message)
    if (kind === 'abort') return { action: 'ignore', reason: '播放器主动中断' }
    if (kind === 'network') return this.onNetworkFailure(now)
    if (kind === 'media') return this.onMediaFailure(now)
    return this.onHardFailure()
  }

  schedule(fn, delayMs) {
    if (this.disposed) return undefined
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) fn()
    }, delayMs)
    this.timers.add(timer)
    return timer
  }

  dispose() {
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
}
