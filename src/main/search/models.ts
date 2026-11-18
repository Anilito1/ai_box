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
  /** ONNX Runtime instead of llama.cpp: `file` is then a folder, made of `files`, each checked against its hash. */
  engine?: 'onnx';
  files?: { name: string; url: string; bytes: number; sha256: string }[];
}

const hf = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`;
/** The ONNX export of Qwen3 Embedding 0.6B (fp16), at the commit measured: its vectors match the GGUF's (cosine 0.9997). */
const QWEN3_ONNX = (file: string) => `https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/resolve/c25a394dd583836952667c12f008335071b3f43d/${file}`;
const QWEN3_ONNX_FILES = [
  { name: 'config.json', url: QWEN3_ONNX('config.json'), bytes: 1576, sha256: '66a10929782f3c9a3cd5dec90e2a95c60e05736134a63cd54479eeae80bed175' },
  { name: 'tokenizer.json', url: QWEN3_ONNX('tokenizer.json'), bytes: 11_423_705, sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
  { name: 'tokenizer_config.json', url: QWEN3_ONNX('tokenizer_config.json'), bytes: 9731, sha256: '977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1' },
  { name: 'onnx/model_fp16.onnx', url: QWEN3_ONNX('onnx/model_fp16.onnx'), bytes: 583_522, sha256: 'f376cf065d912675dd559270e19361367ebc28c938b9811dd61d5834c78d0834' },
  { name: 'onnx/model_fp16.onnx_data', url: QWEN3_ONNX('onnx/model_fp16.onnx_data'), bytes: 1_199_927_296, sha256: '06fbfded30166e3a33fe5252d7002ed1c370a4ec1bf45aba778cdf6cf7d31439' },
];
const CODE_TASK = 'Instruct: Given a question about a codebase, retrieve the code that answers it\nQuery: ';

export const MODELS: SearchModel[] = [
  { id: 'qwen3-embed-0.6b', kind: 'embed', label: 'Qwen3 Embedding 0.6B (Q8)', file: 'qwen3-embed-0.6b-q8.gguf', url: hf('Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), bytes: 639_150_592, sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439', license: 'Apache-2.0', pooling: 'last', query: CODE_TASK },
  { id: 'qwen3-embed-0.6b-onnx', kind: 'embed', label: 'Qwen3 Embedding 0.6B (ONNX fp16)', file: 'qwen3-embed-0.6b-onnx', url: QWEN3_ONNX(''), bytes: QWEN3_ONNX_FILES.reduce((n, f) => n + f.bytes, 0), license: 'Apache-2.0', pooling: 'last', query: CODE_TASK, engine: 'onnx', files: QWEN3_ONNX_FILES },
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
// Its ONNX export rather than the GGUF: the runtime is signed (Smart App Control blocks llama.cpp's binaries) and the
// answers are the same (test half, app path: hit@5 73.6 and MRR 0.568 for both).
export const EMBED_MODEL = 'qwen3-embed-0.6b-onnx';
/** None: on the dev questions the reranker moved the MRR by noise (0.696 to 0.711) for 640 MiB and up to 0.9 s a question. */
export const RERANK_MODEL: string | null = null;

export const modelOf = (id: string): SearchModel | undefined => MODELS.find((m) => m.id === id);
