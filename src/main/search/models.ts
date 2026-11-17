/** A model the local server can load. Every file comes from Hugging Face; nothing but these downloads uses the network. */
export interface SearchModel {
  id: string;
  kind: 'embed' | 'rerank';
  label: string;
  /** File name under the models folder. */
  file: string;
  url: string;
  bytes: number;
  /** Of the file, checked after its download when known. */
  sha256?: string;
  license: string;
  /** How the token states become one vector (embedding models). */
  pooling?: 'last' | 'mean' | 'cls';
  /** What the model was trained to read before a question; documents go as they are unless `passage` is set. */
  query?: string;
  passage?: string;
}

const hf = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`;
const CODE_TASK = 'Instruct: Given a question about a codebase, retrieve the code that answers it\nQuery: ';

export const MODELS: SearchModel[] = [
  { id: 'qwen3-embed-0.6b', kind: 'embed', label: 'Qwen3 Embedding 0.6B (Q8)', file: 'qwen3-embed-0.6b-q8.gguf', url: hf('Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), bytes: 639_150_592, sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439', license: 'Apache-2.0', pooling: 'last', query: CODE_TASK },
  { id: 'qwen3-embed-4b', kind: 'embed', label: 'Qwen3 Embedding 4B (Q4_K_M)', file: 'qwen3-embed-4b-q4.gguf', url: hf('Qwen/Qwen3-Embedding-4B-GGUF', 'Qwen3-Embedding-4B-Q4_K_M.gguf'), bytes: 2_496_703_776, sha256: '2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b', license: 'Apache-2.0', pooling: 'last', query: CODE_TASK },
  { id: 'qwen3-embed-8b', kind: 'embed', label: 'Qwen3 Embedding 8B (Q4_K_M)', file: 'qwen3-embed-8b-q4.gguf', url: hf('Qwen/Qwen3-Embedding-8B-GGUF', 'Qwen3-Embedding-8B-Q4_K_M.gguf'), bytes: 4_683_074_240, license: 'Apache-2.0', pooling: 'last', query: CODE_TASK },
  { id: 'nemotron-3-embed-1b', kind: 'embed', label: 'Nemotron 3 Embed 1B (Q8)', file: 'nemotron-3-embed-1b-q8.gguf', url: hf('NeoRoth/nemotron-3-embed-1b-gguf', 'nemotron-3-embed-1b-q8_0.gguf'), bytes: 1_220_293_760, sha256: '58e41095862c50bc084bb8afa9b00e586733faaef2627d88c3e04da80d8d8e92', license: 'OpenMDW-1.1', pooling: 'mean', query: 'query: ', passage: 'passage: ' },
  { id: 'embeddinggemma-300m', kind: 'embed', label: 'EmbeddingGemma 300M (QAT Q8)', file: 'embeddinggemma-300m-q8.gguf', url: hf('ggml-org/embeddinggemma-300m-qat-q8_0-GGUF', 'embeddinggemma-300m-qat-Q8_0.gguf'), bytes: 328_577_056, sha256: '6fa0c02a9c302be6f977521d399b4de3a46310a4f2621ee0063747881b673f67', license: 'Gemma', pooling: 'mean', query: 'task: code retrieval | query: ', passage: 'title: none | text: ' },
  // Non-commercial licence: measured, not shipped.
  { id: 'jina-code-0.5b', kind: 'embed', label: 'Jina Code Embeddings 0.5B (Q8)', file: 'jina-code-0.5b-q8.gguf', url: hf('jinaai/jina-code-embeddings-0.5b-GGUF', 'jina-code-embeddings-0.5b-Q8_0.gguf'), bytes: 531_065_120, sha256: '2f8aa3f34f1fae493ff9f6f7894ca7ba390b0d9a58fa0b4e65709a041beb0dc5', license: 'CC-BY-NC-4.0', pooling: 'last', query: 'Find the most relevant code snippet given the following query:\n', passage: 'Candidate code snippet:\n' },
  { id: 'jina-code-1.5b', kind: 'embed', label: 'Jina Code Embeddings 1.5B (Q8)', file: 'jina-code-1.5b-q8.gguf', url: hf('jinaai/jina-code-embeddings-1.5b-GGUF', 'jina-code-embeddings-1.5b-Q8_0.gguf'), bytes: 1_646_569_888, license: 'CC-BY-NC-4.0', pooling: 'last', query: 'Find the most relevant code snippet given the following query:\n', passage: 'Candidate code snippet:\n' },
  { id: 'nomic-embed-code',kind: 'embed', label: 'Nomic Embed Code 7B (Q4_K_M)', file: 'nomic-embed-code-q4.gguf', url: hf('nomic-ai/nomic-embed-code-GGUF', 'nomic-embed-code.Q4_K_M.gguf'), bytes: 4_376_511_808, license: 'Apache-2.0', pooling: 'last', query: 'Represent this query for searching relevant code: ' },
  { id: 'qwen3-rerank-0.6b', kind: 'rerank', label: 'Qwen3 Reranker 0.6B (Q8)', file: 'qwen3-rerank-0.6b-q8.gguf', url: hf('ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', 'qwen3-reranker-0.6b-q8_0.gguf'), bytes: 639_153_184, sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48', license: 'Apache-2.0' },
  { id: 'qwen3-rerank-4b', kind: 'rerank', label: 'Qwen3 Reranker 4B (Q4_K_M)', file: 'qwen3-rerank-4b-q4.gguf', url: hf('Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp', 'Qwen3-Reranker-4B-Q4_K_M.gguf'), bytes: 2_496_717_440, license: 'Apache-2.0' },
];

/** What the app installs and uses; the others are there for the measures (scripts/search-bench). */
// Not nemotron-3-embed-1b: ahead on the dev half, level on the test half (hit@5 +2.8, CI -1.7 to +7.3) for 1.5 GiB of
// video memory instead of 0.9 and 2.0 GB of memory instead of 1.4.
export const EMBED_MODEL = 'qwen3-embed-0.6b';
/** None: on the dev questions the reranker moved the MRR by noise (0.696 to 0.711) for 640 MiB and up to 0.9 s a question. */
export const RERANK_MODEL: string | null = null;

export const modelOf = (id: string): SearchModel | undefined => MODELS.find((m) => m.id === id);
