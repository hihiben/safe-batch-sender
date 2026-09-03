// Frozen golden vectors for the v2 binary wire format. Do not edit `fragment` or `hex`:
// this module is the contract any other implementation of the format is checked against,
// so changing a byte here silently redefines the format instead of catching a bug.
//
// Each was derived from the format specification and then independently reproduced, byte
// for byte, by a separate implementation written from that specification alone. They are
// deliberately small and varied rather than realistic: between them they cover all three
// base64 length remainders, a multi-byte UTF-8 label, a full uint256 amount, an amount
// with an interior zero byte, and a repeated recipient."
import type { BatchInput, BatchPayload } from '../payload.js'

const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'
const A1 = '0x9572561eBe198566bBa3B4e7C53F82Ac27587431'
const A2 = '0x5F8D74fCFE0B42a3a4d5646c0f5d9124059817a2'

export interface GoldenVector {
  name: string
  input: BatchInput
  hex: string
  fragment: string
  decoded: BatchPayload
}

export const GOLDEN_VECTORS: GoldenVector[] = [
  {
    name: 'A — 54 bytes (mod 3 = 0), empty label',
    input: {
      chainId: '4663',
      safe: SAFE,
      label: '',
      txs: [[A1, '500000000000000']],
    },
    hex: '02021237eefa622109b5e97b98220729fa35fc037b7b321200019572561ebe198566bba3b4e7c53f82ac275874310701c6bf52634000',
    fragment: 'AgISN-76YiEJtel7mCIHKfo1_AN7ezISAAGVclYevhmFZrujtOfFP4KsJ1h0MQcBxr9SY0AA',
    decoded: {
      v: 2,
      chainId: '4663',
      safe: SAFE,
      label: '',
      txs: [{ to: A1, amountWei: '500000000000000' }],
    },
  },
  {
    name: 'B — 97 bytes (mod 3 = 1), ASCII label, 2 rows',
    input: {
      chainId: '4663',
      safe: SAFE,
      label: 'gas refill test',
      txs: [
        [A1, '500000000000000'],
        [A2, '500000000000000'],
      ],
    },
    hex: '02021237eefa622109b5e97b98220729fa35fc037b7b32120f67617320726566696c6c2074657374029572561ebe198566bba3b4e7c53f82ac275874310701c6bf526340005f8d74fcfe0b42a3a4d5646c0f5d9124059817a20701c6bf52634000',
    fragment:
      'AgISN-76YiEJtel7mCIHKfo1_AN7ezISD2dhcyByZWZpbGwgdGVzdAKVclYevhmFZrujtOfFP4KsJ1h0MQcBxr9SY0AAX410_P4LQqOk1WRsD12RJAWYF6IHAca_UmNAAA',
    decoded: {
      v: 2,
      chainId: '4663',
      safe: SAFE,
      label: 'gas refill test',
      txs: [
        { to: A1, amountWei: '500000000000000' },
        { to: A2, amountWei: '500000000000000' },
      ],
    },
  },
  {
    name: 'C — 66 bytes (mod 3 = 0), UTF-8 label',
    input: {
      chainId: '42161',
      safe: SAFE,
      label: '補 gas 給 filler',
      txs: [[A1, '1']],
    },
    hex: '0202a4b1eefa622109b5e97b98220729fa35fc037b7b321212e8a39c2067617320e7b5a62066696c6c6572019572561ebe198566bba3b4e7c53f82ac275874310101',
    fragment: 'AgKkse76YiEJtel7mCIHKfo1_AN7ezISEuijnCBnYXMg57WmIGZpbGxlcgGVclYevhmFZrujtOfFP4KsJ1h0MQEB',
    decoded: {
      v: 2,
      chainId: '42161',
      safe: SAFE,
      label: '補 gas 給 filler',
      txs: [{ to: A1, amountWei: '1' }],
    },
  },
  {
    name: 'D — 81 bytes (mod 3 = 0), full uint256 amount',
    input: {
      chainId: '1',
      safe: SAFE,
      label: 'max',
      txs: [[A1, (2n ** 256n - 1n).toString()]],
    },
    hex: '020101eefa622109b5e97b98220729fa35fc037b7b3212036d6178019572561ebe198566bba3b4e7c53f82ac2758743120ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    fragment: 'AgEB7vpiIQm16XuYIgcp-jX8A3t7MhIDbWF4AZVyVh6-GYVmu6O058U_gqwnWHQxIP__________________________________________',
    decoded: {
      v: 2,
      chainId: '1',
      safe: SAFE,
      label: 'max',
      txs: [{ to: A1, amountWei: (2n ** 256n - 1n).toString() }],
    },
  },
  {
    name: 'E — 71 bytes (mod 3 = 2), internal zero byte in amount',
    input: {
      chainId: '56',
      safe: SAFE,
      label: 'b',
      txs: [
        [A1, '255'],
        [A2, '256'],
      ],
    },
    hex: '020138eefa622109b5e97b98220729fa35fc037b7b32120162029572561ebe198566bba3b4e7c53f82ac2758743101ff5f8d74fcfe0b42a3a4d5646c0f5d9124059817a2020100',
    fragment: 'AgE47vpiIQm16XuYIgcp-jX8A3t7MhIBYgKVclYevhmFZrujtOfFP4KsJ1h0MQH_X410_P4LQqOk1WRsD12RJAWYF6ICAQA',
    decoded: {
      v: 2,
      chainId: '56',
      safe: SAFE,
      label: 'b',
      txs: [
        { to: A1, amountWei: '255' },
        { to: A2, amountWei: '256' },
      ],
    },
  },
  {
    name: 'F — 138 bytes (mod 3 = 0), 3 rows, long ASCII label',
    input: {
      chainId: '8453',
      safe: SAFE,
      label: 'uniswapx gas top-up on base',
      txs: [
        [A1, '12345678000000000'],
        [A2, '9876543210000000'],
        [A1, '1000000000000000000'],
      ],
    },
    hex: '02022105eefa622109b5e97b98220729fa35fc037b7b32121b756e6973776170782067617320746f702d7570206f6e2062617365039572561ebe198566bba3b4e7c53f82ac27587431072bdc5427b38c005f8d74fcfe0b42a3a4d5646c0f5d9124059817a2072316a9e9a40e809572561ebe198566bba3b4e7c53f82ac27587431080de0b6b3a7640000',
    fragment:
      'AgIhBe76YiEJtel7mCIHKfo1_AN7ezISG3VuaXN3YXB4IGdhcyB0b3AtdXAgb24gYmFzZQOVclYevhmFZrujtOfFP4KsJ1h0MQcr3FQns4wAX410_P4LQqOk1WRsD12RJAWYF6IHIxap6aQOgJVyVh6-GYVmu6O058U_gqwnWHQxCA3gtrOnZAAA',
    decoded: {
      v: 2,
      chainId: '8453',
      safe: SAFE,
      label: 'uniswapx gas top-up on base',
      txs: [
        { to: A1, amountWei: '12345678000000000' },
        { to: A2, amountWei: '9876543210000000' },
        { to: A1, amountWei: '1000000000000000000' },
      ],
    },
  },
]
