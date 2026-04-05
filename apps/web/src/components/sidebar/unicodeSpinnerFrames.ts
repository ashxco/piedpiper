// 4x4 pixel spinner frames encoded as 16-bit masks.
// Bit (r*4 + c) = pixel at row r, col c:
//   bit  0 = (0,0)   bit  1 = (0,1)   bit  2 = (0,2)   bit  3 = (0,3)
//   bit  4 = (1,0)   ...                                bit  7 = (1,3)
//   bit  8 = (2,0)   ...                                bit 11 = (2,3)
//   bit 12 = (3,0)   ...                                bit 15 = (3,3)
//
// Ported from the uispinners gallery (12 hand-tuned animations).

export interface SpinnerDef {
  readonly name: string;
  readonly frames: Uint16Array;
  readonly interval: number;
}

const PERIMETER: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [3, 0],
  [2, 0],
  [1, 0],
];

function genClassic(): number[] {
  const frames: number[] = [];
  const len = PERIMETER.length;
  for (let i = 0; i < len; i++) {
    let m = 0;
    for (let t = 0; t < 4; t++) {
      const cell = PERIMETER[(i - t + len) % len];
      if (!cell) continue;
      const [r, c] = cell;
      m |= 1 << (r * 4 + c);
    }
    frames.push(m);
  }
  return frames;
}

function genBrailleWave(): number[] {
  const frames: number[] = [];
  for (let f = 0; f < 8; f++) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const row = Math.round((Math.sin(f * 0.9 - c * 0.7) + 1) * 1.5);
      m |= 1 << (row * 4 + c);
    }
    frames.push(m);
  }
  return frames;
}

function genDna(): number[] {
  const frames: number[] = [];
  for (let f = 0; f < 8; f++) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const phase = (f + c) * (Math.PI / 4);
      const y1 = Math.round((Math.sin(phase) + 1) * 1.5);
      const y2 = Math.round((Math.cos(phase) + 1) * 1.5);
      m |= (1 << (y1 * 4 + c)) | (1 << (y2 * 4 + c));
    }
    frames.push(m);
  }
  return frames;
}

function genRain(): number[] {
  const frames: number[] = [];
  const offsets = [0, 3, 1, 2] as const;
  for (let f = 0; f < 6; f++) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const offset = offsets[c];
      if (offset === undefined) continue;
      const row = (f + offset) % 6;
      if (row < 4) m |= 1 << (row * 4 + c);
    }
    frames.push(m);
  }
  return frames;
}

function genPulse(): number[] {
  const frames: number[] = [];
  const cx = 1.5;
  const cy = 1.5;
  const radii = [0, 0.9, 1.6, 2.3, 3.0] as const;
  for (const r of radii) {
    let m = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const dx = col - cx;
        const dy = row - cy;
        if (Math.abs(Math.sqrt(dx * dx + dy * dy) - r) < 0.7) {
          m |= 1 << (row * 4 + col);
        }
      }
    }
    frames.push(m);
  }
  return frames;
}

function genSnake(): number[] {
  // Boustrophedon path through all 16 cells.
  const path: number[] = [];
  for (let r = 0; r < 4; r++) {
    if (r % 2 === 0) for (let c = 0; c < 4; c++) path.push(r * 4 + c);
    else for (let c = 3; c >= 0; c--) path.push(r * 4 + c);
  }
  const frames: number[] = [];
  const len = path.length;
  for (let i = 0; i < len; i++) {
    let m = 0;
    for (let t = 0; t < 4; t++) {
      const idx = path[(i - t + len) % len];
      if (idx === undefined) continue;
      m |= 1 << idx;
    }
    frames.push(m);
  }
  return frames;
}

function genSparkle(): number[] {
  const dotSets: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [
      [0, 0],
      [0, 3],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 1],
    ],
    [
      [0, 1],
      [1, 0],
      [1, 3],
      [2, 1],
      [3, 0],
      [3, 2],
    ],
    [
      [0, 2],
      [1, 1],
      [1, 3],
      [2, 0],
      [3, 2],
      [3, 3],
    ],
    [
      [0, 0],
      [0, 3],
      [1, 1],
      [2, 2],
      [3, 0],
      [3, 3],
    ],
    [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 0],
      [2, 3],
      [3, 1],
    ],
    [
      [0, 3],
      [1, 0],
      [1, 2],
      [2, 1],
      [2, 3],
      [3, 0],
    ],
  ];
  return dotSets.map((dots) => {
    let m = 0;
    for (const [r, c] of dots) m |= 1 << (r * 4 + c);
    return m;
  });
}

function genCascade(): number[] {
  const frames: number[] = [];
  for (let offset = 0; offset < 9; offset++) {
    let m = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const diag = r + c;
        if (diag === offset || diag === offset - 1) m |= 1 << (r * 4 + c);
      }
    }
    frames.push(m);
  }
  return frames;
}

function genColumns(): number[] {
  const frames: number[] = [];
  for (let col = 0; col < 4; col++) {
    for (let fillTo = 3; fillTo >= 0; fillTo--) {
      let m = 0;
      for (let pc = 0; pc < col; pc++) m |= 0x1111 << pc;
      for (let r = fillTo; r < 4; r++) m |= 1 << (r * 4 + col);
      frames.push(m);
    }
  }
  frames.push(0xffff);
  frames.push(0);
  return frames;
}

function genBreathe(): number[] {
  // 0 -> center 2x2 -> ring of 12 -> full -> reverse.
  const stages = [0, 0x0660, 0x6ff6, 0xffff];
  return [...stages, ...stages.toReversed().slice(1)];
}

function genCheckerboard(): number[] {
  const frames: number[] = [];
  for (let phase = 0; phase < 4; phase++) {
    let m = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const on = phase < 2 ? (r + c + phase) % 2 === 0 : (r + c + phase) % 3 === 0;
        if (on) m |= 1 << (r * 4 + c);
      }
    }
    frames.push(m);
  }
  return frames;
}

function genHelix(): number[] {
  const frames: number[] = [];
  for (let f = 0; f < 8; f++) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const phase = (f + c) * (Math.PI / 4);
      const y1 = Math.round((Math.sin(phase) + 1) * 1.5);
      const y2 = Math.round((Math.sin(phase + Math.PI) + 1) * 1.5);
      m |= (1 << (y1 * 4 + c)) | (1 << (y2 * 4 + c));
    }
    frames.push(m);
  }
  return frames;
}

function makeDef(name: string, frames: number[], interval: number): SpinnerDef {
  return {
    name,
    frames: Uint16Array.from(frames),
    interval,
  };
}

export const SPINNERS: ReadonlyArray<SpinnerDef> = [
  makeDef("braille", genClassic(), 80),
  makeDef("braillewave", genBrailleWave(), 100),
  makeDef("dna", genDna(), 90),
  makeDef("rain", genRain(), 110),
  makeDef("pulse", genPulse(), 160),
  makeDef("snake", genSnake(), 80),
  makeDef("sparkle", genSparkle(), 150),
  makeDef("cascade", genCascade(), 90),
  makeDef("columns", genColumns(), 60),
  makeDef("breathe", genBreathe(), 140),
  makeDef("checkerboard", genCheckerboard(), 250),
  makeDef("helix", genHelix(), 90),
];
