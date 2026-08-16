import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { User } from '../src/models';
import { clearCollections, startTestDatabase, stopTestDatabase, auth } from './helpers/db';
import { createUser, TEST_PASSWORD } from './helpers/fixtures';

let app: Application;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterAll(stopTestDatabase);
beforeEach(clearCollections);

describe('POST /api/v1/auth/login', () => {
  it('issues an access and refresh token pair for valid credentials', async () => {
    const user = await createUser({ email: 'valid@test.local', role: 'COMPANY_ADMIN' });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'valid@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.refreshToken).toEqual(expect.any(String));
    expect(response.body.data.user.id).toBe(String(user._id));
  });

  it('never returns the password hash', async () => {
    await createUser({ email: 'hash@test.local' });
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'hash@test.local', password: TEST_PASSWORD });

    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('$2');
  });

  it('rejects a wrong password with the same message as an unknown email', async () => {
    await createUser({ email: 'known@test.local' });

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'known@test.local', password: 'NotThePassword1!' });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // No user enumeration: both paths look identical to the caller.
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('blocks a deactivated account', async () => {
    await createUser({ email: 'disabled@test.local', active: false });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'disabled@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('rejects a malformed email with a validation error', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: TEST_PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('records lastLoginAt', async () => {
    const user = await createUser({ email: 'stamp@test.local' });
    expect(user.lastLoginAt).toBeNull();

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'stamp@test.local', password: TEST_PASSWORD });

    const refreshed = await User.findById(user._id);
    expect(refreshed?.lastLoginAt).toBeInstanceOf(Date);
  });
});

describe('Refresh token rotation', () => {
  it('rotates the refresh token and invalidates the old one', async () => {
    await createUser({ email: 'rotate@test.local' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'rotate@test.local', password: TEST_PASSWORD });

    const first = login.body.data.refreshToken as string;

    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.refreshToken).not.toBe(first);

    // Re-using the consumed token is refused (reuse detection).
    const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');
  });

  it('revokes the whole family after a detected reuse', async () => {
    await createUser({ email: 'family@test.local' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'family@test.local', password: TEST_PASSWORD });

    const original = login.body.data.refreshToken as string;
    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });
    const current = rotated.body.data.refreshToken as string;

    // Replaying the original poisons the family…
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });

    // …so even the legitimately current token stops working.
    const afterBreach = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: current });
    expect(afterBreach.status).toBe(401);
  });
});

describe('Protected routes', () => {
  it('rejects requests with no token', async () => {
    const response = await request(app).get('/api/v1/auth/me');
    expect(response.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const response = await request(app).get('/api/v1/auth/me').set(auth('not.a.real.token'));
    expect(response.status).toBe(401);
  });

  it('returns the current user for a valid token', async () => {
    await createUser({ email: 'me@test.local', role: 'DISPATCHER' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'me@test.local', password: TEST_PASSWORD });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set(auth(login.body.data.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe('me@test.local');
    expect(response.body.data.role).toBe('DISPATCHER');
  });

  it('blocks a user deactivated after their token was issued', async () => {
    const user = await createUser({ email: 'revoked@test.local' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'revoked@test.local', password: TEST_PASSWORD });

    await User.updateOne({ _id: user._id }, { $set: { active: false } });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set(auth(login.body.data.accessToken));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('Change password', () => {
  it('requires the correct current password', async () => {
    await createUser({ email: 'change@test.local' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'change@test.local', password: TEST_PASSWORD });

    const response = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(login.body.data.accessToken))
      .send({ currentPassword: 'WrongPassword1!', newPassword: 'BrandNewPassword1!' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PASSWORD');
  });

  it('changes the password and lets the user sign in with it', async () => {
    await createUser({ email: 'change2@test.local' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'change2@test.local', password: TEST_PASSWORD });

    const change = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(login.body.data.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'BrandNewPassword1!' });
    expect(change.status).toBe(200);

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'change2@test.local', password: 'BrandNewPassword1!' });
    expect(relogin.status).toBe(200);
  });
});
