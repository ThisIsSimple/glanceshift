import type { Edge } from '../perception/edge-detector'
import { directionLabel, PILOT_TARGETS, targetLabel } from './pilot-config'
import type {
  CommandTarget,
  MixerVolumes,
  PilotCondition,
  PromptSpec
} from './pilot-types'

type Props = {
  condition: PilotCondition
  visible: boolean
  edge: Edge | null
  activePrompt: PromptSpec | null
  volumes: MixerVolumes
  hoveredTarget: CommandTarget | null
  selectedTarget: CommandTarget | null
  menuOpen: boolean
}

export function MixerOverlay({
  condition,
  visible,
  edge,
  activePrompt,
  volumes,
  hoveredTarget,
  selectedTarget,
  menuOpen
}: Props): JSX.Element | null {
  if (!visible) return null

  const isBaseline = condition === 'mouse-menu'
  const sideClass = edge ? ` edge-${edge}` : ''

  if (isBaseline && !menuOpen) {
    return (
      <div className="pilot-menu-callout">
        <span>Tab / Space</span>
      </div>
    )
  }

  return (
    <div className={`pilot-mixer-overlay ${isBaseline ? 'baseline' : 'glanceshift'}${sideClass}`}>
      <div className="pilot-mixer-title">
        {activePrompt
          ? `${targetLabel(activePrompt.target)} ${directionLabel(activePrompt.direction)}`
          : 'Audio mixer'}
      </div>

      <div className="pilot-mixer-targets">
        {PILOT_TARGETS.map((target, index) => {
          const isPromptTarget = target === activePrompt?.target
          const isHovered = target === hoveredTarget
          const isSelected = target === selectedTarget
          return (
            <div
              key={target}
              className={[
                'pilot-mixer-target',
                isPromptTarget ? 'prompt-target' : '',
                isHovered ? 'hovered' : '',
                isSelected ? 'selected' : ''
              ].join(' ')}
            >
              {isBaseline && <div className="pilot-mixer-key">{index + 1}</div>}
              <div className="pilot-mixer-label">{targetLabel(target)}</div>
              <div className="pilot-mixer-meter">
                <div style={{ width: `${volumes[target] * 100}%` }} />
              </div>
            </div>
          )
        })}
      </div>

      {isBaseline && (
        <div className="pilot-keyboard-hints">1/2/3 select · Q/E adjust · Enter complete</div>
      )}
    </div>
  )
}
