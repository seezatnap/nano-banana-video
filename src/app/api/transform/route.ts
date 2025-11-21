import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import ai, { DEFAULT_GEMINI_IMAGE_MODEL } from '@/lib/gemini'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

type InlinePart = { text?: string; inlineData?: { data?: string; mimeType?: string } }

type TransformRequest = {
  clipId?: string
  frameName?: string
  prompt?: string
  previousTransformedName?: string | null
}

function buildPrompt(prompt: string, hasPrevious: boolean) {
  const lines = [
    'You are nano banana, stylizing a video one frame at a time.',
    'Keep framing identical to the source frame. Avoid camera moves, cropping, or aspect changes.',
    hasPrevious
      ? 'Use the previous stylized frame as the state to carry forward. Maintain characters, palette, lighting, and brush style while adapting layout to match the new source frame.'
      : 'This is the first frame. Apply the style cleanly while keeping layout and proportions identical.',
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
      userParts.push({ text: 'Previous stylized frame (state to carry forward):' })
      userParts.push({ inlineData: { data: await readBase64(prevPath), mimeType: 'image/png' } })
    }

    userParts.push({ text: 'Next source frame to adapt:' })
    userParts.push({ inlineData: { data: await readBase64(sourcePath), mimeType: 'image/png' } })

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL,
      contents: [{ role: 'user', parts: userParts }],
      config: { responseModalities: ['IMAGE'], temperature: 0.8 },
    })

    const candidate = response.response?.candidates?.[0]
    const parts = (candidate?.content?.parts || []) as InlinePart[]
    const imagePart = parts.find((p) => p.inlineData?.data)?.inlineData

    if (!imagePart?.data) {
      const blockReason =
        response.response?.promptFeedback?.blockReason || candidate?.finishReason || 'UNKNOWN'
      return NextResponse.json(
        { error: `Model did not return an image. Reason: ${blockReason}` },
        { status: 502 }
      )
    }

    const buffer = Buffer.from(imagePart.data, 'base64')
    await fs.writeFile(targetPath, buffer)

    return NextResponse.json({
      transformedUrl: `/runs/${clipId}/transformed/${frameName}`,
    })
  } catch (error) {
    console.error('Transform failed:', error)
    return NextResponse.json({ error: 'Failed to transform frame' }, { status: 500 })
  }
}
