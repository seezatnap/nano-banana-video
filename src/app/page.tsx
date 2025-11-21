"use client"

import Image from "next/image"
import { useEffect, useMemo, useRef, useState } from "react"
import { loadState, saveState, clearState } from "@/lib/localState"
import * as Dialog from "@radix-ui/react-dialog"
import * as Popover from "@radix-ui/react-popover"

type FrameSlot = {
  name: string
  sourceUrl: string
  transformedUrl?: string
  status: "pending" | "processing" | "done" | "error"
  error?: string
  attempt?: number
}

type FrameResponse = { name: string; url: string }

type ClipInfo = {
  clipId: string
  fps: number
  duration: number
  audioUrl: string | null
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s"
  const mins = Math.floor(seconds / 60)
  const secs = seconds - mins * 60
  const secString = secs < 10 ? `0${secs.toFixed(2)}` : secs.toFixed(2)
  return mins > 0 ? `${mins}:${secString}` : `${secString}s`
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export default function Home() {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [thumbAspect, setThumbAspect] = useState(16 / 9)
  const [start, setStart] = useState(0)
  const [clipLength, setClipLength] = useState(5)
  const [fpsInput, setFpsInput] = useState(10)
  const [yoyoEnabled, setYoyoEnabled] = useState(false)
  const [yoyoCount, setYoyoCount] = useState(2)
  const [overrideMp4Fps, setOverrideMp4Fps] = useState<number | null>(null)
  const [customAudio, setCustomAudio] = useState<File | null>(null)
  const [isExportDialogOpen, setExportDialogOpen] = useState(false)

  const [clipInfo, setClipInfo] = useState<ClipInfo | null>(null)
  const [frames, setFrames] = useState<FrameSlot[]>([])
  const [prompt, setPrompt] = useState("studio ghibli")

  const [isExtracting, setIsExtracting] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState("")
  const [hydrated, setHydrated] = useState(false)

  const runnerRef = useRef(false)
  const currentIndexRef = useRef<number | null>(null)
  const framesRef = useRef<FrameSlot[]>([])

  const maxStart = useMemo(
    () => Math.max(0, videoDuration - Math.min(clipLength, 10)),
    [videoDuration, clipLength]
  )

  useEffect(() => {
    if (!videoFile) return
    const url = URL.createObjectURL(videoFile)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [videoFile])

  useEffect(() => {
    setStart((prev) => clamp(prev, 0, maxStart))
  }, [maxStart])

  useEffect(() => {
    framesRef.current = frames
  }, [frames])

  // Load persisted session on mount
  useEffect(() => {
    const hydrate = async () => {
      const saved = await loadState()
      if (saved) {
        setClipInfo(saved.clipInfo ?? null)
        const restoredFrames = (saved.frames ?? []).map((f) => ({
          ...f,
          status: f.transformedUrl ? "done" : "pending",
          error: undefined,
          attempt: undefined,
        }))
        setFrames(restoredFrames)
        setPrompt(saved.prompt ?? "studio ghibli")
        setStart(saved.start ?? 0)
        setClipLength(saved.clipLength ?? 5)
        setFpsInput(saved.fpsInput ?? 10)
        setVideoUrl(saved.videoUrl ?? null)
        setVideoDuration(saved.videoDuration ?? 0)
        setStatus(saved.statusMessage ?? "")
        setYoyoEnabled(saved.yoyoEnabled ?? false)
        setYoyoCount(saved.yoyoCount ?? 2)
        setOverrideMp4Fps(saved.overrideMp4Fps ?? null)
      }
      setHydrated(true)
    }
    hydrate()
  }, [])

  // Persist session when key parts change (after hydration)
  useEffect(() => {
    if (!hydrated) return
    const framesToPersist = frames.map((f) => ({
      name: f.name,
      sourceUrl: f.sourceUrl,
      transformedUrl: f.transformedUrl,
    }))
    void saveState({
      clipInfo,
          frames: framesToPersist,
          prompt,
          start,
          clipLength,
          fpsInput,
      videoUrl,
      videoDuration,
      statusMessage: status,
      yoyoEnabled,
      yoyoCount,
      overrideMp4Fps,
    })
  }, [clipInfo, frames, prompt, start, clipLength, fpsInput, videoUrl, videoDuration, status, yoyoEnabled, yoyoCount, overrideMp4Fps, hydrated])

  const pendingCount = frames.filter((f) => !f.transformedUrl).length

  const handleExtract = async () => {
    if (!videoFile) return
    setIsExtracting(true)
    setStatus("Extracting frames...")
    setFrames([])
    setClipInfo(null)
    setIsRunning(false)
    runnerRef.current = false
    currentIndexRef.current = null

    try {
      const formData = new FormData()
      formData.append("video", videoFile)
      formData.append("start", String(start))
      formData.append("duration", String(clipLength))
      formData.append("fps", String(fpsInput))

      const res = await fetch("/api/extract", { method: "POST", body: formData })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to extract frames")
      }
      const data = await res.json()
      const framesFromApi = Array.isArray(data.frames) ? (data.frames as FrameResponse[]) : []
      const nextFrames: FrameSlot[] = framesFromApi.map((frame) => ({
        name: frame.name,
        sourceUrl: frame.url,
        status: "pending",
      }))
      setFrames(nextFrames)
      setClipInfo({
        clipId: data.clipId,
        fps: data.fps,
        duration: data.duration,
        audioUrl: data.audioUrl,
      })
      if (data.inputUrl) {
        setVideoUrl(data.inputUrl)
      }
      setStatus(`Captured ${nextFrames.length} frames at ${data.fps} fps`)
    } catch (error) {
      console.error(error)
      setStatus(error instanceof Error ? error.message : "Extraction failed")
    } finally {
      setIsExtracting(false)
    }
  }

  const retryFrame = async (index: number) => {
    if (!clipInfo) return
    const frame = framesRef.current[index]
    if (!frame) return
    runnerRef.current = false
    currentIndexRef.current = index
    setIsRunning(false)
    setFrames((prev) => {
      const next = prev.map((f, idx) =>
        idx === index
          ? {
              ...f,
              transformedUrl: undefined,
              status: "pending",
              error: undefined,
            }
          : f
      )
      framesRef.current = next
      return next
    })
    await processSingleFrame(index, true)
  }

  const processSingleFrame = async (index: number, skipAlreadyDone = false): Promise<boolean> => {
    const frame = framesRef.current[index]
    if (!clipInfo || !frame || !prompt.trim()) return false
    if (skipAlreadyDone && frame.transformedUrl) return true

    setFrames((prev) => {
      const next = prev.map((f, idx) =>
        idx === index ? { ...f, status: "processing", error: undefined, attempt: (f.attempt || 0) + 1 } : f
      )
      framesRef.current = next
      return next
    })

    const body = {
      clipId: clipInfo.clipId,
      frameName: frame.name,
      prompt,
      previousTransformedName:
        index > 0 && framesRef.current[index - 1]?.transformedUrl ? framesRef.current[index - 1].name : null,
    }

    try {
      const res = await fetch("/api/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Transform failed")
      }
      const data = await res.json()
      setFrames((prev) => {
        const next = prev.map((f, idx) =>
          idx === index ? { ...f, transformedUrl: data.transformedUrl, status: "done" } : f
        )
        framesRef.current = next
        return next
      })
      return true
    } catch (error) {
      console.error(error)
      setFrames((prev) => {
        const next = prev.map((f, idx) =>
          idx === index
            ? {
                ...f,
                status: "error",
                error: error instanceof Error ? error.message : "Transform failed",
              }
            : f
        )
        framesRef.current = next
        return next
      })
      setStatus(error instanceof Error ? error.message : "Transform failed")
      runnerRef.current = false
      return false
    }
  }

  const clearFrame = async (index: number) => {
    const frame = framesRef.current[index]
    if (!clipInfo || !frame) return
    try {
      await fetch("/api/clear-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId: clipInfo.clipId, frameName: frame.name }),
      })
    } catch (e) {
      console.warn("Failed to clear server frame", e)
    }
    setFrames((prev) => {
      const next = prev.map((f, idx) =>
        idx === index
          ? { ...f, transformedUrl: undefined, status: "pending", error: undefined, attempt: undefined }
          : f
      )
      framesRef.current = next
      return next
    })
  }

  const processFrames = async () => {
    if (!clipInfo || frames.length === 0 || !prompt.trim()) return
    runnerRef.current = true
    framesRef.current = frames
    setIsRunning(true)
    setStatus("Running nano banana...")

    for (let i = 0; i < frames.length && runnerRef.current; i++) {
      const currentFrame = framesRef.current[i]
      if (!currentFrame) break
      if (currentFrame.transformedUrl) continue
      currentIndexRef.current = i
      const ok = await processSingleFrame(i, true)
      if (!ok || !runnerRef.current) break
    }

    runnerRef.current = false
    setIsRunning(false)
    currentIndexRef.current = null
    const remaining = framesRef.current.filter((f) => !f.transformedUrl).length
    setStatus(remaining === 0 ? "Complete" : "Paused")
  }

  const stop = () => {
    runnerRef.current = false
    setIsRunning(false)
    currentIndexRef.current = null
    setStatus("Stopped")
  }

  const resume = () => {
    if (!runnerRef.current) processFrames()
  }

  const exportVideo = async () => {
    if (!clipInfo) return
    setExporting(true)
    setStatus("Encoding MP4...")
    try {
      const form = new FormData()
      form.append("clipId", clipInfo.clipId)
      form.append("fps", String(clipInfo.fps))
      if (yoyoEnabled) {
        form.append("yoyoCount", String(Math.max(1, Math.floor(yoyoCount) || 1)))
      }
      if (overrideMp4Fps && overrideMp4Fps > 0) {
        form.append("overrideFps", String(overrideMp4Fps))
      }
      if (customAudio) {
        form.append("audio", customAudio)
      }

      const res = await fetch("/api/export", {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Export failed")
      }
      const data = await res.json()
      if (data.videoUrl) {
        const link = document.createElement("a")
        link.href = data.videoUrl
        link.download = `nano-banana-${clipInfo.clipId}.mp4`
        document.body.appendChild(link)
        link.click()
        link.remove()
        setStatus("Export ready")
      }
    } catch (error) {
      console.error(error)
      setStatus(error instanceof Error ? error.message : "Export failed")
    } finally {
      setExporting(false)
      setExportDialogOpen(false)
    }
  }

  const framesReady = frames.length > 0
  const transformedCount = frames.filter((f) => f.transformedUrl).length

  const handleClearSession = async () => {
    runnerRef.current = false
    currentIndexRef.current = null
    framesRef.current = []
    await clearState()
    setVideoFile(null)
    setVideoUrl(null)
    setVideoDuration(0)
    setStart(0)
    setClipLength(5)
    setFpsInput(10)
    setYoyoEnabled(false)
    setYoyoCount(2)
    setOverrideMp4Fps(null)
    setCustomAudio(null)
    setFrames([])
    setClipInfo(null)
    setPrompt("studio ghibli")
    setStatus("Local session cleared.")
    setIsRunning(false)
    setIsExtracting(false)
    setExporting(false)
    setInbetweenCount(0)
  }

  return (
    <div className="min-h-screen text-slate-100">
      <div className="max-w-6xl mx-auto px-6 py-12 space-y-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-2xl accent-gradient shadow-lg shadow-emerald-500/30 flex items-center justify-center text-slate-900 font-bold">
                  NB
                </div>
                <div>
                  <h1 className="text-3xl font-semibold leading-tight">Nano Banana Video</h1>
                </div>
              </div>
              <button
                onClick={handleClearSession}
                className="rounded-lg px-3 py-2 bg-white/10 hover:bg-white/20 text-sm border border-white/10"
            >
              Clear session
            </button>
          </div>
        </header>

        <section className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">Upload & Clip</div>
              <p className="text-sm text-slate-300">Choose a video and define a ≤10s range.</p>
            </div>
            <div className="text-sm text-slate-400">
              {videoDuration ? `Video length: ${formatTime(videoDuration)}` : "Awaiting video"}
            </div>
          </div>

          <div className="grid md:grid-cols-[1.2fr_1fr] gap-4">
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-200">Video file</label>
              <input
                type="file"
                accept="video/*"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    setVideoFile(file)
                    setClipInfo(null)
                    setFrames([])
                  }
                }}
                className="block w-full text-sm text-slate-200 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
              />

              {videoUrl && (
                <div className="rounded-xl overflow-hidden border border-white/10">
                  <video
                    src={videoUrl}
                    controls
                    className="w-full h-64 object-cover bg-black"
                    onLoadedMetadata={(e) => {
                      const duration = (e.target as HTMLVideoElement).duration || 0
                      const vw = (e.target as HTMLVideoElement).videoWidth || 16
                      const vh = (e.target as HTMLVideoElement).videoHeight || 9
                      if (vw && vh) setThumbAspect(vw / vh)
                      setVideoDuration(duration)
                      setClipLength(Math.min(10, duration || clipLength))
                    }}
                  />
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-200">Start (seconds)</span>
                <span className="font-mono text-slate-300">{start.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={maxStart || 0}
                step={0.05}
                value={start}
                onChange={(e) => setStart(Number.parseFloat(e.target.value))}
              />

              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-200">Clip length (max 10s)</span>
                <span className="font-mono text-slate-300">{clipLength.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={Math.min(10, videoDuration || 10)}
                step={0.1}
                value={clipLength}
                onChange={(e) => setClipLength(Math.min(10, Number.parseFloat(e.target.value)))}
              />

              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-200">Frames per second</span>
                <span className="font-mono text-slate-300">{fpsInput}</span>
              </div>
              <input
                type="range"
                min={1}
                max={30}
                step={1}
                value={fpsInput}
                onChange={(e) => setFpsInput(clamp(Number.parseInt(e.target.value || "10", 10), 1, 30))}
              />

              <div className="text-xs text-slate-300">
                Range: {formatTime(start)} → {formatTime(start + clipLength)}
              </div>

              <button
                onClick={handleExtract}
                disabled={!videoFile || isExtracting}
                className="w-full rounded-lg px-4 py-3 bg-white/10 hover:bg-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
              >
                {isExtracting ? "Extracting..." : `Generate ${fpsInput} fps frames`}
              </button>
            </div>
          </div>
        </section>

        <section className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Frames</div>
              <p className="text-sm text-slate-300">
                Scroll horizontally. Top row is the raw clip. Bottom row fills as transforms complete.
              </p>
            </div>
            <div className="text-sm text-slate-300">
              {framesReady
                ? `${transformedCount}/${frames.length} ready`
                : "No frames yet"}
            </div>
          </div>

          {framesReady ? (
            <div className="overflow-x-auto no-scrollbar">
              <div className="grid auto-cols-[220px] grid-flow-col gap-3 min-w-full pb-2">
              {frames.map((frame, idx) => (
                <div
                  key={frame.name}
                  className={`rounded-xl border ${
                    frame.status === "processing"
                        ? "border-emerald-300/70 shadow-[0_0_0_1px_rgba(16,185,129,0.4)]"
                        : "border-white/10"
                    } bg-white/5 overflow-hidden`}
                >
                  <div className="p-2 space-y-2">
                    <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black" style={{ aspectRatio: thumbAspect }}>
                      <Popover.Root>
                        <Popover.Trigger asChild>
                          <button
                            className="absolute right-2 top-2 z-10 text-[11px] px-2 py-1 rounded-md bg-white/15 border border-white/20 hover:bg-white/25"
                            title="Frame actions"
                          >
                            •••
                          </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Content className="rounded-lg bg-slate-900/95 border border-white/10 shadow-xl p-2 text-xs text-white space-y-1">
                            <button
                              onClick={() => retryFrame(idx)}
                              className="block w-full text-left px-3 py-2 rounded hover:bg-white/10"
                            >
                              Retry
                            </button>
                            <button
                              onClick={() => clearFrame(idx)}
                              className="block w-full text-left px-3 py-2 rounded hover:bg-white/10 text-rose-200"
                            >
                              Clear output
                            </button>
                            <Popover.Arrow className="fill-slate-900" />
                          </Popover.Content>
                        </Popover.Portal>
                      </Popover.Root>
                      <Image
                        src={frame.sourceUrl}
                        alt={frame.name}
                        fill
                        sizes="220px"
                        className="object-cover"
                        unoptimized
                      />
                        <div className="absolute left-2 top-2 text-[10px] px-2 py-1 rounded-full bg-black/60 border border-white/10">
                          Source #{idx + 1}
                        </div>
                      </div>
                    <div className="relative overflow-hidden rounded-lg border border-dashed border-emerald-200/30 bg-slate-900" style={{ aspectRatio: thumbAspect }}>
                      {frame.transformedUrl ? (
                        <Image
                          src={frame.transformedUrl}
                          alt={`Transformed ${frame.name}`}
                          fill
                            sizes="220px"
                            className="object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                            {frame.status === "processing" ? "Transforming..." : "Waiting"}
                          </div>
                        )}
                        <div className="absolute left-2 top-2 text-[10px] px-2 py-1 rounded-full bg-emerald-500/20 border border-emerald-300/40">
                          Stylized
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-300">
                        <span className="font-mono">{frame.name}</span>
                        <span
                          className={
                            frame.status === "done"
                              ? "text-emerald-300"
                              : frame.status === "processing"
                              ? "text-amber-300"
                              : frame.status === "error"
                              ? "text-rose-300"
                              : "text-slate-400"
                          }
                        >
                          {frame.status}
                        </span>
                      </div>
                      {frame.error && (
                        <div className="text-[11px] text-rose-200 truncate">{frame.error}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-300">No frames yet. Extract a clip to begin.</div>
          )}
        </section>

        <section className="glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Transform controls</div>
              <p className="text-sm text-slate-300">Run left-to-right, feeding each stylized frame into the next.</p>
            </div>
            <div className="text-xs text-slate-300">
              {pendingCount
                ? `${pendingCount} frames remaining`
                : framesReady
                ? "All frames ready"
                : "Idle"}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-slate-200">Style prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
              rows={3}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={processFrames}
              disabled={!framesReady || !prompt.trim() || isRunning}
              className="rounded-lg px-4 py-2 bg-emerald-400 text-slate-900 font-semibold hover:bg-emerald-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start
            </button>
            <button
              onClick={stop}
              disabled={!isRunning}
              className="rounded-lg px-4 py-2 bg-white/10 text-white hover:bg-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Stop
            </button>
            <button
              onClick={resume}
              disabled={isRunning || !framesReady || pendingCount === 0}
              className="rounded-lg px-4 py-2 bg-white/5 text-white hover:bg-white/15 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Resume
            </button>
            <Dialog.Root open={isExportDialogOpen} onOpenChange={setExportDialogOpen}>
              <Dialog.Trigger asChild>
                <button
                  disabled={!clipInfo || exporting || !framesReady}
                  className="rounded-lg px-4 py-2 bg-blue-400 text-slate-900 font-semibold hover:bg-blue-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exporting ? "Exporting..." : "Export MP4"}
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
                <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-slate-900/95 border border-white/10 shadow-2xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <Dialog.Title className="text-lg font-semibold text-white">Export options</Dialog.Title>
                    <Dialog.Close className="text-slate-300 hover:text-white">&times;</Dialog.Close>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={yoyoEnabled}
                          onChange={(e) => setYoyoEnabled(e.target.checked)}
                        />
                        <span className="text-slate-200">Yo-yo loop (disables original audio)</span>
                      </label>
                      {yoyoEnabled && (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-300">Loops:</span>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={yoyoCount}
                            onChange={(e) =>
                              setYoyoCount(Math.max(1, Math.min(10, parseInt(e.target.value || "1", 10))))
                            }
                            className="w-20 rounded bg-white/5 border border-white/10 px-2 py-1"
                          />
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-slate-200">Override MP4 FPS (disables original audio)</label>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={overrideMp4Fps ?? ""}
                        onChange={(e) => {
                          const val = e.target.value
                          setOverrideMp4Fps(val === "" ? null : Math.max(1, Math.min(60, parseInt(val || "0", 10))))
                        }}
                        className="w-full rounded bg-white/5 border border-white/10 px-2 py-2"
                        placeholder="leave empty to keep source fps"
                      />
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <label className="text-slate-200">Custom MP3 audio (overrides original)</label>
                      <input
                        type="file"
                        accept="audio/mpeg,.mp3"
                        onChange={(e) => setCustomAudio(e.target.files?.[0] || null)}
                        className="block w-full text-slate-200 text-xs"
                      />
                      {customAudio && (
                        <div className="text-xs text-slate-300 truncate">Selected: {customAudio.name}</div>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-3 pt-2">
                    <Dialog.Close asChild>
                      <button className="px-4 py-2 rounded-lg border border-white/10 text-slate-200 hover:bg-white/10">
                        Cancel
                      </button>
                    </Dialog.Close>
                    <button
                      onClick={exportVideo}
                      disabled={!clipInfo || exporting || !framesReady}
                      className="px-4 py-2 rounded-lg bg-blue-400 text-slate-900 font-semibold hover:bg-blue-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {exporting ? "Exporting..." : "Start export"}
                    </button>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>

          <div className="text-sm text-slate-300 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-300 animate-pulse" />
            {status || "Waiting for instructions"}
          </div>
        </section>
      </div>
    </div>
  )
}
