import { StringDecoder } from "node:string_decoder";

export interface LineSplitter {
  push(chunk: Buffer): void;
  end(): void;
}

/**
 * Split a byte stream into JSONL records the way pi's RPC mode frames them.
 *
 * Hand-rolled ON PURPOSE (D1). pi's docs say so in as many words: "Node
 * `readline` is not protocol-compliant for RPC mode because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings" (docs/rpc.md:28-37).
 * A job description pasted into a prompt is exactly the kind of text that
 * carries one, and the failure mode is a silently truncated record rather than
 * an error.
 *
 * So: split on "\n" and nothing else, strip ONE optional trailing "\r" (the
 * docs' stated tolerance), and flush whatever is left when the stream ends —
 * a child killed mid-write still gets its last complete-enough record read.
 *
 * `StringDecoder` rather than `chunk.toString()`: a multi-byte character can
 * straddle two chunks, and decoding each chunk independently turns it into two
 * replacement characters inside an otherwise valid JSON string.
 *
 * Empty records are dropped rather than passed on — a trailing newline at the
 * end of the stream would otherwise hand the caller "" to JSON.parse.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let ended = false;

  const emit = (record: string) => {
    const line = record.endsWith("\r") ? record.slice(0, -1) : record;
    if (line.length > 0) onLine(line);
  };

  return {
    push(chunk: Buffer) {
      if (ended) return;
      buffer += decoder.write(chunk);
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    end() {
      if (ended) return;
      ended = true;
      buffer += decoder.end();
      const remainder = buffer;
      buffer = "";
      if (remainder.length > 0) emit(remainder);
    },
  };
}
