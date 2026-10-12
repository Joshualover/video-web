// 纯 JS 的 DES-ECB 解密（只实现解密方向，够用即可）
//
// 为什么不用 node:crypto：
//   Node 18+ 链接 OpenSSL 3，DES 属于 legacy provider，默认不加载 ——
//   createDecipheriv('des-ecb', ...) 会直接抛 "digital envelope routines::unsupported"，
//   除非用 --openssl-legacy-provider 启动（不能要求使用者这么干）。
//   JioSaavn 的加密播放地址是 DES-ECB / PKCS#5，所以这里自带一份实现。
//
// 正确性由标准测试向量保证（见 scripts/test-music.mjs）：
//   key=133457799BBCDFF1 data=0123456789ABCDEF -> 85E813540F0AB405

// 初始置换 IP
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
]
// 逆初始置换 FP
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
]
// 扩展置换 E：32 -> 48
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13,
  12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
]
// P 置换：32 -> 32
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
]
// 密钥置换 PC1：64 -> 56
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
]
// 密钥置换 PC2：56 -> 48
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
]
// 每轮左移位数
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]

// 8 个 S 盒（每个 4 行 × 16 列，这里展平成 64 个）
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
]

// 按表做位置换：表里是 1-based 的「从最高位起数第几位」
function permute(input, table, inputBits) {
  let out = 0n
  for (const position of table) {
    const bit = (input >> BigInt(inputBits - position)) & 1n
    out = (out << 1n) | bit
  }
  return out
}

function rotateLeft28(value, count) {
  const bits = BigInt(count)
  return ((value << bits) | (value >> (28n - bits))) & 0xfffffffn
}

// 由 64 位密钥生成 16 个 48 位子密钥
export function desSubkeys(key) {
  const permuted = permute(key, PC1, 64)
  let c = permuted >> 28n
  let d = permuted & 0xfffffffn
  const keys = []
  for (let i = 0; i < 16; i += 1) {
    c = rotateLeft28(c, SHIFTS[i])
    d = rotateLeft28(d, SHIFTS[i])
    keys.push(permute((c << 28n) | d, PC2, 56))
  }
  return keys
}

// 轮函数 f：32 位 -> 32 位
function feistel(right, subkey) {
  const mixed = permute(right, E, 32) ^ subkey
  let out = 0n
  for (let i = 0; i < 8; i += 1) {
    const chunk = (mixed >> BigInt(42 - 6 * i)) & 0x3fn
    const row = Number(((chunk & 0x20n) >> 4n) | (chunk & 1n))
    const col = Number((chunk >> 1n) & 0xfn)
    out = (out << 4n) | BigInt(SBOX[i][row * 16 + col])
  }
  return permute(out, P, 32)
}

// 单块 DES：加密与解密只差子密钥顺序
function cryptBlock(block, subkeys) {
  const permuted = permute(block, IP, 64)
  let left = permuted >> 32n
  let right = permuted & 0xffffffffn
  for (let i = 0; i < 16; i += 1) {
    const next = left ^ feistel(right, subkeys[i])
    left = right
    right = next
  }
  return permute((right << 32n) | left, FP, 64)
}

export function desDecryptBlock(block, key) {
  const subkeys = desSubkeys(key).reverse()
  return cryptBlock(block, subkeys)
}

export function desEncryptBlock(block, key) {
  return cryptBlock(block, desSubkeys(key))
}

// DES-ECB + PKCS#5 去填充，输入输出都是 Buffer
export function desEcbDecrypt(ciphertext, key) {
  const data = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)
  if (data.length === 0 || data.length % 8 !== 0) throw new Error('DES 密文长度必须是 8 的整数倍')
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
  if (keyBuf.length !== 8) throw new Error('DES 密钥必须是 8 字节')
  let keyBits = 0n
  for (const byte of keyBuf) keyBits = (keyBits << 8n) | BigInt(byte)

  const chunks = []
  for (let offset = 0; offset < data.length; offset += 8) {
    let blockBits = 0n
    for (let i = 0; i < 8; i += 1) blockBits = (blockBits << 8n) | BigInt(data[offset + i])
    const plain = desDecryptBlock(blockBits, keyBits)
    const out = Buffer.alloc(8)
    for (let i = 0; i < 8; i += 1) out[i] = Number((plain >> BigInt(56 - 8 * i)) & 0xffn)
    chunks.push(out)
  }
  const plain = Buffer.concat(chunks)
  // PKCS#5 去填充：末字节 n（1..8）表示填充了 n 个 n
  const pad = plain[plain.length - 1]
  if (pad >= 1 && pad <= 8 && pad <= plain.length) {
    let valid = true
    for (let i = plain.length - pad; i < plain.length; i += 1) {
      if (plain[i] !== pad) {
        valid = false
        break
      }
    }
    if (valid) return plain.subarray(0, plain.length - pad)
  }
  return plain
}

// base64 字符串形式的便捷封装（JioSaavn 的 encrypted_media_url 就是 base64）
export function desDecryptBase64(encoded, key) {
  return desEcbDecrypt(Buffer.from(String(encoded || ''), 'base64'), key).toString('utf8')
}
