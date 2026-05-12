/**
 * predev / prebuild / postinstall:
 *   WebGazer 관련 자산을 src/renderer/public/ 으로 준비한다.
 *
 *     - node_modules/webgazer/dist/webgazer.js
 *     - node_modules/webgazer/dist/mediapipe/face_mesh/...
 *
 * Note (Phase 2):
 *   Head pose 는 WebGazer 가 이미 추출하는 478개 face mesh landmarks 를 그대로
 *   재사용해서 계산한다. @mediapipe/tasks-vision 은 같은 페이지에서 두 MediaPipe
 *   런타임이 전역 Module 객체를 공유하면서 충돌하는 문제 때문에 채택하지 않았다.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
  readdirSync
} from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const publicDir = resolve(root, 'src/renderer/public')

/** size/mtime 동일하면 skip 하는 단일 파일 복사. */
function copyIfChanged(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const needs =
    !existsSync(dest) ||
    statSync(src).size !== statSync(dest).size ||
    statSync(src).mtimeMs > statSync(dest).mtimeMs
  if (needs) {
    copyFileSync(src, dest)
    return true
  }
  return false
}

/** 디렉토리 재귀 복사. */
function copyDir(srcDir, destDir) {
  let copied = 0
  if (!existsSync(srcDir)) return 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name)
    const d = join(destDir, entry.name)
    if (entry.isDirectory()) {
      copied += copyDir(s, d)
    } else if (entry.isFile()) {
      if (copyIfChanged(s, d)) copied++
    }
  }
  return copied
}

// ===== (1) WebGazer 번들 =====
const wgSrc = resolve(root, 'node_modules/webgazer/dist/webgazer.js')
if (existsSync(wgSrc)) {
  const wgChanged = copyIfChanged(wgSrc, resolve(publicDir, 'webgazer.js'))
  if (wgChanged) console.log(`[assets] webgazer.js → ${publicDir}/webgazer.js`)
} else {
  console.warn('[assets] webgazer not installed yet — skipping (run npm install)')
}

// ===== (2) WebGazer 의 MediaPipe Face Mesh =====
const wgMpSrc = resolve(root, 'node_modules/webgazer/dist/mediapipe/face_mesh')
const wgMpDest = resolve(publicDir, 'mediapipe/face_mesh')
if (existsSync(wgMpSrc)) {
  const count = copyDir(wgMpSrc, wgMpDest)
  console.log(
    count > 0
      ? `[assets] mediapipe/face_mesh: ${count} file(s) copied`
      : `[assets] mediapipe/face_mesh: up to date`
  )
}
