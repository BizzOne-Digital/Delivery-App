import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { auth, clearCollections, login, startTestDatabase, stopTestDatabase } from './helpers/db';
import { createCustomer, createPharmacy, createReadyOrder, createUser, TEST_PASSWORD } from './helpers/fixtures';

let app: Application;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
});

afterAll(stopTestDatabase);
beforeEach(clearCollections);

describe('Order detail is readable by the people who legitimately see it', () => {
  /*
   * Regression guard. GET /orders/:id populates `pharmacyId` and
   * `assignedDriverId`, which replaces each ObjectId with a full document.
   * The access check compared them with String(...), which stringifies a
   * populated document to something that is not an id — so every non-company
   * caller was denied their own data. The existing isolation tests all passed
   * because they only assert the DENY direction, which stayed correct.
   */
  it('lets a pharmacy user open their own pharmacy’s order', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const order = await createReadyOrder(pharmacy._id, customer._id);

    const staff = await createUser({
      email: 'own-order@test.local',
      role: 'PHARMACY_STAFF',
      pharmacyId: pharmacy._id,
    });

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app).get(`/api/v1/orders/${order._id}`).set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.data.referenceNumber).toBe(order.referenceNumber);
  });

  it('lets a linked driver open an unclaimed order in their pool', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const order = await createReadyOrder(pharmacy._id, customer._id);

    const driver = await createUser({
      email: 'pool-driver@test.local',
      role: 'DRIVER',
      assignedPharmacyIds: [pharmacy._id],
    });
    pharmacy.linkedDriverIds = [driver._id];
    await pharmacy.save();

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app).get(`/api/v1/orders/${order._id}`).set(auth(token));

    expect(response.status).toBe(200);
  });

  it('lets a driver open an order already assigned to them', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const driver = await createUser({
      email: 'mine-driver@test.local',
      role: 'DRIVER',
      assignedPharmacyIds: [pharmacy._id],
    });
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      assignedDriverId: driver._id,
      status: 'ON_THE_WAY',
      claimedAt: new Date(),
    });

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app).get(`/api/v1/orders/${order._id}`).set(auth(token));

    expect(response.status).toBe(200);
  });

  it('still refuses a driver an order in a pharmacy they are not linked to', async () => {
    const mine = await createPharmacy();
    const other = await createPharmacy();
    const customer = await createCustomer(other._id);
    const order = await createReadyOrder(other._id, customer._id);

    const driver = await createUser({
      email: 'unlinked-driver@test.local',
      role: 'DRIVER',
      assignedPharmacyIds: [mine._id],
    });

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app).get(`/api/v1/orders/${order._id}`).set(auth(token));

    expect(response.status).toBe(403);
  });
});

describe('Pharmacy data isolation', () => {
  it('stops a pharmacy user reading another pharmacy’s order', async () => {
    const pharmacyA = await createPharmacy();
    const pharmacyB = await createPharmacy();
    const customerB = await createCustomer(pharmacyB._id);
    const orderB = await createReadyOrder(pharmacyB._id, customerB._id);

    const staffA = await createUser({
      email: 'staff-a@test.local',
      role: 'PHARMACY_STAFF',
      pharmacyId: pharmacyA._id,
    });

    const token = await login(app, staffA.email, TEST_PASSWORD);
    const response = await request(app).get(`/api/v1/orders/${orderB._id}`).set(auth(token));

    expect(response.status).toBe(403);
  });

  it('excludes other pharmacies from a pharmacy user’s order list', async () => {
    const pharmacyA = await createPharmacy();
    const pharmacyB = await createPharmacy();
    const customerA = await createCustomer(pharmacyA._id);
    const customerB = await createCustomer(pharmacyB._id);
    await createReadyOrder(pharmacyA._id, customerA._id);
    await createReadyOrder(pharmacyB._id, customerB._id);

    const staffA = await createUser({
      email: 'list-a@test.local',
      role: 'PHARMACY_STAFF',
      pharmacyId: pharmacyA._id,
    });

    const token = await login(app, staffA.email, TEST_PASSWORD);
    const response = await request(app).get('/api/v1/orders').set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(String(response.body.data[0].pharmacyId._id ?? response.body.data[0].pharmacyId)).toBe(
      String(pharmacyA._id),
    );
  });

  it('stops a pharmacy user creating a customer for another pharmacy', async () => {
    const pharmacyA = await createPharmacy();
    const pharmacyB = await createPharmacy();
    const staffA = await createUser({
      email: 'cust-a@test.local',
      role: 'PHARMACY_ADMIN',
      pharmacyId: pharmacyA._id,
    });

    const token = await login(app, staffA.email, TEST_PASSWORD);
    const response = await request(app)
      .post('/api/v1/customers')
      .set(auth(token))
      .send({
        pharmacyId: String(pharmacyB._id),
        firstName: 'Sneaky',
        lastName: 'Insert',
        phone: '+44 7700 900000',
        addresses: [{ line1: '1 Nowhere Lane' }],
      });

    expect(response.status).toBe(403);
  });
});

describe('Role gates', () => {
  it('stops a driver from creating orders', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const driver = await createUser({
      email: 'nocreate@test.local',
      role: 'DRIVER',
      assignedPharmacyIds: [pharmacy._id],
    });

    const token = await login(app, driver.email, TEST_PASSWORD);
    const response = await request(app)
      .post('/api/v1/orders')
      .set(auth(token))
      .send({
        pharmacyId: String(pharmacy._id),
        customerId: String(customer._id),
        deliveryDate: new Date().toISOString(),
      });

    expect(response.status).toBe(403);
  });

  it('stops a dispatcher from creating a pharmacy', async () => {
    const dispatcher = await createUser({ email: 'nopharm@test.local', role: 'DISPATCHER' });
    const token = await login(app, dispatcher.email, TEST_PASSWORD);

    const response = await request(app)
      .post('/api/v1/pharmacies')
      .set(auth(token))
      .send({ name: 'Rogue Pharmacy', address: '1 Rogue Way', latitude: 51.5, longitude: -0.1 });

    expect(response.status).toBe(403);
  });

  it('blocks every write for a READ_ONLY account', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const observer = await createUser({ email: 'observer@test.local', role: 'READ_ONLY' });

    const token = await login(app, observer.email, TEST_PASSWORD);

    const write = await request(app)
      .post('/api/v1/orders')
      .set(auth(token))
      .send({ pharmacyId: String(pharmacy._id), customerId: String(customer._id), deliveryDate: new Date().toISOString() });
    expect(write.status).toBe(403);

    const read = await request(app).get('/api/v1/orders').set(auth(token));
    expect(read.status).toBe(200);
  });

  it('stops a non-admin reading the audit log', async () => {
    const pharmacy = await createPharmacy();
    const staff = await createUser({
      email: 'noaudit@test.local',
      role: 'PHARMACY_ADMIN',
      pharmacyId: pharmacy._id,
    });

    const token = await login(app, staff.email, TEST_PASSWORD);
    const response = await request(app).get('/api/v1/audit-logs').set(auth(token));
    expect(response.status).toBe(403);
  });

  it('stops a pharmacy admin from creating a company-role account', async () => {
    const pharmacy = await createPharmacy();
    const admin = await createUser({
      email: 'pharmadmin@test.local',
      role: 'PHARMACY_ADMIN',
      pharmacyId: pharmacy._id,
    });

    const token = await login(app, admin.email, TEST_PASSWORD);
    const response = await request(app)
      .post('/api/v1/users')
      .set(auth(token))
      .send({
        firstName: 'Escalated',
        lastName: 'Admin',
        email: 'escalated@test.local',
        password: 'SomePassword1!',
        role: 'COMPANY_ADMIN',
      });

    expect(response.status).toBe(403);
  });
});

describe('Pharmacy deactivation guard', () => {
  it('refuses to deactivate a pharmacy with unresolved orders unless forced', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    await createReadyOrder(pharmacy._id, customer._id);
    const admin = await createUser({ email: 'coadmin@test.local', role: 'COMPANY_ADMIN' });

    const token = await login(app, admin.email, TEST_PASSWORD);

    const blocked = await request(app)
      .post(`/api/v1/pharmacies/${pharmacy._id}/active`)
      .set(auth(token))
      .send({ active: false });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('PHARMACY_HAS_ACTIVE_ORDERS');

    const forced = await request(app)
      .post(`/api/v1/pharmacies/${pharmacy._id}/active`)
      .set(auth(token))
      .send({ active: false, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.data.active).toBe(false);
  });
});

describe('Public patient tracking', () => {
  it('never exposes notes, amounts or the manifest', async () => {
    const pharmacy = await createPharmacy();
    const customer = await createCustomer(pharmacy._id);
    const order = await createReadyOrder(pharmacy._id, customer._id, {
      orderNotes: 'CONFIDENTIAL CLINICAL NOTE',
      amountDue: 42.5,
    });
    const staff = await createUser({
      email: 'tracking-staff@test.local',
      role: 'PHARMACY_ADMIN',
      pharmacyId: pharmacy._id,
    });

    const token = await login(app, staff.email, TEST_PASSWORD);
    const linkResponse = await request(app)
      .get(`/api/v1/orders/${order._id}/tracking-link`)
      .set(auth(token));
    expect(linkResponse.status).toBe(200);

    const trackingToken = linkResponse.body.data.token as string;
    const publicResponse = await request(app).get(`/api/v1/tracking/${trackingToken}`);

    expect(publicResponse.status).toBe(200);
    const body = JSON.stringify(publicResponse.body);
    expect(body).not.toContain('CONFIDENTIAL');
    expect(body).not.toContain('42.5');
    expect(body).not.toContain('Test medication');
    expect(publicResponse.body.data.statusLabel).toBeTruthy();
  });

  it('rejects a tampered tracking token', async () => {
    const response = await request(app).get('/api/v1/tracking/bm90LWEtcmVhbC10b2tlbg.forged');
    expect(response.status).toBe(400);
  });
});
