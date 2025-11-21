import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import ai, { DEFAULT_GEMINI_IMAGE_MODEL } from '@/lib/gemini'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

type InlinePart = { text?: string; inlineData?: { data?: string; mimeType?: string } }
type StreamChunk = {
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string | null }
  candidates?: {
    finishReason?: string
    content?: { parts?: InlinePart[] }
    safetyRatings?: unknown
  }[]
}

type TransformRequest = {
  clipId?: string
  frameName?: string
  prompt?: string
  previousTransformedName?: string | null
}

function buildPrompt(prompt: string, hasPrevious: boolean) {
  const lines = [
    'You are nano banana, stylizing a video one frame at a time.',
    'Start from the PREVIOUS RENDERED frame as your base. The current SOURCE frame tells you what changed—apply those changes (motion, pose, camera shift) while keeping the style from the previous output.',
    'Match composition to the source where needed, but allow natural scene shifts shown in the source. Do not rigidly lock to prior layout; follow the scene transition indicated by the source.',
    hasPrevious
      ? 'Keep palette/brush/texture from the previous stylized frame, but redraw the new frame to reflect the source changes (animation state, camera move, subject movement).'
      : 'This is the first frame. Apply the style cleanly while respecting the source framing.',
    'Output exactly one PNG at the same resolution as the source frame. No borders, text, or watermarks.',
    `Style prompt: ${prompt}`,
  ]
  return lines.join('\n')
}

async function readBase64(filePath: string) {
  const buf = await fs.readFile(filePath)
  return buf.toString('base64')
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: 'GEMINI_API_KEY is not configured on the server' },
        { status: 500 }
      )
    }

    const body: TransformRequest = await req.json()
    const { clipId, frameName, prompt, previousTransformedName } = body

    if (!clipId || !frameName || !prompt) {
      return NextResponse.json(
        { error: 'clipId, frameName, and prompt are required' },
        { status: 400 }
      )
    }

    const baseDir = path.join(process.cwd(), 'public', 'runs', clipId)
    const sourcePath = path.join(baseDir, 'source', frameName)
    const transformedDir = path.join(baseDir, 'transformed')
    const targetPath = path.join(transformedDir, frameName)

    if (!existsSync(sourcePath)) {
      return NextResponse.json({ error: 'Source frame not found' }, { status: 404 })
    }
    if (!existsSync(transformedDir)) {
      await fs.mkdir(transformedDir, { recursive: true })
    }

    const hasPrevious = Boolean(previousTransformedName)
    const prevPath = previousTransformedName
      ? path.join(transformedDir, previousTransformedName)
      : null

    const userParts: InlinePart[] = [{ text: buildPrompt(prompt, hasPrevious) }]

    if (prevPath && existsSync(prevPath)) {
      userParts.push({ text: 'Previous stylized frame (your starting state):' })
      userParts.push({ inlineData: { data: await readBase64(prevPath), mimeType: 'image/png' } })
      userParts.push({ text: 'Current source frame (what changed):' })
      userParts.push({ inlineData: { data: await readBase64(sourcePath), mimeType: 'image/png' } })
    } else {
      userParts.push({ text: 'Next source frame to adapt:' })
      userParts.push({ inlineData: { data: await readBase64(sourcePath), mimeType: 'image/png' } })
    }

    const allowedModels = new Set([
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image-preview',
    ])
    const requestedModel = process.env.GEMINI_IMAGE_MODEL
    const model =
      requestedModel && allowedModels.has(requestedModel)
        ? requestedModel
        : DEFAULT_GEMINI_IMAGE_MODEL

    const stream = await ai.models.generateContentStream({
      model,
      config: { responseModalities: ['IMAGE'] },
      contents: [{ role: 'user', parts: userParts }],
    })

    let imageBase64: string | null = null
    let chunkCount = 0
    let candidateInfo: StreamChunk['candidates'][number] | null = null
    let blockReason: string | null = null
    let blockReasonMessage: string | null = null
    let safetyRatings: unknown
    let promptFeedback: StreamChunk['promptFeedback'] | null = null

    for await (const rawChunk of stream) {
      const chunk = rawChunk as StreamChunk
      chunkCount++
      if (chunk.promptFeedback?.blockReason) {
        blockReason = chunk.promptFeedback.blockReason || null
        blockReasonMessage = chunk.promptFeedback.blockReasonMessage || null
        promptFeedback = chunk.promptFeedback
        break
      }
      if (chunk.candidates && chunk.candidates.length > 0) {
        const candidate = chunk.candidates[0]
        candidateInfo = candidate
        safetyRatings = candidate.safetyRatings || safetyRatings
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData?.data) {
              imageBase64 = part.inlineData.data
              break
            }
          }
          if (imageBase64) break
        }
      }
    }

    if (!imageBase64) {
      const diagnostics: Record<string, unknown> = {
        model,
        chunkCount,
        promptFeedback,
        blockReason,
        blockReasonMessage,
        candidateFinishReason: candidateInfo?.finishReason,
        safetyRatings,
      }
      return NextResponse.json(
        {
          error: `Model did not return an image. Reason: ${blockReason || candidateInfo?.finishReason || 'UNKNOWN'}`,
          code: blockReason || candidateInfo?.finishReason || 'NO_IMAGE_RETURNED',
          details: diagnostics,
        },
        { status: blockReason ? 422 : 502 }
      )
    }

    const buffer = Buffer.from(imageBase64, 'base64')
    await fs.writeFile(targetPath, buffer)

    return NextResponse.json({
      transformedUrl: `/runs/${clipId}/transformed/${frameName}`,
    })
  } catch (error) {
    console.error('Transform failed:', error)
    const err = error as { message?: string; status?: number; code?: number; response?: unknown }
    const rawMessage = typeof err?.message === 'string' ? err.message : ''
    const serviceUnavailable =
      rawMessage.toLowerCase().includes('model is overloaded') ||
      err?.status === 503 ||
      err?.code === 503

    const details = err?.response ? { response: err.response } : undefined
    const message = serviceUnavailable
      ? 'Gemini is under load. Please retry in a moment.'
      : 'Failed to transform frame'

    return NextResponse.json(
      { error: message, details },
      { status: serviceUnavailable ? 503 : 500 }
    )
  }
}
