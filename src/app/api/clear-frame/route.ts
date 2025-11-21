import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { clipId, frameName } = body || {}
    if (!clipId || !frameName) {
      return NextResponse.json({ error: 'clipId and frameName are required' }, { status: 400 })
    }
    const baseDir = path.join(process.cwd(), 'public', 'runs', clipId)
    const transformedPath = path.join(baseDir, 'transformed', frameName)
    if (existsSync(transformedPath)) {
      await fs.rm(transformedPath, { force: true })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Clear frame failed:', error)
    return NextResponse.json({ error: 'Failed to clear frame' }, { status: 500 })
  }
}
