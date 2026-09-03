// Frozen golden vectors for the v2 binary wire format. Do not edit `fragment` or `hex`:
// this module is the contract any other implementation of the format is checked against,
// so changing a byte here silently redefines the format instead of catching a bug.
//
// Each was derived from the format specification and then independently reproduced, byte
// for byte, by a separate implementation written from that specification alone. They are
// deliberately small and varied rather than realistic: between them they cover all three
// base64 length remainders, a multi-byte UTF-8 label, a full uint256 amount, an amount
// with an interior zero byte, and a repeated recipient.
//
// The accounts are synthetic — the first 20 bytes of keccak256 over a fixed string — so
// nothing here points at a real Safe or a real recipient.
import type { BatchInput, BatchPayload } from '../payload.js'

const SAFE = '0x3432931ca9f58f3943cE806039c799F0613871BD'
const A1 = '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14'
const A2 = '0x0FEb17f6998038CEfBE15260dd246a73Ae7544Ad'

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
      label: "",
      txs: [[A1, '500000000000000']],
    },
    hex: '020212373432931ca9f58f3943ce806039c799f0613871bd00012701232ab142dff035245dbcaa08e316bf5d1b140701c6bf52634000',
    fragment: 'AgISNzQykxyp9Y85Q86AYDnHmfBhOHG9AAEnASMqsULf8DUkXbyqCOMWv10bFAcBxr9SY0AA',
    decoded: {
      v: 2,
      chainId: '4663',
      safe: SAFE,
      label: "",
      txs: [
        { to: A1, amountWei: '500000000000000' },
      ],
    },
  },
  {
    name: 'B — 97 bytes (mod 3 = 1), ASCII label, 2 rows',
    input: {
      chainId: '4663',
      safe: SAFE,
      label: "sample batch v2",
      txs: [[A1, '500000000000000'], [A2, '500000000000000']],
    },
    hex: '020212373432931ca9f58f3943ce806039c799f0613871bd0f73616d706c65206261746368207632022701232ab142dff035245dbcaa08e316bf5d1b140701c6bf526340000feb17f6998038cefbe15260dd246a73ae7544ad0701c6bf52634000',
    fragment:
      'AgISNzQykxyp9Y85Q86AYDnHmfBhOHG9D3NhbXBsZSBiYXRjaCB2MgInASMqsULf8DUkXbyqCOMWv10bFAcBxr9SY0AAD-sX9pmAOM774VJg3SRqc651RK0HAca_UmNAAA',
    decoded: {
      v: 2,
      chainId: '4663',
      safe: SAFE,
      label: "sample batch v2",
      txs: [
        { to: A1, amountWei: '500000000000000' },
        { to: A2, amountWei: '500000000000000' },
      ],
    },
  },
  {
    name: 'C — 77 bytes (mod 3 = 2), UTF-8 label',
    input: {
      chainId: '1',
      safe: SAFE,
      label: "多位元組標籤 🔥",
      txs: [[A1, '1000000000000000000']],
    },
    hex: '0201013432931ca9f58f3943ce806039c799f0613871bd17e5a49ae4bd8de58583e7b584e6a899e7b1a420f09f94a5012701232ab142dff035245dbcaa08e316bf5d1b14080de0b6b3a7640000',
    fragment:
      'AgEBNDKTHKn1jzlDzoBgOceZ8GE4cb0X5aSa5L2N5YWD57WE5qiZ57GkIPCflKUBJwEjKrFC3_A1JF28qgjjFr9dGxQIDeC2s6dkAAA',
    decoded: {
      v: 2,
      chainId: '1',
      safe: SAFE,
      label: "多位元組標籤 🔥",
      txs: [
        { to: A1, amountWei: '1000000000000000000' },
      ],
    },
  },
  {
    name: 'D — 81 bytes (mod 3 = 0), full uint256 amount',
    input: {
      chainId: '1',
      safe: SAFE,
      label: "max",
      txs: [[A1, '115792089237316195423570985008687907853269984665640564039457584007913129639935']],
    },
    hex: '0201013432931ca9f58f3943ce806039c799f0613871bd036d6178012701232ab142dff035245dbcaa08e316bf5d1b1420ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    fragment:
      'AgEBNDKTHKn1jzlDzoBgOceZ8GE4cb0DbWF4AScBIyqxQt_wNSRdvKoI4xa_XRsUIP__________________________________________',
    decoded: {
      v: 2,
      chainId: '1',
      safe: SAFE,
      label: "max",
      txs: [
        { to: A1, amountWei: '115792089237316195423570985008687907853269984665640564039457584007913129639935' },
      ],
    },
  },
  {
    name: 'E — 71 bytes (mod 3 = 2), internal zero byte in amount',
    input: {
      chainId: '56',
      safe: SAFE,
      label: "b",
      txs: [[A1, '255'], [A2, '256']],
    },
    hex: '0201383432931ca9f58f3943ce806039c799f0613871bd0162022701232ab142dff035245dbcaa08e316bf5d1b1401ff0feb17f6998038cefbe15260dd246a73ae7544ad020100',
    fragment: 'AgE4NDKTHKn1jzlDzoBgOceZ8GE4cb0BYgInASMqsULf8DUkXbyqCOMWv10bFAH_D-sX9pmAOM774VJg3SRqc651RK0CAQA',
    decoded: {
      v: 2,
      chainId: '56',
      safe: SAFE,
      label: "b",
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
      label: "batch transfer sample label",
      txs: [[A1, '12345678000000000'], [A2, '9876543210000000'], [A1, '1000000000000000000']],
    },
    hex: '020221053432931ca9f58f3943ce806039c799f0613871bd1b6261746368207472616e736665722073616d706c65206c6162656c032701232ab142dff035245dbcaa08e316bf5d1b14072bdc5427b38c000feb17f6998038cefbe15260dd246a73ae7544ad072316a9e9a40e802701232ab142dff035245dbcaa08e316bf5d1b14080de0b6b3a7640000',
    fragment:
      'AgIhBTQykxyp9Y85Q86AYDnHmfBhOHG9G2JhdGNoIHRyYW5zZmVyIHNhbXBsZSBsYWJlbAMnASMqsULf8DUkXbyqCOMWv10bFAcr3FQns4wAD-sX9pmAOM774VJg3SRqc651RK0HIxap6aQOgCcBIyqxQt_wNSRdvKoI4xa_XRsUCA3gtrOnZAAA',
    decoded: {
      v: 2,
      chainId: '8453',
      safe: SAFE,
      label: "batch transfer sample label",
      txs: [
        { to: A1, amountWei: '12345678000000000' },
        { to: A2, amountWei: '9876543210000000' },
        { to: A1, amountWei: '1000000000000000000' },
      ],
    },
  },
]
