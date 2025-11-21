import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, copyFileSync } from 'fs'
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
}

export async function POST(req: NextRequest) {
  try {
    ensureFfmpegAvailable()

    const body: ExportRequest = await req.json()
    const { clipId, fps = 10 } = body

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
    try {
      const metaRaw = await fs.readFile(path.join(baseDir, 'meta.json'), 'utf8')
      const meta = JSON.parse(metaRaw)
      frameNames = Array.isArray(meta.frames)
        ? meta.frames
            .map((f: unknown) => (typeof f === 'object' && f && 'name' in f ? (f as { name: string }).name : null))
            .filter((name): name is string => Boolean(name))
        : []
    } catch {}

    if (frameNames.length === 0) {
      frameNames = (await fs.readdir(sourceDir)).filter((n) => n.endsWith('.png')).sort()
    }

    if (frameNames.length === 0) {
      return NextResponse.json({ error: 'No frames to export' }, { status: 404 })
    }

    for (const name of frameNames) {
      const target = path.join(workingDir, name)
      const transformed = path.join(transformedDir, name)
      const source = path.join(sourceDir, name)
      if (existsSync(transformed)) {
        copyFileSync(transformed, target)
      } else if (existsSync(source)) {
        copyFileSync(source, target)
      } else {
        return NextResponse.json({ error: `Missing frame ${name}` }, { status: 404 })
      }
    }

    const cmd = ffmpeg()
      .addInput(path.join(workingDir, 'frame_%04d.png'))
      .inputOptions(['-framerate', String(fps)])
      .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])

    if (existsSync(audioPath)) {
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
