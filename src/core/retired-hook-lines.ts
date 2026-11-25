// #879: the block an earlier RedLog left in `~/.bashrc` that nothing here
// could see any more.
//
// Until 2026-09-22 the bash install copied its hook to
// `~/.redlog/shell-preexec-hook.sh` and appended
//
//     # RedLog shell hook
//     source <home>/.redlog/shell-preexec-hook.sh
//
// to `~/.bashrc`. The file left the product and the block stayed, so the shell
// has printed "No such file or directory" at every start since and recorded
// nothing. Install, removal and Settings each matched the current filename
// only, so none of them could name the line or take it out.
//
// This recognises that block and removes it. It does not load the old file,
// migrate it, or keep it working: RedLog is pre-1.0. zsh and PowerShell left
// nothing of the kind behind — their installed names (`shell-hook.zsh`,
// `shell-hook.ps1`) never changed, and the copy under them is refreshed at
// launch.
//
// Only a line under RedLog's marker comment counts, the same rule
// `rcWithoutHook` keeps for the current hook: a bare `source` of that file is
// something the operator wrote, possibly inside an `if` or a function, and
// taking one line out of those leaves a syntax error in their rc.
//
// Pure, and apart from the file I/O in hooks-manager, so both halves can be
// tested on any platform. scripts/verify-specs.mjs lets this file alone name
// the retired entry point.

const RETIRED_HOOK_FILE = 'shell-preexec-hook.sh'
const HOOK_MARKER = '# RedLog shell hook'

/** The file a `source X` line loads, when the line does nothing else. The
 *  path may have been rewritten by hand since (Git Bash needs `/c/Users/…`),
 *  so any spelling of it counts; a line that goes on after it does not. */
function sourcedPath(line: string): string | null {
  const m = /^source[ \t]+(?:"([^"]+)"|'([^']+)'|(\S+))[ \t]*$/.exec(line)
  return m ? m[1] ?? m[2] ?? m[3] : null
}

/** Each line with its own terminator, so what is kept is kept byte for byte. */
const splitLines = (content: string): string[] => content.split(/(?<=\n)/)
const bare = (line: string): string => line.replace(/\r?\n$/, '')

/** Indexes of the `source` lines of retired blocks: marker above, retired file named. */
function retiredSourceLines(lines: string[]): number[] {
  return lines.flatMap((line, i) =>
    i > 0 && bare(lines[i - 1]) === HOOK_MARKER
      && sourcedPath(bare(line))?.split(/[\\/]/).pop() === RETIRED_HOOK_FILE ? [i] : [])
}

/** 1-based numbers of the lines in `content` that load the retired hook. */
export function retiredHookLineNumbers(content: string): number[] {
  if (!content.includes(RETIRED_HOOK_FILE)) return []
  return retiredSourceLines(splitLines(content)).map((i) => i + 1)
}

/** `content` without those blocks: the line, the marker above it, and the
 *  blank line the block opened with, which leaves the file as it was before
 *  that install. */
export function rcWithoutRetiredHooks(content: string): string {
  if (!content.includes(RETIRED_HOOK_FILE)) return content
  const lines = splitLines(content)
  const drop = new Set<number>()
  for (const i of retiredSourceLines(lines)) {
    drop.add(i).add(i - 1)
    if (i > 1 && bare(lines[i - 2]) === '') drop.add(i - 2)
  }
  return drop.size === 0 ? content : lines.filter((_, i) => !drop.has(i)).join('')
}
