// Installs this folder as the Code Explainer that Orca runs, replacing the installed copy. It
// builds, copies the plugin's files without node_modules (Orca refuses its symlinks), shows the
// access Orca asks for, and approves only after you say yes. Usage: npm run reinstall [-- --yes]
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const root = import.meta.dirname
// Why one fixed folder: Orca remembers where a plugin came from and flags a new source each time.
const copy = join(tmpdir(), 'code-explainer-install')
const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8'))

function orca(args) {
  const run = spawnSync('orca', args, { encoding: 'utf8' })
  if (run.error) {
    throw new Error(`could not run the orca CLI: ${run.error.message}`)
  }
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() }
}

async function confirm(question) {
  if (process.argv.includes('--yes')) {
    return true
  }
  if (!process.stdin.isTTY) {
    throw new Error('Run this in a terminal to answer the question, or pass --yes.')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(question)
  prompt.close()
  return /^y(es)?$/i.test(answer.trim())
}

async function main() {
  execFileSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' })

  // The plugin's files: what git tracks, plus new files .gitignore lets through.
  rmSync(copy, { recursive: true, force: true })
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8'
  })
  for (const file of files.split('\0').filter(Boolean)) {
    // Deleted but not yet staged files are still listed.
    if (existsSync(join(root, file))) {
      mkdirSync(dirname(join(copy, file)), { recursive: true })
      cpSync(join(root, file), join(copy, file))
    }
  }

  const asked = orca(['plugin', 'install', copy])
  if (asked.status === 0) {
    console.log(asked.output)
    return
  }
  const fingerprint = /^Fingerprint: (\S+)$/m.exec(asked.output)?.[1]
  if (asked.status !== 3 || !fingerprint) {
    throw new Error(asked.output)
  }
  console.log(`\n${asked.output.slice(0, asked.output.indexOf('Fingerprint:')).trim()}\n`)
  if (!(await confirm(`Install ${manifest.name} ${manifest.version} with this access? [y/N] `))) {
    console.log('Nothing installed.')
    return
  }

  // A dev copy of the same plugin runs instead of the installed one.
  const listed = JSON.parse(orca(['plugin', 'list', '--json']).output)
  const dev = listed.result?.plugins?.find(
    (plugin) => plugin.isDev && plugin.pluginKey.endsWith(`.${manifest.id}`)
  )
  if (dev) {
    console.log(orca(['plugin', 'dev', 'unload', dev.pluginKey]).output)
  }

  const installed = orca(['plugin', 'install', copy, '--approve', fingerprint])
  if (installed.status !== 0) {
    throw new Error(installed.output)
  }
  console.log(installed.output.split('\n')[0])
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(copy, { recursive: true, force: true })
}
