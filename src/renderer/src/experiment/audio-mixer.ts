import gameTrackUrl from '../assets/audio/ncone-bgm-blues-guitar-loop-192099.mp3?url'
import voiceTrackUrl from '../assets/audio/freesound_community-people-talking-in-small-room-6064.mp3?url'
import type { CommandTarget, MixerVolumes } from './pilot-types'

const CHANNEL_GAIN = 0.5

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
    this.setVolumes(volumes)

    const [gameBuffer, voiceBuffer] = await Promise.all([
      loadAudioBuffer(ctx, gameTrackUrl),
      loadAudioBuffer(ctx, voiceTrackUrl)
    ])

    const gameSource = createLoopSource(ctx, gameBuffer, game)
    const voiceSource = createLoopSource(ctx, voiceBuffer, voice)
    gameSource.start()
    voiceSource.start()

    this.nodes = [gameSource, voiceSource, game, voice, master]
    await ctx.resume()
  }

  setVolumes(volumes: MixerVolumes): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.gameGain?.gain.setTargetAtTime(volumes.game * CHANNEL_GAIN, now, 0.02)
    this.voiceGain?.gain.setTargetAtTime(volumes.voice * CHANNEL_GAIN, now, 0.02)
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

async function loadAudioBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load audio asset: ${url}`)
  const data = await response.arrayBuffer()
  return ctx.decodeAudioData(data)
}

function createLoopSource(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode
): AudioBufferSourceNode {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.connect(destination)
  return source
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
