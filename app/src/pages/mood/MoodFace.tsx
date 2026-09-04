/*
 * The face.
 *
 * One shape per feature — two eyes, two lids, two brows, a mouth, a tongue, two cheeks —
 * and every one of them is a path string computed by {@link faceFor} from the slider's
 * value. There is no sprite sheet, no set of five drawings cross-faded, and no library:
 * moving the slider recomputes the geometry, so the expression is genuinely continuous
 * rather than five pictures with a dissolve between them. That is the whole reason it
 * reads as a face changing its mind rather than as an animation playing.
 *
 * ## The three things that make it not look flat
 *
 *  - **The head is lit, not filled.** An off-centre radial gradient, a rim light down the
 *    shaded side, and a soft occlusion under the chin. A circle of one yellow is a token;
 *    a circle with a light source is a head.
 *  - **The brows do most of the acting.** More of the difference between miserable and
 *    delighted is in the brows than in the mouth, which is the opposite of what everyone
 *    assumes. Both are drawn from a single path and mirrored, so they can never disagree.
 *  - **The eyes close upward.** At the top of the scale both edges of the eye bow up and
 *    the shape becomes a crescent — the ^ ^ of somebody laughing. It is not a special
 *    case; it falls out of interpolating one control point past zero. See sky.ts.
 *
 * ## Blinking
 *
 * On a random 3–7 second gap, and only while the eyes are open enough to have something to
 * close — a crescent has no lid to drop. The animation is a `scaleY` about the eye's own
 * bounding box, which is why the group carries `transform-box: fill-box`; without it the
 * scale would happen about the top-left of the viewBox and the eyes would fly off.
 *
 * The whole face is `aria-hidden`. It is a picture of the slider's value, and the slider
 * announces that value properly — a screen reader being told about a mouth curve would be
 * noise on top of the answer.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import { FACE_LAYOUT, faceFor } from './sky'

export interface MoodFaceProps {
  /** The slider's 0…100. */
  value: number
}

export function MoodFace({ value }: MoodFaceProps): ReactElement {
  const face = useMemo(() => faceFor(value), [value])
  const { cx, cy, r, mouthY } = FACE_LAYOUT

  /*
   * A counter rather than a boolean, because restarting a CSS animation needs the element
   * to be a new one — bumping this changes the group's `key`, React replaces it, and the
   * animation runs from the start. A boolean would fire once and then never again.
   */
  const [blink, setBlink] = useState(0)
  const crescent = face.t > 0.78

  useEffect(() => {
    if (crescent) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let cancelled = false
    let timer: number | undefined
    const schedule = (): void => {
      timer = window.setTimeout(
        () => {
          if (cancelled) return
          setBlink(previous => previous + 1)
          schedule()
        },
        3000 + Math.random() * 4000,
      )
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [crescent])

  return (
    <svg
      className="face"
      viewBox="0 0 240 240"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <defs>
        {/* Off-centre, so the light has a direction. The highlight sits up and to the
            left because that is where the sun is in MoodSky. */}
        <radialGradient id="face-skin" cx="0.36" cy="0.28" r="0.82">
          <stop offset="0%" stopColor={face.skinLit} />
          <stop offset="58%" stopColor={face.skinLit} />
          <stop offset="100%" stopColor={face.skinShade} />
        </radialGradient>

        {/* The shaded side picks up a little of the sky, which is what stops a yellow
            circle looking like it was pasted on. */}
        <linearGradient id="face-rim" x1="0.15" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="rgb(255 255 255)" stopOpacity="0.34" />
          <stop offset="46%" stopColor="rgb(255 255 255)" stopOpacity="0" />
          <stop offset="100%" stopColor="rgb(255 240 200)" stopOpacity="0.22" />
        </linearGradient>

        <radialGradient id="face-blush">
          <stop offset="0%" stopColor="rgb(240 110 120)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="rgb(240 110 120)" stopOpacity="0" />
        </radialGradient>

        {/* Keeps the tongue and the teeth inside the lips however wide the mouth opens.
            Drawn untranslated because the group that references it is the one carrying the
            translate — the clip resolves in that same space. */}
        <clipPath id="face-mouth-clip">
          <path d={face.mouth} />
        </clipPath>

        {/*
          The lid is skin lying over the eye, so it has to end where the eye ends.
          Unclipped, the part of it that overhangs the eye's own curve shows above the lash
          line as a pale angular wedge — which at half opacity, halfway along the slider,
          reads as a rendering fault rather than as a heavy eyelid.
        */}
        <clipPath id="face-eye-clip">
          <path d={face.eye} />
        </clipPath>
      </defs>

      {/* ------------------------------------------------ the head */}
      <circle cx={cx} cy={cy} r={r} fill="url(#face-skin)" />
      <circle cx={cx} cy={cy} r={r} fill="url(#face-rim)" />
      {/* Occlusion under the chin. Very faint, and it is most of the sphere. */}
      <ellipse
        cx={cx}
        cy={cy + r * 0.62}
        rx={r * 0.78}
        ry={r * 0.34}
        fill={face.skinShade}
        opacity="0.28"
      />

      {/* ------------------------------------------------ cheeks */}
      <g style={{ opacity: face.blush }}>
        <ellipse cx={cx - 54} cy={cy + 26} rx="22" ry="14" fill="url(#face-blush)" />
        <ellipse cx={cx + 54} cy={cy + 26} rx="22" ry="14" fill="url(#face-blush)" />
      </g>

      {/* ------------------------------------------------ brows
          One path, mirrored. `scale(-1 1)` on the left keeps the two in agreement by
          construction rather than by two sets of numbers that have to be kept in step. */}
      <g
        fill="none"
        stroke={face.skinShade}
        strokeWidth="9"
        strokeLinecap="round"
        style={{ filter: 'brightness(0.72)' }}
      >
        <g transform={`translate(${cx + face.eyeDx} ${face.eyeY})`}>
          <path d={face.brow} />
        </g>
        <g transform={`translate(${cx - face.eyeDx} ${face.eyeY}) scale(-1 1)`}>
          <path d={face.brow} />
        </g>
      </g>

      {/* ------------------------------------------------ eyes */}
      <g key={blink} className={blink > 0 ? 'face__eyes face__eyes--blink' : 'face__eyes'}>
        {[1, -1].map(side => (
          <g key={side} transform={`translate(${cx + face.eyeDx * side} ${face.eyeY})`}>
            <path d={face.eye} fill="#2a2018" />
            {/*
              The pupil is occluded by the closing eye rather than faded out.

              Fading it is the obvious way and it looks wrong for a reason worth naming: a
              black dot at 60% over a dark eye is grey, so three-quarters of the way up the
              slider the eyes read as *greying out* instead of *narrowing*. Clipping to the
              eye's own shape is what actually happens to an eye — by the time the shape is
              a crescent sitting above the lash line there is nowhere for a pupil to be, and
              it disappears because it is behind the lid, not because it faded.
            */}
            <g clipPath="url(#face-eye-clip)">
              <circle r="4.6" cy="1.5" fill="#120d09" />
              {/* The catchlight does fade — a specular highlight is light on a wet surface,
                  and a narrowed eye genuinely catches less of it. */}
              <circle
                r="2.4"
                cx="2.2"
                cy="-3"
                fill="rgb(255 255 255)"
                style={{ opacity: face.pupil * 0.9 }}
              />
            </g>
            {/* The heavy upper lid. Only present at the bottom of the scale, where it is
                the difference between a small eye and a tired one. */}
            <g clipPath="url(#face-eye-clip)">
              <path d={face.lidPath} fill={face.skinShade} style={{ opacity: face.lidOpacity }} />
            </g>
          </g>
        ))}
      </g>

      {/* ------------------------------------------------ mouth */}
      <g transform={`translate(${cx} ${mouthY})`}>
        <path d={face.mouth} fill="#5c2131" />
        <g clipPath="url(#face-mouth-clip)">
          {/* Teeth along the upper lip, and the tongue below. Both only readable once the
              mouth is actually open; both clipped, so neither can escape the lips. */}
          <path d={face.teeth} fill="rgb(255 253 248)" style={{ opacity: face.teethOpacity }} />
          <path d={face.tongue} fill="#e2687f" style={{ opacity: face.tongueOpacity }} />
        </g>
      </g>
    </svg>
  )
}
