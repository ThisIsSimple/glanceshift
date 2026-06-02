/**
 * One Euro Filter — Casiez, Roussel & Vogel (2012, CHI).
 *
 * 시선·머리 각도 같은 노이즈가 많은 실시간 신호를:
 *   - 정지/느린 움직임에서는 강하게 스무딩 (jitter 제거)
 *   - 빠른 움직임에서는 약하게 스무딩 (지연 최소화)
 *
 * 핵심 파라미터:
 *   mincutoff : 정지 시 cutoff 주파수 (낮을수록 부드러움 ↑, 지연 ↑)
 *   beta      : 움직임 속도에 따른 cutoff 증가량 (높을수록 빠른 움직임에 즉응)
 *   dcutoff   : 미분(속도) 신호의 cutoff (보통 1.0)
 *
 * 시선용 권장 시작값: { mincutoff: 1.0, beta: 0.007, dcutoff: 1.0 }
 * 머리 각도용 권장 : { mincutoff: 1.5, beta: 0.05,  dcutoff: 1.0 }
 */

class LowPassFilter {
  private y: number | null = null
  reset(): void {
    this.y = null
  }
  filter(x: number, alpha: number): number {
    if (this.y === null) {
      this.y = x
    } else {
      this.y = alpha * x + (1 - alpha) * this.y
    }
    return this.y
  }
  hasInit(): boolean {
    return this.y !== null
  }
  lastValue(): number {
    return this.y ?? 0
  }
}

export class OneEuroFilter {
  private xFilter = new LowPassFilter()
  private dxFilter = new LowPassFilter()
  private lastT: number | null = null

  constructor(
    public freq: number,
    public mincutoff = 1.0,
    public beta = 0.0,
    public dcutoff = 1.0
  ) {}

  reset(): void {
    this.xFilter.reset()
    this.dxFilter.reset()
    this.lastT = null
  }

  private alpha(cutoff: number): number {
    const te = 1 / this.freq
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / te)
  }

  /** timestamp 는 ms (performance.now() 또는 Date.now()). */
  filter(x: number, timestamp?: number): number {
    if (timestamp != null && this.lastT != null) {
      const dt = (timestamp - this.lastT) / 1000
      if (dt > 1e-6) this.freq = 1 / dt
    }
    if (timestamp != null) this.lastT = timestamp

    const prev = this.xFilter.lastValue()
    const dx = this.xFilter.hasInit() ? (x - prev) * this.freq : 0
    const edx = this.dxFilter.filter(dx, this.alpha(this.dcutoff))
    const cutoff = this.mincutoff + this.beta * Math.abs(edx)
    return this.xFilter.filter(x, this.alpha(cutoff))
  }
}

/** 2D 좌표용 편의 래퍼. */
export class OneEuro2D {
  private fx: OneEuroFilter
  private fy: OneEuroFilter
  constructor(opts: { freq?: number; mincutoff?: number; beta?: number; dcutoff?: number } = {}) {
    const { freq = 60, mincutoff = 1.0, beta = 0.007, dcutoff = 1.0 } = opts
    this.fx = new OneEuroFilter(freq, mincutoff, beta, dcutoff)
    this.fy = new OneEuroFilter(freq, mincutoff, beta, dcutoff)
  }
  filter(x: number, y: number, timestamp?: number): { x: number; y: number } {
    return { x: this.fx.filter(x, timestamp), y: this.fy.filter(y, timestamp) }
  }
  reset(): void {
    this.fx.reset()
    this.fy.reset()
  }
}
