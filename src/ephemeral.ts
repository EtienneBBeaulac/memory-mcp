// Ephemeral content detection — soft warnings at store time.
//
// Design: declarative signal registry. Each signal is a simple object with
// an id, label, confidence, and a test function. Adding a new signal = appending
// one object to the SIGNALS array. No other code changes needed.
//
// Two detection layers:
//   1. Regex signals (instant, interpretable, 100% precision on known patterns)
//   2. TF-IDF classifier (catches subtle cases regex misses, ~81% precision)
//
// The TF-IDF layer fires only when NO regex signals matched — it's a safety net,
// not a replacement. When it fires, confidence is 'low' to reflect its lower
// precision compared to regex.
//
// Philosophy: soft warnings, never hard blocks. False positives (blocking good
// content) are far more expensive than false negatives (allowing ephemeral content
// through, which staleness handles naturally).

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TopicScope } from './types.js';

// ─── TF-IDF Classifier ────────────────────────────────────────────────────
// Lightweight logistic regression over TF-IDF features. Trained on 400+
// labeled examples. Catches subtle ephemeral content that regex misses
// (narrative style, first-person-plural, past-tense problem descriptions).
// Zero external dependencies — just JSON weights + simple math.

interface ClassifierModel {
  readonly version?: number;
  readonly vocabulary: readonly string[];
  readonly idf: readonly number[];
  readonly weights: readonly number[];
  readonly bias: number;
  // v2 additions: engineered features
  readonly extra_features?: readonly string[];
  readonly extra_weights?: readonly number[];
}

let cachedModel: ClassifierModel | null = null;

function loadModel(): ClassifierModel | null {
  if (cachedModel) return cachedModel;
  const dir = dirname(fileURLToPath(import.meta.url));
  // Try: same dir as the JS file (works for both src/ with tsx and dist/ after build)
  const candidates = [
    join(dir, 'ephemeral-weights.json'),
    join(dir, '..', 'src', 'ephemeral-weights.json'),
    join(dir, '..', 'dist', 'ephemeral-weights.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      cachedModel = JSON.parse(raw) as ClassifierModel;
      return cachedModel;
    } catch { /* try next */ }
  }
  return null;
}

function tokenize(text: string, includeBigrams: boolean): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_]+/g) ?? [];
  if (!includeBigrams) return words;
  // Append bigrams
  const tokens = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }
  return tokens;
}

const KNOWN_TOPICS = ['architecture', 'conventions', 'gotchas', 'preferences', 'user', 'recent-work'];
const PRESCRIPTIVE_WORDS = new Set(['must', 'always', 'never', 'all', 'every', 'ensure', 'required']);
const FIRST_PLURAL_WORDS = new Set(['we', 'our', 'us', "we've", "we're", "we'd"]);
const PAST_TENSE_WORDS = new Set(['was', 'were', 'had', 'did', 'found', 'discovered', 'noticed', 'observed', 'saw']);
const CONJUNCTION_WORDS = new Set(['but', 'however', 'though', 'although', 'yet']);

/** Extract engineered features for v2 model — order must match training. */
function extractExtraFeatures(title: string, content: string, topic: string): Map<string, number> {
  const text = `${title}. ${content}`.toLowerCase();
  const words = text.match(/\b\w+\b/g) ?? [];
  const wLen = Math.max(words.length, 1);
  const features = new Map<string, number>();

  // Content length buckets
  features.set('_len_short', content.length < 100 ? 1.0 : 0.0);
  features.set('_len_medium', content.length >= 100 && content.length < 250 ? 1.0 : 0.0);
  features.set('_len_long', content.length >= 250 ? 1.0 : 0.0);

  // Linguistic ratios (scaled by 10 to match training)
  let fp = 0, pt = 0, pr = 0, cj = 0;
  for (const w of words) {
    if (FIRST_PLURAL_WORDS.has(w)) fp++;
    if (PAST_TENSE_WORDS.has(w)) pt++;
    if (PRESCRIPTIVE_WORDS.has(w)) pr++;
    if (CONJUNCTION_WORDS.has(w)) cj++;
  }
  features.set('_first_person_plural_ratio', fp / wLen * 10);
  features.set('_past_tense_ratio', pt / wLen * 10);
  features.set('_prescriptive_ratio', pr / wLen * 10);
  features.set('_conjunction_ratio', cj / wLen * 10);

  // Topic encoding
  const baseTopic = topic.includes('/') ? topic.split('/')[0] : topic;
  for (const t of KNOWN_TOPICS) features.set(`_topic_${t}`, baseTopic === t ? 1.0 : 0.0);
  features.set('_topic_modules', topic.startsWith('modules/') ? 1.0 : 0.0);

  // Sentence count (normalized)
  const sentences = (content.match(/[.!?]+/g) ?? []).length;
  features.set('_sentence_count', Math.min(sentences / 5.0, 1.0));

  return features;
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Run the TF-IDF classifier on a text. Returns probability 0-1 that content is ephemeral.
 *  Supports both v1 (unigrams only) and v2 (bigrams + engineered features) models. */
export function classifyEphemeral(title: string, content: string, topic?: string): number | null {
  const model = loadModel();
  if (!model) return null;

  const isV2 = (model.version ?? 1) >= 2;
  const text = `${title}. ${content}`;
  const tokens = tokenize(text, isV2);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const maxTf = Math.max(...tf.values(), 1);

  // Build TF-IDF vector
  const vocabIndex = new Map(model.vocabulary.map((v, i) => [v, i]));
  const vector = new Float64Array(model.vocabulary.length);

  for (const [token, count] of tf) {
    const idx = vocabIndex.get(token);
    if (idx !== undefined) {
      const tfVal = 0.5 + 0.5 * (count / maxTf);
      vector[idx] = tfVal * model.idf[idx];
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;

  // TF-IDF dot product
  let z = model.bias;
  for (let i = 0; i < vector.length; i++) z += vector[i] * model.weights[i];

  // v2: add engineered feature contributions
  if (isV2 && model.extra_features && model.extra_weights) {
    const extras = extractExtraFeatures(title, content, topic ?? 'architecture');
    for (let i = 0; i < model.extra_features.length; i++) {
      const val = extras.get(model.extra_features[i]) ?? 0;
      z += val * model.extra_weights[i];
    }
  }

  return sigmoid(z);
}

/** Confidence level for an ephemeral signal — affects how strongly we warn */
export type SignalConfidence = 'high' | 'medium' | 'low';

/** A single detected ephemeral signal */
export interface EphemeralSignal {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly confidence: SignalConfidence;
}

// ─── Signal definition ─────────────────────────────────────────────────────
// Each signal defines: what to look for, how confident we are, and a human-
// readable explanation. The `test` function receives lowercase title+content
// and returns a detail string (truthy = matched) or undefined (no match).

interface SignalDefinition {
  readonly id: string;
  readonly label: string;
  readonly confidence: SignalConfidence;
  /** Topics to skip detection for (e.g. recent-work is ephemeral by design) */
  readonly skipTopics?: readonly TopicScope[];
  /** Returns a detail string if the signal fires, undefined otherwise */
  readonly test: (title: string, content: string, raw: { title: string; content: string }) => string | undefined;
}

// ─── Pattern helpers ────────────────���───────���──────────────────────────────
// Tiny utilities for building signal tests declaratively.

/** Returns the first matching pattern's match, or undefined */
function firstMatch(text: string, patterns: readonly RegExp[]): RegExpMatchArray | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return undefined;
}

/** Count how many patterns match in the text */
function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.filter(p => p.test(text)).length;
}

// ─── Signal registry ───────────────────────────────────────────────────────
// To add a new signal: append an object here. No other changes needed.

const SIGNALS: readonly SignalDefinition[] = [

  // ── Temporal language ──────────────────────────────────────────────────
  {
    id: 'temporal',
    label: 'Temporal language',
    confidence: 'high',
    test: (_title, content) => {
      const patterns = [
        /\bcurrently\b/, /\bright now\b/, /\bat the moment\b/,
        /\bas of today\b/, /\bas of now\b/, /\btoday\b/,
        /\bjust (now|happened|found|noticed|discovered|tried|ran|tested)\b/,
        /\bat this point\b/, /\bfor now\b/, /\btemporarily\b/,
        /\bin progress\b/, /\bongoing\b/,
        // Session/run-specific
        /\bin this session\b/, /\bthis run\b/,
        /\bas things stand\b/, /\bgiven the current state\b/,
        /\bstill (pending|waiting|blocked)\b/,
        /\blast time (i|we) (ran|checked|tested)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `contains "${m[0]}"` : undefined;
    },
  },

  // ── Fixed/resolved bugs ────────────────────────────────────────────────
  {
    id: 'fixed-bug',
    label: 'Resolved issue',
    confidence: 'high',
    test: (_title, content) => {
      const patterns = [
        /\b(bug|issue|problem|crash|error)\b.*\b(fixed|resolved|patched|addressed|corrected)\b/,
        /\b(fixed|resolved|patched)\b.*\b(bug|issue|problem|crash|error)\b/,
        /\bwas (broken|failing|crashing)\b/,
        /\bno longer (fails|crashes|breaks|errors)\b/,
        /\bhas been (fixed|resolved|patched|addressed)\b/,
        /\bworkaround[\s\S]{0,60}no longer needed\b/,
        /\bthis (was|used to be) a (bug|issue|problem)\b/,
        // Breakage narrative (broke/broken after a change)
        /\bbroke (after|during|when|on)\b/,
        /\bbroken after\b/,
        // Post-fix narrative
        /\b(works|working) now\b/,
        /\b(closes|fixes|resolved) #\d+\b/,
        /\bturns? out (it was|the|that)\b/,
        /\b(false alarm|non-issue|not a bug|user error)\b/,
        /\bafter the (fix|patch|update|upgrade)\b/,
        /\bonce we (patched|fixed|updated|upgraded)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — resolved issues don't need long-term memory` : undefined;
    },
  },

  // ── Task/TODO language ─────────────────────────────────────────────────
  {
    id: 'task-language',
    label: 'Task/TODO language',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\b(we|i) need to\b/, /\bnext step\b/, /\btodo\b/i,
        /\bwill (do|implement|fix|add|create|update)\b/,
        /\bplan to\b/, /\b(we|i|you) should (do|fix|add|create|update|refactor)\b/,
        /\bremember to\b/, /\bdon'?t forget\b/,
        // Code comment markers used in prose (content is lowercased)
        /\bfixme\b/,
        // Work-in-progress indicators
        /\b(wip|work in progress)\b/, /\b(prototype|poc|proof of concept)\b/,
        // Unfinished / partial work
        /\b(partial|incomplete)\b.*\bimplementation\b/,
        /\b(doesn'?t|don'?t) (handle|support|implement).*\byet\b/,
        /\bis (underway|not finished|not complete)\b/,
        /\bblocked on\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `contains "${m[0]}" — task tracking doesn't belong in long-term memory` : undefined;
    },
  },

  // ── Stack traces / debug logs ──────────────────────────────────────────
  {
    id: 'stack-trace',
    label: 'Stack trace or debug log',
    confidence: 'high',
    test: (_title, _content, raw) => {
      // Check the raw (non-lowercased) content for typical stack trace patterns
      const stackPatterns = [
        /^\s+at\s+[\w.$]+\(.*:\d+\)/m,               // Java/Kotlin: "at com.foo.Bar(File.kt:42)"
        /^\s+at\s+[\w.$]+\.[\w$]+\(.*\)/m,            // Java: "at com.foo.Bar.method(File.java:10)"
        /^\s+File ".*", line \d+/m,                    // Python: 'File "foo.py", line 42'
        /^\s+\d+\s*\|/m,                               // Numbered log lines: "  42 | something"
        /Caused by:\s/m,                                // Java exception chains
        /Traceback \(most recent call last\)/m,         // Python traceback
        /^Error:.*\n\s+at\s/m,                         // Node.js: "Error: msg\n  at ..."
      ];
      const m = firstMatch(raw.content, stackPatterns);
      return m ? 'contains stack trace or debug log output' : undefined;
    },
  },

  // ── Environment-specific values ────────────────────────────────────────
  {
    id: 'environment-specific',
    label: 'Environment-specific values',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\b(?:localhost|127\.0\.0\.1):\d+\b/,          // localhost:8080
        /\bport\s+\d{4,5}\b/,                          // "port 3000"
        /\bpid\s*[:=]?\s*\d+\b/,                       // "pid: 12345" or "PID 12345"
        /\/(?:users|home)\/\w+\//i,                     // absolute home paths
        /\b[a-f0-9]{40}\b/,                             // full git SHAs (40 hex)
      ];
      const hits = countMatches(content, patterns);
      return hits >= 2
        ? `contains ${hits} environment-specific values (paths, ports, PIDs)`
        : undefined;
    },
  },

  // ── Verbatim code blocks ───────────────────────────────────────────────
  {
    id: 'verbatim-code',
    label: 'Mostly verbatim code',
    confidence: 'low',
    test: (_title, _content, raw) => {
      // Heuristic: high density of code-like characters
      const codeChars = (raw.content.match(/[{}();=><]/g) ?? []).length;
      const ratio = raw.content.length > 0 ? codeChars / raw.content.length : 0;
      // Also check for triple-backtick fenced blocks
      const fences = (raw.content.match(/```/g) ?? []).length;
      if (ratio > 0.08 && raw.content.length > 100) {
        return `high code-character density (${Math.round(ratio * 100)}%) — store the pattern, not the code`;
      }
      if (fences >= 2 && raw.content.length > 100) {
        return 'contains fenced code blocks — store the insight, not the snippet';
      }
      return undefined;
    },
  },

  // ── Session investigation language ─────────────────────────────────────
  {
    id: 'investigation',
    label: 'Active investigation',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\b(investigating|looking into|digging into)\b/,
        // "debugging X" at start or after subject, but not "when debugging" (methodology)
        /(?<!\bwhen )\bdebugging (the|a|an|this|that|our|my)\b/,
        /\b(trying to (figure out|understand|find|fix))\b/,
        /\b(still (working on|figuring out|debugging))\b/,
        /\bhaven'?t (figured out|found|fixed|determined)\b/,
        // Session-specific actions
        /\blet me (check|verify|test|confirm)\b/,
        /\b(can'?t|unable to|couldn'?t) reproduce\b/,
        /\b(seeing|getting|receiving) (an? )?(\w*)?(error|crash|exception|failure)/,
        /\b(not sure|unclear|don'?t know) why\b/,
        /\b(added|adding) (logging|debug|print)\b/,
        // Observed instability (active problem)
        /\b(failing|crashing|timing out) (intermittent|on)\b/,
        /\bintermittent(ly)? (fail|crash|error|timeout|429|500|503)\b/,
        /\b(flaky|flaking) (on|in|during)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — store conclusions, not in-progress investigations` : undefined;
    },
  },

  // ── Uncertainty / speculation ────────────────────────────────────────────
  {
    id: 'uncertainty',
    label: 'Uncertain or speculative',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\bi think\b/, /\bi believe\b/, /\bi suspect\b/,
        /\bmaybe\b/, /\bperhaps\b/, /\bprobably\b/,
        /\bnot sure\b/, /\bnot certain\b/, /\bunsure\b/,
        /\bmight be (because|due to|related|caused)\b/,
        /\bcould be (because|due to|related|caused|a)\b/,
        /\bseems like\b/, /\bappears to be\b/, /\blooks like it\b/,
        /\bguess(ing)?\b/, /\bhypothesis\b/,
        /\bnot confirmed\b/, /\bunverified\b/,
        // Explicit knowledge limitations
        /\bas far as i know\b/, /\bif i'?m not mistaken\b/,
        /\bto the best of my knowledge\b/,
        /\bi could be wrong\b/, /\bi could be way off\b/,
        // Explicit speculation markers
        /\bspitballing\b/, /\bjust (a thought|throwing this out|an idea)\b/,
        /\btake this with a grain of salt\b/,
        /\byour mileage may vary\b/, /\bworks for me\b/,
        /\bworking theory\b/, /\bi'?m speculating\b/,
        // Unresolved / pending determination
        /\bit remains to be seen\b/, /\bsubject to change\b/,
        /\btbd\b/, /\bto be determined\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — store verified facts, not speculation` : undefined;
    },
  },

  // ── Self-correction / retraction ───────────────────────────────────────
  {
    id: 'self-correction',
    label: 'Self-correction or retraction',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\bactually,? wait\b/, /\bnever mind\b/, /\bscratch that\b/,
        /\bon second thought\b/, /\bthat'?s not quite right\b/,
        /\bi take (that|it) back\b/, /\bi misspoke\b/,
        /\bupon further reflection\b/, /\blet me reconsider\b/,
        /\bi was wrong\b/, /\bi retract\b/, /\bignore (that|this|what i said)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — self-corrections indicate in-flight thinking, not stable knowledge` : undefined;
    },
  },

  // ── Meeting / conversation references ─────────────────────────────────
  {
    id: 'meeting-reference',
    label: 'Meeting or conversation reference',
    confidence: 'low',
    test: (_title, content) => {
      const patterns = [
        /\bas discussed in (the|today'?s?|yesterday'?s?) (meeting|sync|standup|call)\b/,
        /\bper (our|the) (discussion|conversation|sync|call)\b/,
        /\bin (today'?s?|yesterday'?s?) (meeting|sync|standup|call|retro)\b/,
        /\b(he|she|they|someone|\w+) (mentioned|said|pointed out|noted) (that |in )/,
        /\bjust (heard|learned) from\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — store the decision or fact, not the meeting reference` : undefined;
    },
  },

  // ── Pending decision / under evaluation ─────────────────────────────────
  {
    id: 'pending-decision',
    label: 'Pending decision',
    confidence: 'medium',
    test: (_title, content) => {
      const patterns = [
        /\bunder (evaluation|review|consideration|assessment)\b/,
        /\b(evaluating|assessing) (whether|if|the)\b/,
        /\b(has|have) not been (deployed|decided|finalized|chosen|scheduled)\b/,
        /\b(decision|config|configuration) (pending|has not|hasn'?t)\b/,
        /\bnot (yet )?(been )?(deployed|merged|released|shipped|implemented)\b/,
        /\b(being|is) (planned|evaluated|considered|debated)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — pending decisions aren't stable knowledge yet` : undefined;
    },
  },

  // ── Version-pinned / regression observations ──────────────────────────
  {
    id: 'version-pinned',
    label: 'Version-specific observation',
    confidence: 'low',
    test: (_title, content) => {
      // Match "X version N.N.N introduced/broke/caused/is incompatible"
      const patterns = [
        /\bv?\d+\.\d+\.\d+\b.*\b(introduced|broke|caused|regression|incompatible)\b/,
        /\b(introduced|broke|caused|regression|incompatible)\b.*\bv?\d+\.\d+\.\d+\b/,
        /\bversion \d+\.\d+.*\b(broke|regression|incompatible|breaking)\b/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — version-specific issues may be resolved in future updates` : undefined;
    },
  },

  // ── Metrics change / regression observation ───────────────────────────
  {
    id: 'metrics-change',
    label: 'Metrics change observation',
    confidence: 'low',
    test: (_title, content) => {
      // "X increased/jumped/dropped from N to N"
      const patterns = [
        /\b(increased|jumped|dropped|spiked|rose|fell|regressed|degraded) from\b.*\bto\b/,
        /\b(increased|jumped|dropped|spiked|rose|fell|regressed|degraded) (by|to) \d/,
      ];
      const m = firstMatch(content, patterns);
      return m ? `"${m[0]}" — metric changes are often transient observations` : undefined;
    },
  },

  // ── Very short content ─────────────────────────────────────────────────
  {
    id: 'too-short',
    label: 'Very short content',
    confidence: 'low',
    test: (_title, content) => {
      // Only flag if no references are likely being used as context
      return content.length < 20
        ? `only ${content.length} chars — consider adding more context for future usefulness`
        : undefined;
    },
  },

];

// ─── Public API ────────────────────────────────────────────────────────────

/** Detect ephemeral signals in a store request.
 *  Returns an array of matched signals, empty if content looks durable.
 *  Pure function — no side effects, no I/O. */
export function detectEphemeralSignals(
  title: string,
  content: string,
  topic: TopicScope,
): readonly EphemeralSignal[] {
  const lowerTitle = title.toLowerCase();
  const lowerContent = content.toLowerCase();
  const raw = { title, content };

  const signals: EphemeralSignal[] = [];

  for (const def of SIGNALS) {
    // Skip signals that don't apply to this topic
    if (def.skipTopics?.includes(topic)) continue;

    const detail = def.test(lowerTitle, lowerContent, raw);
    if (detail) {
      signals.push({
        id: def.id,
        label: def.label,
        detail,
        confidence: def.confidence,
      });
    }
  }

  // TF-IDF classifier layer — fires only when regex signals missed.
  // This catches subtle ephemeral content written in neutral prose.
  // Two-tier threshold: 0.65 for short content (higher FP risk), 0.55 for longer content.
  // Short durable entries (gotchas, conventions) often use "we" which biases the model.
  if (signals.length === 0 && topic !== 'recent-work' && topic !== 'user') {
    const score = classifyEphemeral(title, content, topic);
    const threshold = content.length < 200 ? 0.65 : 0.55;
    if (score !== null && score >= threshold) {
      signals.push({
        id: 'tfidf-classifier',
        label: 'ML classifier: likely ephemeral',
        detail: `model confidence ${(score * 100).toFixed(0)}% — narrative style suggests transient content`,
        confidence: 'low',
      });
    }
  }

  return signals;
}

/** Format ephemeral signals into a human-readable warning string.
 *  Returns undefined if no signals were detected. */
export function formatEphemeralWarning(signals: readonly EphemeralSignal[]): string | undefined {
  if (signals.length === 0) return undefined;

  const highCount = signals.filter(s => s.confidence === 'high').length;
  const severity = highCount >= 2 ? 'likely contains' : highCount === 1 ? 'possibly contains' : 'may contain';

  const lines = [
    `This entry ${severity} ephemeral content:`,
    ...signals.map(s => `  - ${s.label}: ${s.detail}`),
    '',
  ];

  // Scale the guidance with confidence — high-confidence gets direct advice,
  // low-confidence gets a softer suggestion to let the agent decide
  if (highCount >= 2) {
    lines.push('This is almost certainly session-specific. Consider deleting after your session.');
  } else if (highCount === 1) {
    lines.push('If this is a lasting insight, keep it. If session-specific, consider deleting after your session.');
  } else {
    lines.push('This might still be valid long-term knowledge — use your judgment.');
  }

  return lines.join('\n');
}
