import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchWithTempHome } from './helpers'

// Spec 068: the project picker's search box and scope badge, on a real app.
// The rule that matters most: a project whose scope cannot be read says
// "Scope unknown", never "Scope not set".
test('picker: search box at six projects, scope badges by project, Enter opens the one match', async () => {
  test.setTimeout(90_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    const projects = await page.evaluate(async () => {
      const made = []
      for (const name of ['Scoped Lab', 'File Only Lab', 'Broken Lab', 'Bare Lab', 'Filler 1', 'Filler 2']) {
        const p = await window.redlog.project.create(name)
        made.push({ id: p.id, name: p.name, path: p.path })
        await window.redlog.project.close()
      }
      return made
    })
    const dir = (name: string) => projects.find(p => p.name === name)!.path
    fs.writeFileSync(path.join(dir('Scoped Lab'), 'config.yaml'), 'scope:\n  targets:\n    - 10.0.0.0/24\n    - app.example.com\n    - api.example.com\n')
    const scopeFile = path.join(tmpHome, 'scope.txt')
    fs.writeFileSync(scopeFile, '# declared only in the file\n10.1.0.1\n10.1.0.2\n')
    fs.writeFileSync(path.join(dir('File Only Lab'), 'config.yaml'), `scope:\n  scopeFile: ${JSON.stringify(scopeFile)}\n`)
    fs.writeFileSync(path.join(dir('Broken Lab'), 'config.yaml'), 'scope: [unterminated\n  targets: {')
    fs.rmSync(path.join(dir('Bare Lab'), 'config.yaml'), { force: true })

    const lastOpenedBefore = await page.evaluate(async () => Object.fromEntries((await window.redlog.project.list()).map(p => [p.id, p.lastOpened])))
    await page.reload()
    const rowOf = (name: string) => page.getByRole('button', { name, exact: true }).locator('xpath=ancestor::div[1]')
    const badge = (name: string) => rowOf(name).getByTestId('project-scope-badge')

    // six projects: the search box is there
    await expect(page.getByRole('searchbox', { name: 'Search projects' })).toBeVisible()

    await expect(badge('Scoped Lab')).toHaveText('3 targets')
    await expect(badge('File Only Lab')).toHaveText('2 targets')
    await expect(badge('Broken Lab')).toHaveText('Scope unknown')
    await expect(badge('Bare Lab')).toHaveText('Scope not set')


    // the picker only reads: showing the badges did not bump any lastOpened
    const lastOpenedAfter = await page.evaluate(async () => Object.fromEntries((await window.redlog.project.list()).map(p => [p.id, p.lastOpened])))
    expect(lastOpenedAfter).toEqual(lastOpenedBefore)

    // filtering to one project keeps its own badge, and Enter opens exactly that one
    const search = page.getByRole('searchbox', { name: 'Search projects' })
    await search.fill('broken')
    await expect(page.getByRole('button', { name: 'Scoped Lab', exact: true })).toHaveCount(0)
    await expect(badge('Broken Lab')).toHaveText('Scope unknown')
    await search.press('Enter')
    await expect(page.getByTestId('view-root')).toHaveAttribute('data-view', 'dashboard')
    const active = await page.evaluate(() => window.redlog.project.active())
    expect(active?.id).toBe(projects.find(p => p.name === 'Broken Lab')!.id)
  } finally {
    await app.close()
  }
})
