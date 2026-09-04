/**
 * The demonstration figure's geometry.
 *
 * These are the tests that decide whether the drawing is a body or a tangle. They are written
 * as things a person looking at the figure would say — the head is above the hips, a raised
 * arm ends up over the head — because that is the only property that matters and it is easy
 * to satisfy the maths while failing it.
 *
 * Screen coordinates: +y is DOWN, so "above" means a smaller y.
 */
import { describe, expect, it } from 'vitest'

import { BONES, VIEW_TURN, boundsOf, toFigure } from './dancer'
import { REST } from './routines'
import type { Skeleton } from './pose'

const pose = (over: Partial<Skeleton> = {}): Skeleton => ({ ...REST, ...over })

describe('a body at rest', () => {
  it('stands up: head over neck over hips over knees over ankles', () => {
    const f = toFigure(pose())
    expect(f.head.y).toBeLessThan(f.neck.y)
    expect(f.neck.y).toBeLessThan(f.hips.y)
    expect(f.hips.y).toBeLessThan(f.leftKnee.y)
    expect(f.leftKnee.y).toBeLessThan(f.leftAnkle.y)
    expect(f.rightKnee.y).toBeLessThan(f.rightAnkle.y)
  })

  it('hangs its arms: wrists below elbows below shoulders', () => {
    // The convention this catches: shoulder elevation is measured from the spine pointing UP,
    // so a hanging arm is ~π. An earlier REST said 0.18, which is both arms straight
    // overhead — and nothing noticed, because nothing drew it.
    const f = toFigure(pose())
    expect(f.leftShoulder.y).toBeLessThan(f.leftElbow.y)
    expect(f.leftElbow.y).toBeLessThan(f.leftWrist.y)
    expect(f.rightElbow.y).toBeLessThan(f.rightWrist.y)
  })

  it('is roughly symmetric left to right when seen head on', () => {
    const f = toFigure(pose(), 0)
    expect(f.leftWrist.x + f.rightWrist.x).toBeCloseTo(0, 1)
    expect(f.leftAnkle.x + f.rightAnkle.x).toBeCloseTo(0, 1)
  })

  it('never produces a NaN, even from a pose full of them', () => {
    // Unseen joints arrive as NaN from the detector all the time. One NaN in a path
    // definition blanks the whole figure, so every joint falls back rather than propagating.
    const broken = Object.fromEntries(
      Object.keys(REST).map(name => [name, Number.NaN]),
    ) as unknown as Skeleton
    const f = toFigure(broken)
    for (const [name, dot] of Object.entries(f)) {
      expect(Number.isFinite(dot.x), `${name}.x`).toBe(true)
      expect(Number.isFinite(dot.y), `${name}.y`).toBe(true)
    }
  })
})

describe('arms go where they are told', () => {
  it('puts a raised arm above the head', () => {
    // Elevation 0 is straight up the spine.
    const f = toFigure(pose({ leftShoulder: 0.1, leftElbow: Math.PI }))
    expect(f.leftWrist.y).toBeLessThan(f.head.y)
  })

  it('puts an arm held out at roughly shoulder height, well out to the side', () => {
    const f = toFigure(pose({ leftShoulder: Math.PI / 2, leftArmAround: 0, leftElbow: Math.PI }), 0)
    expect(Math.abs(f.leftWrist.y - f.leftShoulder.y)).toBeLessThan(0.15)
    expect(Math.abs(f.leftWrist.x)).toBeGreaterThan(Math.abs(f.leftShoulder.x) + 0.7)
  })

  it('bends the elbow without moving the shoulder or detaching the arm', () => {
    const straight = toFigure(pose({ leftShoulder: Math.PI / 2, leftElbow: Math.PI }))
    const bent = toFigure(pose({ leftShoulder: Math.PI / 2, leftElbow: Math.PI / 2 }))

    expect(bent.leftShoulder.x).toBeCloseTo(straight.leftShoulder.x, 6)
    expect(bent.leftElbow.x).toBeCloseTo(straight.leftElbow.x, 6)
    // A bent arm brings the hand closer to the shoulder than a straight one.
    const reach = (f: ReturnType<typeof toFigure>) =>
      Math.hypot(f.leftWrist.x - f.leftShoulder.x, f.leftWrist.y - f.leftShoulder.y)
    expect(reach(bent)).toBeLessThan(reach(straight) - 0.2)
  })
})

describe('the three-quarter view', () => {
  it('separates forward from backward, which head on are the same picture', () => {
    // The real collapse, and the reason for the turn. An arm out to the SIDE and one straight
    // FORWARD are already distinguishable head on — they differ in x. Forward and BACKWARD
    // are not: both sit on the body's midline and differ only in depth, so orthographically
    // they land on exactly the same pixel. Half the box step is forward and back.
    const front = { leftShoulder: Math.PI / 2, leftArmAround: Math.PI / 2 }
    const back = { leftShoulder: Math.PI / 2, leftArmAround: -Math.PI / 2 }

    const apart = (turn: number) => {
      const a = toFigure(pose(front), turn)
      const b = toFigure(pose(back), turn)
      return Math.hypot(a.leftWrist.x - b.leftWrist.x, a.leftWrist.y - b.leftWrist.y)
    }

    // Head on they are the same picture.
    expect(apart(0)).toBeLessThan(0.02)
    // Turned, the difference is plain.
    expect(apart(VIEW_TURN)).toBeGreaterThan(0.5)
  })

  it('separates a step forward from a step to the side', () => {
    // The box step's entire identity. If these two land in the same place, the figure cannot
    // teach it.
    const forward = toFigure(pose({ leftHip: 0.6, leftLegAround: Math.PI / 2 }))
    const sideways = toFigure(pose({ leftHip: 0.6, leftLegAround: 0 }))
    const apart = Math.hypot(
      forward.leftAnkle.x - sideways.leftAnkle.x,
      forward.leftAnkle.y - sideways.leftAnkle.y,
    )
    expect(apart).toBeGreaterThan(0.4)
  })
})

describe('the torso', () => {
  it('tips the head towards the side it is leaning', () => {
    // Positive roll is towards the person's own left. The figure faces the viewer, so their
    // left is the viewer's right — the head moves to +x. Getting this backwards would draw a
    // sway that leans the opposite way to the one being scored, which is the worst possible
    // outcome for a demonstration.
    const upright = toFigure(pose(), 0)
    const leaning = toFigure(pose({ roll: 0.4 }), 0)
    expect(leaning.head.x).toBeGreaterThan(upright.head.x + 0.2)

    const other = toFigure(pose({ roll: -0.4 }), 0)
    expect(other.head.x).toBeLessThan(upright.head.x - 0.2)
  })

  it('faces the viewer: the person’s right is drawn on the viewer’s left', () => {
    const f = toFigure(pose(), 0)
    expect(f.rightShoulder.x).toBeLessThan(0)
    expect(f.leftShoulder.x).toBeGreaterThan(0)
  })

  it('turns the shoulders against the hips when twisted', () => {
    const straight = toFigure(pose(), 0)
    const twisted = toFigure(pose({ twist: 0.8 }), 0)
    // The hips stay put; the shoulder line narrows as it rotates away from the viewer.
    expect(twisted.leftHip.x).toBeCloseTo(straight.leftHip.x, 6)
    const width = (f: ReturnType<typeof toFigure>) => Math.abs(f.leftShoulder.x - f.rightShoulder.x)
    expect(width(twisted)).toBeLessThan(width(straight))
  })
})

describe('the drawing', () => {
  it('names only joints the figure actually has', () => {
    const f = toFigure(pose())
    for (const [from, to] of BONES) {
      expect(f[from], String(from)).toBeDefined()
      expect(f[to], String(to)).toBeDefined()
    }
  })

  it('measures one box over the whole routine rather than per frame', () => {
    // A viewport resized every frame makes the figure appear to zoom as it moves, which reads
    // as the camera moving rather than the dancer.
    const frames = [toFigure(pose()), toFigure(pose({ leftShoulder: 0.1 }))]
    const box = boundsOf(frames)
    expect(box.minY).toBeLessThanOrEqual(Math.min(...frames.map(f => f.leftWrist.y)))
    expect(box.maxY).toBeGreaterThanOrEqual(Math.max(...frames.map(f => f.leftAnkle.y)))
  })
})
