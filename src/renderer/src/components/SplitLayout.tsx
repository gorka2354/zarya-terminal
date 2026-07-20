import { useRef } from 'react'
import type { SplitNode, TabState } from '@shared/types'
import { useSessionsStore } from '@/state/sessionsStore'
import { TerminalPane } from './TerminalPane'

interface Props {
  tab: TabState
  visible: boolean
}

export function SplitLayout({ tab, visible }: Props): React.JSX.Element {
  return (
    <div className="zy-panes" style={{ display: visible ? 'flex' : 'none' }}>
      <SplitNodeView node={tab.layout} tab={tab} visible={visible} />
    </div>
  )
}

function SplitNodeView({
  node,
  tab,
  visible
}: {
  node: SplitNode
  tab: TabState
  visible: boolean
}): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        sessionId={node.sessionId}
        active={tab.activeSessionId === node.sessionId}
        visible={visible}
      />
    )
  }
  return <SplitBranch node={node} tab={tab} visible={visible} />
}

function SplitBranch({
  node,
  tab,
  visible
}: {
  node: Extract<SplitNode, { type: 'split' }>
  tab: TabState
  visible: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const setSplitRatio = useSessionsStore((s) => s.setSplitRatio)
  const isRow = node.dir === 'row'

  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const gutter = e.currentTarget as HTMLElement
    gutter.classList.add('zy-split-gutter--dragging')
    const move = (ev: PointerEvent): void => {
      const frac = isRow
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      setSplitRatio(tab.id, node, Math.min(0.85, Math.max(0.15, frac)))
    }
    const up = (): void => {
      gutter.classList.remove('zy-split-gutter--dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={containerRef} className={`zy-split${isRow ? '' : ' zy-split--col'}`}>
      <div className="zy-split-child" style={{ flex: node.ratio }}>
        <SplitNodeView node={node.a} tab={tab} visible={visible} />
      </div>
      <div
        className={`zy-split-gutter zy-split-gutter--${node.dir}`}
        onPointerDown={startDrag}
      />
      <div className="zy-split-child" style={{ flex: 1 - node.ratio }}>
        <SplitNodeView node={node.b} tab={tab} visible={visible} />
      </div>
    </div>
  )
}
