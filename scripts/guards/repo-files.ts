// The files the guard tests read: everything git tracks plus new files it doesn't ignore. So
// node_modules/, build output and local-data/ are never read: local-data/ holds people's data,
// which coding agents and CI never open (CLAUDE.md, Security and privacy).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

export function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // A tracked file deleted in the working tree is still listed, so keep only files that exist.
  return out.split('\0').filter(path => path && !/(^|\/)local-data\//.test(path) && existsSync(join(root, path)))
}

export const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8')

// JavaScript and TypeScript sources and configs, wherever they are.
export const isScript = (path: string) => /\.[cm]?[jt]sx?$/.test(path)
