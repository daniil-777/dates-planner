
import { describe, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { toFigure, VIEW_TURN } from './dancer'
import { REST } from './routines'
import { poseAt } from './routines'
import { ROUTINES } from './routines'
const LOG = (...a: unknown[]): void => { appendFileSync('/tmp/probe3.txt', a.join(' ') + '\n') }

describe('view direction', () => {
  it('left arm raised, seen from the front vs from behind', () => {
    const pose = { ...REST, leftShoulder: 0.6, leftArmAround: 1.2, leftElbow: 2.8 }
    for (const [name, turn] of [['front 3/4', VIEW_TURN], ['behind 3/4', Math.PI + VIEW_TURN], ['dead front', 0], ['dead behind', Math.PI]] as const) {
      const f = toFigure(pose, turn)
      LOG(name, '| leftWrist x', f.leftWrist.x.toFixed(2), 'y', f.leftWrist.y.toFixed(2), 'z', f.leftWrist.z.toFixed(2),
        '| rightWrist x', f.rightWrist.x.toFixed(2), '| head y', f.head.y.toFixed(2))
    }
  })
  it('box step beat 1 (left foot forward): does depth read as sideways travel', () => {
    const turnRoutine = ROUTINES.find(r => r.id === 'box')!
    for (const beat of [0, 1, 2, 4]) {
      const p = poseAt(turnRoutine.keys, beat)
      const front = toFigure(p, VIEW_TURN)
      const back = toFigure(p, Math.PI + VIEW_TURN)
      LOG('beat', beat, '| front leftAnkle x', front.leftAnkle.x.toFixed(2), 'y', front.leftAnkle.y.toFixed(2),
        '| back leftAnkle x', back.leftAnkle.x.toFixed(2), 'y', back.leftAnkle.y.toFixed(2))
    }
  })
})
