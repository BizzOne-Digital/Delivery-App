process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_at_least_16_chars_long';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_at_least_16_chars_long';
process.env.TRACKING_TOKEN_SECRET = 'test_tracking_secret_at_least_16_chars';
process.env.SEED_PASSWORD = 'TestPassword123!';
process.env.STORAGE_DRIVER = 'memory';

jest.setTimeout(60_000);
