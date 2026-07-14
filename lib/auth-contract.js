'use strict';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAuthoritativeProfile(user = {}) {
  const id = String(user.id || '').trim();
  const email = normalizeEmail(user.email);
  if (!id) throw new Error('authoritative_profile_user_id_required');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('authoritative_profile_email_required');
  const displayName = String(user.name || user.displayName || '').trim() || email.split('@')[0];
  return {
    id,
    email,
    displayName,
    language: String(user.language || 'en-US'),
    plan: String(user.plan || 'Free Trial'),
    streak: Number.isFinite(Number(user.streak)) ? Number(user.streak) : 0,
  };
}

function buildAuthoritativeAuthResponse({ token, user, isNewUser = false, provider = null } = {}) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) throw new Error('authoritative_auth_token_required');
  const profile = normalizeAuthoritativeProfile(user);
  return {
    token: normalizedToken,
    userId: profile.id,
    isNewUser: isNewUser === true,
    accountCreated: true,
    provider: provider || null,
    profile,
  };
}

module.exports = {
  normalizeAuthoritativeProfile,
  buildAuthoritativeAuthResponse,
};
