import { join } from 'node:path';
import type { DataType, DeviceType } from '@huggingface/transformers';
import { resolveBookHome } from '../book-home.js';
import type { ZeroMemSemanticModel } from './zero-mem.js';

export interface PaperZeroMemModelOptions {
  embeddingModel?: string;
  nerModel?: string;
  cacheDir?: string;
  device?: DeviceType;
  dtype?: DataType;
  batchSize?: number;
  localFilesOnly?: boolean;
}

export interface LoadedPaperZeroMemModel {
  model: ZeroMemSemanticModel;
  loadMs: number;
  cacheDir: string;
  embeddingModel: string;
  nerModel: string;
  dispose(): Promise<void>;
}

interface NerEntity {
  word: string;
  score: number;
  entity_group?: string;
}

const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-m3';
const DEFAULT_NER_MODEL = 'Xenova/bert-base-NER';
const DEFAULT_BATCH_SIZE = 8;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function cleanEntity(value: string): string {
  return value.replaceAll(' ##', '').replaceAll('##', '').replace(/\s+/g, ' ').trim();
}

export async function createPaperZeroMemModel(
  options: PaperZeroMemModelOptions = {},
): Promise<LoadedPaperZeroMemModel> {
  const started = Date.now();
  const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const nerModel = options.nerModel ?? DEFAULT_NER_MODEL;
  const cacheDir =
    options.cacheDir ??
    process.env.BOOK_ZERO_MEM_MODEL_CACHE ??
    join(resolveBookHome(), 'models', 'zero-mem');
  const device = options.device ?? 'cpu';
  const dtype = options.dtype ?? 'q8';
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const localFilesOnly =
    options.localFilesOnly ?? process.env.BOOK_ZERO_MEM_LOCAL_FILES_ONLY === 'true';
  const { env, pipeline } = await import('@huggingface/transformers');
  if (localFilesOnly) {
    env.localModelPath = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  }
  const pipelineOptions = localFilesOnly
    ? { device, dtype, local_files_only: true }
    : { cache_dir: cacheDir, device, dtype };
  const [embeddingPipeline, nerPipeline] = await Promise.all([
    pipeline('feature-extraction', embeddingModel, pipelineOptions),
    pipeline('token-classification', nerModel, pipelineOptions),
  ]);

  const model: ZeroMemSemanticModel = {
    name: `${embeddingModel}+${nerModel}:${dtype}:${device}`,
    async embed(texts) {
      const embeddings: Float32Array[] = [];
      for (const batch of chunks(texts, batchSize)) {
        const output = await embeddingPipeline(batch, { pooling: 'mean', normalize: true });
        const rows = output.tolist() as number[][];
        for (const row of rows) embeddings.push(Float32Array.from(row));
      }
      return embeddings;
    },
    async extractEntities(texts) {
      const entities: string[][] = [];
      for (const batch of chunks(texts, batchSize)) {
        const output = (await nerPipeline(batch, {
          aggregation_strategy: 'simple',
        })) as NerEntity[][];
        for (const items of output) {
          entities.push(
            items
              .filter((item) => item.score >= 0.5)
              .map((item) => cleanEntity(item.word))
              .filter(Boolean),
          );
        }
      }
      return entities;
    },
  };
  return {
    model,
    loadMs: Date.now() - started,
    cacheDir,
    embeddingModel,
    nerModel,
    async dispose() {
      await Promise.all([embeddingPipeline.dispose(), nerPipeline.dispose()]);
    },
  };
}
