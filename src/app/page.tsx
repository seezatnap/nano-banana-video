"use client"

import Image from "next/image"
import { useEffect, useMemo, useRef, useState } from "react"

type FrameSlot = {
  name: string
  sourceUrl: string
  transformedUrl?: string
  status: "pending" | "processing" | "done" | "error"
  error?: string
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
  const [start, setStart] = useState(0)
  const [clipLength, setClipLength] = useState(5)

  const [clipInfo, setClipInfo] = useState<ClipInfo | null>(null)
  const [frames, setFrames] = useState<FrameSlot[]>([])
  const [prompt, setPrompt] = useState("studio ghibli watercolor, luminous edges, soft motion blur")

  const [isExtracting, setIsExtracting] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState("")

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
      setStatus(`Captured ${nextFrames.length} frames at 10 fps`)
    } catch (error) {
      console.error(error)
      setStatus(error instanceof Error ? error.message : "Extraction failed")
    } finally {
      setIsExtracting(false)
    }
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
      setFrames((prev) => {
        const next = prev.map((f, idx) =>
          idx === i ? { ...f, status: "processing", error: undefined } : f
        )
        framesRef.current = next
        return next
      })

      const body = {
        clipId: clipInfo.clipId,
        frameName: currentFrame.name,
        prompt,
        previousTransformedName:
          i > 0 && framesRef.current[i - 1]?.transformedUrl ? framesRef.current[i - 1].name : null,
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
            idx === i ? { ...f, transformedUrl: data.transformedUrl, status: "done" } : f
          )
          framesRef.current = next
          return next
        })
      } catch (error) {
        console.error(error)
        setFrames((prev) => {
          const next = prev.map((f, idx) =>
            idx === i
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
        break
      }
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
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId: clipInfo.clipId, fps: clipInfo.fps }),
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
    }
  }

  const framesReady = frames.length > 0
  const transformedCount = frames.filter((f) => f.transformedUrl).length

  return (
    <div className="min-h-screen text-slate-100">
      <div className="max-w-6xl mx-auto px-6 py-12 space-y-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl accent-gradient shadow-lg shadow-emerald-500/30 flex items-center justify-center text-slate-900 font-bold">
              NB
            </div>
            <div>
              <h1 className="text-3xl font-semibold leading-tight">Nano Banana Video</h1>
              <p className="text-sm text-slate-300">
                Slice a 10s clip, view 10 fps frames, transform sequentially with Gemini 3,
                and export with the original audio.
              </p>
            </div>
          </div>
          <div className="text-xs text-slate-300">
            Set <span className="font-mono">GEMINI_API_KEY</span> in your env to enable frame stylization.
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

              <div className="text-xs text-slate-300">
                Range: {formatTime(start)} → {formatTime(start + clipLength)}
              </div>

              <button
                onClick={handleExtract}
                disabled={!videoFile || isExtracting}
                className="w-full rounded-lg px-4 py-3 bg-white/10 hover:bg-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
              >
                {isExtracting ? "Extracting..." : "Generate 10 fps frames"}
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
                      <div className="relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-black">
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
                      <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-emerald-200/30 bg-slate-900">
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
            <button
              onClick={exportVideo}
              disabled={!clipInfo || exporting || !framesReady}
              className="rounded-lg px-4 py-2 bg-blue-400 text-slate-900 font-semibold hover:bg-blue-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exporting ? "Exporting..." : "Export MP4"}
            </button>
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
