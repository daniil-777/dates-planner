
import { describe, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { toSequence, ROUTINES } from './routines'
import { scoreRoutine } from './score'
const LOG = (...a: unknown[]): void => { appendFileSync('/tmp/probe2.txt', a.join(' ') + '\n') }

// ---- proposed fixed roll/pitch, computed from the same synthetic bodies ----
type V = [number, number, number]
const sub = (a: V, b: V): V => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
const unit = (a: V): V => { const n = Math.hypot(...a); return [a[0]/n, a[1]/n, a[2]/n] }
const dot = (a: V, b: V): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
const cross = (a: V, b: V): V => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
const rot = (v: V, axis: V, a: number): V => {
  const c = Math.cos(a), s = Math.sin(a)
  const k = cross(axis, v), d = dot(axis, v)
  return [v[0]*c+k[0]*s+axis[0]*d*(1-c), v[1]*c+k[1]*s+axis[1]*d*(1-c), v[2]*c+k[2]*s+axis[2]*d*(1-c)]
}
function fixed(rollRad: number, pitchRad: number, yaw = 0): { roll: number; pitch: number } {
  let ls: V = [-0.2, -0.5, 0], rs: V = [0.2, -0.5, 0], lh: V = [-0.1, 0, 0], rh: V = [0.1, 0, 0]
  const tilt = (p: V): V => rot(rot(rot(p, [0,0,1], rollRad), [1,0,0], pitchRad), [0,1,0], yaw)
  ls = tilt(ls); rs = tilt(rs); lh = tilt(lh); rh = tilt(rh)
  const shoulders: V = [(ls[0]+rs[0])/2, (ls[1]+rs[1])/2, (ls[2]+rs[2])/2]
  const hips: V = [(lh[0]+rh[0])/2, (lh[1]+rh[1])/2, (lh[2]+rh[2])/2]
  const up = unit(sub(shoulders, hips))
  const across = unit(sub(rs, ls))
  const worldUp: V = [0, -1, 0]
  // flatten the body's lateral axis into the horizontal plane -> a yaw-aligned world frame
  const rightH = unit(sub(across, [worldUp[0]*dot(across, worldUp), worldUp[1]*dot(across, worldUp), worldUp[2]*dot(across, worldUp)]))
  const fwdH = unit(cross(rightH, worldUp))
  return { roll: Math.atan2(-dot(up, rightH), dot(up, worldUp)), pitch: Math.atan2(dot(up, fwdH), dot(up, worldUp)) }
}

describe('probe2', () => {
  it('fixed roll/pitch is signed and yaw-invariant', () => {
    for (const [n, r, p] of [['upright',0,0],['own-left',0.3,0],['own-right',-0.3,0],['fwd',0,0.3],['back',0,-0.3]] as const) {
      const a = fixed(r, p), b = fixed(r, p, 1.2)
      LOG(n, 'roll', a.roll.toFixed(3), 'pitch', a.pitch.toFixed(3), '| yawed 69deg: roll', b.roll.toFixed(3), 'pitch', b.pitch.toFixed(3))
    }
  })
  it('timing band: how late can you be and still score 100', () => {
    for (const r of ROUTINES) {
      const seq = toSequence(r, 20)
      for (const lateFrames of [10, 20, 30, 40]) {
        const learner = seq.slice(lateFrames).concat(seq.slice(0, lateFrames))
        LOG(r.id, 'shifted', lateFrames, 'frames (', (lateFrames/20).toFixed(1), 's ) ->', scoreRoutine(seq, learner).score)
      }
      // half speed: learner performs the same shapes over twice as long
      const slow: typeof seq = []
      for (const f of seq) { slow.push(f); slow.push(f) }
      LOG(r.id, 'danced at HALF SPEED ->', scoreRoutine(seq, slow).score)
    }
  })
})
