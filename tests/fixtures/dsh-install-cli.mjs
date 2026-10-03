#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const patch = args.includes('--version') ? '' : readFileSync(join(process.env.DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8')
const active = /id: llm-chatgpt/.test(patch)
if (args.includes('--version')) console.log('0.2.0-rc.2')
else if (args.includes('--dump-config')) console.log(active ? 'name: dsh-llm-chatgpt' : 'name: prior-plugin')
else if (args.includes('--dump-config-schema')) {
  const entries = [{ path: '/0', id: 'prior-plugin', name: 'prior-plugin', status: 'partial' }]
  const diagnostics = [{ path: '/0', level: 'warning', message: 'Existing projection limitation' }]
  if (active) {
    entries.push({ path: '/1', id: 'llm-chatgpt', name: 'dsh-llm-chatgpt', status: process.env.TEST_SCHEMA_PLUGIN_ERROR ? 'error' : 'absent' })
    if (process.env.TEST_SCHEMA_PLUGIN_ERROR) diagnostics.push({ path: '/1', level: 'error', message: 'Plugin import failed' })
  }
  console.log(JSON.stringify({ 'x-cordis': { complete: false, entries, diagnostics } }))
  process.exitCode = 1
} else { console.error('Unexpected package operation'); process.exitCode = 2 }
