import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { Order } from '../src/models';
import { claimOrderAtomically } from '../src/services/order.service';
import { auth, clearCollections, login, startTestDatabase, stopTestDatabase } from './helpers/db';
import { createCustomer, createPharmacy, createReadyOrder, createUser, TEST_PASSWORD } from './helpers/fixtures';

let app: Application;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterAll(stopTestDatabase);
beforeEach(clearCollections);

async function scenario() {
  const pharmacy = await createPharmacy();
  const customer = await createCustomer(pharmacy._id);
  const driver = await createUser({
    email: 'lifecycle-driver@test.local',
    role: 'DRIVER',
    assignedPharmacyIds: [pharmacy._id],
    driverStatus: 'AVAILABLE',
  });
  const staff = await createUser({
    email: 'lifecycle-staff@test.local',
    role: 'PHARMACY_ADMIN',
    pharmacyId: pharmacy._id,
  });
  const dispatcher = await createUser({ email: 'lifecycle-dispatch@test.local', role: 'DISPATCHER' });
  await pharmacy.updateOne({ $set: { linkedDriverIds: [driver._id] } });

  return { pharmacy, customer, driver, staff, dispatcher };
}

describe('Successful delivery flow', () => {
  it('completes an order and stores proof, payment and GPS', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, { amountDue: 12.5 });
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/complete`)
      .set(auth(token))
      .send({
        receiverType: 'CUSTOMER',
        receiverName: 'Pat Tester',
        receiverRelationship: 'Self',
        manifestConfirmed: true,
        amountCollected: 12.5,
        paymentMethod: 'CASH',
        latitude: 51.54,
        longitude: -0.11,
        note: 'Handed over at the door.',
      });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('COMPLETED');
    expect(stored?.completedAt).toBeInstanceOf(Date);
    expect(stored?.amountCollected).toBe(12.5);
    expect(stored?.paymentMethod).toBe('CASH');
    expect(stored?.proofOfDelivery?.receiverName).toBe('Pat Tester');
    // Proof coordinates live on the order, exempt from the location TTL.
    expect(stored?.proofOfDelivery?.coordinates?.latitude).toBeCloseTo(51.54);
    expect(stored?.timeline.some((t) => t.action === 'DELIVERY_COMPLETED')).toBe(true);
  });

  it('enforces the pharmacy signature requirement server-side', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      proofConfigSnapshot: {
        signatureRequired: true,
        photoRequired: false,
        receiverIdentityRequired: true,
        authorizedRecipientRequired: false,
        manifestConfirmationRequired: false,
      },
    });
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/complete`)
      .set(auth(token))
      .send({
        receiverType: 'CUSTOMER',
        receiverName: 'Pat Tester',
        manifestConfirmed: true,
        amountCollected: 0,
        paymentMethod: 'NO_PAYMENT',
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SIGNATURE_REQUIRED');
  });

  it('enforces the photo requirement server-side', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      proofConfigSnapshot: {
        signatureRequired: false,
        photoRequired: true,
        receiverIdentityRequired: false,
        authorizedRecipientRequired: false,
        manifestConfirmationRequired: false,
      },
    });
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/complete`)
      .set(auth(token))
      .send({
        receiverType: 'CUSTOMER',
        manifestConfirmed: true,
        amountCollected: 0,
        paymentMethod: 'NO_PAYMENT',
        photoUrls: [],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PHOTO_REQUIRED');
  });

  it('refuses a completion for an order held by a different driver', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const other = await createUser({
      email: 'not-mine@test.local',
      role: 'DRIVER',
      assignedPharmacyIds: [pharmacy._id],
    });
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, other.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/complete`)
      .set(auth(token))
      .send({ receiverType: 'CUSTOMER', manifestConfirmed: true, amountCollected: 0, paymentMethod: 'NO_PAYMENT' });

    expect(response.status).toBe(404);
  });
});

describe('Failed delivery flow', () => {
  it('moves a failed order to RETURNING with reason, GPS and timestamp', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/fail`)
      .set(auth(token))
      .send({
        reason: 'CUSTOMER_ABSENT',
        note: 'No answer after three attempts.',
        callAttempted: true,
        latitude: 51.54,
        longitude: -0.11,
      });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('RETURNING');
    expect(stored?.failureDetails?.reason).toBe('CUSTOMER_ABSENT');
    expect(stored?.failureDetails?.callAttempted).toBe(true);
    expect(stored?.failureDetails?.coordinates?.longitude).toBeCloseTo(-0.11);
    expect(stored?.returnDetails?.exceptionStatus).toBe('OPEN');
  });

  it('rejects an unknown failure reason', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/fail`)
      .set(auth(token))
      .send({ reason: 'BECAUSE_I_SAID_SO' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Returning flow', () => {
  it('sends a failed delivery back out with Back to Delivery', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    await request(app)
      .post(`/api/v1/orders/${order._id}/fail`)
      .set(auth(token))
      .send({ reason: 'CUSTOMER_ABSENT' });

    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/back-to-delivery`)
      .set(auth(token));

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('ON_THE_WAY');
    expect(stored?.retryCount).toBe(1);
  });

  it('moves a failed delivery to ACTION_REQUIRED once handed back', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, driver.email, TEST_PASSWORD);
    await request(app)
      .post(`/api/v1/orders/${order._id}/fail`)
      .set(auth(token))
      .send({ reason: 'WRONG_ADDRESS' });

    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/confirm-returned`)
      .set(auth(token))
      .send({ receivedByName: 'Helen Marsh', receivedByEmployeeCode: 'NG-114', latitude: 51.53, longitude: -0.1 });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('ACTION_REQUIRED');
    expect(stored?.returnDetails?.receivedByName).toBe('Helen Marsh');
    expect(stored?.returnDetails?.returnedAt).toBeInstanceOf(Date);
  });

  it('completes a customer pickup once handed to the pharmacy', async () => {
    const { pharmacy, customer, driver } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      orderType: 'CUSTOMER_PICKUP',
    });
    await claimOrderAtomically(String(order._id), driver);
    await Order.updateOne({ _id: order._id }, { $set: { status: 'RETURNING', returningAt: new Date() } });

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/confirm-returned`)
      .set(auth(token))
      .send({ receivedByName: 'Sofia Duarte' });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('COMPLETED');
  });
});

describe('Cancellation rules', () => {
  it('cancels immediately when no driver holds the package', async () => {
    const { pharmacy, customer, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/cancel`)
      .set(auth(token))
      .send({ reason: 'Patient no longer needs the medication' });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('CANCELLED');
    expect(stored?.cancellationDetails?.requiredReturn).toBe(false);
  });

  it('routes a cancellation through RETURNING when the driver has the package', async () => {
    const { pharmacy, customer, driver, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/cancel`)
      .set(auth(token))
      .send({ reason: 'Duplicate order raised in error' });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('RETURNING');
    expect(stored?.cancellationDetails?.requiredReturn).toBe(true);
    expect(stored?.cancelledAt).toBeNull();

    // Only after the handover does it truly become CANCELLED.
    const driverToken = await login(app, driver.email, TEST_PASSWORD);
    await request(app)
      .post(`/api/v1/orders/${order._id}/confirm-returned`)
      .set(auth(driverToken))
      .send({ receivedByName: 'Helen Marsh' });

    const final = await Order.findById(order._id);
    expect(final?.status).toBe('CANCELLED');
    expect(final?.cancelledAt).toBeInstanceOf(Date);
  });
});

describe('Edit rules after driver ownership', () => {
  it('locks the delivery date once a driver has the package', async () => {
    const { pharmacy, customer, driver, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .patch(`/api/v1/orders/${order._id}`)
      .set(auth(token))
      .send({ deliveryDate: new Date(Date.now() + 86_400_000).toISOString() });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('FIELD_LOCKED_AFTER_CLAIM');
  });

  it('allows a note change and does not require review', async () => {
    const { pharmacy, customer, driver, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .patch(`/api/v1/orders/${order._id}`)
      .set(auth(token))
      .send({ orderNotes: 'Ring the top bell.' });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.orderNotes).toBe('Ring the top bell.');
    expect(stored?.requiresDispatcherReview).toBe(false);
  });

  it('flags an address change for dispatcher review', async () => {
    const { pharmacy, customer, driver, staff } = await scenario();
    const secondCustomer = await createCustomer(pharmacy._id, {
      firstName: 'Other',
      lastName: 'Person',
      phone: '+44 7700 999999',
    });
    const order = await createReadyOrder(pharmacy._id, customer._id);
    await claimOrderAtomically(String(order._id), driver);

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .patch(`/api/v1/orders/${order._id}`)
      .set(auth(token))
      .send({ customerId: String(secondCustomer._id) });

    expect(response.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored?.requiresDispatcherReview).toBe(true);
    expect(stored?.dispatcherReviewReason).toContain('Route needs recalculation');
  });
});

describe('Status transitions', () => {
  it('rejects an impossible transition', async () => {
    const { pharmacy, customer, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, { status: 'COMPLETED' });

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app)
      .post(`/api/v1/orders/${order._id}/status`)
      .set(auth(token))
      .send({ status: 'READY' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('walks ACTION_REQUIRED → PREPARING → READY', async () => {
    const { pharmacy, customer, staff } = await scenario();
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      status: 'ACTION_REQUIRED',
      readyAt: null,
    });

    const token = await login(app, staff.email, TEST_PASSWORD);

    const preparing = await request(app)
      .post(`/api/v1/orders/${order._id}/status`)
      .set(auth(token))
      .send({ status: 'PREPARING' });
    expect(preparing.status).toBe(200);

    const ready = await request(app)
      .post(`/api/v1/orders/${order._id}/status`)
      .set(auth(token))
      .send({ status: 'READY' });
    expect(ready.status).toBe(200);

    const stored = await Order.findById(order._id);
    expect(stored?.status).toBe('READY');
    expect(stored?.preparingAt).toBeInstanceOf(Date);
    expect(stored?.readyAt).toBeInstanceOf(Date);
  });
});
