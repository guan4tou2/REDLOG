import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { makeTempHome } from './helpers'

// Smoke test for a PACKAGED build, run against the executable rather than the
// source tree. Everything else in e2e/ launches `out/main`; that cannot see what
// packaging changes — which files land in resources/, whether the native modules
// load, whether the shipped hooks and verifier are the ones the app reaches for.
//
// Skipped unless REDLOG_PACKAGED_APP points at the executable, so CI (which does
// not build one) is unaffected:
//
//   npx electron-builder --win dir --x64 --publish never --config.npmRebuild=false
//   REDLOG_PACKAGED_APP=<...>/dist/win-unpacked/RedLog.exe \
//     npx playwright test e2e/packaged-smoke.spec.ts
//
// Optional: REDLOG_PACKAGED_WSL_DISTRO=<name> also drives the bash hook inside
// that WSL distribution against the same isolated profile.
//
// The profile is isolated (HOME/USERPROFILE and --user-data-dir are a temp dir),
// so nothing here touches the operator's own RedLog or PowerShell profile.
// What this does NOT exercise: the NSIS installer, shortcuts and the uninstaller —
// it runs whatever executable it is given. .github/workflows/windows-install-smoke.yml
// installs the NSIS build on a clean runner, points this spec at the installed
// exe, then uninstalls and checks what is left.

const exe = process.env.REDLOG_PACKAGED_APP
const wslDistro = process.env.REDLOG_PACKAGED_WSL_DISTRO

interface Ev { agentType: string; data: Record<string, unknown> }

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: exe!,
    args: [`--user-data-dir=${join(home, 'userdata')}`],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Carry the isolated profile into a WSL distro, and back out to the
      // Windows processes it starts (cmd.exe), so WSL resolves THIS profile.
      WSLENV: `${process.env.WSLENV ? process.env.WSLENV + ':' : ''}USERPROFILE/p`,
      REDLOG_E2E: '1',
      NODE_ENV: 'test'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const events = (page: Page): Promise<Ev[]> =>
  page.evaluate(async () => (await window.redlog.events.query({ limit: 1000 })) as unknown as Ev[])

const shellEnd = (list: Ev[], command: string): Ev | undefined =>
  list.find((e) => e.agentType === 'shell' && e.data.subtype === 'command_end' && e.data.command === command)

const toWsl = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out }))
  })
}

test.describe('packaged app', () => {
  test.skip(!exe, 'set REDLOG_PACKAGED_APP to a packaged executable to run this')

  test('records, exports, verifies and survives a restart', async () => {
    test.setTimeout(300_000)
    const home = makeTempHome('redlog-pkg-')
    const rl = join(home, '.redlog')
    let { app, page } = await launch(home)
    try {
      await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
      await page.reload()
      await page.waitForSelector('[data-testid="project-picker"]', { timeout: 30_000 })

      await test.step('the API is up before any project is open', async () => {
        const port = readFileSync(join(rl, 'api-port'), 'utf8').trim()
        const token = readFileSync(join(rl, 'api-token'), 'utf8').trim()
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` } })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, projectOpen: false })
      })

      await test.step('create a project', async () => {
        await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('pkg-smoke')
        await page.getByRole('button', { name: 'Create' }).click()
        await page.waitForSelector('[data-testid="view-root"]', { timeout: 30_000 })
      })

      await test.step('the built-in terminal records a command with its exit code and a cast', async () => {
        // Wait for the shell's own prompt: keys typed before it starts are lost.
        await expect(page.locator('.xterm').first()).toContainText(/PS .*>|[$#%] $/, { timeout: 30_000 })
        await page.locator('.xterm').first().click()
        await page.keyboard.type('echo redlog-ok-builtin')
        await page.keyboard.press('Enter')
        await expect.poll(async () => shellEnd(await events(page), 'echo redlog-ok-builtin'), { timeout: 30_000 }).toBeTruthy()
        const end = shellEnd(await events(page), 'echo redlog-ok-builtin')!
        expect(end.data.source).toBe('builtin-terminal')
        expect(end.data.exit_code).toBe(0)
        const cast = (end.data.io as { ref?: string } | undefined)?.ref
        expect(cast, 'command_end should point at its recording').toBeTruthy()
        expect(existsSync(cast!)).toBe(true)
      })

      if (process.platform === 'win32') {
        await test.step('the PowerShell hook installs once, records real exit codes, and uninstalls clean', async () => {
          const install = async (): Promise<void> => {
            const r = await page.evaluate(async () => window.redlog.hooks.install('shell-powershell'))
            expect((r as { success: boolean }).success).toBe(true)
          }
          await install()
          await install()
          const profiles = ['PowerShell', 'WindowsPowerShell'].map((d) => join(home, 'Documents', d, 'Microsoft.PowerShell_profile.ps1'))
          for (const p of profiles.filter(existsSync)) {
            const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => /shell-hook\.ps1/.test(l))
            expect(lines, `${p}: installing twice must leave one source line`).toHaveLength(1)
          }

          // Drive a real interactive Windows PowerShell with the hook the app installed.
          const hook = join(rl, 'shell-hook.ps1')
          expect(existsSync(hook)).toBe(true)
          const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${hook}'`], {
            env: { ...process.env, USERPROFILE: home, HOME: home },
            stdio: ['pipe', 'pipe', 'pipe']
          })
          child.stdout.on('data', () => undefined)
          child.stderr.on('data', () => undefined)
          const closed = new Promise<void>((r) => child.on('close', () => r()))
          for (const c of ['echo pkg-win-canary', 'cmd /c exit 3', 'exit']) {
            child.stdin.write(`${c}\r\n`)
            await new Promise((r) => setTimeout(r, 2000))
          }
          child.stdin.end()
          await closed

          await expect.poll(async () => shellEnd(await events(page), 'cmd /c exit 3'), { timeout: 20_000 }).toBeTruthy()
          const list = await events(page)
          expect(shellEnd(list, 'echo pkg-win-canary')?.data.exit_code).toBe(0)
          // A failing command must not be recorded as success. The shipped hook
          // once read $LASTEXITCODE before $? and recorded 0 for everything.
          expect(shellEnd(list, 'cmd /c exit 3')?.data.exit_code).toBe(3)

          const un = await page.evaluate(async () => window.redlog.hooks.uninstall('shell-powershell'))
          expect((un as { success: boolean }).success).toBe(true)
          for (const p of profiles.filter(existsSync)) {
            expect(readFileSync(p, 'utf8')).not.toMatch(/shell-hook\.ps1/)
          }
        })
      }

      if (process.platform === 'win32' && wslDistro) {
        await test.step(`the bash hook inside WSL (${wslDistro}) reaches this profile`, async () => {
          const hook = join(dirname(exe!), 'resources', 'hooks', 'shell-bash-hook.sh')
          expect(existsSync(hook), 'the packaged hook').toBe(true)
          const script = join(home, 'wsl-hook-run.sh')
          // A scratch HOME so the distro's own ~/.redlog (which the hook prefers
          // when it exists) cannot shadow the Windows profile; the first lookup
          // runs cmd.exe, which would swallow a piped script, so do it with
          // stdin closed. Refuses to send anything unless WSL sees THIS profile.
          writeFileSync(script, [
            '#!/usr/bin/env bash',
            'hook="$1"; expected="$2"',
            `seen=$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\\r'); seen=$(wslpath "$seen" 2>/dev/null)`,
            '[ "$seen" = "$expected" ] || { echo "ABORT: WSL sees $seen, expected $expected"; exit 9; }',
            'export HOME=$(mktemp -d); rc="$HOME/rc"',
            'printf \'source "%s"\\n_redlog_is_running </dev/null\\n\' "$hook" > "$rc"',
            "printf 'echo wsl-canary\\nls /nonexistent-path-zz\\nexit\\n' | bash --rcfile \"$rc\" -i >/dev/null 2>&1",
            'rm -rf "$HOME"',
            ''
          ].join('\n'), { mode: 0o755 })
          const r = await run('wsl.exe', ['-d', wslDistro, '--', 'bash', toWsl(script), toWsl(hook), toWsl(home)], {
            ...process.env, USERPROFILE: home, HOME: home,
            WSLENV: `${process.env.WSLENV ? process.env.WSLENV + ':' : ''}USERPROFILE/p`
          })
          expect(r.code, r.out).toBe(0)
          await expect.poll(async () => shellEnd(await events(page), 'ls /nonexistent-path-zz'), { timeout: 20_000 }).toBeTruthy()
          const list = await events(page)
          expect(shellEnd(list, 'echo wsl-canary')?.data.exit_code).toBe(0)
          expect(shellEnd(list, 'ls /nonexistent-path-zz')?.data.exit_code).toBe(2)
        })
      }

      await test.step('an evidence bundle exports and its bundled verifier passes', async () => {
        const plan = await page.evaluate(async () => window.redlog.data.resolveExportPlan({ format: 'bundle', subset: { kind: 'all' } })) as { ok: boolean; plan?: { id: string } }
        expect(plan.ok).toBe(true)
        const done = await page.evaluate(async (id) => window.redlog.data.executeExportPlan({ planId: id }), plan.plan!.id) as { ok: boolean; artifactPath?: string }
        expect(done.ok).toBe(true)
        const dir = done.artifactPath!
        expect(readdirSync(dir)).toEqual(expect.arrayContaining(['manifest.json', 'events.jsonl', 'redlog-verify.py', 'verify.cmd', 'verify.sh']))

        // The verifier is Python. A machine without it cannot verify, which is
        // worth knowing but is not this build's fault.
        const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0)
        if (!py) {
          test.info().annotations.push({ type: 'not-exercised', description: 'no python on PATH — the bundled verifier was not run' })
          return
        }
        const v = spawnSync(py, [join(dir, 'redlog-verify.py'), dir], { encoding: 'utf8' })
        expect(v.status, v.stdout + v.stderr).toBe(0)
        expect(v.stdout).toMatch(/Chain\s*:\s*INTACT/)
      })

      // HTTP capture goes through mitmdump, which is looked up on PATH rather than
      // shipped. Without it the card says so (that is its own state, not a failure
      // of this build), so the step is left out and annotated.
      //
      // It runs AFTER the export on purpose. The request goes to a loopback
      // server, loopback is a "personal" domain, and a bundle exported after one
      // fails its own verifier (#329): the personal row is dropped from the chain.
      // Putting this first would make the export step report that known problem
      // instead of what it is here to check.
      const mitmdump = spawnSync('mitmdump', ['--version'], { stdio: 'ignore' }).status === 0
      if (!mitmdump) {
        test.info().annotations.push({ type: 'not-exercised', description: 'no mitmdump on PATH — HTTP capture was not exercised' })
      } else {
        await test.step('HTTP through the managed proxy is recorded, and the card verifies HTTP and HTTPS', async () => {
          const started = (await events(page)).find((e) => e.data.subtype === 'http_proxy_started')
          expect(started, 'the managed proxy should announce itself').toBeTruthy()
          const proxy = new URL(String(started!.data.proxy))

          // A local server, so no traffic leaves the machine.
          const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('pkg-http-canary-body') })
          await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
          const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/pkg-canary?x=1`
          try {
            const status = await new Promise<number>((resolve, reject) => {
              const req = http.request({ host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: target, headers: { Host: new URL(target).host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
              req.on('error', reject)
              req.end()
            })
            expect(status).toBe(200)
          } finally {
            server.close()
          }
          await expect.poll(async () => (await events(page)).some((e) => e.data.subtype === 'http_response' && e.data.url === target), { timeout: 20_000 }).toBe(true)
          const flow = (await events(page)).filter((e) => e.data.url === target)
          expect(flow.map((e) => e.data.subtype).sort()).toEqual(expect.arrayContaining(['http_request_start', 'http_response']))
          expect(new Set(flow.filter((e) => e.data.flow_id).map((e) => e.data.flow_id)).size, 'request and response belong to one flow').toBe(1)

          // A recorded request is not the card's proof: it wants a request for
          // its own nonce on a reserved host (#220), and offers the curl commands
          // only after its 60 s window. Run them as given. HTTPS additionally
          // gets this profile's CA by --cacert — trusting it system-wide would
          // change the machine, and the CA is what the proxy is minting with.
          const box = page.getByTestId('first-run-http-verify-commands')
          await box.waitFor({ timeout: 100_000 })
          const commands = [...(await box.innerText()).matchAll(/curl(?:\.exe)? -sS[^\n]*? (https?:\/\/redlog\.verify\.invalid\/\S+)/g)].map((m) => m[0])
          expect(commands.map((c) => c.includes('https://'))).toEqual([false, true])
          const ca = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem')
          expect(existsSync(ca), 'the proxy mints with a CA under this profile').toBe(true)
          for (const command of commands) {
            const [exe0, ...rest] = command.split(' ')
            const args = [...rest, ...(command.includes('https://') ? ['--cacert', ca] : []), '-m', '15', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}']
            const r = await run(exe0, args, { ...process.env, HOME: home, USERPROFILE: home })
            expect(r.out, command).toMatch(/200$/)
          }
          await expect.poll(async () => ((await page.locator('body').innerText()).match(/verified via/g) ?? []).length, { timeout: 20_000 }).toBe(2)
        })
      }

      await app.close()

      await test.step('after a restart the project, events and recording are still there and searchable', async () => {
        ;({ app, page } = await launch(home))
        // A window that has not produced an animation frame never lets Playwright's
        // click settle as "stable"; one reload gets it painting (as in
        // profile-import.spec.ts).
        await page.reload()
        await page.waitForLoadState('domcontentloaded')
        await page.waitForSelector('[data-testid="project-picker"], [data-testid="view-root"]', { timeout: 30_000 })
        if (await page.getByTestId('project-picker').count()) {
          await page.getByText('pkg-smoke').first().click()
          await page.waitForSelector('[data-testid="view-root"]', { timeout: 30_000 })
        }
        await expect.poll(async () => shellEnd(await events(page), 'echo redlog-ok-builtin'), { timeout: 20_000 }).toBeTruthy()
        // A live recording is not indexed until it closes; the backfill on
        // project open picks it up.
        await expect.poll(async () => (await page.evaluate(async () => window.redlog.events.castIndexStatus())).pending, { timeout: 30_000 }).toBe(0)
        const hits = await page.evaluate(async () => window.redlog.events.searchCasts('redlog-ok-builtin', 10))
        expect(hits.length).toBeGreaterThan(0)
      })
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
