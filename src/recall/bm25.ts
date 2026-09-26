/**
 * BM25 retrieval over the local mirror.
 *
 * Replaces the original keyword scorer, which matched whole CJK characters
 * with `String.includes` and ranked by raw hit count. That approach gave every
 * memory containing a common character (的/项/目) a non-zero score, so the
 * ranking was close to random: on 424 shadow-logged queries it reached
 * mean overlap@5 of 0.269/5 and put the remote top-1 in the local top-10 only
 * 5.0% of the time.
 *
 * Two changes carry the improvement:
 * - CJK is indexed as overlapping bigrams. Single characters are too common to
 *   discriminate; bigrams recover most of the precision a real segmenter gives
 *   without the dictionary (中文 -> 中文).
 * - Ranking is BM25 with IDF and length normalization, so a rare term in a short
 *   memory outweighs a common term in a long one.
 *
 * No network, no state, no provider: this channel never fails, which makes it the
 * always-available floor under the dense and rerank channels.
 */

/** Default BM25 parameters. k1 damps term-frequency saturation, b sets the
 *  strength of length normalization. 1.2/0.75 is the standard starting point. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * Tokenize into discriminating units:
 * - runs of Latin letters/digits/underscore stay whole, lowercased
 *   ("HK-Express" -> "hk", "express")
 * - CJK runs become overlapping bigrams ("香港出发" -> "香港","港出","出发")
 * - a lone CJK character is kept as a unigram so single-character queries work
 */
export function tokenizeBM25(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let latin = "";
  let cjkRun: string[] = [];

  const flushLatin = () => {
    if (latin.length > 0) {
      tokens.push(latin);
      latin = "";
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 0) return;
    if (cjkRun.length === 1) tokens.push(cjkRun[0]);
    else for (let i = 0; i < cjkRun.length - 1; i++) tokens.push(cjkRun[i] + cjkRun[i + 1]);
    cjkRun = [];
  };

  for (const ch of lower) {
    if (isCjk(ch)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (/[a-z0-9_]/.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return tokens;
}

export interface Bm25Doc {
  id: string;
  text: string;
}

interface IndexedDoc {
  id: string;
  /** term -> within-document frequency */
  tf: Map<string, number>;
  length: number;
}

export interface Bm25Index {
  docs: IndexedDoc[];
  /** term -> number of documents containing it */
  df: Map<string, number>;
  avgLength: number;
}

/** Build a BM25 index. Rebuild per query: at a few thousand short memories this
 *  costs far less than maintaining it incrementally across the JSON store. */
export function buildBm25Index(docs: Bm25Doc[], tokenize = tokenizeBM25): Bm25Index {
  const indexed: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    indexed.push({ id: doc.id, tf, length: tokens.length });
    totalLength += tokens.length;
  }

  return { docs: indexed, df, avgLength: indexed.length === 0 ? 0 : totalLength / indexed.length };
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** Query terms that matched nothing in the corpus — useful diagnostics for
   *  judging whether a zero-recall query was a vocabulary gap or a ranking miss. */
  unmatched: string[];
}

export function searchBm25(
  index: Bm25Index,
  query: string,
  opts: { k1?: number; b?: number; limit?: number; tokenize?: (t: string) => string[] } = {},
): Bm25Hit[] {
  const tokenize = opts.tokenize ?? tokenizeBM25;
  const k1 = opts.k1 ?? BM25_K1;
  const b = opts.b ?? BM25_B;
  const limit = opts.limit ?? 10;
  const n = index.docs.length;
  if (n === 0) return [];

  // Query term frequencies, deduped: repeated query terms shouldn't multiply.
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const unmatched: string[] = [];
  const scores = new Map<string, number>();

  for (const term of queryTerms) {
    const df = index.df.get(term) ?? 0;
    if (df === 0) {
      unmatched.push(term);
      continue;
    }
    // Fully-saturated IDF keeps a term present in every doc from going negative
    // (the classic Lucene form).
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const doc of index.docs) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const norm = 1 - b + b * (index.avgLength === 0 ? 1 : doc.length / index.avgLength);
      scores.set(doc.id, (scores.get(doc.id) ?? 0) + (idf * (tf * (k1 + 1))) / (tf + k1 * norm));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, unmatched }))
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .slice(0, limit);
}
