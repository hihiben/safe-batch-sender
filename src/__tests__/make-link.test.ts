import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePayload } from '../payload.js'

const A1 = '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14'
// --safe has no default: the CLI is generic, so the caller always names the Safe.
const SAFE = '0x3432931ca9f58f3943cE806039c799F0613871BD'

// tools/make-link.mjs does `import '../src/payload.ts'` directly, relying on Node's
// native TypeScript type-stripping (stable by default from Node 23.6+; Node 22 needs
// --experimental-strip-types; Node <22 doesn't support it at all and this fails
// outright). Spawning it as a real subprocess under whatever Node is running this
// test is what actually verifies "does this Node version work", as opposed to
// asserting a version number and hoping.
describe('tools/make-link.mjs (Node compatibility smoke test)', () => {
  function runWithRows(rows: unknown, label = 'runtime shape test'): ReturnType<typeof spawnSync> {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify(rows))
    return spawnSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'eth', '--safe', SAFE, '--format', 'v2', '--label', label, rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    )
  }

  it('produces a link this app decodes back to the same payload it was given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify([['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '500000000000000']]))

    const output = execFileSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'robinhood', '--safe', SAFE, '--label', 'ci smoke test', rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    ).trim()

    expect(output).toMatch(new RegExp(`^https://app\\.safe\\.global/apps/open\\?safe=robinhood:${SAFE}&appUrl=`))

    const appUrl = new URL(output).searchParams.get('appUrl')
    if (!appUrl) throw new Error('make-link.mjs output had no appUrl param')
    const fragment = new URL(appUrl).hash

    const decoded = decodePayload(fragment)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    expect(decoded.value).toEqual({
      v: 1,
      chainId: '4663',
      safe: SAFE,
      label: 'ci smoke test',
      txs: [{ to: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amountWei: '500000000000000' }],
    })
  })

  it('produces a v2 link when --format v2 is passed, decoding back to the same payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify([['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '500000000000000']]))

    const output = execFileSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'robinhood', '--safe', SAFE, '--format', 'v2', '--label', 'ci smoke test', rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    ).trim()

    const appUrl = new URL(output).searchParams.get('appUrl')
    if (!appUrl) throw new Error('make-link.mjs output had no appUrl param')
    const fragment = new URL(appUrl).hash

    const decoded = decodePayload(fragment)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    expect(decoded.value).toEqual({
      v: 2,
      chainId: '4663',
      safe: SAFE,
      label: 'ci smoke test',
      txs: [{ to: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amountWei: '500000000000000' }],
    })
  })

  it('rejects a runtime 3-tuple as unsupported ERC-20 input', () => {
    const result = runWithRows([["0x2701232ab142dfF035245dBcaA08e316Bf5d1B14", '5000000000000000000', '0x6B175474E89094C44Da98b954EedeAC495271d0F']])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ERC-20 tokens are not supported yet.*remove the third \(token address\) element/i)
    expect(result.stdout).toBe('')
  })

  it.each([
    { name: '4-tuple', row: [A1, '1', 'extra', 'extra'] },
    { name: '1-tuple', row: [A1] },
    { name: 'non-array row', row: { to: A1, amountWei: '1' } },
  ])('rejects a runtime $name with a clear tuple-shape error', ({ row }) => {
    const result = runWithRows([row])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/txs\[0\] must be a \[to, amountWei\] tuple/i)
    expect(result.stdout).toBe('')
  })

  // --safe is validated for both formats. The v1 encoder itself does not validate
  // (it JSON.stringifies whatever it gets), so without the CLI check the default
  // format would print a link built around a placeholder and fail only in the app.
  it.each([
    { name: 'a placeholder', safe: '0xYourSafe...' },
    { name: 'a bad EIP-55 checksum', safe: '0x2701232AB142dfF035245dBcaA08e316Bf5d1B14' },
    { name: 'a too-short address', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B1' },
  ])('rejects $name passed to --safe, on the default (v1) format', ({ safe }) => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify([[A1, '1000000000000000']]))
    const result = spawnSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'eth', '--safe', safe, '--label', 'x', rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--safe is not a valid address/)
    expect(result.stdout).toBe('')
  })

  it('refuses to read the next flag as a flag value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify([[A1, '1000000000000000']]))
    const result = spawnSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'eth', '--safe', '--format', 'v2', '--label', 'x', rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--safe needs a value/)
    expect(result.stdout).toBe('')
  })

  it('throws instead of printing a link once the carrier link limit is exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    // 50 distinct rows with a max-length label pushes a v2 link past 3000 chars only
    // when a huge amount is also present; MAX_TXS rows of a maximal uint256 amount
    // under v1 (verbose decimal JSON) is a cheap way to blow the 3000-char limit
    // without needing v2's own worst-case construction here.
    const hugeAmount = (2n ** 256n - 1n).toString()
    const rows = Array.from({ length: 50 }, (_, i) => [
      `0x${(1000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(40, '0')}`,
      hugeAmount,
    ])
    writeFileSync(rowsPath, JSON.stringify(rows))

    expect(() =>
      execFileSync(
        process.execPath,
        ['tools/make-link.mjs', '--chain', 'robinhood', '--safe', SAFE, '--label', 'x'.repeat(64), rowsPath],
        { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toThrow()
  })

  it('rejects a v2 format-maximum link that exceeds the carrier link limit', () => {
    const maxUint256 = (2n ** 256n - 1n).toString()
    const rows = Array.from({ length: 50 }, (_, i) => [
      `0x${(1000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(40, '0')}`,
      maxUint256,
    ])
    const result = runWithRows(rows, 'x'.repeat(64))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exceeds the 3000-char limit')
    expect(result.stdout).toBe('')
  })
})
