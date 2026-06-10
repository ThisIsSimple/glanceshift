import type { CommandTarget, MixerVolumes } from './pilot-types'

export class ExperimentAudioMixer {
  private ctx: AudioContext | null = null
  private gameGain: GainNode | null = null
  private voiceGain: GainNode | null = null
  private masterGain: GainNode | null = null
  private nodes: AudioNode[] = []

  async start(volumes: MixerVolumes): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume()
      this.setVolumes(volumes)
      return
    }

    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) throw new Error('Web Audio API is not available')
    const ctx = new Ctx()
    this.ctx = ctx

    const master = ctx.createGain()
    const game = ctx.createGain()
    const voice = ctx.createGain()
    master.connect(ctx.destination)
    game.connect(master)
    voice.connect(master)
    this.masterGain = master
    this.gameGain = game
    this.voiceGain = voice

    const gameOsc = ctx.createOscillator()
    gameOsc.type = 'sawtooth'
    gameOsc.frequency.value = 164
    const gameFilter = ctx.createBiquadFilter()
    gameFilter.type = 'lowpass'
    gameFilter.frequency.value = 620
    gameOsc.connect(gameFilter)
    gameFilter.connect(game)
    gameOsc.start()

    const voiceOsc = ctx.createOscillator()
    voiceOsc.type = 'triangle'
    voiceOsc.frequency.value = 410
    const voiceLfo = ctx.createOscillator()
    const voiceLfoGain = ctx.createGain()
    voiceLfo.frequency.value = 5.2
    voiceLfoGain.gain.value = 42
    voiceLfo.connect(voiceLfoGain)
    voiceLfoGain.connect(voiceOsc.frequency)
    voiceOsc.connect(voice)
    voiceOsc.start()
    voiceLfo.start()

    this.nodes = [gameOsc, gameFilter, voiceOsc, voiceLfo, voiceLfoGain, game, voice, master]
    this.setVolumes(volumes)
    await ctx.resume()
  }

  setVolumes(volumes: MixerVolumes): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.gameGain?.gain.setTargetAtTime(volumes.game * 0.22, now, 0.02)
    this.voiceGain?.gain.setTargetAtTime(volumes.voice * 0.18, now, 0.02)
    this.masterGain?.gain.setTargetAtTime(volumes.master, now, 0.02)
  }

  setVolume(target: CommandTarget, value: number, current: MixerVolumes): MixerVolumes {
    const next = { ...current, [target]: Math.max(0, Math.min(1, value)) }
    this.setVolumes(next)
    return next
  }

  tick(direction: 'up' | 'down'): void {
    if (!this.ctx || !this.masterGain) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = direction === 'up' ? 880 : 330
    gain.gain.setValueAtTime(0.0001, this.ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, this.ctx.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.08)
    osc.connect(gain)
    gain.connect(this.ctx.destination)
    osc.start()
    osc.stop(this.ctx.currentTime + 0.09)
  }

  async stop(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    for (const node of this.nodes) {
      const source = node as AudioScheduledSourceNode
      if (typeof source.stop === 'function') {
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
      }
      try {
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = []
    this.ctx = null
    this.gameGain = null
    this.voiceGain = null
    this.masterGain = null
    await ctx.close()
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
