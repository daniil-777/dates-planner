/**
 * Map view — where the memories happened.
 *
 * Two well-known Leaflet-under-a-bundler problems are handled explicitly:
 *
 *  1. **The broken default marker.** `L.Icon.Default` resolves its PNGs by
 *     rewriting the URL of the Leaflet stylesheet, which no bundler preserves;
 *     the classic symptom is invisible or 404-ing pins. Every marker here is a
 *     `divIcon` with inline SVG, so there is no external asset to resolve.
 *  2. **Sizing.** The container is measured on mount, and the map only mounts
 *     when this view is on screen, so an `invalidateSize()` on the next frame
 *     is enough to survive the toggle from the timeline.
 */

import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { divIcon, latLngBounds } from 'leaflet'
import type { LatLngTuple, Map as LeafletMap } from 'leaflet'
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { Text } from '@ui5/webcomponents-react'
import type { MemoryKind } from '@/api/types'
import { formatSwissDate } from './dates'
import { kindLabel } from './timeline'
import type { TimelineEntry } from './timeline'

export interface MemoryMapProps {
  entries: readonly TimelineEntry[]
  /** How many timeline entries could not be pinned, for the footnote. */
  unlocatedCount: number
  onSelect: (entryKey: string) => void
}

interface MapPoint {
  key: string
  lat: number
  lon: number
  title: string
  date: string
  kind: MemoryKind
  place: string | null
}

interface Cluster {
  id: string
  lat: number
  lon: number
  members: MapPoint[]
}

/**
 * Pin colours follow the category palette in CONTRACTS §1.1 so a trip pin is
 * the same teal as the Travel category and a gift pin the same magenta —
 * memory kinds are not categories, so they cannot read `Category.colour`, but
 * they should not look like a second, unrelated palette either.
 */
const KIND_COLOUR: Record<MemoryKind, string> = {
  date_night: '#e76500',
  trip: '#049f9a',
  gift: '#f31ded',
  anniversary: '#7858ff',
  other: '#5b738b',
}

const CLUSTER_RADIUS_PX = 44
const DEFAULT_CENTER: LatLngTuple = [47.3769, 8.5417]

function pinIcon(kind: MemoryKind) {
  const colour = KIND_COLOUR[kind] ?? KIND_COLOUR.other
  return divIcon({
    className: 'tw-pin',
    iconSize: [26, 34],
    iconAnchor: [13, 34],
    popupAnchor: [0, -30],
    html: `<svg class="tw-pin__svg" width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 33.2S24.8 20.6 24.8 13A11.8 11.8 0 1 0 1.2 13C1.2 20.6 13 33.2 13 33.2z" fill="${colour}" stroke="#ffffff" stroke-width="1.6"/><circle cx="13" cy="12.6" r="4.4" fill="#ffffff"/></svg>`,
  })
}

function clusterIcon(count: number) {
  return divIcon({
    className: 'tw-pin',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    html: `<div class="tw-pin__cluster">${count}</div>`,
  })
}

/**
 * Grid-free greedy clustering in projected pixel space: two memories merge
 * when they are within ~44 px of each other at the current zoom, which is
 * about a fingertip. Cheap, stable, and it re-runs on every zoom.
 */
function clusterPoints(map: LeafletMap, points: readonly MapPoint[]): Cluster[] {
  const zoom = map.getZoom()
  const buckets: Array<{ x: number; y: number; sumX: number; sumY: number; members: MapPoint[] }> =
    []

  for (const point of points) {
    const projected = map.project([point.lat, point.lon], zoom)
    let target = buckets.find(
      bucket => Math.hypot(bucket.x - projected.x, bucket.y - projected.y) <= CLUSTER_RADIUS_PX,
    )
    if (!target) {
      target = { x: projected.x, y: projected.y, sumX: 0, sumY: 0, members: [] }
      buckets.push(target)
    }
    target.members.push(point)
    target.sumX += projected.x
    target.sumY += projected.y
    target.x = target.sumX / target.members.length
    target.y = target.sumY / target.members.length
  }

  return buckets.map(bucket => {
    const centre = map.unproject([bucket.x, bucket.y], zoom)
    return {
      id: bucket.members.map(member => member.key).join('|'),
      lat: centre.lat,
      lon: centre.lng,
      members: bucket.members,
    }
  })
}

function ClusterLayer({
  points,
  onSelect,
}: {
  points: readonly MapPoint[]
  onSelect: (key: string) => void
}) {
  const map = useMap()
  const [revision, setRevision] = useState(0)

  useMapEvents({
    zoomend: () => setRevision(value => value + 1),
    moveend: () => setRevision(value => value + 1),
  })

  const clusters = useMemo(() => clusterPoints(map, points), [map, points, revision])

  return (
    <>
      {clusters.map(cluster => {
        if (cluster.members.length === 1) {
          const point = cluster.members[0]
          return (
            <Marker
              key={cluster.id}
              position={[point.lat, point.lon]}
              icon={pinIcon(point.kind)}
              eventHandlers={{ click: () => onSelect(point.key) }}
            >
              <Popup>
                <strong>{point.title}</strong>
                <br />
                {kindLabel(point.kind)} · {formatSwissDate(point.date)}
                {point.place ? (
                  <>
                    <br />
                    {point.place}
                  </>
                ) : null}
              </Popup>
            </Marker>
          )
        }
        return (
          <Marker
            key={cluster.id}
            position={[cluster.lat, cluster.lon]}
            icon={clusterIcon(cluster.members.length)}
            eventHandlers={{
              click: () => map.flyTo([cluster.lat, cluster.lon], Math.min(map.getZoom() + 2, 18)),
            }}
          />
        )
      })}
    </>
  )
}

function FitToPoints({ points }: { points: readonly MapPoint[] }) {
  const map = useMap()
  const fitted = useRef(false)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => map.invalidateSize())
    return () => window.cancelAnimationFrame(frame)
  }, [map])

  useEffect(() => {
    if (fitted.current || points.length === 0) return
    fitted.current = true
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 13)
      return
    }
    map.fitBounds(latLngBounds(points.map(point => [point.lat, point.lon] as LatLngTuple)), {
      padding: [36, 36],
      maxZoom: 15,
    })
  }, [map, points])

  return null
}

export function MemoryMap({ entries, unlocatedCount, onSelect }: MemoryMapProps) {
  const points = useMemo<MapPoint[]>(
    () =>
      entries.flatMap(entry =>
        entry.lat === null || entry.lon === null
          ? []
          : [
              {
                key: entry.key,
                lat: entry.lat,
                lon: entry.lon,
                title: entry.title,
                date: entry.date,
                kind: entry.kind,
                place: entry.place,
              },
            ],
      ),
    [entries],
  )

  const centre: LatLngTuple = points.length > 0 ? [points[0].lat, points[0].lon] : DEFAULT_CENTER

  return (
    <section className="tw-section" aria-label="Memories on a map">
      <div className="tw-map">
        <MapContainer center={centre} zoom={points.length > 0 ? 11 : 6} scrollWheelZoom>
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            maxZoom={19}
          />
          <FitToPoints points={points} />
          <ClusterLayer points={points} onSelect={onSelect} />
        </MapContainer>
      </div>
      <div className="tw-map__legend">
        <Text className="tw-label">
          {points.length} {points.length === 1 ? 'memory' : 'memories'} pinned
        </Text>
        {unlocatedCount > 0 ? (
          <Text className="tw-label">
            {unlocatedCount} without coordinates — add a place in the editor to pin{' '}
            {unlocatedCount === 1 ? 'it' : 'them'}.
          </Text>
        ) : null}
        <Text className="tw-label">Tap a pin to jump to it in the timeline.</Text>
      </div>
    </section>
  )
}

export default MemoryMap
