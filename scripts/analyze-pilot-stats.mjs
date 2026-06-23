#!/usr/bin/env node
/**
 * analyze-pilot-stats — 파일럿 설문/행동 로그 통계 재분석.
 *
 *   $ node scripts/analyze-pilot-stats.mjs
 *
 * 무엇을 하나 (계획: docs/analysis/.. 참고):
 *  1) 설문 1·2 를 within-subjects(대응) 형태로 합쳐 참가자 11명(임의 ID P1–P11) 구성.
 *     - 설문1(8행, 조건 라벨 있음): 연속 2행 = 한 사람 → P1–P4.
 *     - 설문2(7행, 한 행에 두 조건): 앞 4문항=베이스라인, 뒤 4문항=GlanceShift → P5–P11.
 *     - 자유응답까지 완전 동일한 행은 "중복" 으로 보고 주 분석(n=10)에서 제외, n=11 은 부수로 병기.
 *  2) 항목(통제감/자연스러움/흐름끊김/재사용)마다 **대응표본 t-검정** + Wilcoxon 부호순위검정(비모수
 *     보강) + 효과크기 Cohen's d_z. 원점수 유지(flow_break 역코딩 안 함).
 *  3) 행동 로그(P01 단일)는 **기술통계만**(추론검정 없음) — 조건별 mean/sd/median/min/max + 성공률.
 *
 * 출력:
 *   - 콘솔: 마크다운 표
 *   - docs/analysis/summary_survey_stats.csv
 *   - docs/analysis/summary_behavioral_descriptive.csv
 *
 * 외부 의존성 0 — 통계 함수(불완전베타 t-CDF, Wilcoxon 정규근사)는 직접 구현.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const OUT_DIR = join(__dirname, '..', 'docs', 'analysis')

// ───────────────────────── CSV 파서 (따옴표 안 개행 처리) ─────────────────────────
// 설문2 의 한 자유응답에 줄바꿈이 들어있어, 줄 단위 분리로는 깨진다. 전체 텍스트를
// 문자 단위 상태기계로 토큰화한다.
function parseCsv(text) {
  const noBom = text.replace(/^﻿/, '')
  const rows = []
  let row = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < noBom.length; i++) {
    const c = noBom[i]
    if (inQuote) {
      if (c === '"' && noBom[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQuote = false
      else cur += c
    } else {
      if (c === '"' && cur === '') inQuote = true
      else if (c === ',') { row.push(cur); cur = '' }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
      else if (c === '\r') { /* skip */ }
      else cur += c
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  // 완전히 빈 행 제거
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

// ───────────────────────── 통계 유틸 ─────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
function sampleSd(a) {
  if (a.length < 2) return NaN
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}
function median(a) {
  if (a.length === 0) return NaN
  const s = [...a].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// log-gamma (Lanczos)
function gammln(xx) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ]
  let x = xx
  let y = xx
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}
// 정규화 불완전베타 연속분수 (Numerical Recipes betacf)
function betacf(a, b, x) {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}
// 정규화 불완전베타 I_x(a,b)
function betai(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(
    gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x)
  )
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a
  return 1 - (bt * betacf(b, a, 1 - x)) / b
}
// Student t 양측 p값 (Numerical Recipes: A(t|ν) 의 여집합)
function studentTwoTailedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return NaN
  return betai(0.5 * df, 0.5, df / (df + t * t))
}
// 표준정규 CDF (erf 근사, A&S 7.1.26)
function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))

// 대응표본 t-검정
function pairedT(diffs) {
  const n = diffs.length
  const m = mean(diffs)
  const sd = sampleSd(diffs)
  const se = sd / Math.sqrt(n)
  const t = m / se
  const df = n - 1
  return { n, meanDiff: m, sdDiff: sd, t, df, p: studentTwoTailedP(t, df), cohenDz: m / sd }
}

// Wilcoxon 부호순위검정 (정규근사 + 연속성·동순위 보정). 0 차이는 제외.
function wilcoxonSignedRank(diffs) {
  const nz = diffs.filter((d) => d !== 0)
  const n = nz.length
  if (n === 0) return { n: 0, W: NaN, z: NaN, p: NaN }
  // |diff| 평균순위
  const abs = nz.map((d, i) => ({ a: Math.abs(d), s: Math.sign(d), i }))
  abs.sort((x, y) => x.a - y.a)
  const ranks = new Array(n)
  let tieSum = 0 // Σ(t³ − t)
  let k = 0
  while (k < n) {
    let j = k
    while (j + 1 < n && abs[j + 1].a === abs[k].a) j++
    const avg = (k + j + 2) / 2 // (k+1 .. j+1) 평균 (1-based)
    const groupSize = j - k + 1
    if (groupSize > 1) tieSum += groupSize ** 3 - groupSize
    for (let t = k; t <= j; t++) ranks[t] = avg
    k = j + 1
  }
  let wPlus = 0
  for (let t = 0; t < n; t++) if (abs[t].s > 0) wPlus += ranks[t]
  const muW = (n * (n + 1)) / 4
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48
  const cc = Math.max(Math.abs(wPlus - muW) - 0.5, 0) // 연속성 보정
  const z = cc / Math.sqrt(varW)
  const p = 2 * (1 - normCdf(z))
  return { n, W: wPlus, z, p }
}

// ───────────────────────── 설문 로드 ─────────────────────────
const ITEMS = [
  { key: 'control', label: '통제감', dir: '↑' },
  { key: 'natural', label: '자연스러움', dir: '↑' },
  { key: 'flow_break', label: '흐름끊김', dir: '↓' },
  { key: 'reuse', label: '재사용의향', dir: '↑' }
]

function num(x) {
  const v = parseFloat(x)
  return Number.isFinite(v) ? v : NaN
}

// 한 참가자 = { id, freetext, base:{control,..}, glance:{control,..} }
function loadSurvey1() {
  const rows = parseCsv(readFileSync(join(DATA_DIR, 'GlanceShift 사용자 평가 설문 1.csv'), 'utf8'))
  const body = rows.slice(1) // 헤더 제외
  const out = []
  for (let i = 0; i + 1 < body.length; i += 2) {
    const pair = [body[i], body[i + 1]]
    const gp = pair.find((r) => /gamepad/i.test(r[1]))
    const gs = pair.find((r) => /glanceshift/i.test(r[1]))
    if (!gp || !gs) throw new Error(`설문1 ${i} 행 조건 라벨 인식 실패`)
    // 열: 0 ts, 1 cond, 2 control, 3 natural, 4 flow, 5 reuse, 6 freetext
    const pick = (r) => ({ control: num(r[2]), natural: num(r[3]), flow_break: num(r[4]), reuse: num(r[5]) })
    out.push({ base: pick(gp), glance: pick(gs), freetext: gs[6] || '' })
  }
  return out
}

function loadSurvey2() {
  const rows = parseCsv(readFileSync(join(DATA_DIR, 'GlanceShift 사용자 평가 설문 2.csv'), 'utf8'))
  const body = rows.slice(1)
  // 열: 0 ts, 1-4 베이스라인(c,n,f,r), 5-8 GlanceShift(c,n,f,r), 9 freetext
  return body.map((r) => ({
    base: { control: num(r[1]), natural: num(r[2]), flow_break: num(r[3]), reuse: num(r[4]) },
    glance: { control: num(r[5]), natural: num(r[6]), flow_break: num(r[7]), reuse: num(r[8]) },
    freetext: r[9] || ''
  }))
}

function signature(p) {
  return ITEMS.map((it) => `${p.base[it.key]}|${p.glance[it.key]}`).join(',') + '#' + p.freetext.trim()
}

function buildParticipants() {
  const all = [...loadSurvey1(), ...loadSurvey2()].map((p, i) => ({ id: `P${i + 1}`, ...p }))
  // 중복(자유응답까지 완전 동일) 표시 — 첫 등장만 유지하는 집합이 n10
  const seen = new Set()
  const dupIds = []
  for (const p of all) {
    const sig = signature(p)
    if (seen.has(sig)) dupIds.push(p.id)
    else seen.add(sig)
  }
  const n10 = all.filter((p) => !dupIds.includes(p.id))
  return { all, n10, dupIds }
}

function analyzeVariant(participants) {
  return ITEMS.map((it) => {
    const base = participants.map((p) => p.base[it.key])
    const glance = participants.map((p) => p.glance[it.key])
    const diffs = participants.map((p) => p.glance[it.key] - p.base[it.key])
    const t = pairedT(diffs)
    const w = wilcoxonSignedRank(diffs)
    return {
      item: it,
      n: participants.length,
      baseMean: mean(base),
      baseSd: sampleSd(base),
      glanceMean: mean(glance),
      glanceSd: sampleSd(glance),
      diffMean: t.meanDiff,
      diffSd: t.sdDiff,
      t: t.t,
      df: t.df,
      pT: t.p,
      W: w.W,
      pW: w.p,
      dz: t.cohenDz
    }
  })
}

// ───────────────────────── 행동 로그 (기술통계만) ─────────────────────────
const BEHAV_METRICS = [
  'selection_time_ms',
  'control_time_ms',
  'total_command_time_ms',
  'gaze_off_ms_during_selection',
  'gaze_off_ms_during_adjustment',
  'gaze_missing_ms_during_command',
  'collisions_total'
]
function loadBehavioral() {
  const files = readdirSync(DATA_DIR).filter((f) => /^pilot_P01_.*\.csv$/.test(f)).sort()
  const rows = []
  for (const f of files) {
    const parsed = parseCsv(readFileSync(join(DATA_DIR, f), 'utf8'))
    const header = parsed[0]
    for (const cols of parsed.slice(1)) {
      const o = {}
      header.forEach((h, i) => (o[h] = cols[i] ?? ''))
      rows.push(o)
    }
  }
  return rows
}
function behavioralSummary(rows) {
  const conditions = ['mouse-menu', 'glanceshift']
  const out = []
  for (const cond of conditions) {
    const cr = rows.filter((r) => r.condition === cond)
    const total = cr.length
    const success = cr.filter((r) => r.command_success === 'true').length
    const incomplete = cr.filter((r) => r.incomplete === 'true').length
    out.push({ cond, metric: 'trials', n: total })
    out.push({ cond, metric: 'success_rate_pct', value: (success / total) * 100 })
    out.push({ cond, metric: 'incomplete', value: incomplete })
    for (const m of BEHAV_METRICS) {
      const vals = cr.map((r) => parseFloat(r[m])).filter((v) => Number.isFinite(v))
      out.push({
        cond,
        metric: m,
        n: vals.length,
        mean: mean(vals),
        sd: sampleSd(vals),
        median: median(vals),
        min: Math.min(...vals),
        max: Math.max(...vals)
      })
    }
  }
  return out
}

// ───────────────────────── 출력 ─────────────────────────
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—')
const fp = (x) => (Number.isFinite(x) ? (x < 0.001 ? '<0.001' : x.toFixed(3)) : '—')

function surveyTableMd(title, rows) {
  const out = []
  out.push(`### ${title} (n=${rows[0].n})\n`)
  out.push('| 항목(방향) | base mean(sd) | glance mean(sd) | diff mean(sd) | t(df) | p (t) | p (Wilcoxon) | Cohen dz |')
  out.push('|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    out.push(
      `| ${r.item.label} (${r.item.dir}) | ${f2(r.baseMean)} (${f2(r.baseSd)}) | ` +
        `${f2(r.glanceMean)} (${f2(r.glanceSd)}) | ${f2(r.diffMean)} (${f2(r.diffSd)}) | ` +
        `${f2(r.t)}(${r.df}) | ${fp(r.pT)} | ${fp(r.pW)} | ${f2(r.dz)} |`
    )
  }
  return out.join('\n')
}

function main() {
  const { all, n10, dupIds } = buildParticipants()
  console.log(`# 파일럿 설문 통계 재분석\n`)
  console.log(`참가자: 전체 ${all.length}명 (P1–P${all.length}). 중복 제외: ${dupIds.join(', ') || '없음'} → 주 분석 n=${n10.length}.\n`)
  console.log(`diff = GlanceShift − 베이스라인. flow_break 는 ↓좋음(음수 diff = 개선).\n`)

  const primary = analyzeVariant(n10) // n=10 주 분석
  const withDup = analyzeVariant(all) // n=11 부수

  console.log(surveyTableMd('주 분석 — 중복 제외', primary) + '\n')
  console.log(surveyTableMd('부수 — 중복 포함', withDup) + '\n')

  // CSV: summary_survey_stats.csv
  const csvLines = [
    'variant,question,direction,n,base_mean,base_sd,glance_mean,glance_sd,diff_mean,diff_sd,t,df,p_ttest,W,p_wilcoxon,cohen_dz'
  ]
  const emit = (variant, rows) => {
    for (const r of rows) {
      csvLines.push(
        [
          variant,
          r.item.key,
          r.item.dir,
          r.n,
          f3(r.baseMean),
          f3(r.baseSd),
          f3(r.glanceMean),
          f3(r.glanceSd),
          f3(r.diffMean),
          f3(r.diffSd),
          f3(r.t),
          r.df,
          f3(r.pT),
          f3(r.W),
          f3(r.pW),
          f3(r.dz)
        ].join(',')
      )
    }
  }
  emit('n10_primary', primary)
  emit('n11_with_dup', withDup)
  writeFileSync(join(OUT_DIR, 'summary_survey_stats.csv'), csvLines.join('\n') + '\n', 'utf8')
  console.log(`[write] docs/analysis/summary_survey_stats.csv`)

  // 행동 로그 기술통계 (추론검정 없음)
  const behav = behavioralSummary(loadBehavioral())
  const bLines = ['condition,metric,n,mean,sd,median,min,max']
  for (const b of behav) {
    if (b.value !== undefined) {
      bLines.push([b.cond, b.metric, b.n ?? '', f3(b.value), '', '', '', ''].join(','))
    } else if (b.mean !== undefined) {
      bLines.push([b.cond, b.metric, b.n, f3(b.mean), f3(b.sd), f3(b.median), b.min, b.max].join(','))
    } else {
      bLines.push([b.cond, b.metric, b.n, '', '', '', '', ''].join(','))
    }
  }
  writeFileSync(join(OUT_DIR, 'summary_behavioral_descriptive.csv'), bLines.join('\n') + '\n', 'utf8')
  console.log(`[write] docs/analysis/summary_behavioral_descriptive.csv`)

  // 검산용: n=11 평균 콘솔 출력
  console.log('\n## 검산 (n=11 평균 — 기존 summary_survey.csv 와 대조)')
  for (const r of withDup) {
    console.log(`  ${r.item.key}: base ${f2(r.baseMean)} → glance ${f2(r.glanceMean)}`)
  }
}

main()
