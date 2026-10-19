import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const S = 256
const px = Buffer.alloc(S * S * 4)

function set(x, y, r, g, b) {
  const i = (y * S + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = 255
}

// 圆角方块背景（teal #0F6E56）
const R = 52
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = Math.min(x, S - 1 - x)
    const cy = Math.min(y, S - 1 - y)
    let inside = true
    if (cx < R && cy < R) {
      const dx = R - cx
      const dy = R - cy
      inside = dx * dx + dy * dy <= R * R
    }
    if (inside) set(x, y, 15, 110, 86)
  }
}

// 白色对勾：点到线段距离
function distSeg(x1, y1, x2, y2, px_, py_) {
  const vx = x2 - x1
  const vy = y2 - y1
  const len2 = vx * vx + vy * vy
  let t = ((px_ - x1) * vx + (py_ - y1) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const dx = px_ - (x1 + t * vx)
  const dy = py_ - (y1 + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

const TH = 20
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d1 = distSeg(68, 134, 112, 178, x, y)
    const d2 = distSeg(112, 178, 190, 92, x, y)
    if (d1 < TH || d2 < TH) set(x, y, 255, 255, 255)
  }
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA

const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(root, 'resources', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('written:', out, png.length, 'bytes')
