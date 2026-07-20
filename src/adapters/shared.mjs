import fs from "node:fs";

export const MAX_JOURNAL_LINE_BYTES = 1024 * 1024;

export async function* readCompleteJsonLines(filePath, startOffset = 0, endOffset = null) {
  if (endOffset !== null && endOffset <= startOffset) return;
  let absoluteOffset = startOffset;
  let lineStart = startOffset;
  let pieces = [];
  let bufferedBytes = 0;
  let oversized = false;
  const stream = fs.createReadStream(filePath, {
    start: startOffset,
    ...(endOffset === null ? {} : { end: endOffset - 1 })
  });
  for await (const chunk of stream) {
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(segmentStart, index);
      if (!oversized) {
        if (bufferedBytes + segment.length <= MAX_JOURNAL_LINE_BYTES) {
          pieces.push(segment);
          bufferedBytes += segment.length;
        } else {
          pieces = [];
          bufferedBytes = 0;
          oversized = true;
        }
      }
      const lineEnd = absoluteOffset + index + 1;
      let text = null;
      if (!oversized) {
        const bytes = Buffer.concat(pieces, bufferedBytes);
        const withoutCarriageReturn = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d
          ? bytes.subarray(0, bytes.length - 1)
          : bytes;
        text = withoutCarriageReturn.toString("utf8");
      }
      yield {
        text,
        oversized,
        startOffset: lineStart,
        endOffset: lineEnd
      };
      lineStart = lineEnd;
      pieces = [];
      bufferedBytes = 0;
      oversized = false;
      segmentStart = index + 1;
    }
    const remainder = chunk.subarray(segmentStart);
    if (!oversized) {
      if (bufferedBytes + remainder.length <= MAX_JOURNAL_LINE_BYTES) {
        pieces.push(remainder);
        bufferedBytes += remainder.length;
      } else {
        pieces = [];
        bufferedBytes = 0;
        oversized = true;
      }
    }
    absoluteOffset += chunk.length;
  }
}

export async function isCompleteLineBoundary(filePath, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) return false;
  if (offset === 0) return true;
  const handle = await fs.promises.open(filePath, "r");
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

export function safeNonNegativeInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export function normalizeUsage(usage = {}, provider) {
  const reportedInput = safeNonNegativeInteger(usage.input_tokens ?? usage.input ?? 0);
  const cachedInput = safeNonNegativeInteger(
    usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cache_read ?? 0
  );
  const cacheWriteInput = safeNonNegativeInteger(
    usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation ?? 0
  );
  const output = safeNonNegativeInteger(usage.output_tokens ?? usage.output ?? 0);
  const reasoningOutput = safeNonNegativeInteger(
    usage.reasoning_output_tokens ?? usage.reasoning_tokens ?? usage.reasoning_output ?? 0
  );
  const reportedTotal = safeNonNegativeInteger(usage.total_tokens ?? usage.total ?? 0);
  const input = provider === "codex" ? Math.max(0, reportedInput - cachedInput) : reportedInput;
  const calculatedTotal = provider === "codex"
    ? reportedInput + cacheWriteInput + output
    : input + cachedInput + cacheWriteInput + output;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    reasoningOutput,
    total: reportedTotal || calculatedTotal
  };
}

export function normalizeTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeModel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "unknown";
  }
  return value.trim().slice(0, 120);
}

export function normalizeMode({ serviceTier, speed } = {}) {
  const safeServiceTier = typeof serviceTier === "string" ? serviceTier.slice(0, 40) : null;
  const safeSpeed = typeof speed === "string" ? speed.slice(0, 40) : null;
  return {
    serviceTier: safeServiceTier,
    speed: safeSpeed,
    fast: safeServiceTier === "priority" || safeSpeed === "fast"
  };
}

export function totalForComparison(event) {
  return event?.usage?.total || 0;
}
