'use strict';

const crypto = require('crypto');

const COMMITMENT_TEXT = 'I choose to give this part of my life my attention and care. There will be days when I feel close to it and days when I do not. What matters is that I can return, remember my decision, and keep it with me.';
const COMMITMENT_VERSION = 'alzo.commitment.fixed.en.v1';
const COMMITMENT_SHA256 = '87edc1147b91f71e49bc9e35193a2c5dc848dd6d99f34d35a1ecc53c2315492f';
const { VOICE_DURATION_RULE } = require('./release-contract');

const MIN_VALID_AUDIO_MS = VOICE_DURATION_RULE.minimumAggregateSeconds * 1000;
const CAPTURE_ORDER = Object.freeze(['goal', 'purpose', 'reconnectionAnchor', 'commitment']);
const SEMANTIC_CAPTURE_ORDER = Object.freeze(['goal', 'purpose', 'reconnectionAnchor']);
const FORBIDDEN_CONTEXT_PATTERN = /(commitment|journal)/i;
const AUTHORITATIVE_SEMANTIC_CONTEXT_KEYS = Object.freeze(['goal', 'purpose', 'reconnectionAnchor']);
const AUTHORITATIVE_SEMANTIC_PLACEHOLDER_PATTERNS = Object.freeze([
  /^backend_transcription_pending(?::|$)/i,
  /^semantic_(?:unavailable|pending)(?::|$)/i,
  /^the goal i recorded for this journey\.?$/i,
  /^the reason i recorded for this goal\.?$/i,
  /^the obstacle i named in my recording\.?$/i,
  /^the return point i recorded for hard days\.?$/i,
  /^qa mock (?:goal|purpose|anchor|affirmation)/i,
]);
const DAILY_NOVELTY_DIMENSIONS = Object.freeze([
  'direct_phrase',
  'central_idea',
  'rhetorical_structure',
  'opening',
  'closing',
  'metaphor_image',
  'goal_interpretation_angle',
  'reconnection_anchor_use_framing_placement',
]);
const DAILY_NOVELTY_CHECK_KEYS = Object.freeze([
  'directPhraseDistinct',
  'centralIdeaDistinct',
  'structureDistinct',
  'openingDistinct',
  'closingDistinct',
  'metaphorDistinct',
  'goalInterpretationDistinct',
  'anchorUseDistinct',
]);

const FIRST_SYSTEM_PROMPT = `Write one short First Message in English and first person as the user speaking to themselves.

Use only Goal, Purpose, Reconnection Anchor and their exact source refs.

You may ONLY order, condense, clarify, connect and reflect existing user meaning.

Never invent facts, create a plan, add actions or next steps, coach, add generic motivation, speak in second person, mention ALZO or an app/system, introduce a new objective, use Commitment, use Journal or make an unsupported claim.

Return only the message text. No labels, quotes, JSON or explanation.`;

const DAILY_SYSTEM_PROMPT = `Write one short Daily Message in English and first person as the user speaking to themselves.

Use only Goal, Purpose, Reconnection Anchor, Mood, Alignment as emotional relationship to the 90-day Goal, First Message as continuity reference only and the selected canonical Daily history.

Use no source outside those supplied fields. Never interpret Alignment as compliance, productivity, discipline, performance, objective progress, success, failure or task completion. Never invent a fact, plan, action, result or new Goal. Never speak in second person or as ALZO, an app, coach, mentor, narrator, companion, motivational speaker or fictional future self.

Avoid repetition across direct phrase, central idea, structure, opening, closing, metaphor/image, Goal interpretation and Reconnection Anchor use/framing/placement.

Return only the message text. No labels, quotes, JSON or explanation.`;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function isAuthoritativeSemanticPlaceholder(value) {
  const text = clean(value);
  return !text || AUTHORITATIVE_SEMANTIC_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text));
}

function assertNoForbiddenKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return true;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONTEXT_PATTERN.test(key)) {
      const error = new Error(`forbidden_context_key:${path}.${key}`);
      error.code = 'FORBIDDEN_CONTEXT_KEY';
      throw error;
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
  return true;
}

function sourceRef(kind, capture = {}, transcript = '') {
  const text = clean(transcript);
  return {
    captureId: capture.captureId || capture.id || null,
    captureKind: kind,
    transcriptSha256: capture.transcriptSha256 || sha256(text),
    quotedText: text,
    start: 0,
    end: text.length,
  };
}

function semanticDisposition(kind, capture = {}, transcript = '') {
  const text = clean(transcript);
  if (capture.voicePresent === false) return { disposition: 'rerecord', reasonCode: 'no_voice' };
  if (capture.intelligible === false) return { disposition: 'rerecord', reasonCode: 'unintelligible_audio' };
  if (!text) return { disposition: 'rerecord', reasonCode: 'empty_transcript' };
  if (capture.usableContent === false) return { disposition: 'rerecord', reasonCode: 'no_usable_content' };
  if (capture.questionRelated === false) return { disposition: 'rerecord', reasonCode: 'unrelated_content' };
  if (kind === 'goal' && capture.goalConcrete === false) return { disposition: 'rerecord', reasonCode: 'goal_not_concrete' };
  if ((kind === 'purpose' || kind === 'reconnectionAnchor') && capture.richInterpretationCertain === false) {
    return { disposition: 'use_transcript_mirror', reasonCode: 'usable_semantics_uncertain' };
  }
  return { disposition: 'use_structured', reasonCode: 'supported' };
}

function buildSemanticExtraction(captures = {}) {
  assertNoForbiddenKeys(captures);
  const assessments = SEMANTIC_CAPTURE_ORDER.map((kind) => {
    const capture = captures[kind] || {};
    const transcript = clean(capture.transcript || capture.text);
    const disposition = semanticDisposition(kind, capture, transcript);
    return {
      captureKind: kind,
      captureId: capture.captureId || capture.id || null,
      ...disposition,
      sourceRef: transcript ? sourceRef(kind, capture, transcript) : null,
      value: disposition.disposition === 'rerecord' ? null : transcript,
    };
  });
  const blocking = assessments.filter((item) => item.disposition === 'rerecord');
  const goalBlocked = blocking.some((item) => item.captureKind === 'goal');
  const semanticContext = blocking.length ? null : {
    goal: { text: assessments[0].value, sourceRefs: [assessments[0].sourceRef] },
    purpose: { text: assessments[1].value, sourceRefs: [assessments[1].sourceRef] },
    reconnectionAnchor: { text: assessments[2].value, sourceRefs: [assessments[2].sourceRef] },
  };
  return {
    kind: 'semantic_extraction_result',
    status: blocking.length ? 'rerecord_required' : 'ready',
    goalBlocked,
    assessments,
    semanticContext,
    semanticContextSha256: semanticContext ? sha256(JSON.stringify(semanticContext)) : null,
  };
}

function normalizeSemanticContext(raw = {}) {
  assertNoForbiddenKeys(raw);
  const source = raw.semanticContext || raw;
  const value = (key, aliases = []) => {
    const candidate = source[key] ?? aliases.map((alias) => source[alias]).find((entry) => entry != null);
    if (candidate && typeof candidate === 'object') return clean(candidate.text || candidate.value || candidate.meaning);
    return clean(candidate);
  };
  const goal = value('goal', ['goalStatement', 'bigGoal', 'goal90']);
  const purpose = value('purpose', ['purposeStatement', 'whyItMatters']);
  const reconnectionAnchor = value('reconnectionAnchor', ['reconnectionAnchorStatement', 'returnAnchor']);
  if (!goal) throw Object.assign(new Error('goal_required'), { code: 'GOAL_REQUIRED' });
  if (!purpose) throw Object.assign(new Error('purpose_required'), { code: 'PURPOSE_REQUIRED' });
  if (!reconnectionAnchor) throw Object.assign(new Error('reconnection_anchor_required'), { code: 'RECONNECTION_ANCHOR_REQUIRED' });
  return { goal, purpose, reconnectionAnchor };
}

function validateAuthoritativeSemanticContext(raw = {}, { expectedSha256 = null } = {}) {
  try {
    assertNoForbiddenKeys(raw);
  } catch (error) {
    return { ok: false, error: 'authoritative_semantic_context_forbidden_key', code: error.code || 'FORBIDDEN_CONTEXT_KEY' };
  }
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).sort() : [];
  const expectedKeys = [...AUTHORITATIVE_SEMANTIC_CONTEXT_KEYS].sort();
  const missing = expectedKeys.filter((key) => !keys.includes(key));
  const unexpected = keys.filter((key) => !expectedKeys.includes(key));
  if (missing.length || unexpected.length) return { ok: false, error: 'authoritative_semantic_context_shape_invalid', missing, unexpected };
  for (const key of AUTHORITATIVE_SEMANTIC_CONTEXT_KEYS) {
    const item = raw[key];
    const text = clean(item && item.text);
    if (!item || typeof item !== 'object' || !text || !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1) {
      return { ok: false, error: 'authoritative_semantic_context_source_ref_required', key };
    }
    if (isAuthoritativeSemanticPlaceholder(text)) {
      return { ok: false, error: 'authoritative_semantic_context_placeholder_forbidden', key };
    }
    const invalidSourceRef = item.sourceRefs.find((ref) => {
      const quotedText = clean(ref && ref.quotedText);
      return !clean(ref && ref.captureId)
        || !clean(ref && ref.transcriptSha256)
        || !quotedText
        || quotedText !== text
        || clean(ref.transcriptSha256) !== sha256(quotedText)
        || isAuthoritativeSemanticPlaceholder(quotedText);
    });
    if (invalidSourceRef) {
      return { ok: false, error: 'authoritative_semantic_context_source_ref_integrity_invalid', key };
    }
  }
  let normalized;
  try { normalized = normalizeSemanticContext(raw); } catch (error) {
    return { ok: false, error: error.message || 'authoritative_semantic_context_invalid', code: error.code || null };
  }
  const semanticContextSha256 = sha256(JSON.stringify(raw));
  if (expectedSha256 && semanticContextSha256 !== expectedSha256) {
    return { ok: false, error: 'authoritative_semantic_context_hash_mismatch', expectedSha256, actualSha256: semanticContextSha256 };
  }
  return { ok: true, semanticContext: raw, normalized, semanticContextSha256 };
}

function resolveAuthoritativeSemanticContext({ manifest = {}, requestContext = null } = {}) {
  if (!manifest || manifest.schemaVersion !== 'alzo.voice_manifest.r2.v1') {
    return { ok: false, error: 'r2_manifest_required' };
  }
  const validation = validateAuthoritativeSemanticContext(manifest.semanticContext, { expectedSha256: manifest.semanticContextSha256 || null });
  if (!validation.ok) return validation;
  return {
    ok: true,
    semanticContext: validation.semanticContext,
    semanticContextSha256: validation.semanticContextSha256,
    requestContextIgnored: requestContext !== null && requestContext !== undefined,
  };
}

function validateDailyNoveltyChecks(noveltyChecks = {}) {
  const provided = Object.keys(noveltyChecks || {}).sort();
  const expected = [...DAILY_NOVELTY_CHECK_KEYS].sort();
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(noveltyChecks || {}, key));
  const unexpected = provided.filter((key) => !expected.includes(key));
  const collisions = expected.filter((key) => noveltyChecks?.[key] !== true);
  return { ok: missing.length === 0 && unexpected.length === 0 && collisions.length === 0, missing, unexpected, collisions, dimensions: [...DAILY_NOVELTY_DIMENSIONS] };
}

function selectDailyHistory(history = []) {
  const canonical = Array.isArray(history) ? history.filter((entry) => entry && entry.messageType !== 'first') : [];
  return canonical.length < 30 ? canonical : canonical.slice(-30);
}

function buildFirstPrompt(context = {}) {
  const semantic = normalizeSemanticContext(context);
  return {
    promptVersion: 'alzo.first.r2.v1',
    semanticContext: semantic,
    messages: [
      { role: 'system', content: FIRST_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ kind: 'first_message_input', language: 'en', semanticContext: semantic }) },
    ],
  };
}

function buildDailyPrompt(context = {}) {
  assertNoForbiddenKeys(context);
  const semantic = normalizeSemanticContext(context);
  const history = selectDailyHistory(context.recentDailyMessages || context.dailyHistory || []);
  const checkIn = context.checkIn || {};
  const input = {
    kind: 'daily_message_input',
    language: 'en',
    semanticContext: semantic,
    checkIn: {
      mood: clean(checkIn.mood || context.mood),
      alignment: clean(checkIn.alignment || context.alignment),
      alignmentSemantics: 'emotional_connection_only',
      visibleNumericScore: false,
      scoringEnabled: false,
    },
    firstMessageReference: context.firstMessageReference ? {
      messageId: context.firstMessageReference.messageId || context.firstMessageReference.id || null,
      use: 'continuity_reference_only',
      text: clean(context.firstMessageReference.text || context.firstMessageReference.transcript),
    } : null,
    dailyHistoryAvailableCount: Array.isArray(context.recentDailyMessages || context.dailyHistory) ? (context.recentDailyMessages || context.dailyHistory).length : 0,
    recentDailyMessages: history,
  };
  return {
    promptVersion: 'alzo.daily.r3.v1',
    semanticContext: semantic,
    historyReviewedIds: history.map((entry) => entry.messageId || entry.id).filter(Boolean),
    messages: [
      { role: 'system', content: DAILY_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input) },
    ],
  };
}

function validateMessageText(text, { productName = 'ALZO' } = {}) {
  const normalized = clean(text);
  const failureCodes = [];
  if (!normalized) failureCodes.push('empty_text');
  if (/\b(you|your|you’re|you'll|you’ve)\b/i.test(normalized)) failureCodes.push('second_person_present');
  if (new RegExp(`\\b${productName}\\b|\\bapp\\b|\\bsystem\\b`, 'i').test(normalized)) failureCodes.push('product_or_system_present');
  if (/\b(should|must|need to|plan|step|task|do this|take action)\b/i.test(normalized)) failureCodes.push('plan_action_or_coaching_present');
  if (/\b(unstoppable|crush|greatness|manifest|universe|you got this)\b/i.test(normalized)) failureCodes.push('generic_motivation_present');
  return { ok: failureCodes.length === 0, text: normalized, wordCount: normalized ? normalized.split(/\s+/).length : 0, failureCodes };
}

function validateTrainingBundle({ mergedDurationMs, validAudioDurationMs, humanVoicePresent, silencePredominant, noisePredominant, sourceCount, providerFileCount, provenanceComplete, orderedCaptureKinds } = {}) {
  const failureCodes = [];
  if (Number(validAudioDurationMs ?? mergedDurationMs) < MIN_VALID_AUDIO_MS) failureCodes.push('valid_duration_below_40000ms');
  if (humanVoicePresent !== true) failureCodes.push('human_voice_absent');
  if (silencePredominant === true) failureCodes.push('silence_predominant');
  if (noisePredominant === true) failureCodes.push('noise_predominant');
  if (sourceCount !== 4) failureCodes.push('capture_missing');
  if (JSON.stringify(orderedCaptureKinds) !== JSON.stringify(CAPTURE_ORDER)) failureCodes.push('capture_order_invalid');
  if (providerFileCount !== 1) failureCodes.push('provider_file_count_not_one');
  if (provenanceComplete !== true) failureCodes.push('provenance_incomplete');
  return { ok: failureCodes.length === 0, failureCodes, minimumDurationMs: MIN_VALID_AUDIO_MS, recoveryKind: failureCodes.length ? 'extend_recording|new_capture' : null };
}

module.exports = {
  COMMITMENT_TEXT,
  COMMITMENT_VERSION,
  COMMITMENT_SHA256,
  MIN_VALID_AUDIO_MS,
  CAPTURE_ORDER,
  SEMANTIC_CAPTURE_ORDER,
  AUTHORITATIVE_SEMANTIC_CONTEXT_KEYS,
  DAILY_NOVELTY_DIMENSIONS,
  DAILY_NOVELTY_CHECK_KEYS,
  FIRST_SYSTEM_PROMPT,
  DAILY_SYSTEM_PROMPT,
  assertNoForbiddenKeys,
  buildSemanticExtraction,
  normalizeSemanticContext,
  validateAuthoritativeSemanticContext,
  resolveAuthoritativeSemanticContext,
  validateDailyNoveltyChecks,
  selectDailyHistory,
  buildFirstPrompt,
  buildDailyPrompt,
  validateMessageText,
  validateTrainingBundle,
  sha256,
};
