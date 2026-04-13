"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_EMBEDDING_DIM = void 0;
exports.embedHash = embedHash;
exports.embed = embed;
exports.createAsyncEmbedder = createAsyncEmbedder;
const sha256_1 = require("@noble/hashes/sha256");
/** Vector size for `Xenova/all-MiniLM-L6-v2` and the default `memory_vectors` schema. */
exports.SEMANTIC_EMBEDDING_DIM = 384;
/** Deterministic hash → L2-normalized vector (default backend). */
function embedHash(text, embeddingDim = exports.SEMANTIC_EMBEDDING_DIM) {
    const hash = (0, sha256_1.sha256)(Buffer.from(text, 'utf8'));
    const vec = new Float32Array(embeddingDim);
    for (let i = 0; i < embeddingDim; i++) {
        vec[i] = (hash[i % 32] / 127.5) - 1.0;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0)
        for (let i = 0; i < vec.length; i++)
            vec[i] /= norm;
    return vec;
}
/** @deprecated Use `embedHash`; kept for backwards compatibility. */
function embed(text, embeddingDim = exports.SEMANTIC_EMBEDDING_DIM) {
    return embedHash(text, embeddingDim);
}
function l2Normalize(vec) {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm <= 0)
        return vec;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++)
        out[i] = vec[i] / norm;
    return out;
}
function toFloat32Length(v, dim) {
    if (v.length === dim)
        return l2Normalize(v);
    const out = new Float32Array(dim);
    if (v.length >= dim) {
        out.set(v.subarray(0, dim));
    }
    else {
        out.set(v);
    }
    return l2Normalize(out);
}
function tensorDataToFloat32(raw) {
    let cur = raw;
    for (let depth = 0; depth < 6; depth++) {
        if (cur instanceof Float32Array)
            return cur;
        if (Array.isArray(cur))
            return Float32Array.from(cur);
        if (cur && typeof cur === 'object' && 'data' in cur) {
            const d = cur.data;
            if (d instanceof Float32Array)
                return d;
            if (d instanceof ArrayBuffer)
                return new Float32Array(d);
            if (Array.isArray(d))
                return Float32Array.from(d);
            cur = d;
            continue;
        }
        break;
    }
    throw new Error('Unexpected embedding tensor shape from feature extractor');
}
let semanticPipelinePromise = null;
async function loadSemanticPipeline() {
    if (!semanticPipelinePromise) {
        semanticPipelinePromise = (async () => {
            try {
                const { pipeline } = await Promise.resolve().then(() => __importStar(require('@xenova/transformers')));
                return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                throw new Error(`semantic embeddings need optional dependency @xenova/transformers (${msg}). Install: npm install @xenova/transformers`);
            }
        })();
    }
    return (await semanticPipelinePromise);
}
/**
 * Builds the async embedder used by MemoryStore / EncryptedSync.
 * - `embed` custom fn wins over `embeddings`.
 * - `embeddings: 'semantic'` uses Xenova all-MiniLM-L6-v2 (384-dim, L2-normalized).
 * - Default: hash backend.
 */
function createAsyncEmbedder(config) {
    const dim = config.embeddingDimensions ?? exports.SEMANTIC_EMBEDDING_DIM;
    if (config.embed) {
        const fn = config.embed;
        return async (text) => {
            const v = await Promise.resolve(fn(text, dim));
            return toFloat32Length(v, dim);
        };
    }
    if (config.embeddings === 'semantic') {
        if (dim !== exports.SEMANTIC_EMBEDDING_DIM) {
            throw new Error(`embeddings: "semantic" requires embeddingDimensions: ${exports.SEMANTIC_EMBEDDING_DIM} (all-MiniLM-L6-v2).`);
        }
        return async (text) => {
            const pipe = await loadSemanticPipeline();
            const raw = await pipe(text, { pooling: 'mean', normalize: true });
            const data = tensorDataToFloat32(raw);
            return toFloat32Length(data, exports.SEMANTIC_EMBEDDING_DIM);
        };
    }
    return async (text) => embedHash(text, dim);
}
//# sourceMappingURL=embeddings.js.map