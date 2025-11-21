import { GoogleGenAI } from '@google/genai'

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3-pro-image-preview'

const apiKey = process.env.GEMINI_API_KEY || ''

const ai = new GoogleGenAI({ apiKey })

export default ai
