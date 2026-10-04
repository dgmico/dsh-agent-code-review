#!/usr/bin/env node
/**
 * Offline validation for the code-review agent preset.
 *
 * Checks, without booting DSH and without touching $DSH_HOME:
 *   1. the patch fragment parses as loader-patch YAML (`!!js` expressions included);
 *   2. it is one top-level `insert` whose rows contain the expected preset declaration;
 *   3. the preset config satisfies `@deepseek-ai/dsh-agent-preset`'s own schema;
 *   4. every child row names an installed package, and its `config` satisfies that
 *      plugin's own `Config` schema;
 *   5. entry ids are unique and entry keys are loader-level keys;
 *   6. every skill referenced through `customSkillDirs` exists with valid frontmatter.
 *
 * Usage: node verify.mjs [path/to/preset-code-review.yml]
 * Exit code 0 = all checks passed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = dirname(realpathSync(new URL(import.meta.url).pathname))
const FRAGMENT = resolve(process.argv[2] ?? join(HERE, 'preset-code-review.yml'))
const SKILLS_DIR = join(HERE, 'skills')

const ENTRY_KEYS = new Set(['id', 'name', 'disabled', 'group', 'isolate', 'intercept', 'inject', 'config'])

const failures = []
const notes = []
const fail = (message) => failures.push(message)
const note = (message) => notes.push(message)

/** Resolve the installed dsh package root from the `dsh` binary on PATH. */
function resolveDshRoot() {
  const bin = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()
  if (bin === '') throw new Error('dsh is not on PATH')
  return dirname(dirname(realpathSync(bin))) // <root>/lib/bin.js -> <root>
}

const DSH_ROOT = resolveDshRoot()
const MODULES = join(DSH_ROOT, 'node_modules')
const requireFromDsh = createRequire(join(DSH_ROOT, 'package.json'))
const yaml = requireFromDsh('js-yaml')

// ── 1. parse the file ───────────────────────────────────────────────────────
// Accepts either the standalone fragment or a whole profile patch: rows come
// from every top-level `insert` list plus the plain entries beside them.

const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: data }),
})
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])

const source = readFileSync(FRAGMENT, 'utf8').replaceAll('__SKILLS_DIR__', SKILLS_DIR)
let document
try {
  document = yaml.load(source, { schema, filename: FRAGMENT })
} catch (error) {
  fail(`${FRAGMENT} is not valid YAML: ${error.message}`)
  report()
}

if (!Array.isArray(document)) fail(`${FRAGMENT} must be a top-level YAML array of patch entries`)

const rows = []
for (const entry of Array.isArray(document) ? document : []) {
  if (entry !== null && typeof entry === 'object' && Array.isArray(entry.insert)) rows.push(...entry.insert)
  else rows.push(entry)
}

// ── 2. locate the preset declaration ────────────────────────────────────────

const presets = rows.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
if (presets.length !== 1) fail(`expected exactly one @deepseek-ai/dsh-agent-preset row, found ${presets.length}`)
const presetRow = presets[0] ?? {}
const preset = presetRow.config ?? {}
const PRESET_ID = 'code-review'
if (preset.id !== PRESET_ID) fail(`preset id must be ${JSON.stringify(PRESET_ID)}, found ${JSON.stringify(preset.id)}`)
for (const field of ['name', 'description']) {
  if (typeof preset[field] !== 'string' || preset[field].trim() === '') fail(`preset ${field} must be a non-empty string`)
  if (preset[field]?.trim()?.endsWith('。')) note(`preset ${field} ends with a full stop; the roster shows it as a label`)
}
if (!Array.isArray(preset.plugins) || preset.plugins.length === 0) fail('preset plugins must be a non-empty list')

// ── 3..5. validate rows against the plugins actually installed ───────────────

/** Resolve `@scope/pkg/subpath` to its package directory and subpath. */
function resolvePackage(name) {
  const parts = name.split('/')
  const packageName = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = name.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
  return { packageName, subpath, dir: join(MODULES, packageName) }
}

async function loadPluginConfigSchema(name) {
  const { packageName, subpath, dir } = resolvePackage(name)
  if (!existsSync(join(dir, 'package.json'))) return { missing: packageName }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  let entry
  const exported = manifest.exports?.[subpath === '' ? '.' : `./${subpath}`]
  if (typeof exported === 'string') entry = exported
  else if (exported && typeof exported === 'object') entry = exported.default ?? exported.import ?? exported.require
  else if (subpath === '') entry = manifest.main ?? 'index.js'
  if (entry === undefined) return { missing: `${packageName}${subpath && `/${subpath}`}` }

  const module = await import(pathToFileURL(join(dir, entry)).href)
  const Plugin = module.default ?? module
  let configSchema = Plugin?.Config
  if (typeof configSchema === 'function' && configSchema.length === 0) {
    try {
      const built = configSchema()
      if (built && typeof built === 'function') configSchema = built
    } catch {
      /* a Coercion-free Config stays the schema itself */
    }
  }
  return { packageName, Plugin, configSchema }
}

const seenIds = new Set()
const checkedPackages = new Set()

async function validateRows(list, trail) {
  for (const row of list) {
    const where = `${trail}/${row?.id ?? row?.name ?? '?'}`
    if (row === null || typeof row !== 'object') {
      fail(`${where}: entry must be a mapping`)
      continue
    }
    for (const key of Object.keys(row)) if (!ENTRY_KEYS.has(key)) fail(`${where}: unknown entry key ${JSON.stringify(key)}`)
    if (typeof row.id === 'string') {
      if (seenIds.has(row.id)) fail(`${where}: duplicate entry id ${JSON.stringify(row.id)}`)
      seenIds.add(row.id)
    }
    if (typeof row.name !== 'string' || row.name === '') {
      fail(`${where}: entry needs a plugin name`)
      continue
    }

    const placeholder = Object.values(row.config ?? {}).some((value) => value?.__js !== undefined)
    if (row.name === 'cordis:group') {
      if (!Array.isArray(row.config)) fail(`${where}: group entry needs a config list`)
      else await validateRows(row.config, where)
      continue
    }

    const resolved = await loadPluginConfigSchema(row.name)
    if (resolved.missing !== undefined) {
      fail(`${where}: plugin ${JSON.stringify(resolved.missing)} is not installed under ${MODULES}`)
      continue
    }
    checkedPackages.add(resolved.packageName)

    if (row.config === undefined) continue
    if (placeholder) {
      note(`${where}: config holds a !!js expression; schema check skipped`)
      continue
    }
    if (typeof resolved.configSchema !== 'function') {
      note(`${where}: ${resolved.packageName} exports no Config schema; shape not checked`)
      continue
    }
    try {
      resolved.configSchema(row.config)
    } catch (error) {
      fail(`${where}: config rejected by ${resolved.packageName} Config: ${error.message}`)
      continue
    }
    const known = resolved.configSchema.dict
    if (known !== null && typeof known === 'object') {
      for (const key of Object.keys(row.config)) {
        // The loader keeps unknown keys silently; a typo is still worth failing on here.
        if (!(key in known)) fail(`${where}: config key ${JSON.stringify(key)} is not declared by ${resolved.packageName}`)
      }
    }
  }
}

// A standalone fragment holds only this patch entry; a whole profile patch also
// holds app-managed id-targeted override rows, which are not ours to validate.
const standalone = document.length === 1 && Array.isArray(document[0]?.insert)
if (standalone) await validateRows(rows, 'insert')
else await validateRows([presetRow], 'patch')
await validateRows(preset.plugins ?? [], `preset:${PRESET_ID}`)

const presetModule = await import(
  pathToFileURL(join(MODULES, '@deepseek-ai/dsh-agent-preset', 'lib', 'index.js')).href
)
try {
  const presetSchema = presetModule.default.Config
  presetSchema(preset)
  const known = presetSchema.dict
  for (const key of Object.keys(preset)) {
    if (known !== null && typeof known === 'object' && !(key in known)) {
      fail(`preset declaration key ${JSON.stringify(key)} is not declared by @deepseek-ai/dsh-agent-preset`)
    }
  }
} catch (error) {
  fail(`preset declaration rejected by @deepseek-ai/dsh-agent-preset Config: ${error.message}`)
}

// ── 6. skills referenced by customSkillDirs ─────────────────────────────────

const skillDirs = []
const walk = (list) => {
  for (const row of list ?? []) {
    if (row?.name === 'cordis:group' && Array.isArray(row.config)) walk(row.config)
    if (Array.isArray(row?.config?.customSkillDirs)) skillDirs.push(...row.config.customSkillDirs)
  }
}
walk(preset.plugins ?? [])

for (const dir of skillDirs) {
  if (!existsSync(dir)) {
    fail(`customSkillDirs entry does not exist: ${dir}`)
    continue
  }
  if (!statSync(dir).isDirectory()) {
    fail(`customSkillDirs entry is not a directory: ${dir}`)
    continue
  }
  const found = []
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, 'SKILL.md')
    if (existsSync(skillFile)) found.push(skillFile)
    else if (entry.endsWith('.md')) found.push(join(dir, entry))
  }
  if (found.length === 0) fail(`no skill found under customSkillDirs entry: ${dir}`)
  for (const file of found) {
    const text = readFileSync(file, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (match === null) {
      fail(`${file}: missing YAML frontmatter`)
      continue
    }
    let frontmatter
    try {
      frontmatter = yaml.load(match[1])
    } catch (error) {
      fail(`${file}: frontmatter is not valid YAML: ${error.message}`)
      continue
    }
    for (const field of ['name', 'description']) {
      if (typeof frontmatter?.[field] !== 'string' || frontmatter[field].trim() === '') {
        fail(`${file}: frontmatter requires a non-empty ${field}`)
      }
    }
  }
}

report()

function report() {
  if (notes.length > 0) {
    console.log('notes:')
    for (const message of notes) console.log(`  - ${message}`)
  }
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`)
    for (const message of failures) console.error(`  - ${message}`)
    process.exit(1)
  }
  console.log(`OK: ${FRAGMENT}${standalone ? ' (fragment)' : ' (profile patch)'}`)
  console.log(`  preset ${PRESET_ID} — ${checkedPackages.size} plugin packages resolved under ${MODULES}`)
  console.log(`  ${seenIds.size} entries checked, ${skillDirs.length} custom skill dir(s) verified`)
}
