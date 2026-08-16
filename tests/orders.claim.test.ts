import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { Order } from '../src/models';
import { claimOrderAtomically } from '../src/services/order.service';
import { ApiError } from '../src/utils/ApiError';
import { auth, clearCollections, login, startTestDatabase, stopTestDatabase } from './helpers/db';
import { createCustomer, createPharmacy, createReadyOrder, createUser, TEST_PASSWORD } from './helpers/fixtures';

let app: Application;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterAll(stopTestDatabase);
beforeEach(clearCollections);

async function setup() {
  const pharmacy = await createPharmacy();
  const customer = await createCustomer(pharmacy._id);
  const driverA = await createUser({
    email: 'driver-a@test.local',
    role: 'DRIVER',
    assignedPharmacyIds: [pharmacy._id],
    driverStatus: 'AVAILABLE',
  });
  const driverB = await createUser({
    email: 'driver-b@test.local',
    role: 'DRIVER',
    assignedPharmacyIds: [pharmacy._id],
    driverStatus: 'AVAILABLE',
  });
  await pharmacy.updateOne({ $set: { linkedDriverIds: [driverA._id, driverB._id] } });
  const order = await createReadyOrder(pharmacy._id, customer._id);
  return { pharmacy, customer, driverA, driverB, order };
}

describe('Atomic order claiming', () => {
  it('moves the order to ON_THE_WAY and records the owner', async () => {
    const { driverA, order } = await setup();

    const claimed = await claimOrderAtomically(String(order._id), driverA);

    expect(claimed.status).toBe('ON_THE_WAY');
    expect(String(claimed.assignedDriverId)).toBe(String(driverA._id));
    expect(claimed.claimedAt).toBeInstanceOf(Date);
    expect(claimed.timeline.at(-1)?.action).toBe('DRIVER_TOOK_OWNERSHIP');
  });

  it('lets exactly one of two concurrent drivers win the race', async () => {
    const { driverA, driverB, order } = await setup();

    const results = await Promise.allSettled([
      claimOrderAtomically(String(order._id), driverA),
      claimOrderAtomically(String(order._id), driverB),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('ORDER_ALREADY_CLAIMED');

    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('ON_THE_WAY');
  });

  it('holds up under a burst of five simultaneous claims', async () => {
    const { pharmacy, customer } = await setup();
    const order = await createReadyOrder(pharmacy._id, customer._id);

    const drivers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createUser({
          email: `burst-${i}@test.local`,
          role: 'DRIVER',
          assignedPharmacyIds: [pharmacy._id],
        }),
      ),
    );

    const results = await Promise.allSettled(
      drivers.map((driver) => claimOrderAtomically(String(order._id), driver)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
  });

  it('refuses to claim an order that is no longer READY', async () => {
    const { driverA, order } = await setup();
    await Order.updateOne({ _id: order._id }, { $set: { status: 'PREPARING' } });

    await expect(claimOrderAtomically(String(order._id), driverA)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_NOT_READY',
    });
  });

  it('lets the pre-assigned driver claim an assigned order', async () => {
    const { pharmacy, customer, driverA } = await setup();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      assignedDriverId: driverA._id,
    });

    const claimed = await claimOrderAtomically(String(order._id), driverA);
    expect(claimed.status).toBe('ON_THE_WAY');
  });

  it('stops a different driver claiming an order assigned to someone else', async () => {
    const { pharmacy, customer, driverA, driverB } = await setup();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      assignedDriverId: driverA._id,
    });

    await expect(claimOrderAtomically(String(order._id), driverB)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('POST /api/v1/orders/driver/claim-batch', () => {
  it('claims what it can and reports conflicts for the rest', async () => {
    const { pharmacy, customer, driverA, driverB } = await setup();
    const [first, second, third] = await Promise.all([
      createReadyOrder(pharmacy._id, customer._id),
      createReadyOrder(pharmacy._id, customer._id),
      createReadyOrder(pharmacy._id, customer._id),
    ]);

    // Driver B grabs one of them first.
    await claimOrderAtomically(String(second._id), driverB);

    const token = await login(app, driverA.email, TEST_PASSWORD);
    const response = await request(app)
      .post('/api/v1/orders/driver/claim-batch')
      .set(auth(token))
      .send({ orderIds: [String(first._id), String(second._id), String(third._id)] });

    expect(response.status).toBe(200);
    expect(response.body.data.claimedCount).toBe(2);
    expect(response.body.data.conflictCount).toBe(1);
    expect(response.body.data.conflicts[0].reason).toContain('took this order first');
  });
});

describe('Driver Ready visibility', () => {
  it('hides orders from pharmacies the driver is not assigned to', async () => {
    const { driverA } = await setup();
    const otherPharmacy = await createPharmacy();
    const otherCustomer = await createCustomer(otherPharmacy._id);
    await createReadyOrder(otherPharmacy._id, otherCustomer._id);

    const token = await login(app, driverA.email, TEST_PASSWORD);
    const response = await request(app).get('/api/v1/orders/driver/ready').set(auth(token));

    expect(response.status).toBe(200);
    const pharmacyIds = response.body.data.map((g: { pharmacy: { _id: string } }) => g.pharmacy._id);
    expect(pharmacyIds).not.toContain(String(otherPharmacy._id));
  });

  it('hides all orders from an inactive pharmacy', async () => {
    const { pharmacy, driverA } = await setup();
    await pharmacy.updateOne({ $set: { active: false } });

    const token = await login(app, driverA.email, TEST_PASSWORD);
    const response = await request(app).get('/api/v1/orders/driver/ready').set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('applies ASSIGNED mode: an unassigned order is invisible to the pool', async () => {
    const { pharmacy, customer, driverA } = await setup();
    await pharmacy.updateOne({ $set: { assignmentMode: 'ASSIGNED' } });
    await createReadyOrder(pharmacy._id, customer._id); // unassigned

    const token = await login(app, driverA.email, TEST_PASSWORD);
    const response = await request(app).get('/api/v1/orders/driver/ready').set(auth(token));

    expect(response.body.data).toHaveLength(0);
  });
});
