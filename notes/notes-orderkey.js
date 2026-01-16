(() => {
  if (globalThis.NotesOrderKey) return;

  const { DEFAULT_ORDER_STEP } = globalThis.NotesConstants || {};
  const ORDER_STEP = typeof DEFAULT_ORDER_STEP === 'bigint' ? DEFAULT_ORDER_STEP : 1000n;
  const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
  const BASE = 36n;
  const KEY_LENGTH = 12;
  const MAX_VALUE = BASE ** BigInt(KEY_LENGTH) - 1n;

  const decode = (value) => {
    if (!value) return null;
    let result = 0n;
    for (const char of value) {
      const idx = DIGITS.indexOf(char);
      if (idx < 0) {
        throw new Error(`Invalid orderKey character: ${char}`);
      }
      result = result * BASE + BigInt(idx);
    }
    return result;
  };

  const encode = (value) => {
    let remaining = value;
    let out = '';
    for (let i = 0; i < KEY_LENGTH; i += 1) {
      const digit = remaining % BASE;
      out = DIGITS[Number(digit)] + out;
      remaining /= BASE;
    }
    return out;
  };

  const generateKeyAfter = (leftKey) => {
    const leftValue = leftKey ? decode(leftKey) : -1n;
    const nextValue = leftValue + ORDER_STEP;
    if (nextValue > MAX_VALUE) return null;
    return encode(nextValue);
  };

  const generateKeyBefore = (rightKey) => {
    const rightValue = rightKey ? decode(rightKey) : MAX_VALUE + 1n;
    const prevValue = rightValue - ORDER_STEP;
    if (prevValue < 0n) return null;
    return encode(prevValue);
  };

  const generateKeyBetween = (leftKey, rightKey) => {
    if (!leftKey && !rightKey) {
      return generateKeyAfter(null);
    }
    if (!leftKey) {
      return generateKeyBefore(rightKey);
    }
    if (!rightKey) {
      return generateKeyAfter(leftKey);
    }

    const leftValue = decode(leftKey);
    const rightValue = decode(rightKey);
    if (rightValue <= leftValue) {
      throw new Error('Right orderKey must be greater than left orderKey');
    }
    const gap = rightValue - leftValue;
    if (gap <= 1n) return null;
    const midValue = leftValue + gap / 2n;
    if (midValue === leftValue || midValue === rightValue) return null;
    return encode(midValue);
  };

  const allocateBetween = (leftKey, rightKey, count) => {
    const leftValue = leftKey ? decode(leftKey) : -1n;
    const rightValue = rightKey ? decode(rightKey) : MAX_VALUE + 1n;
    const totalGap = rightValue - leftValue;
    if (totalGap <= BigInt(count)) return null;
    const step = totalGap / BigInt(count + 1);
    if (step <= 0n) return null;
    const keys = [];
    for (let i = 1n; i <= BigInt(count); i += 1n) {
      keys.push(encode(leftValue + step * i));
    }
    return keys;
  };

  globalThis.NotesOrderKey = {
    generateKeyAfter,
    generateKeyBefore,
    generateKeyBetween,
    allocateBetween,
    decode,
    encode,
    KEY_LENGTH
  };
})();
