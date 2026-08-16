import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Application } from 'express';
import request from 'supertest';

let mongo: MongoMemoryServer | null = null;

/** Spins up an in-memory MongoDB so tests never touch a real Atlas cluster. */
export async function startTestDatabase(): Promise<void> {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'delivery-app-test' });
}

export async function stopTestDatabase(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await mongo?.stop();
  mongo = null;
}

export async function clearCollections(): Promise<void> {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/** Logs in and returns the access token for use as a Bearer credential. */
export async function login(app: Application, email: string, password: string): Promise<string> {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data.accessToken as string;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
