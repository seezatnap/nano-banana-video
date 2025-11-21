// Client-only IndexedDB helpers for persisting session state.

type FrameState = {
  name: string
  sourceUrl: string
  transformedUrl?: string
}

export type PersistedState = {
  clipInfo?: {
    clipId: string
    fps: number
    duration: number
    audioUrl: string | null
  } | null
  frames?: FrameState[]
  prompt?: string
  start?: number
  clipLength?: number
  fpsInput?: number
  videoUrl?: string | null
  videoDuration?: number
  statusMessage?: string
  yoyoEnabled?: boolean
  yoyoCount?: number
  overrideMp4Fps?: number | null
}

const DB_NAME = 'nano-banana-video'
const DB_VERSION = 1
const STORE = 'state'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'))
  })
}

export async function saveState(state: PersistedState) {
  if (typeof window === 'undefined') return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(state, 'session')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('Failed to save state'))
    })
  } catch (e) {
    console.warn('Persist state failed:', e)
  }
}

export async function loadState(): Promise<PersistedState | null> {
  if (typeof window === 'undefined') return null
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get('session')
      req.onsuccess = () => resolve((req.result as PersistedState) || null)
      req.onerror = () => reject(req.error || new Error('Failed to load state'))
    })
  } catch (e) {
    console.warn('Load state failed:', e)
    return null
  }
}

export async function clearState() {
  if (typeof window === 'undefined') return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete('session')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('Failed to clear state'))
    })
  } catch (e) {
    console.warn('Clear state failed:', e)
  }
}
