// Shared by the editor frame and the worker: both must fingerprint text the same way.

/** Text as compared: no BOM, LF line endings, so a CRLF file still matches its editor buffer. */
export function normalizeText(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
}

/** cyrb53: a fast 53-bit hash. Only a match key after the size check, never a security check. */
export function fingerprintText(text) {
  const normalized = normalizeText(text)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return {
    hash: (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36),
    length: normalized.length
  }
}
