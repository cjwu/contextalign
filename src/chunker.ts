const MAX_CHUNK_CHARS = 1200;
const HARD_CAP_CHARS = 2400;

interface Block {
  text: string;
  isCode: boolean;
}

export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const t = buffer.trim();
    if (t) chunks.push(t);
    buffer = "";
  };

  for (const block of parseBlocks(trimmed)) {
    if (block.isCode) {
      flush();
      if (block.text.length <= HARD_CAP_CHARS) {
        chunks.push(block.text);
      } else {
        for (const part of splitByLines(block.text, HARD_CAP_CHARS)) {
          chunks.push(part);
        }
      }
      continue;
    }

    const paragraphs = block.text.split(/\n\s*\n/).filter((p) => p.trim());
    for (const para of paragraphs) {
      if (para.length > MAX_CHUNK_CHARS) {
        flush();
        for (const sent of splitSentences(para)) {
          if (buffer.length + sent.length + 1 > MAX_CHUNK_CHARS) flush();
          buffer += (buffer ? " " : "") + sent;
        }
        flush();
        continue;
      }
      if (buffer.length + para.length + 2 > MAX_CHUNK_CHARS) flush();
      buffer += (buffer ? "\n\n" : "") + para;
    }
  }

  flush();
  return chunks.length > 0 ? chunks : [trimmed.slice(0, MAX_CHUNK_CHARS)];
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const fenceRe = /```[\s\S]*?```/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > lastEnd) {
      const before = text.slice(lastEnd, match.index).trim();
      if (before) blocks.push({ text: before, isCode: false });
    }
    blocks.push({ text: match[0], isCode: true });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) {
    const tail = text.slice(lastEnd).trim();
    if (tail) blocks.push({ text: tail, isCode: false });
  }
  return blocks.length > 0 ? blocks : [{ text: text.trim(), isCode: false }];
}

function splitByLines(text: string, cap: number): string[] {
  const lines = text.split(/\n/);
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur.length + line.length + 1 > cap && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?。！？])\s+/);
  return parts.filter((s) => s.trim());
}
