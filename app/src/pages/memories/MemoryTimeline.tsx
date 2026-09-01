/**
 * The timeline itself: a Fiori `Timeline` of memories and of the expenses that
 * were worth remembering, newest first, grouped by month, with pinned items
 * lifted into their own section above.
 *
 * Every item carries a stable DOM id (`entryDomId`) because the map view
 * scrolls to it when a pin is tapped.
 */

import {
  Button,
  Icon,
  Text,
  Timeline,
  TimelineGroupItem,
  TimelineItem,
} from '@ui5/webcomponents-react'
import { MoneyText } from '@/components/MoneyText'
import { api } from '@/api/client'
import { formatSwissDate } from './dates'
import { entryDomId, kindIcon, kindLabel, noteExcerpt } from './timeline'
import type { MonthGroup, TimelineEntry } from './timeline'

export interface MemoryTimelineProps {
  pinned: readonly TimelineEntry[]
  groups: readonly MonthGroup[]
  onEdit: (entry: TimelineEntry) => void
  onTogglePin: (entry: TimelineEntry) => void
  onDelete: (entry: TimelineEntry) => void
  onCompose: (entry: TimelineEntry) => void
  onOpenDocumentOne: (entry: TimelineEntry) => void
  busyKey: string | null
  flashKey: string | null
}

interface EntryProps extends Omit<MemoryTimelineProps, 'pinned' | 'groups'> {
  entry: TimelineEntry
}

function EntryItem({
  entry,
  onEdit,
  onTogglePin,
  onDelete,
  onCompose,
  onOpenDocumentOne,
  busyKey,
  flashKey,
}: EntryProps) {
  const excerpt = noteExcerpt(entry.note)
  const nameParts = [kindLabel(entry.kind)]
  if (entry.place) nameParts.push(entry.place)
  const busy = busyKey === entry.key

  return (
    <TimelineItem
      id={entryDomId(entry)}
      icon={kindIcon(entry.kind)}
      iconTooltip={kindLabel(entry.kind)}
      name={nameParts.join(' · ')}
      titleText={entry.title}
      subtitleText={formatSwissDate(entry.date)}
      className={flashKey === entry.key ? 'tw-flash' : undefined}
    >
      <div className="tw-entry">
        <div className="tw-entry__line">
          {entry.isDocumentOne ? (
            <span className="tw-badge-one" title="The first date">
              #1
            </span>
          ) : null}
          {entry.pinned ? <Icon name="pushpin-on" aria-label="Pinned" /> : null}
          {entry.amount !== null ? (
            <MoneyText amount={entry.amount} currency={entry.currency} bold />
          ) : null}
          {entry.source === 'expense' ? <Text className="tw-label">Not written up yet</Text> : null}
        </div>

        {excerpt ? <p className="tw-entry__note">{excerpt}</p> : null}

        {entry.photos.length > 0 ? (
          <div className="tw-entry__photos">
            {entry.photos.map(photo => (
              <img
                key={photo.ID}
                className="tw-thumb"
                src={api.photoImageUrl(photo.ID)}
                alt={photo.caption ?? `Photo from ${entry.title}`}
                loading="lazy"
                decoding="async"
              />
            ))}
          </div>
        ) : null}

        <div className="tw-entry__actions">
          {entry.isDocumentOne ? (
            <Button design="Transparent" icon="favorite" onClick={() => onOpenDocumentOne(entry)}>
              Open Document #1
            </Button>
          ) : null}

          {entry.source === 'memory' ? (
            <>
              <Button
                design="Transparent"
                icon={entry.pinned ? 'pushpin-off' : 'pushpin-on'}
                disabled={busy}
                accessibleName={entry.pinned ? 'Unpin this memory' : 'Pin this memory'}
                tooltip={entry.pinned ? 'Unpin' : 'Pin'}
                onClick={() => onTogglePin(entry)}
              />
              <Button
                design="Transparent"
                icon="edit"
                accessibleName={`Edit ${entry.title}`}
                tooltip="Edit"
                onClick={() => onEdit(entry)}
              />
              <Button
                design="Transparent"
                icon="delete"
                accessibleName={`Delete ${entry.title}`}
                tooltip="Delete"
                onClick={() => onDelete(entry)}
              />
            </>
          ) : (
            <Button
              design="Transparent"
              icon="write-new"
              disabled={busy}
              onClick={() => onCompose(entry)}
            >
              Write it up
            </Button>
          )}
        </div>
      </div>
    </TimelineItem>
  )
}

export function MemoryTimeline({ pinned, groups, ...handlers }: MemoryTimelineProps) {
  return (
    <>
      {pinned.length > 0 ? (
        <section className="tw-section" aria-label="Pinned memories">
          <div className="tw-section__head">
            <Icon name="pushpin-on" aria-hidden="true" />
            <span>Pinned</span>
          </div>
          <Timeline accessibleName="Pinned memories">
            {pinned.map(entry => (
              <EntryItem key={entry.key} entry={entry} {...handlers} />
            ))}
          </Timeline>
        </section>
      ) : null}

      {groups.length > 0 ? (
        <section className="tw-section" aria-label="Memories by month">
          {pinned.length > 0 ? (
            <div className="tw-section__head">
              <Icon name="history" aria-hidden="true" />
              <span>Everything else</span>
            </div>
          ) : null}
          {/* One Timeline, one continuous spine: the month groups are items on
              it rather than four separate timelines stacked on each other. */}
          <Timeline accessibleName="Memories by month">
            {groups.map(group => (
              <TimelineGroupItem key={group.period} groupName={group.label}>
                {group.entries.map(entry => (
                  <EntryItem key={entry.key} entry={entry} {...handlers} />
                ))}
              </TimelineGroupItem>
            ))}
          </Timeline>
        </section>
      ) : null}
    </>
  )
}
