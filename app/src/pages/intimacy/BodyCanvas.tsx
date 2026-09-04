/**
 * The rotatable figure.
 *
 * Three.js lives entirely behind this component, and this component is only ever reached
 * through a lazily-loaded route, so the library is code-split away from everybody who
 * never opens the page — it is by some margin the largest dependency in the app and the
 * one screen that needs it is not on the critical path.
 *
 * ## Turning and tapping are the same gesture
 *
 * On a phone there is one pointer, and it has to both orbit the figure and choose a
 * region. Distinguishing them by element or by button is not available, so this measures:
 * a pointer that travels less than `TAP_SLOP` between down and up was somebody pointing at
 * something, and anything further was somebody turning the model. Without that, every
 * attempt to rotate ends by selecting whatever was under the finger when it stopped.
 *
 * ## Accessibility
 *
 * A WebGL canvas cannot be operated from a keyboard, and pretending otherwise with a
 * focus ring on a `<canvas>` helps nobody. It is `aria-hidden`, and the region list beside
 * it is the real control surface — every zone is reachable there as an ordinary button.
 * `TouchMapCard` is what guarantees that list is always rendered.
 */
import { useEffect, useRef } from 'react'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { buildFigure, paint, zoneOfFace, type Figure } from './figure'
import type { BodyForm, ZoneCode } from './zones'

/** Pointer travel, in CSS pixels, below which a gesture counts as a tap and not a drag. */
const TAP_SLOP = 6

export interface BodyCanvasProps {
  form: BodyForm
  /** Zone → the colour its mark should paint it. Regions absent from this are unmarked. */
  marks: ReadonlyMap<ZoneCode, string>
  /** The region currently highlighted from the list, if any. */
  highlighted: ZoneCode | null
  /** Null makes the figure read-only — somebody else's map. */
  onPick: ((zone: ZoneCode) => void) | null
  /** Unmarked body colour, passed in so the card can theme it. */
  baseColour: string
}

export function BodyCanvas({ form, marks, highlighted, onPick, baseColour }: BodyCanvasProps) {
  const host = useRef<HTMLDivElement | null>(null)

  // Everything three.js owns is a ref: none of it is React state, re-creating it on a
  // render would drop the user's camera angle, and the cleanup path has to see the
  // current objects rather than the ones a stale closure captured.
  const figureRef = useRef<Figure | null>(null)
  const meshRef = useRef<Mesh | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const cameraRef = useRef<PerspectiveCamera | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const hoveredRef = useRef<ZoneCode | null>(null)

  // The latest props, readable from event handlers that are registered once.
  const pickRef = useRef(onPick)
  const marksRef = useRef(marks)
  const baseRef = useRef(baseColour)
  pickRef.current = onPick
  marksRef.current = marks
  baseRef.current = baseColour

  /* ---------------------------------------------------------------- scene */

  useEffect(() => {
    const mount = host.current
    if (mount === null) return

    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    // Above 2 the extra pixels cost real battery on a phone and are invisible.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    mount.appendChild(renderer.domElement)
    renderer.domElement.setAttribute('aria-hidden', 'true')
    // The canvas must own its gestures or the page scrolls while somebody turns the model.
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    rendererRef.current = renderer

    const scene = new Scene()
    sceneRef.current = scene

    const camera = new PerspectiveCamera(34, 1, 0.1, 100)
    camera.position.set(0, 1.0, 3.55)
    cameraRef.current = camera

    // Three lights: a key that shapes the form, a cool rim that separates the silhouette
    // from the background in the dark theme, and just enough ambient that a region facing
    // away is still legible when it is marked.
    scene.add(new AmbientLight(0xffffff, 0.55))
    const key = new DirectionalLight(0xffffff, 2.1)
    key.position.set(2.4, 3.4, 3.2)
    scene.add(key)
    const rim = new DirectionalLight(0xbcd4ff, 1.15)
    rim.position.set(-2.6, 1.6, -2.4)
    scene.add(rim)

    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.58,
      metalness: 0.04,
    })
    const mesh = new Mesh(undefined, material)
    meshRef.current = mesh
    scene.add(mesh)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.92, 0)
    controls.enablePan = false
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.rotateSpeed = 0.85
    controls.minDistance = 2.2
    controls.maxDistance = 5.0
    // Stop the camera going under the floor or over the top, where the figure reads as a
    // shape rather than a body and there is nothing useful to point at.
    controls.minPolarAngle = Math.PI * 0.16
    controls.maxPolarAngle = Math.PI * 0.86
    controls.update()

    /*
     * `pan-y`, and it must be set AFTER OrbitControls — its `connect()` assigns
     * `touchAction = 'none'` to the element itself, so anything set before this line is
     * silently overwritten.
     *
     * With `none` the canvas claims every gesture, and it is 420px tall and full width — half
     * the phone. The commonest first gesture on any page, a thumb drag downwards to see what
     * is below, therefore spun the figure instead of scrolling, and the page felt frozen at
     * exactly the moment somebody was looking for the response to their first tap.
     *
     * `pan-y` hands vertical drags back to the browser and keeps horizontal ones here, which
     * is the right split: turning the figure is a left-right gesture, and the polar angle is
     * clamped to a narrow band anyway. Vertical orbiting is lost on touch and was worth
     * very little.
     */
    renderer.domElement.style.touchAction = 'pan-y'
    controlsRef.current = controls

    /* --------------------------------------------------------- pointers */

    const raycaster = new Raycaster()
    const pointer = new Vector2()
    let downAt: { x: number; y: number } | null = null

    const toLocal = (event: PointerEvent): void => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    }

    const hit = (): ZoneCode | null => {
      const figure = figureRef.current
      const target = meshRef.current
      if (figure === null || target === null || cameraRef.current === null) return null
      raycaster.setFromCamera(pointer, cameraRef.current)
      const [first] = raycaster.intersectObject(target, false)
      if (first?.face === undefined || first.face === null) return null
      return zoneOfFace(figure, first.face.a)
    }

    const repaint = (): void => {
      const figure = figureRef.current
      if (figure !== null) paint(figure, marksRef.current, hoveredRef.current, baseRef.current)
    }

    const onDown = (event: PointerEvent): void => {
      downAt = { x: event.clientX, y: event.clientY }
    }

    const onMove = (event: PointerEvent): void => {
      // Hover is a mouse affordance; on touch the finger is over the thing it is about to
      // select and a highlight under it tells nobody anything.
      if (event.pointerType !== 'mouse' || pickRef.current === null) return
      toLocal(event)
      const zone = hit()
      if (zone === hoveredRef.current) return
      hoveredRef.current = zone
      renderer.domElement.style.cursor = zone === null ? 'grab' : 'pointer'
      repaint()
    }

    const onUp = (event: PointerEvent): void => {
      const start = downAt
      downAt = null
      const pick = pickRef.current
      if (start === null || pick === null) return
      const travelled = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (travelled > TAP_SLOP) return // a turn, not a choice
      toLocal(event)
      const zone = hit()
      if (zone !== null) pick(zone)
    }

    const onLeave = (): void => {
      if (hoveredRef.current === null) return
      hoveredRef.current = null
      repaint()
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointerleave', onLeave)

    /* ------------------------------------------------------------ frame */

    const resize = (): void => {
      const width = mount.clientWidth
      const height = mount.clientHeight
      if (width === 0 || height === 0) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      figureRef.current?.geometry.dispose()
      material.dispose()
      renderer.dispose()
      // A WebGL context is not garbage collected promptly, and browsers cap how many a
      // page may hold; navigating in and out of this route a dozen times without this
      // silently stops rendering.
      renderer.forceContextLoss()
      mount.removeChild(renderer.domElement)
      rendererRef.current = null
    }
  }, [])

  /* ------------------------------------------------- geometry, per form */

  useEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    // Deliberately *not* disposing the outgoing geometry. `buildFigure` memoises one mesh
    // per form and hands out the same object every time, so disposing on a form change
    // would free a buffer that is about to be handed back — the figure would render once,
    // then come back empty the second time somebody chose that form. The three geometries
    // are a few megabytes and live as long as the page does; the teardown effect that owns
    // the renderer is where anything gets freed.
    const figure = buildFigure(form)
    figureRef.current = figure
    mesh.geometry = figure.geometry
    paint(figure, marksRef.current, hoveredRef.current, baseRef.current)
  }, [form])

  /* -------------------------------------------------- marks and highlight */

  useEffect(() => {
    const figure = figureRef.current
    if (figure === null) return
    // A region highlighted from the list outranks the pointer's own hover: it is the
    // deliberate one, and the two can only disagree on a mouse.
    paint(figure, marks, highlighted ?? hoveredRef.current, baseColour)
  }, [marks, highlighted, baseColour])

  return <div className="figure__canvas" ref={host} />
}
