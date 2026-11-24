// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPYRIGHT, LOCALES, checkCopy, createApi, run } from '../scripts/og/asc-ios-1-10-0-metadata.mjs'

const locales = ['zh-Hant', 'en-US', 'zh-Hans', 'ja'] as const
const copyDir = new URL('../scripts/og/asc-ios-1-10-0-copy/', import.meta.url)
const script = fileURLToPath(new URL('../scripts/og/asc-ios-1-10-0-metadata.mjs', import.meta.url))
const fixtureToken = 'mock-secret-value'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected global fetch') }))
})

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

describe('approved copy', () => {
  it.each([
    ['description.zh-Hant', 918, '18cdb4137f8d272764ae40a0e04554d1138f1147b1a7d6e78257fd41b73aafea', '有種實驗室 出品'],
    ['description.en-US', 2768, 'f0af4e6497f9537c8e2f88ebbcc5e9db9bf6d61bc7d825f155180050faaeb4f3', 'Made by Kind of Lab'],
    ['description.zh-Hans', 922, 'c239fd2bf85aa05f64dc8ba5eb16e6bd8c6274fe389fd93703f3cfd1637f187a', '有种实验室 出品'],
    ['description.ja', 1271, 'c91a00bba6797e7f9896e8d08031097947a2f7e7a9034e735682108538f31be6', '開発・提供：Kind of Lab'],
    ['whatsnew.zh-Hant', 335, 'e8e2f933e7d2bf22af87ac4d8876505783b08aecece5c6131ae95527964c9fec', null],
    ['whatsnew.en-US', 941, '58861220295ea21aae1d4b75784039c39fc4f66ed2926288abef98454228c1c6', null],
    ['whatsnew.zh-Hans', 348, 'be7a10ee4eabe8ec2440f6a8aa9f284320c9f109b961d7be96d41ca4bf4494e3', null],
    ['whatsnew.ja', 517, 'd58cdc8b23c8810365273adf45c47f9114a2c92a8241c774a6e9aa932634ff9e', null],
  ] as const)('%s has the approved bytes', (name, length, digest, credit) => {
    const bytes = readFileSync(new URL(`${name}.txt`, copyDir))
    const value = bytes.toString('utf8')
    expect([...value]).toHaveLength(length)
    expect([...value].length).toBeLessThanOrEqual(4000)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
    expect(value).not.toContain('\r')
    expect(value.trim()).toBe(value)
    if (credit) expect(value.endsWith(`\n\n${credit}`)).toBe(true)
  })

  it('uses the exact copyright and locale set', () => {
    expect(COPYRIGHT).toBe('\u00a9 2026 有種實驗室')
    expect(LOCALES).toEqual(locales)
    expect(Object.keys(checkCopy()).sort()).toEqual([...locales].sort())
  })
})

function mockAsc({ state = 'PREPARE_FOR_SUBMISSION', duplicate = false, missing = false, stale = false } = {}) {
  const copy = checkCopy()
  const version = { id: '2d01869a-test', attributes: { platform: 'IOS', versionString: '1.10.0', appStoreState: state } }
  const versionPath = `/v1/appStoreVersions/${version.id}`
  const versionDetails = { copyright: 'Old copyright' }
  const localizations = locales.filter((locale) => !missing || locale !== 'ja').map((locale) => ({
    id: `loc-${locale}`,
    attributes: { locale, ...copy[locale], keywords: 'keep', promotionalText: 'keep' },
  }))
  localizations[0].attributes.whatsNew = 'Old first line\nOld second line'
  localizations[1].attributes.description = 'Old description'
  const requests: { method: string; path: string; body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ method: init.method ?? 'GET', path, body })
    if (init.method === 'PATCH') {
      const attributes = path === versionPath
        ? versionDetails
        : localizations.find(({ id }) => path === `/v1/appStoreVersionLocalizations/${id}`)?.attributes
      if (!attributes) throw new Error('Unexpected PATCH')
      if (!stale) Object.assign(attributes, body.data.attributes)
      return new Response(null, { status: 204 })
    }
    if (path === '/v1/apps/6779264784/appStoreVersions') {
      if (new URL(url).searchParams.has('cursor')) {
        return Response.json({ data: [{ ...version, id: 'duplicate' }] })
      }
      return Response.json({
        data: [version, { ...version, attributes: { ...version.attributes, platform: 'MAC_OS' } }],
        links: duplicate ? { next: `${path}?cursor=2` } : {},
      })
    }
    if (path === versionPath) return Response.json({ data: { attributes: versionDetails } })
    if (path === `${versionPath}/appStoreVersionLocalizations`) return Response.json({ data: localizations })
    throw new Error('Unexpected GET')
  })

  const output = vi.fn<(line: string) => void>()
  const error = vi.fn<(line: string) => void>()
  const tokenProvider = vi.fn(() => fixtureToken)
  return { fetchImpl, output, error, tokenProvider, requests, copy, version }
}

describe('ASC workflow with injected requests', () => {
  it('reports differences and missing locales using GET only', async () => {
    const asc = mockAsc({ missing: true })
    expect(await run([], asc)).toBe(0)
    expect(asc.requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'GET'])
    const lines = asc.output.mock.calls.flat()
    expect(lines.filter((line) => line.startsWith('PATCH '))).toEqual([
      'PATCH /v1/appStoreVersions/2d01869a-test · copyright',
      'PATCH /v1/appStoreVersionLocalizations/loc-zh-Hant · whatsNew',
      'PATCH /v1/appStoreVersionLocalizations/loc-en-US · description',
    ])
    expect(lines.join('\n')).toMatch(/zh-Hant\/whatsNew current 30 cp sha256=[a-f0-9]{12} → new 335 cp sha256=e8e2f933e7d2 · different · line 1/)
    expect(lines.join('\n')).toMatch(/ja\/description .*locale missing/)
    expect(lines.join('\n')).toMatch(/zh-Hant\/description .*same/)
    expect(lines.at(-1)).toBe('dry-run 結束，沒有寫入任何東西')
    for (const value of [fixtureToken, 'Authorization', 'Old first line', 'keywords', 'promotionalText',
      'supportUrl', 'marketingUrl', 'privacyPolicyUrl', 'subtitle', 'screenshots']) {
      expect(lines.join('\n')).not.toContain(value)
    }
  })

  it('gates writes before requesting credentials or calling fetch', async () => {
    const asc = mockAsc()
    const api = createApi(asc)
    await expect(api('PATCH', '/v1/appStoreVersions/id')).rejects.toThrow('GET')
    expect(asc.tokenProvider).not.toHaveBeenCalled()
    expect(asc.fetchImpl).not.toHaveBeenCalled()
  })

  it('patches only changed fields and verifies them with fresh reads', async () => {
    const asc = mockAsc()
    expect(await run(['--apply'], asc)).toBe(0)
    expect(asc.requests.map(({ method }) => method)).toEqual([
      'GET', 'GET', 'GET', 'PATCH', 'PATCH', 'PATCH', 'GET', 'GET',
    ])
    expect(asc.requests.filter(({ method }) => method === 'PATCH')).toEqual([
      {
        method: 'PATCH', path: '/v1/appStoreVersions/2d01869a-test',
        body: { data: { type: 'appStoreVersions', id: '2d01869a-test', attributes: { copyright: COPYRIGHT } } },
      },
      {
        method: 'PATCH', path: '/v1/appStoreVersionLocalizations/loc-zh-Hant',
        body: { data: { type: 'appStoreVersionLocalizations', id: 'loc-zh-Hant', attributes: { whatsNew: asc.copy['zh-Hant'].whatsNew } } },
      },
      {
        method: 'PATCH', path: '/v1/appStoreVersionLocalizations/loc-en-US',
        body: { data: { type: 'appStoreVersionLocalizations', id: 'loc-en-US', attributes: { description: asc.copy['en-US'].description } } },
      },
    ])
    expect(await run(['--apply'], asc)).toBe(0)
    expect(asc.requests.filter(({ method }) => method === 'PATCH')).toHaveLength(3)
  })

  it.each([
    { state: 'WAITING_FOR_REVIEW' },
    { duplicate: true },
    { missing: true },
  ])('refuses before any write with %j', async (options) => {
    const asc = mockAsc(options)
    expect(await run(['--apply'], asc)).toBe(3)
    expect(asc.requests.length).toBeGreaterThan(0)
    expect(asc.requests.every(({ method }) => method === 'GET')).toBe(true)
  })

  it('returns 4 when an accepted write fails byte-for-byte readback', async () => {
    const asc = mockAsc({ stale: true })
    expect(await run(['--apply'], asc)).toBe(4)
    expect(asc.error.mock.calls.flat().join('\n')).toContain('zh-Hant/whatsNew')
  })

  it('returns 2 without echoing credential failures', async () => {
    const asc = mockAsc()
    const tokenProvider = () => { throw new Error(`Authorization: ${fixtureToken}`) }
    expect(await run([], { ...asc, tokenProvider })).toBe(2)
    expect(asc.fetchImpl).not.toHaveBeenCalled()
    expect(asc.error.mock.calls.flat().join('\n')).not.toMatch(/Authorization|mock-secret-value/)
  })
})

describe('CLI', () => {
  it('rejects unknown arguments without echoing them', () => {
    const result = spawnSync(process.execPath, [script, '--version=1.10.0'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('--version')
  })

  it('passes self-check offline', () => {
    const result = spawnSync(process.execPath, [script, '--self-check'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('離線檢查通過')
    expect(result.stderr).toBe('')
  })
})
