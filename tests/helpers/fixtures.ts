import { Types } from 'mongoose';
import { Customer, Order, Pharmacy, User } from '../../src/models';
import type { CustomerDocument } from '../../src/models/Customer';
import type { OrderDocument } from '../../src/models/Order';
import type { PharmacyDocument } from '../../src/models/Pharmacy';
import type { UserDocument } from '../../src/models/User';

export const TEST_PASSWORD = 'TestPassword123!';

export async function createUser(overrides: Record<string, unknown> = {}): Promise<UserDocument> {
  return (await User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${new Types.ObjectId().toHexString()}@test.local`,
    passwordHash: await User.hashPassword(TEST_PASSWORD),
    role: 'DISPATCHER',
    active: true,
    ...overrides,
  } as never)) as unknown as UserDocument;
}

export async function createPharmacy(
  overrides: Record<string, unknown> = {},
): Promise<PharmacyDocument> {
  const suffix = new Types.ObjectId().toHexString().slice(-5).toUpperCase();
  return (await Pharmacy.create({
    name: `Test Pharmacy ${suffix}`,
    code: `TP${suffix}`,
    address: '1 Test Street',
    city: 'London',
    postalCode: 'N1 1AA',
    latitude: 51.53,
    longitude: -0.1,
    active: true,
    ...overrides,
  } as never)) as unknown as PharmacyDocument;
}

export async function createCustomer(
  pharmacyId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
): Promise<CustomerDocument> {
  const customer = new Customer({
    pharmacyId,
    firstName: 'Pat',
    lastName: 'Tester',
    phone: '+44 7700 900000',
    addresses: [
      {
        label: 'Home',
        line1: '10 Sample Road',
        city: 'London',
        postalCode: 'N1 2BB',
        latitude: 51.54,
        longitude: -0.11,
        isDefault: true,
      },
    ],
    ...overrides,
  });
  customer.defaultAddressId = customer.addresses[0]!._id;
  await customer.save();
  return customer;
}

/** Creates a READY, unclaimed order ready for the claim-race tests. */
export async function createReadyOrder(
  pharmacyId: Types.ObjectId,
  customerId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
): Promise<OrderDocument> {
  return (await Order.create({
    referenceNumber: `JD-${new Types.ObjectId().toHexString().slice(-8).toUpperCase()}`,
    pharmacyId,
    customerId,
    orderType: 'DELIVERY',
    status: 'READY',
    deliveryDate: new Date(),
    priority: 'NORMAL',
    amountDue: 10,
    packageCount: 1,
    pickupAddress: { line1: '1 Test Street', city: 'London' },
    deliveryAddress: { line1: '10 Sample Road', city: 'London' },
    pickupCoordinates: { latitude: 51.53, longitude: -0.1 },
    deliveryCoordinates: { latitude: 51.54, longitude: -0.11 },
    customerSnapshot: { firstName: 'Pat', lastName: 'Tester', phone: '+44 7700 900000', authorizedRecipients: [] },
    manifestItems: [{ name: 'Test medication', quantity: 1 }],
    proofConfigSnapshot: {
      signatureRequired: false,
      photoRequired: false,
      receiverIdentityRequired: true,
      authorizedRecipientRequired: false,
      manifestConfirmationRequired: false,
    },
    readyAt: new Date(),
    ...overrides,
  } as never)) as unknown as OrderDocument;
}
