/**
 * A QR encoder, in-house.
 *
 * Scope is deliberately narrow: byte mode, error correction level M, versions 1
 * to 10 (up to 213 bytes) — an invite link and nothing else. That is what lets
 * the whole of ISO/IEC 18004 that matters fit in one file, with no dependency
 * pulled in and nothing fetched at runtime, which is the same bargain the rest
 * of the app is built on.
 *
 * Level M corrects around 15% of the symbol. On a screen there is no dirt and no
 * print bleed, so the budget goes to a camera at an angle in poor light rather
 * than to damage.
 *
 * The output is a plain module grid. Turning it into pixels is the caller's
 * business; `createQrCode` below draws it as an SVG.
 *
 * Ported verbatim from the owner's SuperTaki project
 * (github.com/eyalbenzvi/SuperTaki, src/lib/qr.ts) so the invite flow here
 * behaves identically to the one there.
 */

/** Total error-correction codewords per block, level M, indexed by version - 1. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;

/** How many blocks the codewords are split across, level M, by version - 1. */
const BLOCK_COUNT = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;

const MIN_VERSION = 1;
const MAX_VERSION = ECC_PER_BLOCK.length;

/** Level M's two-bit level indicator, as it appears in the format information. */
const ECC_FORMAT_BITS = 0b00;

/** Byte mode's four-bit mode indicator. */
const BYTE_MODE = 0b0100;

/** Penalty weights from the specification, used to pick the mask. */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  /** Row-major grid; `true` is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * Encodes `text` as UTF-8 in the smallest symbol that holds it.
 *
 * Returns `null` when the text is too long for version 10 rather than throwing:
 * a caller showing a QR code beside a link it cannot replace has a perfectly
 * good fallback, and no reason to handle an exception for it.
 */
export function encodeQr(text: string): QrMatrix | null {
  const data = new TextEncoder().encode(text);
  const version = smallestVersion(data.length);
  if (version === null) {
    return null;
  }
  return new Encoder(version, buildCodewords(data, version)).matrix();
}

/** Data codewords available for content, after error correction takes its share. */
function dataCapacity(version: number): number {
  const index = version - 1;
  return rawCodewords(version) - (BLOCK_COUNT[index] as number) * (ECC_PER_BLOCK[index] as number);
}

/** Byte mode's character count field is 8 bits up to version 9, then 16. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function smallestVersion(byteLength: number): number | null {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    const bits = 4 + countBits(version) + byteLength * 8;
    if (bits <= dataCapacity(version) * 8) {
      return version;
    }
  }
  return null;
}

/**
 * Total codewords in a symbol: every module that is not a function pattern,
 * divided by eight. The subtractions are the alignment patterns (which overlap
 * the timing patterns, hence the correction) and, from version 7, the version
 * information blocks.
 */
function rawCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) {
      modules -= 36;
    }
  }
  return Math.floor(modules / 8);
}

/** Mode indicator, length, payload, terminator and padding — one bit stream. */
function buildCodewords(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i -= 1) {
      bits.push((value >>> i) & 1);
    }
  };

  push(BYTE_MODE, 4);
  push(data.length, countBits(version));
  for (const byte of data) {
    push(byte, 8);
  }

  /*
   * The four-bit terminator, unless the payload has already reached capacity.
   *
   * The specification then asks for zero bits up to the next byte boundary; in
   * byte mode there are never any. The header is 4 + 8 or 4 + 16 bits and the
   * payload is whole bytes, so the stream is always four bits short of a boundary
   * and the terminator is exactly what closes it. Nothing else in this file can
   * produce a partial byte, so nothing here pads one.
   */
  for (let i = 0; i < 4 && bits.length < dataCapacity(version) * 8; i += 1) {
    bits.push(0);
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      byte = (byte << 1) | (bits[i + j] as number);
    }
    codewords.push(byte);
  }
  // The two pad codewords the specification names, alternating to the end.
  for (let i = 0; codewords.length < dataCapacity(version); i += 1) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/* Reed-Solomon over GF(2^8) ------------------------------------------------- */

function gfMultiply(x: number, y: number): number {
  let product = 0;
  for (let i = 7; i >= 0; i -= 1) {
    // Double, reducing by the field's primitive polynomial when it overflows.
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> i) & 1) * x;
  }
  return product & 0xff;
}

/** Coefficients of (x - r^0)(x - r^1)…, the divisor for `degree` check bytes. */
function rsDivisor(degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      divisor[j] = gfMultiply(divisor[j] as number, root);
      if (j + 1 < degree) {
        divisor[j] = (divisor[j] as number) ^ (divisor[j + 1] as number);
      }
    }
    root = gfMultiply(root, 2);
  }
  return divisor;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const remainder = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    divisor.forEach((coefficient, i) => {
      remainder[i] = (remainder[i] as number) ^ gfMultiply(coefficient, factor);
    });
  }
  return remainder;
}

/**
 * Splits the data into blocks, appends each block's check bytes, and interleaves
 * the lot — so a scratch across the symbol is spread over every block instead of
 * destroying one of them.
 */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const index = version - 1;
  const blockCount = BLOCK_COUNT[index] as number;
  const eccLength = ECC_PER_BLOCK[index] as number;
  const total = rawCodewords(version);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);

  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  let read = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const dataLength = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(read, read + dataLength);
    read += dataLength;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) {
      // A hole, so every block is the same length while interleaving; the reader
      // below skips it.
      block.push(0);
    }
    blocks.push([...block, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i += 1) {
    blocks.forEach((block, blockIndex) => {
      if (i !== shortLength - eccLength || blockIndex >= shortBlocks) {
        result.push(block[i] as number);
      }
    });
  }
  return result;
}

/* Symbol construction ------------------------------------------------------- */

/** Centres of the alignment patterns; the first is always the timing line at 6. */
function alignmentPositions(version: number): number[] {
  if (version === 1) {
    return [];
  }
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 17 - 7; positions.length < count; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

class Encoder {
  private readonly size: number;
  private readonly modules: boolean[][];
  /** Function patterns are placed first and never masked. */
  private readonly reserved: boolean[][];

  constructor(
    private readonly version: number,
    data: readonly number[],
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );

    this.drawFunctionPatterns();
    this.drawCodewords(addEccAndInterleave(data, version));
    this.applyBestMask();
  }

  matrix(): QrMatrix {
    return { size: this.size, modules: this.modules.map((row) => [...row]) };
  }

  private set(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.reserved[y] as boolean[])[x] = true;
  }

  private drawFunctionPatterns(): void {
    // Timing patterns run the full width and height; the finders overwrite their ends.
    for (let i = 0; i < this.size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((x, i) => {
      positions.forEach((y, j) => {
        // The three corners are where the finders already are.
        const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (!corner) {
          this.drawAlignment(x, y);
        }
      });
    });

    // Reserves the format area; the real bits go on once the mask is chosen.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  /** The 7×7 concentric square plus the light separator around it. */
  private drawFinder(centreX: number, centreY: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = centreX + dx;
        const y = centreY + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, ring !== 2 && ring !== 4);
        }
      }
    }
  }

  private drawAlignment(centreX: number, centreY: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.set(centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Format information: level, mask, and a BCH(15, 5) code over both, twice. */
  private drawFormatBits(mask: number): void {
    const value = (ECC_FORMAT_BITS << 3) | mask;
    let remainder = value;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = (((value << 10) | remainder) ^ 0x5412) & 0x7fff;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

    // Around the top-left finder.
    for (let i = 0; i <= 5; i += 1) {
      this.set(8, i, bit(i));
    }
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) {
      this.set(14 - i, 8, bit(i));
    }

    // And the copy split between the other two finders.
    for (let i = 0; i < 8; i += 1) {
      this.set(this.size - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i += 1) {
      this.set(8, this.size - 15 + i, bit(i));
    }
    this.set(8, this.size - 8, true);
  }

  /** From version 7 a symbol states its own version, twice, in BCH(18, 6). */
  private drawVersionBits(): void {
    if (this.version < 7) {
      return;
    }
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = ((this.version << 12) | remainder) & 0x3ffff;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /**
   * Lays the codewords out in the two-module-wide columns the specification
   * describes: right to left, alternating upwards and downwards, skipping every
   * function module on the way.
   */
  private drawCodewords(codewords: readonly number[]): void {
    let bitIndex = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      // Column 6 is the vertical timing pattern; the pair steps around it.
      const rightColumn = right === 6 ? 5 : right;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = rightColumn - j;
          const upward = ((rightColumn + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!(this.reserved[y] as boolean[])[x] && bitIndex < codewords.length * 8) {
            const byte = codewords[bitIndex >>> 3] as number;
            (this.modules[y] as boolean[])[x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
            bitIndex += 1;
          }
        }
      }
    }
  }

  /**
   * Tries all eight masks and keeps the one the specification's penalties like
   * best — the point being to avoid large blank areas and anything a scanner
   * could mistake for a finder pattern.
   */
  private applyBestMask(): void {
    let best = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.penalty();
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = mask;
      }
      // XOR is its own inverse, so this undoes the mask before the next one.
      this.applyMask(mask);
    }
    this.applyMask(best);
    this.drawFormatBits(best);
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if ((this.reserved[y] as boolean[])[x]) {
          continue;
        }
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (invert) {
          (this.modules[y] as boolean[])[x] = !(this.modules[y] as boolean[])[x];
        }
      }
    }
  }

  private penalty(): number {
    let result = 0;

    // Runs of five or more, and finder-like 1:1:3:1:1 sequences, along each row…
    for (let y = 0; y < this.size; y += 1) {
      result += this.linePenalty((i) => (this.modules[y] as boolean[])[i] as boolean);
    }
    // …and down each column.
    for (let x = 0; x < this.size; x += 1) {
      result += this.linePenalty((i) => (this.modules[i] as boolean[])[x] as boolean);
    }

    // Blocks of one colour.
    for (let y = 0; y < this.size - 1; y += 1) {
      for (let x = 0; x < this.size - 1; x += 1) {
        const colour = (this.modules[y] as boolean[])[x];
        if (
          colour === (this.modules[y] as boolean[])[x + 1] &&
          colour === (this.modules[y + 1] as boolean[])[x] &&
          colour === (this.modules[y + 1] as boolean[])[x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    // And a bias away from symbols that are mostly one colour.
    const dark = this.modules.reduce(
      (sum, row) => sum + row.reduce((count, module) => count + (module ? 1 : 0), 0),
      0,
    );
    const total = this.size * this.size;
    const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + deviation * PENALTY_N4;
  }

  private linePenalty(at: (index: number) => boolean): number {
    let result = 0;
    let runColour = false;
    let runLength = 0;
    // Lengths of the last seven runs, newest first, for the 1:1:3:1:1 test.
    const history = new Array<number>(7).fill(0);

    const addHistory = (length: number): void => {
      // The quiet zone counts as light, so the first run is extended by it.
      const extended = history[0] === 0 ? length + this.size : length;
      history.pop();
      history.unshift(extended);
    };
    const finderPatterns = (): number => {
      const unit = history[1] as number;
      const core =
        unit > 0 &&
        history[2] === unit &&
        history[3] === unit * 3 &&
        history[4] === unit &&
        history[5] === unit;
      return (
        (core && (history[0] as number) >= unit * 4 && (history[6] as number) >= unit ? 1 : 0) +
        (core && (history[6] as number) >= unit * 4 && (history[0] as number) >= unit ? 1 : 0)
      );
    };

    for (let i = 0; i < this.size; i += 1) {
      if (at(i) === runColour) {
        runLength += 1;
        if (runLength === 5) {
          result += PENALTY_N1;
        } else if (runLength > 5) {
          result += 1;
        }
      } else {
        addHistory(runLength);
        if (!runColour) {
          result += finderPatterns() * PENALTY_N3;
        }
        runColour = at(i);
        runLength = 1;
      }
    }

    // Terminate the line, again with the quiet zone standing in as a light run.
    if (runColour) {
      addHistory(runLength);
      runLength = 0;
    }
    addHistory(runLength + this.size);
    return result + finderPatterns() * PENALTY_N3;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** The light border a scanner needs around the symbol; four modules per the spec. */
const QUIET_ZONE = 4;

/**
 * Draw `value` as a QR code, or return `null` when it does not fit the encoder.
 *
 * The plate stays white in both themes: a QR code is read by contrast and
 * scanners expect that polarity, so inverting it for a dark theme is the kind of
 * taste that stops phones from scanning it.
 */
export function createQrCode(doc: Document, value: string, label: string): SVGSVGElement | null {
  const matrix = encodeQr(value);
  if (!matrix) return null;

  const span = matrix.size + QUIET_ZONE * 2;
  // One path for the whole symbol: a rect per module would be thousands of nodes.
  let path = '';
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${String(x + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h1v1h-1z`;
    });
  });

  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'qr');
  svg.setAttribute('viewBox', `0 0 ${String(span)} ${String(span)}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  // Modules are whole units in this coordinate system; keep their edges hard.
  svg.setAttribute('shape-rendering', 'crispEdges');

  const plate = doc.createElementNS(ns, 'rect');
  plate.setAttribute('width', String(span));
  plate.setAttribute('height', String(span));
  plate.setAttribute('fill', '#ffffff');
  svg.appendChild(plate);

  const modules = doc.createElementNS(ns, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', '#12141c');
  svg.appendChild(modules);

  return svg;
}
