import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const APP_ID = '6779264784'
const VERSION = '1.10.0'
const ORIGIN = 'https://api.appstoreconnect.apple.com'
const COPY_DIR = new URL('./asc-ios-1-10-0-copy/', import.meta.url)
const LIMIT = 4000

export const COPYRIGHT = '© 2026 有種實驗室'
export const LOCALES = Object.freeze(['zh-Hant', 'en-US', 'zh-Hans', 'ja'])

const COPY = {
  description: {
    'zh-Hant': [918, '18cdb4137f8d272764ae40a0e04554d1138f1147b1a7d6e78257fd41b73aafea', '有種實驗室 出品'],
    'en-US': [2768, 'f0af4e6497f9537c8e2f88ebbcc5e9db9bf6d61bc7d825f155180050faaeb4f3', 'Made by Kind of Lab'],
    'zh-Hans': [922, 'c239fd2bf85aa05f64dc8ba5eb16e6bd8c6274fe389fd93703f3cfd1637f187a', '有种实验室 出品'],
    ja: [1271, 'c91a00bba6797e7f9896e8d08031097947a2f7e7a9034e735682108538f31be6', '開発・提供：Kind of Lab'],
  },
  whatsNew: {
    'zh-Hant': [335, 'e8e2f933e7d2bf22af87ac4d8876505783b08aecece5c6131ae95527964c9fec'],
    'en-US': [941, '58861220295ea21aae1d4b75784039c39fc4f66ed2926288abef98454228c1c6'],
    'zh-Hans': [348, 'be7a10ee4eabe8ec2440f6a8aa9f284320c9f109b961d7be96d41ca4bf4494e3'],
    ja: [517, 'd58cdc8b23c8810365273adf45c47f9114a2c92a8241c774a6e9aa932634ff9e'],
  },
}

const count = (value) => [...value].length
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const filename = (field, locale) => `${field.toLowerCase()}.${locale}.txt`

class ScriptError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function checkCopy() {
  const fields = Object.keys(COPY)
  const expectedFiles = fields.flatMap((field) => LOCALES.map((locale) => filename(field, locale)))
  const actualFiles = readdirSync(COPY_DIR).filter((file) => /^(description|whatsnew)\./.test(file))
  if (actualFiles.sort().join('\n') !== expectedFiles.sort().join('\n')) {
    throw new ScriptError(3, '文案檔案的語系組合不符。')
  }

  return Object.fromEntries(LOCALES.map((locale) => {
    const attributes = Object.fromEntries(fields.map((field) => {
      const file = filename(field, locale)
      const bytes = readFileSync(new URL(file, COPY_DIR))
      const value = bytes.toString('utf8')
      const [length, hash, credit] = COPY[field][locale]
      if (count(value) !== length || length > LIMIT || sha256(bytes) !== hash ||
          value !== value.trim() || value.includes('\r') ||
          (credit && !value.endsWith(`\n\n${credit}`))) {
        throw new ScriptError(3, `文案檢查失敗：${file}`)
      }
      return [field, value]
    }))
    return [locale, attributes]
  }))
}

function env() {
  const raw = readFileSync('/Volumes/Futari Secrets/env/.env', 'utf8')
  return Object.fromEntries(raw.split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
    }))
}

function signJwt() {
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer, ASC_KEY_PATH: configuredPath } = env()
  if (!keyId || !issuer) throw new Error()
  const keyPath = configuredPath?.replace(/^~(?=\/)/, process.env.HOME ?? '')
  const signingPath = keyPath && existsSync(keyPath)
    ? keyPath
    : `${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const header = encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })
  const claims = encode({ iss: issuer, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })
  const input = `${header}.${claims}`
  const der = execFileSync('openssl', ['dgst', '-sha256', '-sign', signingPath], {
    input, stdio: ['pipe', 'pipe', 'ignore'],
  })

  // A P-256 DER signature contains two short-form INTEGERs. JWT needs two 32-byte values.
  let offset = 2
  const readInteger = () => {
    const length = der[offset + 1]
    const bytes = der.subarray(offset + 2, offset + 2 + length)
    offset += 2 + length
    const value = bytes.subarray(Math.max(0, bytes.length - 32))
    return Buffer.concat([Buffer.alloc(32 - value.length), value])
  }
  return `${input}.${Buffer.concat([readInteger(), readInteger()]).toString('base64url')}`
}

export function createApi({ apply = false, fetchImpl = globalThis.fetch, tokenProvider = signJwt } = {}) {
  return async function api(method, path, body) {
    if (!apply && method !== 'GET') throw new ScriptError(3, 'dry-run 僅允許 GET。')
    const url = new URL(path, ORIGIN)
    if (url.origin !== ORIGIN || url.username || url.password) {
      throw new ScriptError(3, 'ASC 請求網址無效。')
    }

    let jwt
    try {
      jwt = await tokenProvider()
      if (!jwt) throw new Error()
    } catch {
      throw new ScriptError(2, '無法取得 ASC 憑證。')
    }

    try {
      const response = await fetchImpl(url.href, {
        method,
        redirect: 'error',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error()
      return method === 'GET' ? await response.json() : undefined
    } catch {
      throw new ScriptError(3, 'ASC 請求失敗。')
    }
  }
}

async function list(api, path) {
  const records = []
  while (path) {
    const page = await api('GET', path)
    records.push(...page.data)
    path = page.links?.next
  }
  return records
}

function sameBytes(current, desired) {
  return typeof current === 'string' && Buffer.from(current).equals(Buffer.from(desired))
}

function firstDifference(current, desired) {
  const before = typeof current === 'string' ? current.split('\n') : []
  const after = desired.split('\n')
  let index = 0
  while (before[index] === after[index] && index < before.length) index++
  const size = (line) => line === undefined ? 'absent' : `${count(line)} cp`
  return `line ${index + 1} (${size(before[index])} → ${size(after[index])})`
}

function compare(output, label, current, desired, missing = false) {
  const summary = (value) => typeof value === 'string'
    ? `${count(value)} cp sha256=${sha256(value).slice(0, 12)}`
    : 'absent'
  const same = sameBytes(current, desired)
  const status = missing ? 'locale missing' : same ? 'same' : 'different'
  const difference = same ? '' : ` · ${firstDifference(current, desired)}`
  output(`${label} current ${summary(current)} → new ${summary(desired)} · ${status}${difference}`)
  return !same
}

function patch(type, id, attributes) {
  return {
    path: `/v1/${type}/${encodeURIComponent(id)}`,
    body: { data: { type, id, attributes } },
  }
}

const versionPath = (id) =>
  `/v1/appStoreVersions/${encodeURIComponent(id)}?fields[appStoreVersions]=copyright`

const localizationPath = (id) =>
  `/v1/appStoreVersions/${encodeURIComponent(id)}/appStoreVersionLocalizations?limit=200&fields[appStoreVersionLocalizations]=locale,description,whatsNew`

export async function run(args, { fetchImpl, tokenProvider, output = console.log, error = console.error } = {}) {
  const [flag] = args
  if (args.length > 1 || (args.length === 1 && !['--apply', '--self-check'].includes(flag))) {
    error('不支援的參數。')
    return 1
  }

  const apply = flag === '--apply'
  let failureCode = 3
  try {
    const copy = checkCopy()
    if (flag === '--self-check') {
      output('離線檢查通過（4 個語系，8 個文案檔）。')
      return 0
    }

    const api = createApi({ apply, fetchImpl, tokenProvider })
    const versions = (await list(api,
      `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${VERSION}&fields[appStoreVersions]=platform,versionString,appStoreState`,
    )).filter(({ attributes }) => attributes.platform === 'IOS' && attributes.versionString === VERSION)
    for (const { id, attributes } of versions) {
      output(`iOS ${VERSION} id=${id} appStoreState=${attributes.appStoreState} (預期 ID 前綴 2d01869a)`)
    }
    if (versions.length !== 1) throw new ScriptError(3, `iOS ${VERSION} 版本數量為 ${versions.length}，需要恰好一個。`)
    const [version] = versions
    if (apply && version.attributes.appStoreState !== 'PREPARE_FOR_SUBMISSION') {
      throw new ScriptError(3, '版本狀態須為 PREPARE_FOR_SUBMISSION。')
    }

    const current = await api('GET', versionPath(version.id))
    const localizations = await list(api, localizationPath(version.id))
    const plan = []
    if (compare(output, 'version/copyright', current.data.attributes.copyright, COPYRIGHT)) {
      plan.push(patch('appStoreVersions', version.id, { copyright: COPYRIGHT }))
    }
    let allLocalesPresent = true
    for (const locale of LOCALES) {
      const localization = localizations.find(({ attributes }) => attributes.locale === locale)
      const changes = {}
      for (const [field, desired] of Object.entries(copy[locale])) {
        if (compare(output, `${locale}/${field}`, localization?.attributes[field], desired, !localization)) {
          changes[field] = desired
        }
      }
      if (!localization) allLocalesPresent = false
      else if (Object.keys(changes).length) {
        plan.push(patch('appStoreVersionLocalizations', localization.id, changes))
      }
    }

    if (apply && !allLocalesPresent) throw new ScriptError(3, '缺少必要的語系。')
    for (const { path, body } of plan) {
      output(`PATCH ${path} · ${Object.keys(body.data.attributes).join(', ')}`)
    }
    if (!apply) {
      output('dry-run 結束，沒有寫入任何東西')
      return 0
    }

    for (const { path, body } of plan) await api('PATCH', path, body)

    failureCode = 4
    const savedVersion = await api('GET', versionPath(version.id))
    const savedLocalizations = await list(api, localizationPath(version.id))
    const mismatches = []
    if (!sameBytes(savedVersion.data.attributes.copyright, COPYRIGHT)) mismatches.push('version/copyright')
    for (const locale of LOCALES) {
      const saved = savedLocalizations.find(({ attributes }) => attributes.locale === locale)
      for (const [field, desired] of Object.entries(copy[locale])) {
        if (!sameBytes(saved?.attributes[field], desired)) mismatches.push(`${locale}/${field}`)
      }
    }
    if (mismatches.length) throw new ScriptError(4, `回讀比對不符：${mismatches.join(', ')}`)
    output('回讀比對一致。')
    return 0
  } catch (cause) {
    if (cause instanceof ScriptError && cause.code === 2) {
      error(cause.message)
      return 2
    }
    error(cause instanceof ScriptError ? cause.message : '無法完成中繼資料檢查。')
    return failureCode
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2))
}
