import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// project-manager computes PROJECTS_DIR and INDEX_PATH from os.homedir() at
// import time. We must set tmpHome BEFORE the module is imported so the
// module-level constants pick up the redirected home. vi.mock is hoisted but
// its factory is lazy — called when 'os' is first required — so the top-level
// assignment below runs before the factory fires.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pm-'))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  }
})

// Import after mock is set up — module-level constants capture tmpHome
const pm = await import('../src/core/project-manager')

describe('project-manager', () => {
  beforeEach(() => {
    // Clean slate between tests: delete the index file and projects dir
    const indexPath = path.join(tmpHome, '.redlog', 'projects.json')
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath)
    const projectsDir = path.join(tmpHome, '.redlog', 'projects')
    if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true, force: true })
  })

  afterAll(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  describe('createProject', () => {
    it('creates a project with the expected structure', () => {
      const project = pm.createProject('Test Engagement')

      expect(project.name).toBe('Test Engagement')
      expect(project.id).toMatch(/^test-engagement-[a-z0-9]+$/)
      expect(project.createdAt).toBeGreaterThan(0)
      expect(project.lastOpened).toBe(project.createdAt)

      // Directory exists on disk
      expect(fs.existsSync(project.path)).toBe(true)
      // Screenshots subdirectory exists
      expect(fs.existsSync(path.join(project.path, 'screenshots'))).toBe(true)
    })

    it('sanitizes the name for the id (special chars, length)', () => {
      const project = pm.createProject('My $uper!! Project -- v2.0')
      // Non-alphanumeric sequences become dashes, truncated to 30 chars
      expect(project.id).toMatch(/^my-uper-project-v2-0/)
      expect(project.id.split('-').slice(0, -1).join('-').length).toBeLessThanOrEqual(30)
    })

    it('persists to the index file', () => {
      pm.createProject('Alpha')
      pm.createProject('Beta')

      const indexPath = path.join(tmpHome, '.redlog', 'projects.json')
      expect(fs.existsSync(indexPath)).toBe(true)

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(index.recent).toHaveLength(2)
    })
  })

  describe('listProjects', () => {
    it('returns an empty list when no projects exist', () => {
      expect(pm.listProjects()).toEqual([])
    })

    it('lists projects sorted by lastOpened (newest first)', () => {
      const a = pm.createProject('Alpha')
      const b = pm.createProject('Beta')
      // Beta was created last, so it should come first
      const list = pm.listProjects()
      expect(list[0].id).toBe(b.id)
      expect(list[1].id).toBe(a.id)
    })

    it('filters out projects whose directory no longer exists', () => {
      const project = pm.createProject('Ephemeral')
      fs.rmSync(project.path, { recursive: true, force: true })

      const list = pm.listProjects()
      expect(list).toHaveLength(0)
    })
  })

  describe('openProject', () => {
    it('bumps lastOpened and moves the project to the front', () => {
      const a = pm.createProject('Alpha')
      const b = pm.createProject('Beta')

      // Beta is at index 0 since it was created last.
      // Open Alpha to promote it.
      const opened = pm.openProject(a.id)
      expect(opened).not.toBeNull()
      expect(opened!.id).toBe(a.id)
      expect(opened!.lastOpened).toBeGreaterThanOrEqual(a.lastOpened)

      const list = pm.listProjects()
      expect(list[0].id).toBe(a.id)
    })

    it('returns null for a non-existent project id', () => {
      expect(pm.openProject('no-such-id')).toBeNull()
    })

    it('returns null when the directory was deleted', () => {
      const project = pm.createProject('Gone')
      fs.rmSync(project.path, { recursive: true, force: true })

      expect(pm.openProject(project.id)).toBeNull()
    })
  })

  describe('renameProject', () => {
    it('changes the display name but keeps the id and path stable', () => {
      const project = pm.createProject('Original')
      const originalPath = project.path
      const originalId = project.id

      const renamed = pm.renameProject(project.id, 'Renamed')

      expect(renamed).not.toBeNull()
      expect(renamed!.name).toBe('Renamed')
      expect(renamed!.id).toBe(originalId)
      expect(renamed!.path).toBe(originalPath)
    })

    it('trims and truncates the name to 120 chars', () => {
      const project = pm.createProject('Short')
      const longName = 'A'.repeat(200)

      const renamed = pm.renameProject(project.id, `  ${longName}  `)
      expect(renamed!.name).toHaveLength(120)
    })

    it('returns null for an empty name (after trim)', () => {
      const project = pm.createProject('Valid')
      expect(pm.renameProject(project.id, '   ')).toBeNull()
    })

    it('returns null for a non-existent project id', () => {
      expect(pm.renameProject('no-such-id', 'Whatever')).toBeNull()
    })
  })

  describe('deleteProject', () => {
    it('removes the project from the index and deletes the directory', () => {
      const project = pm.createProject('Doomed')
      const projPath = project.path
      expect(fs.existsSync(projPath)).toBe(true)

      const result = pm.deleteProject(project.id)
      expect(result).toBe(true)
      expect(fs.existsSync(projPath)).toBe(false)

      const list = pm.listProjects()
      expect(list.find(p => p.id === project.id)).toBeUndefined()
    })

    it('returns false for a non-existent project id', () => {
      expect(pm.deleteProject('no-such-id')).toBe(false)
    })

    it('succeeds even if the directory was already removed', () => {
      const project = pm.createProject('AlreadyGone')
      fs.rmSync(project.path, { recursive: true, force: true })

      const result = pm.deleteProject(project.id)
      expect(result).toBe(true)
    })
  })

  describe('getProjectDir', () => {
    it('ensures the project directory and screenshots subdirectory exist', () => {
      const project = pm.createProject('DirTest')
      // Remove the screenshots dir to verify getProjectDir recreates it
      fs.rmSync(path.join(project.path, 'screenshots'), { recursive: true, force: true })

      const dir = pm.getProjectDir(project)
      expect(dir).toBe(project.path)
      expect(fs.existsSync(path.join(dir, 'screenshots'))).toBe(true)
    })
  })
})
