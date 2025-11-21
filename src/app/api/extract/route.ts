import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { ffmpeg, ensureFfmpegAvailable } from '@/lib/ffmpeg'
import type { FfmpegCommand } from 'fluent-ffmpeg'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const FPS = 10
const FRAME_PATTERN = 'frame_%04d.png'

async function persistUpload(file: File, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const buffer = Buffer.from(await file.arrayBuffer())
  await fs.writeFile(target, buffer)
}

function parseNumber(value: FormDataEntryValue | null, fallback = 0) {
  if (typeof value !== 'string') return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function runCommand(cmd: FfmpegCommand) {
  return new Promise<void>((resolve, reject) => {
    cmd.on('end', () => resolve())
    cmd.on('error', (err: unknown) => reject(err))
    cmd.run()
  })
}

export async function POST(req: NextRequest) {
  try {
    ensureFfmpegAvailable()

    const formData = await req.formData()
    const video = formData.get('video')
    const start = Math.max(0, parseNumber(formData.get('start'), 0))
    const end = parseNumber(formData.get('end'), 0)
    const durationExplicit = parseNumber(formData.get('duration'), 0)
    const requestedDuration = durationExplicit > 0 ? durationExplicit : Math.max(0, end - start)

    if (!video || !(video instanceof File)) {
      return NextResponse.json({ error: 'Video file is required' }, { status: 400 })
    }

    if (!requestedDuration || requestedDuration <= 0) {
      return NextResponse.json({ error: 'Provide a positive clip duration' }, { status: 400 })
    }

    if (requestedDuration > 10.05) {
      return NextResponse.json({ error: 'Clip duration must be 10 seconds or less' }, { status: 400 })
    }

    const clipId = randomUUID()
    const runsRoot = path.join(process.cwd(), 'public', 'runs')
    const baseDir = path.join(runsRoot, clipId)
    const sourceDir = path.join(baseDir, 'source')
    const transformedDir = path.join(baseDir, 'transformed')
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(transformedDir, { recursive: true })

    const ext = path.extname(video.name || '') || '.mp4'
    const inputPath = path.join(baseDir, `input${ext}`)
    await persistUpload(video, inputPath)

    const frameOutput = path.join(sourceDir, FRAME_PATTERN)
    const extractCmd = ffmpeg(inputPath)
      .seekInput(start)
      .duration(requestedDuration)
      .output(frameOutput)
      .outputOptions(['-vf', `fps=${FPS}`])

    await runCommand(extractCmd)

    const audioPath = path.join(baseDir, 'audio.mp3')
    const audioCmd = ffmpeg(inputPath)
      .seekInput(start)
      .duration(requestedDuration)
      .output(audioPath)
      .outputOptions(['-vn', '-ac', '2', '-ar', '44100', '-b:a', '192k'])

    try {
      await runCommand(audioCmd)
    } catch (e) {
      console.warn('Audio extraction failed; continuing without audio', e)
    }

    const frameNames = (await fs.readdir(sourceDir))
      .filter((name) => name.endsWith('.png'))
      .sort()

    const payload = {
      clipId,
      fps: FPS,
      duration: Number(requestedDuration.toFixed(3)),
      frames: frameNames.map((name) => ({
        name,
        url: `/runs/${clipId}/source/${name}`,
      })),
      audioUrl: existsSync(audioPath) ? `/runs/${clipId}/audio.mp3` : null,
    }

    await fs.writeFile(
      path.join(baseDir, 'meta.json'),
      JSON.stringify(
        {
          ...payload,
          start,
          createdAt: Date.now(),
          framePattern: FRAME_PATTERN,
        },
        null,
        2
      )
    )

    return NextResponse.json(payload)
  } catch (error) {
    console.error('Extract failed:', error)
    return NextResponse.json({ error: 'Failed to extract frames' }, { status: 500 })
  }
}
