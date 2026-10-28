// 跳过片头片尾：标记的存储键、读取侧时长裁剪与「连续越过」判定。
// 思路参考 LibreTV 的 skip-marks 模块，按其语义重写（AGPL 不复制代码），
// 并适配本项目现状：只维护「片头结束点 + 片尾起点」两个边界（暂不做任意多段，UI 成本另议）。
//
// 解决的实际问题：
//  1) 原实现按 `site|id` 记忆标记：自动换源（autoSwitchOnFail）后标记即失效、
//     换一集要重标一次。改为按**归一化剧名**记忆：同剧各集、换源后的同名资源共享。
//  2) 原实现的片尾判定 `duration - t <= outro` 对**任何**位置生效：
//     用户把进度条拖到片尾区，下一帧 timeupdate 直接触发「跳下一集」——
//     根本没法回看结尾。片尾自动结束只认「连续小步越过」（正常播放每 tick 前进 ≤10s），
//     拖动/恢复进度造成的大跳变不触发。
//  3) 标记跨集/跨源共享，但各集时长不同：读取侧必须按**本集时长**裁剪
//     （片头不能超过 时长-保护带，过短/越界的边界视为无效而不是错值播放）。

import { normalizeTitle } from './vod.js'

/** 比这更短的跳过区间没有跳过价值（多半是误标） */
export const MIN_SKIP_SECONDS = 3
/** 边界至少离视频结尾这么多秒，贴着结尾的「片尾」没有意义 */
export const END_GUARD_SECONDS = 2
/** 两次 timeupdate 之间超过该秒数视为 seek/跳变，不使用「连续越过」判定 */
export const MAX_CONTINUOUS_STEP_SECONDS = 10

// 存储键：有剧名 → t:归一化剧名（跨源/跨集共享）；
// 无剧名 → f:site|id 兜底，前缀隔离防两类键形态互串。
export function skipMarkKey(title, site, id) {
  const normalized = normalizeTitle(title || '')
  if (normalized) return `t:${normalized}`
  return `f:${site || ''}|${id || ''}`
}

// 读取侧解析：把存储的 {intro, outro}（outro = 距结尾秒数）裁剪成当前这集的可用边界。
// 非法/越界返回 0（视为该边界无效），绝不抛错——损坏的持久化数据不能让播放报错。
export function resolveSkipRange(skip, duration) {
  const out = { intro: 0, outroStart: 0 }
  if (!skip || skip.enable !== true) return out
  if (!Number.isFinite(duration) || duration <= 0) return out

  const intro = Number(skip.intro) || 0
  if (intro >= MIN_SKIP_SECONDS && intro <= duration - END_GUARD_SECONDS) {
    out.intro = intro
  }

  const outro = Number(skip.outro) || 0
  if (outro >= MIN_SKIP_SECONDS) {
    const start = duration - outro
    if (start >= MIN_SKIP_SECONDS && start < duration - END_GUARD_SECONDS) {
      out.outroStart = start
    }
  }
  return out
}

// 片尾自动结束：只认「从 outroStart 之前、连续小步前进越过 outroStart」。
// prev 不可用（首个 tick / seek 后未拉平）时保守返回 false——宁可不出按钮，也不误切集。
export function crossedEnding(prev, cur, outroStart) {
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || !Number.isFinite(outroStart) || outroStart <= 0) {
    return false
  }
  const step = cur - prev
  if (step <= 0 || step > MAX_CONTINUOUS_STEP_SECONDS) return false
  return prev < outroStart && cur >= outroStart
}

// 片头自动跳：当前时间落在 (0, intro) 内才跳；
// 恢复进度恰好落在片头区内（t 明显 > 0.3 且是 seek 进来的）时，
// 只有「正常从开头播起」才自动跳——判定交给调用方（首个 tick 的 prev）。
export function inOpening(prev, cur, intro) {
  if (!Number.isFinite(cur) || !Number.isFinite(intro) || intro <= 0) return false
  if (cur <= 0.3 || cur >= intro) return false
  // prev 无效（刚起播）视为「从 0 播上来」；连续步进同样视为播上来；
  // 大跳变（seek）落在片头内时不自动跳，避免用户回看片头时被强拉走
  if (!Number.isFinite(prev)) return true
  const step = cur - prev
  return step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS
}
