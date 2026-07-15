'use strict';

const r2 = require('../lib/alzo-r2-contracts');

describe('ALZO R2 Final contracts', () => {
  test('locks Commitment E byte-for-byte and outside semantic context', () => {
    expect(r2.COMMITMENT_VERSION).toBe('alzo.commitment.fixed.en.v1');
    expect(r2.sha256(r2.COMMITMENT_TEXT)).toBe(r2.COMMITMENT_SHA256);
    expect(r2.COMMITMENT_TEXT.split(/\s+/)).toHaveLength(44);
    const result = r2.buildSemanticExtraction({
      goal: { captureId: 'g', transcript: 'I will finish my portfolio in ninety days.', goalConcrete: true },
      purpose: { captureId: 'p', transcript: 'I want to trust my creative direction.' },
      reconnectionAnchor: { captureId: 'a', transcript: 'I return by remembering why the work is mine.' },
    });
    expect(result.status).toBe('ready');
    expect(Object.keys(result.semanticContext)).toEqual(['goal', 'purpose', 'reconnectionAnchor']);
    expect(JSON.stringify(result.semanticContext)).not.toMatch(/commitment|journal/i);
  });

  test('Goal is strict while Purpose and Anchor can transcript-mirror', () => {
    const blocked = r2.buildSemanticExtraction({
      goal: { captureId: 'g', transcript: 'Something better.', goalConcrete: false },
      purpose: { captureId: 'p', transcript: 'I want to trust myself.', richInterpretationCertain: false },
      reconnectionAnchor: { captureId: 'a', transcript: 'I remember my reason.', richInterpretationCertain: false },
    });
    expect(blocked.status).toBe('rerecord_required');
    expect(blocked.assessments[0]).toMatchObject({ disposition: 'rerecord', reasonCode: 'goal_not_concrete' });
    expect(blocked.assessments[1].disposition).toBe('use_transcript_mirror');
    expect(blocked.assessments[2].disposition).toBe('use_transcript_mirror');
  });

  test('forbids Commitment and Journal keys in First/Daily context', () => {
    expect(() => r2.buildFirstPrompt({ goal: 'G', purpose: 'P', reconnectionAnchor: 'A', commitment: 'forbidden' })).toThrow(/forbidden_context_key/);
    expect(() => r2.buildDailyPrompt({ goal: 'G', purpose: 'P', reconnectionAnchor: 'A', journalEntries: [] })).toThrow(/forbidden_context_key/);
  });

  test.each([0, 1, 9, 10, 29, 30, 31, 45])('Daily history selection for %i canonical messages', (count) => {
    const history = Array.from({ length: count }, (_, index) => ({ messageId: `d${index + 1}`, messageType: 'daily', text: `Daily ${index + 1}` }));
    const selected = r2.selectDailyHistory([{ messageId: 'first', messageType: 'first' }, ...history]);
    expect(selected).toHaveLength(Math.min(count, 30));
    if (count >= 30) expect(selected[0].messageId).toBe(`d${count - 29}`);
    if (count < 30 && count > 0) expect(selected[0].messageId).toBe('d1');
  });

  test('Daily prompt preserves emotional Alignment with no score', () => {
    const prompt = r2.buildDailyPrompt({
      goal: 'Finish my portfolio in ninety days.',
      purpose: 'Trust my creative direction.',
      reconnectionAnchor: 'Remember why the work is mine.',
      checkIn: { mood: 'Tender', alignment: 'I feel distant but still connected.' },
      firstMessageReference: { messageId: 'first-1', text: 'I know why this matters.' },
      recentDailyMessages: [],
    });
    const input = JSON.parse(prompt.messages[1].content);
    expect(input.checkIn).toMatchObject({ alignmentSemantics: 'emotional_connection_only', visibleNumericScore: false, scoringEnabled: false });
    expect(input.checkIn).not.toHaveProperty('energy');
    expect(input.firstMessageReference.use).toBe('continuity_reference_only');
  });

  test('authoritative Semantic Context rejects missing, extra, forbidden, unproven and hash-mismatched inputs', () => {
    const sourceRefs = (captureId, quotedText) => [{
      captureId,
      transcriptSha256: r2.sha256(quotedText),
      quotedText,
      start: 0,
      end: quotedText.length,
    }];
    const context = {
      goal: { text: 'Ship the meaningful work', sourceRefs: sourceRefs('goal-1', 'Ship the meaningful work') },
      purpose: { text: 'Support my family', sourceRefs: sourceRefs('purpose-1', 'Support my family') },
      reconnectionAnchor: { text: 'Remember why I chose this', sourceRefs: sourceRefs('anchor-1', 'Remember why I chose this') },
    };
    const hash = r2.sha256(JSON.stringify(context));
    expect(r2.validateAuthoritativeSemanticContext(context, { expectedSha256: hash }).ok).toBe(true);
    expect(r2.validateAuthoritativeSemanticContext({ goal: context.goal, purpose: context.purpose }).error).toBe('authoritative_semantic_context_shape_invalid');
    expect(r2.validateAuthoritativeSemanticContext({ ...context, commitment: { text: 'forbidden' } }).error).toBe('authoritative_semantic_context_forbidden_key');
    expect(r2.validateAuthoritativeSemanticContext({ ...context, extra: { text: 'forbidden' } }).error).toBe('authoritative_semantic_context_shape_invalid');
    expect(r2.validateAuthoritativeSemanticContext({ ...context, goal: { text: context.goal.text, sourceRefs: [] } }).error).toBe('authoritative_semantic_context_source_ref_required');
    expect(r2.validateAuthoritativeSemanticContext({
      ...context,
      goal: { text: context.goal.text, sourceRefs: sourceRefs('goal-1', 'different text') },
    })).toMatchObject({ ok: false, error: 'authoritative_semantic_context_source_ref_integrity_invalid', key: 'goal' });
    expect(r2.validateAuthoritativeSemanticContext(context, { expectedSha256: '0'.repeat(64) }).error).toBe('authoritative_semantic_context_hash_mismatch');
    const resolved = r2.resolveAuthoritativeSemanticContext({
      manifest: { schemaVersion: 'alzo.voice_manifest.r2.v1', semanticContext: context, semanticContextSha256: hash },
      requestContext: { goal: 'request injection', commitment: 'must be ignored' },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.semanticContext).toEqual(context);
    expect(JSON.stringify(resolved.semanticContext)).not.toMatch(/request injection|commitment/i);
  });

  test('authoritative Semantic Context rejects internal pending markers and legacy fixture prose before First Message', () => {
    const sourceRefs = (captureId, quotedText) => [{
      captureId,
      transcriptSha256: r2.sha256(quotedText),
      quotedText,
      start: 0,
      end: quotedText.length,
    }];
    const purpose = 'I want to trust that I can keep a promise to myself.';
    const anchor = 'When motivation drops, I want to remember that returning still counts.';
    const pending = 'backend_transcription_pending';
    const pendingContext = {
      goal: { text: pending, sourceRefs: sourceRefs('goal-pending', pending) },
      purpose: { text: purpose, sourceRefs: sourceRefs('purpose-real', purpose) },
      reconnectionAnchor: { text: anchor, sourceRefs: sourceRefs('anchor-real', anchor) },
    };
    expect(r2.validateAuthoritativeSemanticContext(pendingContext)).toMatchObject({
      ok: false,
      error: 'authoritative_semantic_context_placeholder_forbidden',
      key: 'goal',
    });

    const fixture = 'The reason I recorded for this goal.';
    const fixtureContext = {
      ...pendingContext,
      goal: { text: 'I will rebuild a steady training rhythm over the next ninety days.', sourceRefs: sourceRefs('goal-real', 'I will rebuild a steady training rhythm over the next ninety days.') },
      purpose: { text: fixture, sourceRefs: sourceRefs('purpose-fixture', fixture) },
    };
    expect(r2.validateAuthoritativeSemanticContext(fixtureContext)).toMatchObject({
      ok: false,
      error: 'authoritative_semantic_context_placeholder_forbidden',
      key: 'purpose',
    });
  });

  test('all eight canonical Novelty dimensions are exact and each collision blocks', () => {
    expect(r2.DAILY_NOVELTY_DIMENSIONS).toEqual([
      'direct_phrase',
      'central_idea',
      'rhetorical_structure',
      'opening',
      'closing',
      'metaphor_image',
      'goal_interpretation_angle',
      'reconnection_anchor_use_framing_placement',
    ]);
    const allDistinct = Object.fromEntries(r2.DAILY_NOVELTY_CHECK_KEYS.map((key) => [key, true]));
    expect(r2.validateDailyNoveltyChecks(allDistinct).ok).toBe(true);
    for (const key of r2.DAILY_NOVELTY_CHECK_KEYS) {
      const result = r2.validateDailyNoveltyChecks({ ...allDistinct, [key]: false });
      expect(result.ok).toBe(false);
      expect(result.collisions).toEqual([key]);
    }
    expect(r2.validateDailyNoveltyChecks({ ...allDistinct, ninthDimension: true }).unexpected).toEqual(['ninthDimension']);
  });

  const valid = {
    mergedDurationMs: 64270,
    validAudioDurationMs: 64270,
    humanVoicePresent: true,
    silencePredominant: false,
    noisePredominant: false,
    sourceCount: 4,
    providerFileCount: 1,
    provenanceComplete: true,
    orderedCaptureKinds: r2.CAPTURE_ORDER,
  };

  test.each([
    ['39.9 seconds', { validAudioDurationMs: 39900 }, false, 'valid_duration_below_40000ms'],
    ['40.0 seconds', { validAudioDurationMs: 40000 }, true, null],
    ['64.27 seconds', {}, true, null],
    ['silence predominant', { silencePredominant: true }, false, 'silence_predominant'],
    ['noise predominant', { noisePredominant: true }, false, 'noise_predominant'],
    ['four provider files', { providerFileCount: 4 }, false, 'provider_file_count_not_one'],
    ['Commitment missing', { sourceCount: 3, orderedCaptureKinds: ['goal', 'purpose', 'reconnectionAnchor'] }, false, 'capture_missing'],
  ])('audio gate: %s', (_name, patch, expectedOk, expectedCode) => {
    const result = r2.validateTrainingBundle({ ...valid, ...patch });
    expect(result.ok).toBe(expectedOk);
    if (expectedCode) expect(result.failureCodes).toContain(expectedCode);
  });

  test('First text validator blocks second person, product and coaching', () => {
    expect(r2.validateMessageText('I remember why this goal matters to me.').ok).toBe(true);
    expect(r2.validateMessageText('You should use ALZO and take action.').failureCodes).toEqual(expect.arrayContaining([
      'second_person_present',
      'product_or_system_present',
      'plan_action_or_coaching_present',
    ]));
  });
});
