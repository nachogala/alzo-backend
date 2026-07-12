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
      checkIn: { mood: 'Tender', energy: 'Low', alignment: 'I feel distant but still connected.' },
      firstMessageReference: { messageId: 'first-1', text: 'I know why this matters.' },
      recentDailyMessages: [],
    });
    const input = JSON.parse(prompt.messages[1].content);
    expect(input.checkIn).toMatchObject({ alignmentSemantics: 'emotional_connection_only', visibleNumericScore: false, scoringEnabled: false });
    expect(input.firstMessageReference.use).toBe('continuity_reference_only');
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
