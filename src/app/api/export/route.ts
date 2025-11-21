import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, copyFileSync, statSync } from 'fs'
import { ffmpeg, ensureFfmpegAvailable } from '@/lib/ffmpeg'
import type { FfmpegCommand } from 'fluent-ffmpeg'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

async function runCommand(cmd: FfmpegCommand) {
  return new Promise<void>((resolve, reject) => {
    cmd.on('end', () => resolve())
    cmd.on('error', (err: unknown) => reject(err))
    cmd.run()
  })
}

interface ExportRequest {
  clipId?: string
  fps?: number
  yoyoCount?: number
  overrideFps?: number
}

function parseNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export async function POST(req: NextRequest) {
  try {
    ensureFfmpegAvailable()

    const contentType = req.headers.get('content-type') || ''
    let body: ExportRequest = {}
    let customAudioFile: File | null = null

    if (contentType.includes('application/json')) {
      body = await req.json()
    } else {
      const formData = await req.formData()
      body.clipId = formData.get('clipId') as string | null || undefined
      body.fps = parseNumber(formData.get('fps'), 10)
      body.overrideFps = parseNumber(formData.get('overrideFps'), 0) || undefined
      body.yoyoCount = parseNumber(formData.get('yoyoCount'), 0) || undefined
      const maybeAudio = formData.get('audio')
      if (maybeAudio instanceof File) {
        customAudioFile = maybeAudio
      }
    }

    const { clipId, fps = 10, yoyoCount = 1, overrideFps = 0 } = body

    if (!clipId) {
      return NextResponse.json({ error: 'clipId is required' }, { status: 400 })
    }

    const baseDir = path.join(process.cwd(), 'public', 'runs', clipId)
    const sourceDir = path.join(baseDir, 'source')
    const transformedDir = path.join(baseDir, 'transformed')
    const workingDir = path.join(baseDir, 'export_work')
    const audioPath = path.join(baseDir, 'audio.mp3')
    const outputPath = path.join(baseDir, 'export.mp4')

    if (!existsSync(sourceDir)) {
      return NextResponse.json({ error: 'No frames found for this clip' }, { status: 404 })
    }

    await fs.rm(workingDir, { recursive: true, force: true })
    await fs.mkdir(workingDir, { recursive: true })
    await fs.rm(outputPath, { force: true })

    let frameNames: string[] = []
    let encodedFps: number | null = null
    try {
      const metaRaw = await fs.readFile(path.join(baseDir, 'meta.json'), 'utf8')
      const meta = JSON.parse(metaRaw)
      if (typeof meta.fps === 'number' && Number.isFinite(meta.fps)) {
        encodedFps = meta.fps
      }
    } catch {}

    frameNames = (await fs.readdir(sourceDir)).filter((n) => n.endsWith('.png')).sort()

    if (frameNames.length === 0) {
      return NextResponse.json({ error: 'No frames to export' }, { status: 404 })
    }

    const effectiveFps = overrideFps > 0 ? overrideFps : fps > 0 ? fps : encodedFps || 10

    for (const name of frameNames) {
      const target = path.join(workingDir, name)
      const transformed = path.join(transformedDir, name)
      const source = path.join(sourceDir, name)
      const transformedUsable =
        existsSync(transformed) &&
        (() => {
          try {
            return statSync(transformed).size > 0
          } catch {
            return false
          }
        })()

      if (transformedUsable) {
        copyFileSync(transformed, target)
        continue
      }

      if (existsSync(source)) {
        copyFileSync(source, target)
        continue
      }

      return NextResponse.json({ error: `Missing frame ${name}` }, { status: 404 })
    }

    // Build an explicit concat list to preserve ordering even with retries/gaps.
    const listPath = path.join(workingDir, 'frames.txt')
    const forward = frameNames
    const backward = frameNames.slice(1, -1).reverse()
    const loops = Math.max(1, Math.floor(yoyoCount) || 1)

    const sequence: string[] = []
    for (let i = 0; i < loops; i++) {
      sequence.push(...forward)
      if (loops > 1) {
        sequence.push(...backward)
      }
    }

    const listContent = sequence
      .map((name) => `file '${path.join(workingDir, name).replace(/'/g, "'\\''")}'`)
      .join('\n')
    await fs.writeFile(listPath, listContent, 'utf8')

    const scaleFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    const vf = `${scaleFilter},format=rgb24`

    const useOriginalAudio =
      existsSync(audioPath) && !customAudioFile && !(overrideFps > 0) && !(Math.max(1, Math.floor(yoyoCount) || 1) > 1)

    // Prepare custom audio if provided
    let customAudioPath: string | null = null
    if (customAudioFile) {
      const buf = Buffer.from(await customAudioFile.arrayBuffer())
      customAudioPath = path.join(workingDir, 'custom_audio.mp3')
      await fs.writeFile(customAudioPath, buf)
    }

    const cmd = ffmpeg()
      .addInput(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0', '-r', String(effectiveFps)])
      .outputOptions([
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(effectiveFps),
      ])

    if (customAudioPath) {
      cmd.addInput(customAudioPath).outputOptions(['-shortest'])
    } else if (useOriginalAudio) {
      cmd.addInput(audioPath).outputOptions(['-shortest'])
    }

    cmd.output(outputPath).outputOptions(['-movflags', '+faststart'])

    await runCommand(cmd)

    return NextResponse.json({ videoUrl: `/runs/${clipId}/export.mp4` })
  } catch (error) {
    console.error('Export failed:', error)
    return NextResponse.json({ error: 'Failed to export MP4' }, { status: 500 })
  }
}
