/**
 * The aurora — a slow field of colour behind the mood picker.
 *
 * ## Where the idea comes from, and where it goes further
 *
 * The device is Google Stitch's: a near-black ground, a fine dotted grid, and two or three
 * enormous soft blooms of colour drifting behind a frosted panel. It is beautiful and it is
 * **decoration** — the same bloom plays whatever you type into the box, so it carries no
 * information at all.
 *
 * Here the same device carries the data. The hue, the brightness and *the speed the field
 * drifts at* are the answer to the question on the screen. A rough day is a cold indigo
 * moving almost imperceptibly; a good one is warm gold with visible energy in it. Choosing a
 * face does not merely select a value — it repaints the screen, and the repainting is the
 * feedback.
 *
 * Which makes one further thing possible that decoration cannot do: the field responds to a
 * *hover* before a choice is committed. You can feel what "Good" looks like before you say
 * it, which is a strange and quite affecting thing to be able to do.
 *
 * ## How it is drawn, and why not with blur
 *
 * Three radial gradients with soft transparent stops, on absolutely positioned layers larger
 * than the frame. Not `filter: blur()`, which is what most of these effects use: blurring a
 * full-bleed element forces the compositor to rasterise a very large surface every frame, and
 * on a mid-range phone it is the difference between free and janky. A radial gradient with a
 * long transparent falloff is already soft, costs nothing, and looks the same.
 *
 * Everything that moves is `transform` and `opacity` — compositor-only, no layout, no paint.
 *
 * ## Colour transitions
 *
 * The colours are custom properties registered with `@property` as `<color>`, which is what
 * makes them **interpolate** rather than snap. Without registration a custom property is a
 * string and the gradient jumps between palettes. With it, changing mood is a slow morph
 * across two seconds. Where `@property` is unsupported the colour still applies — it simply
 * changes at once, which is a graceful degradation rather than a broken screen.
 */
import { useEffect, useState } from 'react'

import { moodColour } from './palette'

export interface MoodAuroraProps {
  /** The chosen level, or null before anything is chosen. */
  level: number | null
  /** A level being considered but not committed. Takes precedence, so the field previews it. */
  preview?: number | null
  children: React.ReactNode
}

export function MoodAurora({
  level,
  preview = null,
  children,
}: MoodAuroraProps): React.ReactElement {
  const shown = preview ?? level
  const colour = moodColour(shown)

  // Announced only after a beat, and only for a committed choice. A field that narrates every
  // hover would make a screen reader unusable, and the colour is decoration to somebody who
  // cannot see it — the faces above are the actual control.
  const [announced, setAnnounced] = useState<string>('')
  useEffect(() => {
    if (level === null) return
    const id = window.setTimeout(() => setAnnounced(moodColour(level).word), 400)
    return () => window.clearTimeout(id)
  }, [level])

  return (
    <div
      className="aurora"
      data-level={shown ?? 0}
      style={
        {
          '--aurora-core': colour.core,
          '--aurora-echo': colour.echo,
          '--aurora-ground': colour.ground,
          '--aurora-drift': `${colour.drift}s`,
        } as React.CSSProperties
      }
    >
      {/* Three blooms on separate layers, each with its own period and phase, so the field
          never visibly repeats — the shortest common multiple of the three is very long. */}
      <div className="aurora__field" aria-hidden="true">
        <span className="aurora__bloom aurora__bloom--one" />
        <span className="aurora__bloom aurora__bloom--two" />
        <span className="aurora__bloom aurora__bloom--three" />
      </div>
      {/* The grid sits above the colour and below the content, which is what makes the blooms
          read as light behind a surface rather than as paint on top of one. */}
      <div className="aurora__grid" aria-hidden="true" />

      <div className="aurora__content">{children}</div>

      <span className="aurora__announce" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  )
}
