/**
 * A minimal terminal parser state machine for finding control-sequence boundaries.
 *
 * Trimming retained terminal history from the front can cut through a control sequence;
 * replaying the rest of it would print its parameters (`31m`, an OSC title) as text. These
 * helpers track which sequence, if any, is open at a cut so the remainder can be skipped.
 * States follow libghostty-vt's parser, merged where the same input takes them back to ground.
 */
export const TERMINAL_SEQUENCE_GROUND = 0;
const SEQUENCE_ESCAPE = 1;
const SEQUENCE_ESCAPE_INTERMEDIATE = 2;
const SEQUENCE_CSI = 3;
const SEQUENCE_DCS = 4;
const SEQUENCE_SOS_PM_APC = 5;
const SEQUENCE_OSC = 6;

// Bits above the low three hold a high surrogate until its other half arrives.
function nextTerminalSequenceState(state: number, unit: number): number {
  if (unit === 0x1b) return SEQUENCE_ESCAPE;
  if (state === TERMINAL_SEQUENCE_GROUND || unit === 0x18 || unit === 0x1a) {
    return TERMINAL_SEQUENCE_GROUND;
  }
  let mode = state & 7;
  if (unit < 0x80) {
    switch (mode) {
      case SEQUENCE_ESCAPE:
        if (unit < 0x20 || unit === 0x7f) return mode;
        if (unit < 0x30) return SEQUENCE_ESCAPE_INTERMEDIATE;
        if (unit === 0x5b) return SEQUENCE_CSI;
        if (unit === 0x5d) return SEQUENCE_OSC;
        if (unit === 0x50) return SEQUENCE_DCS;
        return unit === 0x58 || unit === 0x5e || unit === 0x5f
          ? SEQUENCE_SOS_PM_APC
          : TERMINAL_SEQUENCE_GROUND;
      case SEQUENCE_ESCAPE_INTERMEDIATE:
        return unit >= 0x30 && unit !== 0x7f ? TERMINAL_SEQUENCE_GROUND : mode;
      case SEQUENCE_CSI:
        return unit >= 0x40 && unit !== 0x7f ? TERMINAL_SEQUENCE_GROUND : mode;
      case SEQUENCE_OSC:
        return unit === 0x07 ? TERMINAL_SEQUENCE_GROUND : mode;
      default:
        return mode;
    }
  }
  if (mode === SEQUENCE_OSC) return mode;
  if (unit >= 0xd800 && unit <= 0xdbff) return mode | (unit << 3);
  let codePoint = unit;
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    if (state < 8) return mode;
    codePoint = 0x10000 + (((state >> 3) - 0xd800) << 10) + (unit - 0xdc00);
  }
  // Outside ground and OSC the parser reads UTF-8 bytes one at a time, so a continuation
  // byte in 0x80-0x9F acts as a C1 control: most end the sequence, five start another.
  for (let shift = codePoint > 0xffff ? 12 : codePoint > 0x7ff ? 6 : 0; shift >= 0; shift -= 6) {
    const byte = 0x80 | ((codePoint >> shift) & 0x3f);
    if (byte >= 0xa0) continue;
    if (byte === 0x9d) return SEQUENCE_OSC;
    if (byte === 0x90) mode = SEQUENCE_DCS;
    else if (byte === 0x9b) mode = SEQUENCE_CSI;
    else if (byte === 0x98 || byte >= 0x9e) mode = SEQUENCE_SOS_PM_APC;
    else return TERMINAL_SEQUENCE_GROUND;
  }
  return mode;
}

/** The parser state after `text.slice(start, end)`, for a terminal that entered it in `state`. */
export function terminalSequenceStateAfter(
  state: number,
  text: string,
  start = 0,
  end = text.length,
): number {
  if (end <= start) return state;
  // ESC enters the escape state from every state, so only what follows the last one matters.
  const escape = text.lastIndexOf("\u001b", end - 1);
  if (escape >= start) {
    state = SEQUENCE_ESCAPE;
    start = escape + 1;
  }
  for (let index = start; index < end && state !== TERMINAL_SEQUENCE_GROUND; index += 1) {
    state = nextTerminalSequenceState(state, text.charCodeAt(index));
  }
  return state;
}

/** Where in `text` a terminal that entered it in `state` is first back in ground state. */
export function terminalSequenceEnd(state: number, text: string): number {
  let index = 0;
  while (state !== TERMINAL_SEQUENCE_GROUND && index < text.length) {
    state = nextTerminalSequenceState(state, text.charCodeAt(index));
    index += 1;
  }
  return index;
}
