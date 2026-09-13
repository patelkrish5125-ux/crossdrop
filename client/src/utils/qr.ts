/**
 * CrossDrop Zero-Dependency QR Code Generator
 * Pure TypeScript QR Code generator (Model 2, Byte Mode, EC Level L/M).
 * Generates clean SVG markup or SVG Data URLs for pairing links.
 */

// QR Code Polynomials and Galois Field GF(256)
const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGF256() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d; // Generator polynomial x^8 + x^4 + x^3 + x^2 + 1
    }
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF256_EXP[GF256_LOG[x] + GF256_LOG[y]];
}

function polyMul(p1: number[] | Uint8Array, p2: number[] | Uint8Array): number[] {
  const result: number[] = new Array(p1.length + p2.length - 1).fill(0);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      result[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return result;
}

function getGeneratorPoly(degree: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, [1, GF256_EXP[i]]);
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = getGeneratorPoly(ecCount);
  const remainder = new Uint8Array(ecCount);

  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) {
      remainder[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return remainder;
}

// QR Code Specifications for versions 1 to 5, EC Level M
interface QRSpec {
  version: number;
  size: number;
  totalBytes: number;
  dataBytes: number;
  ecBytes: number;
  alignPos: number[];
}

const QR_SPECS: QRSpec[] = [
  { version: 1, size: 21, totalBytes: 26, dataBytes: 16, ecBytes: 10, alignPos: [] },
  { version: 2, size: 25, totalBytes: 44, dataBytes: 28, ecBytes: 16, alignPos: [6, 18] },
  { version: 3, size: 29, totalBytes: 70, dataBytes: 44, ecBytes: 26, alignPos: [6, 22] },
  { version: 4, size: 33, totalBytes: 100, dataBytes: 64, ecBytes: 36, alignPos: [6, 26] },
  { version: 5, size: 37, totalBytes: 134, dataBytes: 86, ecBytes: 48, alignPos: [6, 30] },
];

export function generateQRCodeSVG(text: string, pixelSize = 256): string {
  const utf8 = new TextEncoder().encode(text);
  const spec = QR_SPECS.find((s) => s.dataBytes >= utf8.length + 3) || QR_SPECS[QR_SPECS.length - 1];

  // 1. Bitstream encoding: 4 bits mode (0100 for Byte mode) + 8 bits length + data
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(utf8.length, 8); // Character count indicator
  for (const b of utf8) {
    pushBits(b, 8);
  }

  // Terminator (up to 4 zeroes)
  const maxBits = spec.dataBytes * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);

  // Pad to multiple of 8
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Pad bytes 0xEC, 0x11 until capacity
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < maxBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to bytes
  const dataBytes = new Uint8Array(spec.dataBytes);
  for (let i = 0; i < spec.dataBytes; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i * 8 + b];
    }
    dataBytes[i] = byte;
  }

  // 2. Error correction
  const ecBytes = rsEncode(dataBytes, spec.ecBytes);
  const fullCodewords = new Uint8Array(spec.totalBytes);
  fullCodewords.set(dataBytes, 0);
  fullCodewords.set(ecBytes, dataBytes.length);

  // 3. Matrix layout
  const N = spec.size;
  const matrix: (boolean | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  const isFunction: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false));

  const setModule = (r: number, c: number, val: boolean, isFunc = true) => {
    if (r >= 0 && r < N && c >= 0 && c < N) {
      matrix[r][c] = val;
      if (isFunc) isFunction[r][c] = true;
    }
  };

  // Finder patterns
  const drawFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          const isBlack = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setModule(nr, nc, isBlack);
        } else {
          setModule(nr, nc, false); // Separator
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, N - 7);
  drawFinder(N - 7, 0);

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  if (spec.alignPos.length > 0) {
    for (const r of spec.alignPos) {
      for (const c of spec.alignPos) {
        if (isFunction[r][c]) continue; // Don't overlap with finders
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBlack = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setModule(r + dr, c + dc, isBlack);
          }
        }
      }
    }
  }

  // Dark module
  setModule(4 * spec.version + 9, 8, true);

  // Reserve format information areas
  for (let i = 0; i < 9; i++) {
    if (!isFunction[8][i]) setModule(8, i, false);
    if (!isFunction[i][8]) setModule(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][N - 1 - i]) setModule(8, N - 1 - i, false);
    if (!isFunction[N - 1 - i][8]) setModule(N - 1 - i, 8, false);
  }

  // 4. Place Data Bits in Matrix (zig-zag 2-columns)
  let bitIdx = 0;
  const totalBits = spec.totalBytes * 8;
  const allBits: number[] = [];
  for (let i = 0; i < spec.totalBytes; i++) {
    for (let b = 7; b >= 0; b--) {
      allBits.push((fullCodewords[i] >> b) & 1);
    }
  }

  let upward = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--; // Skip vertical timing pattern
    const rows = upward
      ? Array.from({ length: N }, (_, i) => N - 1 - i)
      : Array.from({ length: N }, (_, i) => i);

    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (!isFunction[row][c]) {
          const bit = bitIdx < totalBits ? allBits[bitIdx++] : 0;
          // Mask 0: (row + col) % 2 === 0
          const mask = (row + c) % 2 === 0;
          matrix[row][c] = (bit === 1) !== mask;
        }
      }
    }
    upward = !upward;
  }

  // 5. Format info for Mask 0, EC Level M (00 101 -> 101010000010010)
  // Standard format bits with mask: 101010000010010 ^ 101010000010010 = 0 (for L0)
  // For M0 (EC Level M = 00, Mask 0 = 000):
  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]; // Mask 0, EC M XORed
  const formatCoords = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const val = formatBits[i] === 1;
    const [r, c] = formatCoords[i];
    matrix[r][c] = val;
  }
  const formatCoords2 = [
    [N - 1, 8], [N - 2, 8], [N - 3, 8], [N - 4, 8], [N - 5, 8], [N - 6, 8], [N - 7, 8],
    [8, N - 8], [8, N - 7], [8, N - 6], [8, N - 5], [8, N - 4], [8, N - 3], [8, N - 2], [8, N - 1]
  ];
  for (let i = 0; i < 15; i++) {
    const val = formatBits[i] === 1;
    const [r, c] = formatCoords2[i];
    matrix[r][c] = val;
  }

  // 6. Generate SVG
  const margin = 3;
  const viewSize = N + margin * 2;
  let rects = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (matrix[r][c]) {
        rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1" fill="#0f172a" />`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff" rx="12" />${rects}</svg>`;
}

export function generateQRCodeDataURL(text: string, pixelSize = 256): string {
  const svg = generateQRCodeSVG(text, pixelSize);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
