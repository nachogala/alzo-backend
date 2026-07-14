'use strict';

const {
  buildAuthoritativeAuthResponse,
  normalizeAuthoritativeProfile,
} = require('../lib/auth-contract');

describe('authoritative auth response contract', () => {
  test('returns the stored verified profile for a returning Apple user', () => {
    const stored = {
      id: 'user_returning_apple',
      email: 'verified@example.com',
      name: 'Verified User',
      language: 'en-US',
      plan: 'Free Trial',
      streak: 4,
    };
    const body = buildAuthoritativeAuthResponse({
      token: 'token-returning',
      user: stored,
      isNewUser: false,
      provider: 'apple',
    });

    expect(body).toEqual(expect.objectContaining({
      token: 'token-returning',
      userId: 'user_returning_apple',
      isNewUser: false,
      accountCreated: true,
      profile: {
        id: 'user_returning_apple',
        email: 'verified@example.com',
        displayName: 'Verified User',
        language: 'en-US',
        plan: 'Free Trial',
        streak: 4,
      },
    }));
  });

  test('fails closed when the stored profile is missing a valid id or email', () => {
    expect(() => normalizeAuthoritativeProfile({ id: 'user-no-email', email: '' }))
      .toThrow('authoritative_profile_email_required');
    expect(() => normalizeAuthoritativeProfile({ id: '', email: 'valid@example.com' }))
      .toThrow('authoritative_profile_user_id_required');
  });

  test('normalizes stored email instead of trusting native Apple credential casing', () => {
    const profile = normalizeAuthoritativeProfile({
      id: 'user-1',
      email: ' Stored.Verified@Example.COM ',
      name: null,
      language: null,
    });
    expect(profile.email).toBe('stored.verified@example.com');
    expect(profile.displayName).toBe('stored.verified');
    expect(profile.language).toBe('en-US');
  });
});
