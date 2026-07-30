import fs from 'fs'
import path from 'path'
import os from 'os'

export interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  lastOpened: number
  path: string
}

interface ProjectsIndex {
  recent: ProjectMeta[]
}

const PROJECTS_DIR = path.join(os.homedir(), '.redlog', 'projects')
const INDEX_PATH = path.join(os.homedir(), '.redlog', 'projects.json')

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadIndex(): ProjectsIndex {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'))
  } catch {
    return { recent: [] }
  }
}

function saveIndex(index: ProjectsIndex): void {
  ensureDir(path.dirname(INDEX_PATH))
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8')
}

export function listProjects(): ProjectMeta[] {
  const index = loadIndex()
  return index.recent
    .filter((p) => fs.existsSync(p.path))
    .sort((a, b) => b.lastOpened - a.lastOpened)
}

export function createProject(name: string): ProjectMeta {
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${Date.now().toString(36)}`
  const projectPath = path.join(PROJECTS_DIR, id)

  ensureDir(projectPath)
  ensureDir(path.join(projectPath, 'screenshots'))

  const meta: ProjectMeta = {
    id,
    name,
    createdAt: Date.now(),
    lastOpened: Date.now(),
    path: projectPath
  }

  const index = loadIndex()
  index.recent.unshift(meta)
  saveIndex(index)

  return meta
}

export function openProject(id: string): ProjectMeta | null {
  const index = loadIndex()
  const project = index.recent.find((p) => p.id === id)
  if (!project || !fs.existsSync(project.path)) return null

  project.lastOpened = Date.now()
  index.recent = [project, ...index.recent.filter((p) => p.id !== id)]
  saveIndex(index)

  return project
}

// Rename display name only. The project ID + on-disk path stay stable so
// existing hashes, evidence bundles, and cli references keep working — the
// name change is UI-visible metadata, not a schema change.
export function renameProject(id: string, name: string): ProjectMeta | null {
  const clean = name.trim().slice(0, 120)
  if (!clean) return null
  const index = loadIndex()
  const project = index.recent.find((p) => p.id === id)
  if (!project) return null
  project.name = clean
  saveIndex(index)
  return project
}

export function deleteProject(id: string): boolean {
  const index = loadIndex()
  const project = index.recent.find((p) => p.id === id)
  if (!project) return false

  index.recent = index.recent.filter((p) => p.id !== id)
  saveIndex(index)

  if (fs.existsSync(project.path)) {
    fs.rmSync(project.path, { recursive: true, force: true })
  }
  return true
}

export function getProjectDir(project: ProjectMeta): string {
  ensureDir(project.path)
  ensureDir(path.join(project.path, 'screenshots'))
  return project.path
}
