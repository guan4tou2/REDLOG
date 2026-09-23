#!/usr/bin/env node
// Architecture gate (Spec 030): every export in src/ must be reachable from
// production code.
//
// Two findings, both failures:
//
//   unused     — exported, and referenced nowhere: not by another src file,
//                not inside its own file, not by a test.
//   test-only  — referenced by tests, but by no production code. The tests
//                pass while proving nothing about what ships; the usual cause
//                is production growing its own copy of the logic (Spec 030
//                found three).
//
// A name starting with `_` is a declared test seam (`_resetForTest`) and may be
// test-only. Anything else that must stay test-only goes in
// scripts/architecture-allowlist.json with a reason; an allowlist entry that no
// longer matches a finding fails too, so the list only shrinks.
//
// References are counted by identifier name across the AST of every file. A
// name shared by two unrelated symbols can hide a finding (a miss), but can
// never invent one, so the gate does not flake. Canonical-module rules (one
// scope classifier, one secret table, one ingest door) are guarded by their own
// tests, not here.

import ts from 'typescript'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (f) => path.relative(root, f).split(path.sep).join('/')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const srcFiles = walk(path.join(root, 'src'))
const testFiles = [...walk(path.join(root, 'test')), ...walk(path.join(root, 'e2e'))]

const parsed = new Map()
for (const f of [...srcFiles, ...testFiles]) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true,
    f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const names = new Map()
  const visit = (n) => {
    if (ts.isIdentifier(n)) names.set(n.text, (names.get(n.text) ?? 0) + 1)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  parsed.set(f, { sf, names })
}

function exportedDeclarations(sf) {
  const out = []
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
  for (const s of sf.statements) {
    const mods = ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, line: line(d) })
    } else if (s.name && ts.isIdentifier(s.name)) {
      out.push({ name: s.name.text, line: line(s) })
    }
  }
  return out
}

const findings = []
for (const f of srcFiles) {
  const { sf, names } = parsed.get(f)
  const decls = exportedDeclarations(sf)
  for (const { name, line } of decls) {
    const ownUses = (names.get(name) ?? 0) - decls.filter((d) => d.name === name).length
    if (ownUses > 0) continue
    if (srcFiles.some((g) => g !== f && parsed.get(g).names.has(name))) continue
    const inTests = testFiles.some((g) => parsed.get(g).names.has(name))
    if (inTests && name.startsWith('_')) continue
    findings.push({ key: `${rel(f)}#${name}`, line, kind: inTests ? 'test-only' : 'unused' })
  }
}

const allowPath = path.join(root, 'scripts', 'architecture-allowlist.json')
const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf8')) : {}
const problems = []
for (const f of findings) {
  if (allow[f.key]) continue
  const [file, name] = f.key.split('#')
  problems.push(f.kind === 'unused'
    ? `${file}:${f.line} ${name} is exported and never referenced — remove it`
    : `${file}:${f.line} ${name} is used only by tests — production never calls it (use it, remove it, or rename it _${name} if it is a test seam)`)
}
const found = new Set(findings.map((f) => f.key))
for (const key of Object.keys(allow)) {
  if (!found.has(key)) problems.push(`scripts/architecture-allowlist.json: "${key}" no longer matches a finding — remove the entry`)
}

if (problems.length) {
  console.error(`Architecture gate failed (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`Architecture gate passed: ${srcFiles.length} source files, every export reachable from production${Object.keys(allow).length ? ` (${Object.keys(allow).length} allowlisted)` : ''}.`)
