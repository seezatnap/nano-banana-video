import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { existsSync } from 'fs'

// Prefer explicit env override, then bundled ffmpeg-static, otherwise rely on system ffmpeg in PATH.
const envPath = process.env.FFMPEG_PATH
const staticPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : null

const resolvedPath = envPath && existsSync(envPath)
  ? envPath
  : staticPath && existsSync(staticPath)
    ? staticPath
    : null

if (resolvedPath) {
  ffmpeg.setFfmpegPath(resolvedPath)
}

export function ensureFfmpegAvailable() {
  if (resolvedPath) return
  // fluent-ffmpeg will fall back to system ffmpeg; leave a clearer error if that also fails.
  try {
    ffmpeg()._getFfmpegPath(() => {})
  } catch {
    throw new Error('FFmpeg binary not found. Install ffmpeg-static, set FFMPEG_PATH, or ensure ffmpeg is on PATH.')
  }
}

export { ffmpeg, resolvedPath as ffmpegBinary }
