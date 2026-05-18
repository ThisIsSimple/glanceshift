/**
 * DebugHud — 시선/머리 입력의 실시간 상태를 좌상단에 보여주는 디버그 패널.
 *
 * 보고서 §3.2 Feel(Cool 매체) 원칙에 따라, 평소엔 숨겨두고
 * Cmd/Ctrl+Shift+D 단축키로만 띄운다.
 */

import type { HeadSample, HeadTrackerStatus } from '../perception/face-landmarker'
import type { EdgeSnapshot } from '../perception/edge-detector'

type Props = {
  point: { x: number; y: number; t: number }
  viewport: { w: number; h: number }
  clickThrough: boolean
  inputSource: string
  trackerStatus?: string
  headStatus?: HeadTrackerStatus
  headError?: string | null
  head?: HeadSample
  edge?: EdgeSnapshot
  gazeBarHover?: string | null
  liveSliderValue?: number | null
  sliderValues?: Record<string, number>
}

function fmtDeg(v: number): string {
  const s = v >= 0 ? '+' : ''
  return `${s}${v.toFixed(1)}°`
}

function statusColor(s?: string): string | undefined {
  if (!s) return undefined
  if (s === 'ready') return '#7be38a'
  if (s === 'error') return '#ff7777'
  return 'rgba(255,255,255,0.5)'
}

export function DebugHud({
  point,
  viewport,
  clickThrough,
  inputSource,
  trackerStatus,
  headStatus,
  headError,
  head,
  edge,
  gazeBarHover,
  liveSliderValue,
  sliderValues
}: Props): JSX.Element {
  // 영역 분류 미리보기 (Phase 3 edge-detector 의 placeholder)
  const edgeFrac = 0.08
  const xFrac = point.x / viewport.w
  const yFrac = point.y / viewport.h
  let zone = 'CENTER'
  if (point.x >= 0 && point.y >= 0) {
    if (xFrac < edgeFrac) zone = 'LEFT'
    else if (xFrac > 1 - edgeFrac) zone = 'RIGHT'
    else if (yFrac < edgeFrac) zone = 'TOP'
    else if (yFrac > 1 - edgeFrac) zone = 'BOTTOM'
  }

  return (
    <div className="debug-hud">
      <h4>GlanceShift · debug</h4>

      <div className="row">
        <span className="label">input</span>
        <span className="value">{inputSource}</span>
      </div>
      <div className="row">
        <span className="label">viewport</span>
        <span className="value">{viewport.w} × {viewport.h}</span>
      </div>
      <div className="row">
        <span className="label">point</span>
        <span className="value">
          {point.x < 0 ? '—' : `${point.x.toFixed(0)}, ${point.y.toFixed(0)}`}
        </span>
      </div>
      <div className="row">
        <span className="label">zone</span>
        <span className="value" style={{ color: zone === 'CENTER' ? undefined : '#5aa9ff' }}>
          {zone}
        </span>
      </div>
      <div className="row">
        <span className="label">click-through</span>
        <span className="value">{clickThrough ? 'on' : 'off'}</span>
      </div>

      <div className="hud-sep" />

      {trackerStatus && (
        <div className="row">
          <span className="label">gaze tracker</span>
          <span className="value" style={{ color: statusColor(trackerStatus) }}>
            {trackerStatus}
          </span>
        </div>
      )}
      {headStatus && (
        <div className="row">
          <span className="label">head tracker</span>
          <span className="value" style={{ color: statusColor(headStatus) }}>
            {headStatus}
          </span>
        </div>
      )}
      {headStatus === 'error' && headError && (
        <div
          style={{
            fontSize: 10,
            color: '#ff9999',
            background: 'rgba(255, 100, 100, 0.08)',
            padding: '6px 8px',
            borderRadius: 6,
            marginTop: 4,
            maxWidth: 280,
            wordBreak: 'break-word'
          }}
        >
          {headError}
        </div>
      )}

      {head && headStatus === 'ready' && (
        <>
          <div className="row">
            <span className="label">yaw / pitch / roll</span>
            <span
              className="value"
              style={{
                color: head.detected ? undefined : 'rgba(255,255,255,0.3)',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {head.detected
                ? `${fmtDeg(head.fYaw)} ${fmtDeg(head.fPitch)} ${fmtDeg(head.fRoll)}`
                : '— no face —'}
            </span>
          </div>
          <div className="row">
            <span className="label">landmarks</span>
            <span
              className="value"
              style={{
                color:
                  head.landmarkCount >= 478
                    ? '#7be38a'
                    : head.landmarkCount > 0
                      ? '#e3c97b'
                      : 'rgba(255,255,255,0.3)'
              }}
            >
              {head.landmarkCount > 0
                ? `${head.landmarkCount}${head.landmarkCount >= 478 ? ' (iris ✓)' : ' (no iris)'}`
                : '—'}
            </span>
          </div>
          {head.iris && (
            <div className="row">
              <span className="label">iris NIC-EC</span>
              <span
                className="value"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {head.iris.mean[0].toFixed(3)}, {head.iris.mean[1].toFixed(3)}
                {' '}
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>
                  (conf {head.iris.confidence.toFixed(2)})
                </span>
              </span>
            </div>
          )}
        </>
      )}

      {edge && (
        <>
          <div className="hud-sep" />
          <div className="row">
            <span className="label">edge state</span>
            <span
              className="value"
              style={{
                color:
                  edge.state === 'entered'
                    ? '#7be38a'
                    : edge.state === 'dwelling'
                      ? '#5aa9ff'
                      : 'rgba(255,255,255,0.5)'
              }}
            >
              {edge.state}
              {edge.edge ? ` · ${edge.edge}` : ''}
            </span>
          </div>
          {edge.state === 'dwelling' && (
            <div className="row">
              <span className="label">dwell</span>
              <span className="value">
                {(edge.dwellProgress * 100).toFixed(0)}%
              </span>
            </div>
          )}
          {edge.state === 'entered' && (
            <>
              <div className="row">
                <span className="label">gazebar hover</span>
                <span
                  className="value"
                  style={{ color: gazeBarHover ? '#5aa9ff' : 'rgba(255,255,255,0.4)' }}
                >
                  {gazeBarHover ?? '—'}
                </span>
              </div>
              {gazeBarHover && liveSliderValue != null && (
                <div className="row">
                  <span className="label">slider live</span>
                  <span className="value" style={{ color: '#7be38a' }}>
                    {(liveSliderValue * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
      {sliderValues && (
        <>
          <div className="hud-sep" />
          {Object.entries(sliderValues).map(([id, v]) => (
            <div className="row" key={`sv-${id}`}>
              <span className="label">{id}</span>
              <span className="value">{(v * 100).toFixed(0)}%</span>
            </div>
          ))}
        </>
      )}

      <div className="row">
        <span className="label">FSM state</span>
        <span className="value" style={{ color: 'rgba(255,255,255,0.4)' }}>idle (Phase 6)</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
        ⌘⇧D HUD · ⌘⇧M click-through · ⌘⇧K calibrate · ⌘⇧Q quit
      </div>
    </div>
  )
}
