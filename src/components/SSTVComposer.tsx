// SSTV QSO Card composer — drop/upload/URL an image, add text overlays (font
// + color pickers), pick an encode mode, then encode + transmit over Web
// Audio. Composed cards persist in IndexedDB (qsoCardStore.ts); composer
// settings (mode, text layers) persist in localStorage (composerSettings.ts).
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, type JSX } from 'solid-js'
import TextField from './TextField'
import TextAreaField from './TextAreaField'
import NumberField from './NumberField'
import { SSTV_MODES } from '$decoder-lib/sstv/constants'
import { resizeImageData, estimateEncodedSeconds } from '$decoder-lib/sstv/encoder'
import { createSSTVTransmit } from '$decoder-lib/sstv/useSSTVTransmit'
import {
  loadTxMode,
  saveTxMode,
  loadTextLayers,
  saveTextLayers,
  loadReplyBoxes,
  saveReplyBoxes,
  loadMyCall,
  saveMyCall,
  ENCODABLE_MODES,
  COMMON_FONTS,
  DEFAULT_TEXT_LAYER,
  DEFAULT_REPLY_BOX,
  REPLY_BOX_PRESETS,
  type EncodableSSTVMode,
  type TextLayer,
  type ReplyBox,
} from '$decoder-lib/sstv/composerSettings'
import { saveCard, loadAllCards, deleteCard, clearAllCards, renameCard, type QSOCard } from '$decoder-lib/sstv/qsoCardStore'
import { formatSignalReport } from '$decoder-lib/sstv/signalReport'
import type { CapturedImage } from '$decoder-lib/sstv/audioProcessor'

const CANVAS_REF_WIDTH = 320 // reference width text layer coordinates/fontSize are relative to

/** Splits text into lines that fit within maxWidth, wrapping on word
 *  boundaries — never shrinks the font to force a fit, since a smaller font
 *  is exactly what makes a received QSO card hard to read. Respects
 *  explicit newlines in the source text as hard paragraph breaks. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ')
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    lines.push(current)
  }
  return lines
}

function newTextLayer(): TextLayer {
  return { ...DEFAULT_TEXT_LAYER, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function newReplyBox(label: string): ReplyBox {
  return { ...DEFAULT_REPLY_BOX, label, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

interface SSTVComposerProps {
  /** A captured image the operator wants to reply to — set once by the
   *  decoder's gallery "Reply" button. Consumed on arrival (image loaded,
   *  timestamp/callsign/RST text layer added), then cleared via onReplyConsumed
   *  so re-opening the same reply doesn't re-trigger. */
  replyRequest?: CapturedImage | null
  onReplyConsumed?: () => void
  /** CAT PTT control, when a radio is connected — undefined disables Auto-PTT
   *  (matches how FTTransmitPanel receives onSetPTT from App.tsx). */
  onSetPTT?: (tx: boolean) => Promise<void>
  /** Live TX status, forwarded so App.tsx can show a summary chip in the
   *  collapsed panel's summary line (mirrors FTTransmitPanel's onStatusChange). */
  onStatusChange?: (status: SSTVTxStatus) => void
}

export interface SSTVTxStatus {
  phase: 'idle' | 'encoding' | 'playing'
  progress: number // 0-1
  remainingSec: number
}

export default function SSTVComposer(props: SSTVComposerProps): JSX.Element {
  const [mode, setMode] = createSignal<EncodableSSTVMode>(loadTxMode())
  const [sourceImg, setSourceImg] = createSignal<HTMLImageElement | null>(null)
  // Inset thumbnail of a received image when replying — common SSTV QSO
  // convention: your own picture fills the frame, with a small copy of the
  // picture you received inset in a corner to confirm which image you got.
  const [insetImg, setInsetImg] = createSignal<HTMLImageElement | null>(null)
  const [imageUrl, setImageUrl] = createSignal('')
  const [imageError, setImageError] = createSignal<string | null>(null)
  const [layers, setLayers] = createSignal<TextLayer[]>(loadTextLayers())
  const [replyBoxes, setReplyBoxes] = createSignal<ReplyBox[]>(loadReplyBoxes())
  const [selectedLayerId, setSelectedLayerId] = createSignal<string | null>(null)
  const [selectedBoxId, setSelectedBoxId] = createSignal<string | null>(null)
  const [isDragOver, setIsDragOver] = createSignal(false)
  const [cards, setCards] = createSignal<QSOCard[]>([])
  const [previewCard, setPreviewCard] = createSignal<QSOCard | null>(null)
  const [pasteError, setPasteError] = createSignal<string | null>(null)
  const [myCall, setMyCall] = createSignal(loadMyCall())
  const [justReplied, setJustReplied] = createSignal(false)
  // Set when a saved card is loaded for editing — Save then overwrites that
  // card (by id) instead of creating a new one, so "load, tweak, save" edits
  // in place rather than accumulating duplicates.
  const [editingCardId, setEditingCardId] = createSignal<string | null>(null)

  const tx = createSSTVTransmit(() => props.onSetPTT)

  createEffect(() => saveTxMode(mode()))
  createEffect(() => saveTextLayers(layers()))
  createEffect(() => saveReplyBoxes(replyBoxes()))
  createEffect(() => saveMyCall(myCall()))

  onMount(() => {
    loadAllCards().then(setCards).catch(() => setCards([]))
    onCleanup(() => tx.destroy())
  })

  // ── Reply to a captured image ────────────────────────────────────────
  // Convention: reply with YOUR OWN picture as the main image, with a small
  // inset thumbnail of the received picture in a corner (confirms to the
  // other station which of their images you're acknowledging) — so this only
  // sets the inset + a timestamp/callsign/RST text layer, and leaves the
  // main image slot for the operator to drop in their own photo.
  createEffect(() => {
    const img = props.replyRequest
    if (!img) return

    setMode(img.mode)
    const clamped = new Uint8ClampedArray(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength)
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d')!.putImageData(new ImageData(clamped, img.width, img.height), 0, 0)
    const el = new Image()
    el.onload = () => setInsetImg(el)
    el.src = canvas.toDataURL('image/png')

    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const time = now.toISOString().slice(11, 16) + 'Z'
    const call = myCall().trim()
    const reportText = `${formatSignalReport(img.signalReport)} RSV`
    // Pre-split into short lines rather than one long dash-joined string —
    // wrapText() would eventually break an overlong line too, but starting
    // from natural line breaks reads better than a wrap landing mid-phrase.
    const text = call ? `${date} ${time}\nde ${call}\n${reportText}` : `${date} ${time}\n${reportText}`
    setLayers((prev) => [...prev, { ...DEFAULT_TEXT_LAYER, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text, fontSize: 18, y: 0.88 }])

    // Scroll the actual canvas (not just the panel) into view and pulse a
    // highlight ring around it — the inset thumbnail is a small corner
    // detail, easy to miss amid the mode/composer chrome above it.
    canvasWrapperEl?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setJustReplied(true)
    setTimeout(() => setJustReplied(false), 2500)

    props.onReplyConsumed?.()
  })

  const modeCfg = createMemo(() => SSTV_MODES[mode()])
  const estimatedDuration = createMemo(() => estimateEncodedSeconds(mode()))

  let canvasEl: HTMLCanvasElement | undefined
  let canvasWrapperEl: HTMLDivElement | undefined
  let fileInputEl: HTMLInputElement | undefined
  let dropZoneEl: HTMLDivElement | undefined

  // ── Image loading ──────────────────────────────────────────────────────

  // Normalizes ANY image source (file data URL, clipboard blob: URL, remote
  // URL) into a stable data: URL before storing it in sourceImg — blob: URLs
  // are only valid for the lifetime of the page that created them (revoked on
  // reload, and unreliable even within the same session once GC'd), and a
  // saved card needs its image to survive being written to IndexedDB and
  // reloaded later. Re-drawing onto a canvas here also surfaces a CORS-taint
  // error immediately (a clear "load" failure) rather than a silent black
  // canvas much later when the card is edited or transmitted.
  function loadImageFromSrc(src: string) {
    setImageError(null)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      let dataUrl: string
      try {
        dataUrl = canvas.toDataURL('image/png')
      } catch {
        setImageError('This image cannot be used — the source blocks canvas access (CORS). Try downloading it and using Choose file instead.')
        return
      }
      const normalized = new Image()
      normalized.onload = () => setSourceImg(normalized)
      normalized.src = dataUrl
    }
    img.onerror = () => setImageError('Could not load image — check the file or URL (remote URLs need CORS enabled)')
    img.src = src
  }

  function loadImageFromFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => loadImageFromSrc(reader.result as string)
    reader.onerror = () => setImageError('Could not read file')
    reader.readAsDataURL(file)
  }

  function handleFileInput(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (file) loadImageFromFile(file)
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file && file.type.startsWith('image/')) loadImageFromFile(file)
  }

  function handleUrlLoad() {
    const url = imageUrl().trim()
    if (url) loadImageFromSrc(url)
  }

  async function handlePasteImage() {
    setPasteError(null)
    if (!navigator.clipboard?.read) {
      setPasteError('Clipboard access not available in this browser — try drag-and-drop or Choose file instead')
      return
    }
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          loadImageFromSrc(URL.createObjectURL(blob))
          return
        }
      }
      setPasteError('No image found on the clipboard')
    } catch {
      setPasteError('Could not read the clipboard — check browser permissions and try again')
    }
  }

  // ── Canvas compositing (source image, cropped/scaled to mode aspect, + text layers) ──

  function drawComposite() {
    const canvas = canvasEl
    const img = sourceImg()
    if (!canvas) return
    const cfg = modeCfg()
    canvas.width = cfg.width
    canvas.height = cfg.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cfg.width, cfg.height)

    if (img) {
      // Cover-fit: scale to fill the mode's aspect ratio, center-cropping overflow.
      const srcAspect = img.naturalWidth / img.naturalHeight
      const dstAspect = cfg.width / cfg.height
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight
      if (srcAspect > dstAspect) {
        sw = img.naturalHeight * dstAspect
        sx = (img.naturalWidth - sw) / 2
      } else {
        sh = img.naturalWidth / dstAspect
        sy = (img.naturalHeight - sh) / 2
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cfg.width, cfg.height)
    }

    // Inset thumbnail of a received image being replied to — bottom-right
    // corner, ~28% of frame width, thin border so it reads clearly against
    // either a busy background or plain black.
    const inset = insetImg()
    if (inset) {
      const insetW = cfg.width * 0.28
      const insetH = insetW * (inset.naturalHeight / inset.naturalWidth)
      const margin = cfg.width * 0.02
      const ix = cfg.width - insetW - margin
      const iy = cfg.height - insetH - margin
      ctx.drawImage(inset, ix, iy, insetW, insetH)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(1, cfg.width * 0.004)
      ctx.strokeRect(ix, iy, insetW, insetH)
    }

    const scale = cfg.width / CANVAS_REF_WIDTH
    for (const layer of layers()) {
      if (!layer.text) continue
      const fontPx = layer.fontSize * scale
      ctx.font = `bold ${fontPx}px ${layer.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const x = layer.x * cfg.width
      const y = layer.y * cfg.height

      // Wrap instead of shrinking — a smaller font is exactly what makes a
      // received card hard to read, so long/multi-line text (e.g. a reply's
      // timestamp + callsign + report) grows the block vertically instead.
      const maxWidth = cfg.width * 0.92
      const lines = wrapText(ctx, layer.text, maxWidth)
      const lineHeight = fontPx * 1.2
      const blockHeight = lineHeight * lines.length
      const firstLineY = y - blockHeight / 2 + lineHeight / 2

      ctx.lineWidth = Math.max(1, fontPx * 0.12)
      for (let i = 0; i < lines.length; i++) {
        const lineY = firstLineY + i * lineHeight
        ctx.strokeStyle = layer.strokeColor
        ctx.strokeText(lines[i], x, lineY)
        ctx.fillStyle = layer.color
        ctx.fillText(lines[i], x, lineY)
      }
    }

    // Reply boxes: an empty outlined rectangle + small label above it — a
    // blank square for the recipient to fill in by hand, not drawn text.
    for (const box of replyBoxes()) {
      const bx = box.x * cfg.width
      const by = box.y * cfg.height
      const bw = box.width * cfg.width
      const bh = box.height * cfg.height
      ctx.strokeStyle = box.color
      ctx.lineWidth = Math.max(1, 2 * scale)
      ctx.setLineDash([6 * scale, 4 * scale])
      ctx.strokeRect(bx, by, bw, bh)
      ctx.setLineDash([])

      const labelPx = Math.max(8, 12 * scale)
      ctx.font = `bold ${labelPx}px Arial`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = box.color
      ctx.fillText(box.label, bx, by - 2 * scale)
    }
  }

  createEffect(() => {
    void sourceImg()
    void insetImg()
    void mode()
    void layers()
    void replyBoxes()
    drawComposite()
  })

  // ── Text layers ────────────────────────────────────────────────────────

  function addLayer() {
    const layer = newTextLayer()
    setLayers((prev) => [...prev, layer])
    setSelectedLayerId(layer.id)
  }
  function updateLayer(id: string, patch: Partial<TextLayer>) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }
  function removeLayer(id: string) {
    setLayers((prev) => prev.filter((l) => l.id !== id))
    if (selectedLayerId() === id) setSelectedLayerId(null)
  }

  // Quick-insert helper — appends a token to a layer's text rather than
  // replacing it, so it composes with whatever the operator already typed.
  function insertTimestamp(id: string) {
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const time = now.toISOString().slice(11, 16) + 'Z'
    const token = `${date} ${time}`
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, text: l.text ? `${l.text} ${token}` : token } : l)))
  }

  // ── Reply boxes ────────────────────────────────────────────────────────
  // Unlike text layers, these are blank rectangles baked into the
  // transmitted image for a human recipient to fill in by hand — nothing is
  // typed here at compose time, only positioned/labeled/sized.

  function addReplyBox(label: string) {
    const box = newReplyBox(label)
    setReplyBoxes((prev) => [...prev, box])
    setSelectedBoxId(box.id)
  }
  function updateReplyBox(id: string, patch: Partial<ReplyBox>) {
    setReplyBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }
  function removeReplyBox(id: string) {
    setReplyBoxes((prev) => prev.filter((b) => b.id !== id))
    if (selectedBoxId() === id) setSelectedBoxId(null)
  }

  // Drag a text layer or reply box directly on the canvas preview
  let dragLayerId: string | null = null
  let dragBoxId: string | null = null
  let dragBoxGrabOffset = { dx: 0, dy: 0 } // pointer position relative to the box's top-left at grab time

  function handleCanvasPointerDown(e: PointerEvent) {
    const canvas = canvasEl
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height

    // Reply boxes take priority when the pointer is inside one (they're
    // areas, not points, so "inside" is a clearer hit test than nearest).
    for (const b of replyBoxes()) {
      if (fx >= b.x && fx <= b.x + b.width && fy >= b.y && fy <= b.y + b.height) {
        dragBoxId = b.id
        dragBoxGrabOffset = { dx: fx - b.x, dy: fy - b.y }
        setSelectedBoxId(b.id)
        setSelectedLayerId(null)
        canvas.setPointerCapture(e.pointerId)
        return
      }
    }

    if (layers().length === 0) return
    // Pick nearest text layer within a reasonable radius
    let nearest: TextLayer | null = null
    let nearestDist = Infinity
    for (const l of layers()) {
      const d = Math.hypot(l.x - fx, l.y - fy)
      if (d < nearestDist) {
        nearestDist = d
        nearest = l
      }
    }
    if (nearest && nearestDist < 0.25) {
      dragLayerId = nearest.id
      setSelectedLayerId(nearest.id)
      setSelectedBoxId(null)
      canvas.setPointerCapture(e.pointerId)
    }
  }
  function handleCanvasPointerMove(e: PointerEvent) {
    if (!canvasEl) return
    const rect = canvasEl.getBoundingClientRect()
    const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    if (dragBoxId) {
      const box = replyBoxes().find((b) => b.id === dragBoxId)
      const w = box?.width ?? 0
      const h = box?.height ?? 0
      const x = Math.max(0, Math.min(1 - w, fx - dragBoxGrabOffset.dx))
      const y = Math.max(0, Math.min(1 - h, fy - dragBoxGrabOffset.dy))
      updateReplyBox(dragBoxId, { x, y })
    } else if (dragLayerId) {
      updateLayer(dragLayerId, { x: fx, y: fy })
    }
  }
  function handleCanvasPointerUp() {
    dragLayerId = null
    dragBoxId = null
  }

  // ── Encode + transmit ──────────────────────────────────────────────────

  function getComposedImageData(): Uint8ClampedArray | null {
    const canvas = canvasEl
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const cfg = modeCfg()
    const data = ctx.getImageData(0, 0, cfg.width, cfg.height).data
    return resizeImageData(data, cfg.width, cfg.height, cfg.width, cfg.height)
  }

  async function handleTransmit() {
    // Redraw synchronously first: callers that just changed sourceImg/insetImg
    // (e.g. Send on a saved card) would otherwise read a stale canvas, since
    // Solid's reactive redraw effect runs on the next microtask, not
    // synchronously with the signal writes.
    drawComposite()
    const img = getComposedImageData()
    if (!img) return
    await tx.encodeAndTransmit(img, mode())
  }

  async function handleSaveCard() {
    const canvas = canvasEl
    if (!canvas) return
    const cfg = modeCfg()
    const src = sourceImg()
    const inset = insetImg()
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    const existing = editingCardId() ? cards().find((c) => c.id === editingCardId()) : null
    const card: QSOCard = {
      id: existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      blob,
      width: cfg.width,
      height: cfg.height,
      mode: mode(),
      createdAt: existing?.createdAt ?? Date.now(),
      name: existing?.name ?? `${SSTV_MODES[mode()].name} — ${new Date().toLocaleString()}`,
      sourceImageDataUrl: src?.src ?? null,
      insetImageDataUrl: inset?.src ?? null,
      layers: layers(),
      replyBoxes: replyBoxes(),
    }
    await saveCard(card)
    setEditingCardId(card.id)
    setCards(await loadAllCards())
  }

  function loadImageEl(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Could not load saved image'))
      el.src = src
    })
  }

  /** Loads a saved card's full editable state back into the composer —
   *  the operator can then tweak it (edit text, swap the image, adjust
   *  boxes) and either re-save (overwrites, since editingCardId is set) or
   *  transmit it as-is. Awaits both images so callers that immediately
   *  encode+transmit (Send) don't race the canvas's own redraw effect. */
  async function handleLoadCard(card: QSOCard, options?: { scrollIntoView?: boolean }): Promise<void> {
    setMode(card.mode as EncodableSSTVMode)
    setLayers(card.layers)
    setReplyBoxes(card.replyBoxes)
    setEditingCardId(card.id)
    let sourceLoadFailed = false
    const [src, inset] = await Promise.all([
      card.sourceImageDataUrl
        ? loadImageEl(card.sourceImageDataUrl).catch(() => {
            sourceLoadFailed = true
            return null
          })
        : Promise.resolve(null),
      card.insetImageDataUrl ? loadImageEl(card.insetImageDataUrl).catch(() => null) : Promise.resolve(null),
    ])
    setSourceImg(src)
    setInsetImg(inset)
    setImageError(sourceLoadFailed ? 'This card\'s saved image could not be restored — it may predate the fix for pasted/URL images not surviving a reload. Drop a new image in above.' : null)
    setPreviewCard(null)
    if (options?.scrollIntoView !== false) {
      canvasWrapperEl?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  async function handleDeleteCard(id: string) {
    await deleteCard(id)
    if (editingCardId() === id) setEditingCardId(null)
    setCards(await loadAllCards())
  }

  async function handleClearCards() {
    await clearAllCards()
    setEditingCardId(null)
    setCards([])
  }

  async function handleRenameCard(id: string, name: string) {
    await renameCard(id, name)
    setCards(await loadAllCards())
  }

  function cardUrl(card: QSOCard): string {
    return URL.createObjectURL(card.blob)
  }

  const hasContent = createMemo(() => sourceImg() !== null || layers().length > 0 || replyBoxes().length > 0)
  const txPhase = createMemo(() => tx.state().phase)
  const txProgress = createMemo(() => tx.state().progress)
  const txRemainingSec = createMemo(() => Math.max(0, Math.ceil(tx.state().durationSec * (1 - tx.state().progress))))
  const gainToDb = (g: number) => (g <= 0 ? -60 : 20 * Math.log10(g))
  const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))
  const txDb = createMemo(() => Math.round(gainToDb(tx.state().txGain)))

  createEffect(() => {
    props.onStatusChange?.({ phase: txPhase(), progress: txProgress(), remainingSec: txRemainingSec() })
  })

  return (
    <div class="space-y-4 rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold sm:text-xl">SSTV QSO Card — Compose &amp; Transmit</h2>
        <span class="font-mono text-xs text-[#8b949e]">
          {modeCfg().width}×{modeCfg().height} px · ~{estimatedDuration().toFixed(0)}s
        </span>
      </div>

      <div class="flex flex-col gap-4 lg:flex-row">
        {/* Left: image source + canvas preview */}
        <div class="flex min-w-0 flex-1 flex-col gap-3">
          <div
            ref={dropZoneEl}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            class={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
              isDragOver() ? 'border-[#2ea043] bg-[#238636]/10' : 'border-[#30363d]'
            }`}
          >
            <p class="text-sm text-[#8b949e]">Drop an image here, or</p>
            <div class="flex flex-wrap items-center justify-center gap-2">
              <input ref={fileInputEl} type="file" accept="image/*" class="hidden" onChange={handleFileInput} />
              <button
                onClick={() => fileInputEl?.click()}
                class="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1.5 text-xs font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]"
              >
                Choose file
              </button>
              <button
                onClick={handlePasteImage}
                class="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1.5 text-xs font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]"
                title="Paste an image from the clipboard"
              >
                Paste image
              </button>
            </div>
            <div class="flex flex-wrap items-center justify-center gap-2">
              <TextField
                value={imageUrl()}
                onCommit={setImageUrl}
                onKeyDown={(e) => e.key === 'Enter' && handleUrlLoad()}
                placeholder="Image URL…"
                class="w-56 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 font-mono text-xs text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              />
              <button
                onClick={handleUrlLoad}
                disabled={!imageUrl().trim()}
                class="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1.5 text-xs font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Load URL
              </button>
            </div>
            <Show when={imageError()}>
              <p class="text-xs text-[#f85149]">{imageError()}</p>
            </Show>
            <Show when={pasteError()}>
              <p class="text-xs text-[#f85149]">{pasteError()}</p>
            </Show>
            <Show when={insetImg()}>
              <div class="flex items-center gap-2 rounded border border-[#30363d] bg-[#161b22] px-2 py-1 text-[10px] text-[#8b949e]">
                <span>Replying with received image inset — drop your own photo above as the main image.</span>
                <button onClick={() => setInsetImg(null)} class="shrink-0 text-[#8b949e] transition-colors hover:text-[#f85149]" title="Remove inset">
                  ✕
                </button>
              </div>
            </Show>
          </div>

          <div
            ref={canvasWrapperEl}
            class={`flex items-center justify-center overflow-hidden rounded border p-2 transition-shadow duration-500 ${
              justReplied() ? 'border-[#58a6ff] shadow-[0_0_0_3px_rgba(88,166,255,0.4)]' : 'border-[#30363d]'
            } bg-[#0d1117]`}
          >
            <div class="relative inline-block">
              <canvas
                ref={canvasEl}
                width={modeCfg().width}
                height={modeCfg().height}
                style={{ 'max-width': '100%', height: 'auto', 'image-rendering': 'pixelated', cursor: layers().length > 0 || replyBoxes().length > 0 ? 'move' : 'default' }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
              />
              {/* Transmit scanline — purely visual, tracks txProgress() top to
                  bottom over the image while playing. SSTV modes scan
                  top-to-bottom over the transmission's duration, so overall
                  progress fraction is a reasonable stand-in for "how far down
                  the image the transmitter currently is" without needing to
                  model each mode's actual line timing. */}
              <Show when={txPhase() === 'playing'}>
                <div
                  class="pointer-events-none absolute inset-x-0 h-0.5 bg-[#2ea043] shadow-[0_0_6px_2px_rgba(46,160,67,0.8)]"
                  style={{ top: `${Math.min(100, txProgress() * 100)}%` }}
                />
              </Show>
            </div>
          </div>
          <Show when={justReplied()}>
            <p class="text-center text-[10px] text-[#58a6ff]">↑ Received image inset in the bottom-right corner — drop your own photo above to reply.</p>
          </Show>
          <p class="text-center text-[10px] text-[#8b949e]">Drag a text layer or reply box directly on the preview to reposition it.</p>
        </div>

        {/* Right: controls */}
        <div class="flex w-full flex-col gap-3 lg:w-80 lg:shrink-0">
          <div class="space-y-1.5">
            <div class="text-xs text-[#8b949e]">My Callsign</div>
            <TextField
              value={myCall()}
              onCommit={(v) => setMyCall(v.toUpperCase())}
              placeholder="e.g. N0CALL"
              class="w-full rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 font-mono text-xs uppercase text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
            />
          </div>

          <div class="space-y-1.5">
            <div class="text-xs text-[#8b949e]">Encode Mode</div>
            <select
              value={mode()}
              onChange={(e) => setMode(e.currentTarget.value as EncodableSSTVMode)}
              class="w-full rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 font-mono text-xs text-[#c9d1d9] transition-colors focus:border-[#2ea043] focus:outline-none"
            >
              <For each={ENCODABLE_MODES}>
                {(m) => (
                  <option value={m}>
                    {SSTV_MODES[m].name} — {SSTV_MODES[m].width}×{SSTV_MODES[m].height}, ~{estimateEncodedSeconds(m).toFixed(0)}s
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Text layers */}
          <div class="space-y-2 rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold text-[#c9d1d9]">Text overlays</div>
              <button onClick={addLayer} class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#2ea043] hover:text-[#2ea043]">
                + Add text
              </button>
            </div>

            {/* Index (not For): keyed by array POSITION, not by object
                identity. updateLayer() replaces the edited layer's object on
                every keystroke — with For, that reference change makes Solid
                tear down and remount this item's DOM (including TextField),
                which drops focus/selection on every character typed even
                though TextField itself is already an uncontrolled input.
                Index keeps the same DOM node per slot and just re-reads the
                accessor, so typing no longer remounts anything. */}
            <Index each={layers()}>
              {(layer) => (
                <div
                  class={`space-y-1.5 rounded border p-2 transition-colors ${
                    selectedLayerId() === layer().id ? 'border-[#2ea043]' : 'border-[#30363d]'
                  }`}
                  onClick={() => setSelectedLayerId(layer().id)}
                >
                  <div class="flex items-start gap-1.5">
                    <TextAreaField
                      value={layer().text}
                      onCommit={(v) => updateLayer(layer().id, { text: v })}
                      placeholder={'e.g. 73 de N0CALL\n(press Enter for a new line)'}
                      rows={2}
                      class="min-w-0 flex-1 resize-y rounded border border-[#30363d] bg-[#161b22] px-2 py-1 font-mono text-xs text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                    />
                    <button onClick={() => removeLayer(layer().id)} class="shrink-0 rounded px-1.5 py-1 text-xs text-[#8b949e] transition-colors hover:text-[#f85149]" title="Remove">
                      ✕
                    </button>
                  </div>
                  <Show when={selectedLayerId() === layer().id}>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => insertTimestamp(layer().id)}
                        class="rounded border border-[#30363d] px-1.5 py-0.5 text-[10px] text-[#8b949e] transition-colors hover:border-[#58a6ff] hover:text-[#58a6ff]"
                        title="Insert the current UTC date/time"
                      >
                        + Timestamp
                      </button>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <select
                        value={layer().fontFamily}
                        onChange={(e) => updateLayer(layer().id, { fontFamily: e.currentTarget.value })}
                        class="rounded border border-[#30363d] bg-[#161b22] px-1.5 py-1 text-[10px] text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                      >
                        <For each={COMMON_FONTS}>{(f) => <option value={f}>{f}</option>}</For>
                      </select>
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]" title="Text color">
                        <input type="color" value={layer().color} onInput={(e) => updateLayer(layer().id, { color: e.currentTarget.value })} class="h-5 w-6 cursor-pointer rounded border border-[#30363d] bg-transparent" />
                        fill
                      </label>
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]" title="Outline color">
                        <input
                          type="color"
                          value={layer().strokeColor}
                          onInput={(e) => updateLayer(layer().id, { strokeColor: e.currentTarget.value })}
                          class="h-5 w-6 cursor-pointer rounded border border-[#30363d] bg-transparent"
                        />
                        outline
                      </label>
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]">
                        size
                        <input
                          type="range"
                          min="10"
                          max="60"
                          value={layer().fontSize}
                          onInput={(e) => updateLayer(layer().id, { fontSize: Number(e.currentTarget.value) })}
                          class="w-16"
                        />
                      </label>
                    </div>
                  </Show>
                </div>
              )}
            </Index>
            <Show when={layers().length === 0}>
              <p class="text-[10px] text-[#8b949e] italic">No text overlays yet — click "+ Add text" to add a callsign, grid, or greeting.</p>
            </Show>
          </div>

          {/* Reply boxes — blank outlined rectangles for a recipient to fill
              in by hand (callsign/RST/etc.), not drawn text. */}
          <div class="space-y-2 rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold text-[#c9d1d9]">Reply boxes</div>
              <div class="flex flex-wrap items-center gap-1">
                <For each={REPLY_BOX_PRESETS}>
                  {(preset) => (
                    <button
                      onClick={() => addReplyBox(preset)}
                      class="rounded border border-[#30363d] px-1.5 py-0.5 text-[10px] text-[#8b949e] transition-colors hover:border-[#2ea043] hover:text-[#2ea043]"
                    >
                      + {preset}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <Index each={replyBoxes()}>
              {(box) => (
                <div
                  class={`space-y-1.5 rounded border p-2 transition-colors ${
                    selectedBoxId() === box().id ? 'border-[#2ea043]' : 'border-[#30363d]'
                  }`}
                  onClick={() => {
                    setSelectedBoxId(box().id)
                    setSelectedLayerId(null)
                  }}
                >
                  <div class="flex items-center gap-1.5">
                    <TextField
                      value={box().label}
                      onCommit={(v) => updateReplyBox(box().id, { label: v })}
                      placeholder="Label, e.g. Callsign"
                      class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#161b22] px-2 py-1 font-mono text-xs text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                    />
                    <button onClick={() => removeReplyBox(box().id)} class="shrink-0 rounded px-1.5 py-1 text-xs text-[#8b949e] transition-colors hover:text-[#f85149]" title="Remove">
                      ✕
                    </button>
                  </div>
                  <Show when={selectedBoxId() === box().id}>
                    <div class="flex flex-wrap items-center gap-2">
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]" title="Box outline color">
                        <input type="color" value={box().color} onInput={(e) => updateReplyBox(box().id, { color: e.currentTarget.value })} class="h-5 w-6 cursor-pointer rounded border border-[#30363d] bg-transparent" />
                        color
                      </label>
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]">
                        width
                        <input
                          type="range"
                          min="0.1"
                          max="0.9"
                          step="0.01"
                          value={box().width}
                          onInput={(e) => updateReplyBox(box().id, { width: Number(e.currentTarget.value) })}
                          class="w-16"
                        />
                      </label>
                      <label class="flex items-center gap-1 text-[10px] text-[#8b949e]">
                        height
                        <input
                          type="range"
                          min="0.05"
                          max="0.5"
                          step="0.01"
                          value={box().height}
                          onInput={(e) => updateReplyBox(box().id, { height: Number(e.currentTarget.value) })}
                          class="w-16"
                        />
                      </label>
                    </div>
                  </Show>
                </div>
              )}
            </Index>
            <Show when={replyBoxes().length === 0}>
              <p class="text-[10px] text-[#8b949e] italic">No reply boxes yet — add one so a recipient can write in their callsign or report by hand.</p>
            </Show>
          </div>

          {/* Transmit controls */}
          <div class="space-y-2 rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <label class="flex items-center justify-between text-xs text-[#8b949e]">
              TX Gain
              <span class="ml-1.5 font-mono text-[#c9d1d9]">{txDb() === 0 ? '0 dB' : `${txDb()} dB`}</span>
            </label>
            <input
              type="range"
              min="-60"
              max="0"
              step="1"
              value={txDb()}
              onInput={(e) => tx.setTxGain(dbToGain(Number(e.currentTarget.value)))}
              class="w-full accent-[#2ea043]"
            />

            <label class="flex items-center justify-between text-xs text-[#8b949e]" title={props.onSetPTT ? 'Automatically key radio PTT via CAT while transmitting' : 'Auto-PTT requires CAT connection'}>
              Auto-PTT
              <button
                role="switch"
                aria-checked={tx.state().autoPTT}
                disabled={!props.onSetPTT}
                onClick={() => tx.setAutoPTT(!tx.state().autoPTT)}
                class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                  tx.state().autoPTT ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
                }`}
              >
                <span
                  class={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    tx.state().autoPTT ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </label>

            <label
              class={`flex items-center justify-between text-xs text-[#8b949e] ${!tx.state().autoPTT ? 'opacity-40' : ''}`}
              title="Key PTT this many ms before the VIS leader tone starts, to let the rig's PTT relay/ALC (or an external PA) settle — a receiver that misses the very start of the leader tone can fail to catch the VIS header at all"
            >
              Pre-key
              <span class="flex items-center gap-1">
                <NumberField
                  value={tx.state().preKeyMs}
                  onCommit={tx.setPreKeyMs}
                  disabled={!tx.state().autoPTT}
                  min={0}
                  max={2000}
                  step={10}
                  class="w-14 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-right font-mono text-[#c9d1d9] focus:border-[#388bfd] focus:outline-none disabled:cursor-not-allowed"
                />
                <span class="text-[10px]">ms</span>
              </span>
            </label>

            <Show
              when={txPhase() === 'idle'}
              fallback={
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between text-xs">
                    <span class="text-[#58a6ff]">{txPhase() === 'encoding' ? 'Encoding…' : 'Transmitting…'}</span>
                    <div class="flex items-center gap-2">
                      <Show when={txPhase() === 'playing'}>
                        <span class="font-mono text-[#8b949e]">{txRemainingSec()}s left</span>
                      </Show>
                      <button onClick={() => tx.stop()} class="rounded border border-[#da3633]/40 px-2 py-0.5 text-[#f85149] transition-colors hover:bg-[#da3633]/10">
                        Stop
                      </button>
                    </div>
                  </div>
                  <div class="h-1.5 w-full rounded-full bg-[#21262d]">
                    <div class="h-1.5 rounded-full bg-[#238636] transition-all duration-150" style={{ width: `${Math.round(txProgress() * 100)}%` }} />
                  </div>
                </div>
              }
            >
              <div class="flex gap-2">
                <button
                  onClick={handleTransmit}
                  disabled={!hasContent()}
                  class="flex-1 rounded-md bg-[#238636] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Encode &amp; Transmit
                </button>
                <button
                  onClick={handleSaveCard}
                  disabled={!hasContent()}
                  class="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d] disabled:cursor-not-allowed disabled:opacity-40"
                  title={editingCardId() ? 'Save changes to this loaded card' : 'Save this composed card to the gallery below'}
                >
                  {editingCardId() ? 'Save Changes' : 'Save'}
                </button>
              </div>
              <Show when={editingCardId()}>
                <button
                  onClick={() => setEditingCardId(null)}
                  class="w-full rounded border border-transparent py-1 text-[10px] text-[#8b949e] transition-colors hover:text-[#c9d1d9]"
                >
                  Editing a saved card — click to save as new instead
                </button>
              </Show>
            </Show>
            <Show when={tx.state().error}>
              <p class="text-xs text-[#f85149]">{tx.state().error}</p>
            </Show>
          </div>
        </div>
      </div>

      {/* Saved cards gallery */}
      <Show when={cards().length > 0}>
        <div class="border-t border-[#30363d] pt-3">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-[#c9d1d9]">
              Saved Cards <span class="font-normal text-[#8b949e]">({cards().length})</span>
            </h3>
            <button onClick={handleClearCards} class="rounded border border-transparent px-2 py-1 text-xs text-[#8b949e] transition-colors hover:border-[#da3633]/30 hover:text-[#da3633]">
              Clear all
            </button>
          </div>
          <div class="flex gap-3 overflow-x-auto pb-2">
            <For each={cards()}>
              {(card) => (
                <button
                  onClick={() => setPreviewCard(card)}
                  class={`group w-32 shrink-0 overflow-hidden rounded-lg border bg-[#0d1117] transition-colors hover:border-[#2ea043] ${
                    editingCardId() === card.id ? 'border-[#58a6ff]' : 'border-[#30363d]'
                  }`}
                >
                  <div class="relative w-full" style={{ 'aspect-ratio': `${card.width}/${card.height}` }}>
                    <img src={cardUrl(card)} alt={card.mode} class="h-full w-full object-cover" />
                  </div>
                  <div class="p-1.5 text-left">
                    <div class="truncate font-mono text-[10px] text-[#2ea043]">{card.name}</div>
                    <div class="text-[10px] text-[#8b949e]">{new Date(card.createdAt).toLocaleTimeString()}</div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Preview modal */}
      <Show when={previewCard()}>
        {(card) => (
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreviewCard(null)}>
            <div class="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-[#30363d] bg-[#161b22] shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div class="flex shrink-0 items-center gap-2 border-b border-[#30363d] p-4">
                <TextField
                  value={card().name}
                  onCommit={(v) => handleRenameCard(card().id, v)}
                  class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm font-semibold text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                <span class="shrink-0 font-mono text-xs text-[#8b949e]">{SSTV_MODES[card().mode as EncodableSSTVMode]?.name ?? card().mode}</span>
                <button onClick={() => setPreviewCard(null)} class="shrink-0 text-[#8b949e] transition-colors hover:text-[#c9d1d9]">
                  ✕
                </button>
              </div>
              <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#0d1117] p-4">
                <img src={cardUrl(card())} alt={card().mode} style={{ 'max-width': '100%', 'max-height': '60vh', 'image-rendering': 'pixelated' }} />
              </div>
              <div class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[#30363d] p-4">
                <button
                  onClick={() => handleDeleteCard(card().id)}
                  class="rounded-md border border-[#da3633]/40 px-4 py-2 text-sm font-semibold text-[#f85149] transition-colors hover:bg-[#da3633]/10"
                >
                  Delete
                </button>
                <a
                  href={cardUrl(card())}
                  download={`sstv-qso-${card().mode.toLowerCase()}-${card().createdAt}.png`}
                  class="rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]"
                >
                  Download PNG
                </a>
                <button
                  onClick={() => handleLoadCard(card())}
                  class="rounded-md border border-[#58a6ff]/40 bg-[#58a6ff]/10 px-4 py-2 text-sm font-semibold text-[#58a6ff] transition-colors hover:bg-[#58a6ff]/20"
                  title="Load this card back into the editor to tweak it"
                >
                  Edit
                </button>
                <button
                  onClick={async () => {
                    await handleLoadCard(card(), { scrollIntoView: false })
                    await handleTransmit()
                  }}
                  class="rounded-md bg-[#238636] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043]"
                  title="Load this card and transmit it immediately"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
