#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const profile = join(process.env.DSH_HOME, 'profiles/web')

/**
 * Whether this profile carries an installed copy of the plugin.
 *
 * The plugin declares no cordis.patch.yml entry, so the installed package is
 * what "installed" means — which is also what the real dsh reports.
 */
function installed() {
  const manifest = join(profile, 'node_modules/dsh-llm-chatgpt/package.json')
  return existsSync(manifest)
}

if (args.includes('--version')) console.log('0.2.0-rc.2')
else if (args.includes('--dump-config')) console.log(installed() ? 'name: dsh-llm-chatgpt' : 'name: prior-plugin')
else if (args.includes('--dump-config-schema')) {
  const entries = [{ path: '/0', id: 'prior-plugin', name: 'prior-plugin', status: 'partial' }]
  const diagnostics = [{ path: '/0', level: 'warning', message: 'Existing projection limitation' }]
  // Only a failed import produces an entry under the plugin's id; a healthy
  // install declares no schema at all.
  if (installed() && process.env.TEST_SCHEMA_PLUGIN_ERROR) {
    entries.push({ path: '/1', id: 'llm-chatgpt', name: 'dsh-llm-chatgpt', status: 'error' })
    diagnostics.push({ path: '/1', level: 'error', message: 'Plugin import failed' })
  }
  console.log(JSON.stringify({ 'x-cordis': { complete: false, entries, diagnostics } }))
  process.exitCode = 1
} else if (args.includes('plugin')) {
  // Model the one effect this installer depends on: the profile ends up with
  // the version carried by the tarball it asked to add.
  const version = /dsh-llm-chatgpt-(\d+\.\d+\.\d+)\.tgz$/.exec(args.at(-1) ?? '')?.[1]
  if (version === undefined) { console.error('Unexpected package operation'); process.exitCode = 2 }
  else writeFileSync(join(profile, 'node_modules/dsh-llm-chatgpt/package.json'), JSON.stringify({ version }))
} else { console.error('Unexpected package operation'); process.exitCode = 2 }
