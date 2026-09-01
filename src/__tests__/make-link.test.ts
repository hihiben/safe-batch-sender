import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePayload } from '../payload.js'

// tools/make-link.mjs does `import '../src/payload.ts'` directly, relying on Node's
// native TypeScript type-stripping (stable by default from Node 23.6+; Node 22 needs
// --experimental-strip-types; Node <22 doesn't support it at all and this fails
// outright). Spawning it as a real subprocess under whatever Node is running this
// test is what actually verifies "does this Node version work", as opposed to
// asserting a version number and hoping.
describe('tools/make-link.mjs (Node compatibility smoke test)', () => {
  it('produces a link this app decodes back to the same payload it was given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'make-link-test-'))
    const rowsPath = join(dir, 'rows.json')
    writeFileSync(rowsPath, JSON.stringify([['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '500000000000000']]))

    const output = execFileSync(
      process.execPath,
      ['tools/make-link.mjs', '--chain', 'robinhood', '--label', 'ci smoke test', rowsPath],
      { encoding: 'utf8', cwd: process.cwd() },
    ).trim()

    expect(output).toMatch(/^https:\/\/app\.safe\.global\/apps\/open\?safe=robinhood:0xEeFa622109b5E97B98220729Fa35fC037B7B3212&appUrl=/)

    const appUrl = new URL(output).searchParams.get('appUrl')
    if (!appUrl) throw new Error('make-link.mjs output had no appUrl param')
    const fragment = new URL(appUrl).hash

    const decoded = decodePayload(fragment)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    expect(decoded.value).toEqual({
      v: 1,
      chainId: '4663',
      safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
      label: 'ci smoke test',
      txs: [{ to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '500000000000000' }],
    })
  })
})
