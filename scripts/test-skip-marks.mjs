// src/lib/skip-marks.js 的单元测试（纯函数，Node 下直接跑）
import assert from 'node:assert/strict'
import {
  skipMarkKey,
  resolveSkipRange,
  crossedEnding,
  inOpening,
  MIN_SKIP_SECONDS,
  END_GUARD_SECONDS
} from '../src/lib/skip-marks.js'

// ---- 存储键：剧名优先、site|id 兜底、前缀隔离 ----
assert.equal(skipMarkKey('庆余年 第二季', 'siteA', '123'), skipMarkKey('庆余年第二季', 'siteB', '999'))
assert.ok(skipMarkKey('庆余年', 'siteA', '1').startsWith('t:'))
assert.equal(skipMarkKey('', 'siteA', '123'), 'f:siteA|123')
assert.equal(skipMarkKey(null, 'siteA', '123'), 'f:siteA|123')
assert.notEqual(skipMarkKey('f:siteA|123', '', ''), skipMarkKey('', 'siteA', '123')) // 标题不会伪装成兜底键

// ---- 读取侧裁剪 ----
{
  // 正常：片头 90s、片尾剩 60s，时长 1500s
  const r = resolveSkipRange({ enable: true, intro: 90, outro: 60 }, 1500)
  assert.deepEqual(r, { intro: 90, outroStart: 1440 })

  // 关闭开关 → 全部无效
  assert.deepEqual(resolveSkipRange({ enable: false, intro: 90, outro: 60 }, 1500), { intro: 0, outroStart: 0 })

  // 跨集越界：电影 1500s 标了 intro=900，切到 300s 的短视频集 → 片头无效（> 时长-保护带）
  assert.equal(resolveSkipRange({ enable: true, intro: 900, outro: 0 }, 300).intro, 0)

  // 太短的边界视为误标
  assert.equal(resolveSkipRange({ enable: true, intro: 1, outro: 1 }, 1500).intro, 0)
  assert.equal(resolveSkipRange({ enable: true, intro: 0, outro: 1 }, 1500).outroStart, 0)
  assert.ok(MIN_SKIP_SECONDS >= 3 && END_GUARD_SECONDS >= 2)

  // 片尾起点贴到开头 → 无效（outro 接近全长说明标错）
  assert.equal(resolveSkipRange({ enable: true, intro: 0, outro: 1499 }, 1500).outroStart, 0)

  // duration 非法 / 数据损坏 → 静默返回 0，绝不抛错
  assert.deepEqual(resolveSkipRange({ enable: true, intro: 90, outro: 60 }, 0), { intro: 0, outroStart: 0 })
  assert.deepEqual(resolveSkipRange({ enable: true, intro: 90, outro: 60 }, NaN), { intro: 0, outroStart: 0 })
  assert.deepEqual(resolveSkipRange(null, 1500), { intro: 0, outroStart: 0 })
  assert.deepEqual(resolveSkipRange('garbage', 1500), { intro: 0, outroStart: 0 })
}

// ---- 片尾「连续越过」：拖动不得触发跳下一集 ----
// 正常播放步进（<1s/tick）越过 → true
assert.equal(crossedEnding(1439.2, 1440.4, 1440), true)
// 用户把进度条拖进片尾区 → false（大跳变）
assert.equal(crossedEnding(300, 1441, 1440), false)
// 拖出片尾区（倒退）→ false
assert.equal(crossedEnding(1500, 1441, 1440), false)
// 尚未到达 → false
assert.equal(crossedEnding(1430, 1435, 1440), false)
// prev 无效（首个 tick / seek 未拉平）→ 保守 false
assert.equal(crossedEnding(NaN, 1441, 1440), false)
assert.equal(crossedEnding(undefined, 1441, 1440), false)
// outroStart 无效 → false
assert.equal(crossedEnding(1439, 1440, 0), false)
// 暂停后恢复的 10s+ 巨步进不算「连续越过」
assert.equal(crossedEnding(1425, 1441, 1440), false)

// ---- 片头自动跳：播上来才跳，seek 进片头不强拉 ----
// 正常从 0 播上来进入片头区 → true
assert.equal(inOpening(0.1, 2.0, 90), true)
assert.equal(inOpening(NaN, 1.5, 90), true) // 首个 tick 视为从 0 播起
// 用户 seek 到片头中段回看 → false
assert.equal(inOpening(500, 55, 90), false)
// 不在片头区 → false
assert.equal(inOpening(88, 95, 90), false)
assert.equal(inOpening(89, 91, 90), false)
assert.equal(inOpening(90, 95, 0), false) // intro 无效
assert.equal(inOpening(0, 0.1, 90), false) // 太靠前（<=0.3）不动作

console.log('skip-marks: all assertions passed')
