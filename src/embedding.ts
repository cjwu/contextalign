import { pipeline } from "@huggingface/transformers";

const MODEL_NAME = "mixedbread-ai/mxbai-embed-large-v1";

let extractor: any = null;
let loading = false;

export async function initEmbedding(): Promise<void> {
  if (extractor || loading) return;
  loading = true;
  try {
    console.error(`[ContextAlign] Loading embedding model: ${MODEL_NAME}...`);
    // @ts-ignore - Transformers.js pipeline types are too complex for TS
    extractor = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32",
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      },
    });
    console.error(`[ContextAlign] Embedding model loaded.`);
  } catch (err) {
    console.error(`[ContextAlign] Failed to load embedding model:`, err);
  } finally {
    loading = false;
  }
}

export function isEmbeddingReady(): boolean {
  return extractor !== null;
}

export async function embed(text: string): Promise<Buffer | null> {
  if (!extractor) return null;

  try {
    const output = await extractor(text, { pooling: "cls", normalize: true });
    const data = output.data as Float32Array;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } catch (err) {
    console.error(`[ContextAlign] Embedding error:`, err);
    return null;
  }
}

export async function embedBatch(texts: string[]): Promise<(Buffer | null)[]> {
  if (!extractor || texts.length === 0) return texts.map(() => null);

  try {
    const output = await extractor(texts, { pooling: "cls", normalize: true });
    const data = output.data as Float32Array;
    const dims = output.dims as number[];
    const [n, dim] = dims;
    const results: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const slice = data.slice(i * dim, (i + 1) * dim);
      results.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    }
    return results;
  } catch (err) {
    console.error(`[ContextAlign] Batch embedding error:`, err);
    return texts.map(() => null);
  }
}

export function embeddingDimension(): number {
  return 1024; // mxbai-embed-large-v1 outputs 1024-dim vectors
}

export function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
