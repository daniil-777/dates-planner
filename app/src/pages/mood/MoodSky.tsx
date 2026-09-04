/*
 * The sky behind the mood picker — a thunderstorm at one end of the slider and a clear
 * noon at the other, with everything in between.
 *
 * ## What is doing the work
 *
 * Four things, layered back to front: a vertical sky gradient, the sun, a cloud deck, and
 * rain. Each of them reads its strength from {@link weatherFor}, so the whole scene is one
 * function of one number and there is no state anywhere in it except the lightning timer.
 *
 * ## The clouds, and why they are filtered
 *
 * A cumulus drawn from overlapping ellipses looks like overlapping ellipses. What makes a
 * cloud read as a cloud is that its edge is fractal — soft in some places, torn in others,
 * never a smooth arc. So each cloud is a handful of ellipses pushed through a static
 * `feTurbulence` + `feDisplacementMap`, which tears the outline into something with grain
 * in it, and then blurred a little.
 *
 * That filter is expensive to *rasterise* and free to *move*, so the two are kept apart:
 * the filter is applied to an inner group and the drift animation to the outer one. The
 * browser rasterises each cloud once and then translates the cached result, which is the
 * difference between this being free and this being the reason the page drops frames on a
 * mid-range phone. Nothing in the filter is animated — `baseFrequency` and `seed` are
 * fixed — because animating a filter primitive re-runs the whole pipeline every frame.
 *
 * ## The rain
 *
 * HTML rather than SVG, and `repeating-linear-gradient` rather than a few thousand lines:
 * two tall layers translated on a loop, at different speeds and opacities, which is enough
 * for parallax and costs one composited transform each. See sky.css.
 *
 * ## Motion
 *
 * Everything that moves is `transform` or `opacity`. Under `prefers-reduced-motion` the
 * drift, the rays and the rain all stop and the lightning never fires — the scene stays
 * fully legible, because none of the information is carried by the movement.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { weatherFor } from './sky'

export interface MoodSkyProps {
  /** The slider's 0…100. */
  value: number
  children?: ReactNode
}

/**
 * One cloud, as a silhouette of overlapping ellipses.
 *
 * Written as plain data so the shapes can be uneven — a cumulus is lopsided, and four
 * ellipses on a regular grid is a caterpillar. `[cx, cy, rx, ry]`, in the cloud's own
 * space, sitting on a baseline of y = 0.
 */
type Puff = readonly [number, number, number, number]

const CLOUD_SHAPES: readonly (readonly Puff[])[] = [
  [
    [0, 0, 46, 26],
    [34, -8, 34, 30],
    [-32, 4, 30, 20],
    [66, 6, 26, 17],
    [12, -20, 26, 20],
  ],
  [
    [0, 0, 38, 22],
    [-30, 6, 26, 16],
    [28, 2, 30, 21],
    [4, -16, 24, 18],
  ],
  [
    [0, 0, 52, 24],
    [40, 6, 30, 17],
    [-38, 8, 28, 15],
    [-6, -18, 30, 21],
    [22, -12, 24, 18],
  ],
]

/** Where each cloud sits, how big it is, how fast it drifts, and which shape it uses. */
const CLOUD_LAYOUT = [
  { shape: 0, x: 70, y: 74, scale: 1.15, speed: 1, depth: 0 },
  { shape: 2, x: 280, y: 52, scale: 0.95, speed: 0.72, depth: 1 },
  { shape: 1, x: 190, y: 104, scale: 1.35, speed: 1.3, depth: 0 },
  { shape: 2, x: 350, y: 118, scale: 0.8, speed: 0.55, depth: 2 },
  { shape: 1, x: 20, y: 128, scale: 0.7, speed: 0.9, depth: 2 },
] as const

/** The small fair-weather clouds that only appear once the deck has broken up. */
const WISP_LAYOUT = [
  { shape: 1, x: 96, y: 62, scale: 0.44, speed: 0.6 },
  { shape: 0, x: 300, y: 92, scale: 0.34, speed: 0.85 },
] as const

function puffs(shape: number): readonly Puff[] {
  return CLOUD_SHAPES[shape] ?? CLOUD_SHAPES[0]!
}

export function MoodSky({ value, children }: MoodSkyProps): ReactElement {
  const weather = useMemo(() => weatherFor(value), [value])

  /*
   * Lightning.
   *
   * Fires on a random interval so it is never a metronome — a storm that flashes exactly
   * every four seconds reads as a loading indicator. The gap shortens as the slider goes
   * down, so the worst end of the scale is also the most agitated.
   *
   * The timer is rescheduled from inside the effect rather than run on an interval, which
   * is what lets each gap be a different length, and it is cleared on unmount and whenever
   * the storm ends — a flash arriving on a sunny screen would be a bug with a very long
   * reproduction time.
   */
  const [flash, setFlash] = useState(0)
  const storm = weather.storm
  const reduced = useRef(false)

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  useEffect(() => {
    if (storm <= 0.02 || reduced.current) {
      setFlash(0)
      return
    }
    let cancelled = false
    let clear: number | undefined
    let next: number | undefined

    const schedule = (): void => {
      // 2.2s at the very bottom of the scale, stretching towards 9s as the storm eases.
      const gap = 2200 + (1 - storm) * 6800 + Math.random() * 2600
      next = window.setTimeout(() => {
        if (cancelled) return
        // A counter rather than a boolean: re-triggering a CSS animation needs the element
        // to change identity, and `key` on a counter is the cheapest way to say that.
        setFlash(previous => previous + 1)
        clear = window.setTimeout(() => {
          if (!cancelled) setFlash(0)
        }, 900)
        schedule()
      }, gap)
    }
    schedule()

    return () => {
      cancelled = true
      if (next !== undefined) window.clearTimeout(next)
      if (clear !== undefined) window.clearTimeout(clear)
    }
  }, [storm])

  const style = {
    '--sky-top': weather.sky.top,
    '--sky-upper': weather.sky.upper,
    '--sky-mid': weather.sky.mid,
    '--sky-horizon': weather.sky.horizon,
    '--sky-rain': weather.rain,
    '--sky-drift': `${weather.drift}s`,
    '--sky-warmth': weather.warmth,
  } as React.CSSProperties

  return (
    <div className="sky" style={style} data-storm={storm > 0.02 ? 'yes' : 'no'}>
      <svg
        className="sky__scene"
        viewBox="0 0 400 300"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="sky-air" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={weather.sky.top} />
            <stop offset="38%" stopColor={weather.sky.upper} />
            <stop offset="72%" stopColor={weather.sky.mid} />
            <stop offset="100%" stopColor={weather.sky.horizon} />
          </linearGradient>

          {/* The sun, in three parts: a wide atmospheric bloom, a tight corona, and the
              disc itself. Real suns are white in the middle and warm at the edge — a solid
              yellow circle is the single thing that most makes a drawn sky look drawn. */}
          <radialGradient id="sky-bloom">
            <stop offset="0%" stopColor="rgb(255 236 190)" stopOpacity="0.72" />
            <stop offset="42%" stopColor="rgb(255 205 128)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="rgb(255 188 108)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sky-corona">
            <stop offset="0%" stopColor="rgb(255 252 240)" stopOpacity="0.95" />
            <stop offset="55%" stopColor="rgb(255 231 170)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="rgb(255 214 140)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sky-disc">
            <stop offset="0%" stopColor="rgb(255 255 252)" />
            <stop offset="62%" stopColor="rgb(255 240 196)" />
            <stop offset="100%" stopColor="rgb(255 199 92)" />
          </radialGradient>
          {/*
            Crepuscular rays, and the direction matters.

            In objectBoundingBox units `y1=0` is the *top* of the shape's box, which for a
            spike pointing upward is its far tip — so the obvious gradient fades from the
            tip towards the sun and the rays read as pale slabs hanging in the sky with
            their bright ends detached from the light. userSpaceOnUse, running from the
            base at the sun outwards to the tip, is the one that reads as light.
          */}
          <linearGradient
            id="sky-ray"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="0"
            y2="-150"
          >
            <stop offset="0%" stopColor="rgb(255 244 214)" stopOpacity="0.34" />
            <stop offset="55%" stopColor="rgb(255 236 190)" stopOpacity="0.1" />
            <stop offset="100%" stopColor="rgb(255 226 160)" stopOpacity="0" />
          </linearGradient>

          {/* A cloud's own shading: lit on top, heavy underneath. The two ends come from
              the weather, so the same geometry is a storm cell or a fair-weather cumulus
              without changing a single coordinate. */}
          <linearGradient id="sky-cloud" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={weather.cloudLit} />
            <stop offset="62%" stopColor={weather.cloudLit} />
            <stop offset="100%" stopColor={weather.cloudShade} />
          </linearGradient>

          {/* Static on purpose — see the header. Tears the ellipse outlines into something
              with grain, then softens what is left. */}
          <filter id="sky-vapour" x="-35%" y="-55%" width="170%" height="210%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.014 0.026"
              numOctaves="4"
              seed="11"
              result="grain"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="grain"
              scale="24"
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feGaussianBlur stdDeviation="2.2" />
          </filter>

          {/* The haze that sits on a horizon and is most of the reason distance reads as
              distance. */}
          <linearGradient id="sky-haze" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={weather.sky.horizon} stopOpacity="0" />
            <stop offset="100%" stopColor={weather.sky.horizon} stopOpacity="0.85" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="400" height="300" fill="url(#sky-air)" />

        {/* ------------------------------------------------ the sun */}
        <g
          className="sky__sun"
          style={{ opacity: weather.sun }}
          transform={`translate(286 ${weather.sunY})`}
        >
          <circle r="132" fill="url(#sky-bloom)" />
          {/* Spikes rather than slabs: a ray that tapers to a point has no far edge to
              give itself away, which is what lets an unblurred shape read as light. */}
          <g className="sky__rays">
            {Array.from({ length: 12 }, (_, index) => (
              <path
                key={index}
                d="M -11 0 L 11 0 L 0 -150 Z"
                fill="url(#sky-ray)"
                transform={`rotate(${index * 30})`}
              />
            ))}
          </g>
          <circle r="58" fill="url(#sky-corona)" />
          <circle r="25" fill="url(#sky-disc)" />
        </g>

        {/* ------------------------------------------------ the cloud deck */}
        <g style={{ opacity: weather.cover }}>
          {CLOUD_LAYOUT.map((cloud, index) => (
            <g
              key={`deck-${index}`}
              className="sky__cloud"
              style={
                { '--drift-speed': cloud.speed, '--drift-phase': index } as React.CSSProperties
              }
              transform={`translate(${cloud.x} ${cloud.y}) scale(${cloud.scale})`}
              opacity={1 - cloud.depth * 0.16}
            >
              <g filter="url(#sky-vapour)">
                {puffs(cloud.shape).map(([cx, cy, rx, ry], puff) => (
                  <ellipse key={puff} cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#sky-cloud)" />
                ))}
              </g>
            </g>
          ))}
        </g>

        {/* The fair-weather wisps, which arrive as the deck goes. Without them a clear sky
            is an empty gradient, and an empty gradient has no scale to it. */}
        <g style={{ opacity: weather.wisp * 0.85 }}>
          {WISP_LAYOUT.map((cloud, index) => (
            <g
              key={`wisp-${index}`}
              className="sky__cloud"
              style={
                { '--drift-speed': cloud.speed, '--drift-phase': index + 5 } as React.CSSProperties
              }
              transform={`translate(${cloud.x} ${cloud.y}) scale(${cloud.scale})`}
            >
              <g filter="url(#sky-vapour)">
                {puffs(cloud.shape).map(([cx, cy, rx, ry], puff) => (
                  <ellipse key={puff} cx={cx} cy={cy} rx={rx} ry={ry} fill="rgb(255 255 255)" />
                ))}
              </g>
            </g>
          ))}
        </g>

        <rect x="0" y="196" width="400" height="104" fill="url(#sky-haze)" />

        {/* ------------------------------------------------ lightning */}
        {flash > 0 ? (
          <g key={flash} className="sky__bolt" style={{ opacity: storm }}>
            <path
              d="M 214 24 L 188 132 L 214 128 L 178 246 L 236 118 L 208 122 L 240 22 Z"
              fill="rgb(255 253 238)"
            />
          </g>
        ) : null}
      </svg>

      {/* Rain. Two layers for parallax; opacity and speed both come from the weather. */}
      <div className="sky__rain sky__rain--far" aria-hidden="true" />
      <div className="sky__rain sky__rain--near" aria-hidden="true" />

      {/* The flash lights the whole frame, not only the bolt — which is what a real one
          does, and what stops the bolt reading as a sticker. */}
      {flash > 0 ? (
        <div key={flash} className="sky__flash" style={{ opacity: storm }} aria-hidden="true" />
      ) : null}

      {/* A warm wash once the sun is properly up, so the light in the scene reaches the
          things in front of it rather than staying in the background. */}
      <div className="sky__warm" aria-hidden="true" />

      <div className="sky__content">{children}</div>
    </div>
  )
}
