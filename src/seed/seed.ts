/* eslint-disable no-console */
/**
 * Development seed script.
 *
 * The demo password comes from SEED_PASSWORD in .env — it is never hard-coded
 * here, and neither is the MongoDB URI. Run with:
 *     npm run seed          (adds data, skips what already exists)
 *     npm run seed:reset    (wipes the seeded collections first)
 */
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../config/db';
import {
  AuditLog,
  Customer,
  DriverLocation,
  Notification,
  Order,
  PaymentReconciliation,
  Pharmacy,
  RecurringOrder,
  RefreshToken,
  Route,
  User,
} from '../models';
import { generateOrderReference } from '../utils/reference';
import { haversineKm } from '../utils/geo';
import { addDays, startOfDay } from '../utils/dates';
import type { PharmacyDocument } from '../models/Pharmacy';
import type { UserDocument } from '../models/User';
import type { Types } from 'mongoose';

const RESET = process.argv.includes('--reset');

function requireSeedPassword(): string {
  const password = env.seedPassword;
  if (!password || /^<.*>$/.test(password) || password.length < 8) {
    throw new Error(
      'SEED_PASSWORD is missing or too short in backend/.env.\n' +
        'Set a development password of at least 8 characters before seeding.',
    );
  }
  return password;
}

const OPENING_HOURS = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: day === 0 ? '10:00' : '08:30',
  close: day === 0 ? '14:00' : '18:30',
  closed: false,
}));

async function main() {
  const password = requireSeedPassword();

  await connectDatabase();
  console.log(`Connected to database "${env.mongoDbName}".`);

  if (RESET) {
    console.log('Resetting seeded collections…');
    await Promise.all([
      User.deleteMany({}),
      Pharmacy.deleteMany({}),
      Customer.deleteMany({}),
      Order.deleteMany({}),
      Route.deleteMany({}),
      DriverLocation.deleteMany({}),
      Notification.deleteMany({}),
      PaymentReconciliation.deleteMany({}),
      AuditLog.deleteMany({}),
      RecurringOrder.deleteMany({}),
      RefreshToken.deleteMany({}),
    ]);
  }

  const passwordHash = await User.hashPassword(password);

  /* ---------------- Company staff ---------------- */
  const companyAdmin = await upsertUser({
    firstName: 'Amara',
    lastName: 'Okonkwo',
    email: 'admin@deliveryapp.test',
    phone: '+44 7700 900101',
    role: 'COMPANY_ADMIN',
    passwordHash,
  });

  await upsertUser({
    firstName: 'Daniel',
    lastName: 'Reyes',
    email: 'dispatch@deliveryapp.test',
    phone: '+44 7700 900102',
    role: 'DISPATCHER',
    passwordHash,
  });

  await upsertUser({
    firstName: 'Priya',
    lastName: 'Nair',
    email: 'finance@deliveryapp.test',
    phone: '+44 7700 900103',
    role: 'FINANCE',
    passwordHash,
  });

  await upsertUser({
    firstName: 'Observer',
    lastName: 'Account',
    email: 'readonly@deliveryapp.test',
    role: 'READ_ONLY',
    passwordHash,
  });

  /* ---------------- Pharmacies ---------------- */
  const northgate = await upsertPharmacy({
    name: 'Northgate Community Pharmacy',
    code: 'NGP01',
    email: 'team@northgate.test',
    phone: '+44 20 7946 0111',
    contactPerson: 'Helen Marsh',
    address: '18 Northgate Street, Islington',
    city: 'London',
    postalCode: 'N1 4RT',
    latitude: 51.5362,
    longitude: -0.1033,
    deliveryStartTime: '10:00',
    pickupInstructions: 'Use the side door on Cavendish Lane. Ring the bell twice for the dispensary.',
    serviceZones: ['N1', 'N5', 'N7', 'EC1'],
    createdBy: companyAdmin._id,
  });

  const riverside = await upsertPharmacy({
    name: 'Riverside Care Chemist',
    code: 'RCC02',
    email: 'hello@riversidecare.test',
    phone: '+44 20 7946 0222',
    contactPerson: 'Marcus Bell',
    address: '4 Riverside Walk, Southwark',
    city: 'London',
    postalCode: 'SE1 9PX',
    latitude: 51.5045,
    longitude: -0.0865,
    deliveryStartTime: '11:00',
    pickupInstructions: 'Collect from the rear counter. Cold-chain items are in the blue fridge.',
    serviceZones: ['SE1', 'SE16', 'SE17'],
    proofConfig: {
      signatureRequired: true,
      photoRequired: true,
      receiverIdentityRequired: true,
      authorizedRecipientRequired: false,
      manifestConfirmationRequired: true,
    },
    createdBy: companyAdmin._id,
  });

  /* ---------------- Pharmacy staff ---------------- */
  await upsertUser({
    firstName: 'Helen',
    lastName: 'Marsh',
    email: 'helen@northgate.test',
    phone: '+44 7700 900201',
    role: 'PHARMACY_ADMIN',
    pharmacyId: northgate._id,
    passwordHash,
  });

  await upsertUser({
    firstName: 'Marcus',
    lastName: 'Bell',
    email: 'marcus@riversidecare.test',
    phone: '+44 7700 900202',
    role: 'PHARMACY_ADMIN',
    pharmacyId: riverside._id,
    passwordHash,
  });

  await upsertUser({
    firstName: 'Sofia',
    lastName: 'Duarte',
    email: 'sofia@northgate.test',
    role: 'PHARMACY_STAFF',
    pharmacyId: northgate._id,
    employeeCode: 'NG-114',
    passwordHash,
  });

  /* ---------------- Drivers ---------------- */
  const driverOne = await upsertUser({
    firstName: 'Jamal',
    lastName: 'Whitfield',
    email: 'jamal@deliveryapp.test',
    phone: '+44 7700 900301',
    role: 'DRIVER',
    employeeCode: 'DRV-001',
    assignedPharmacyIds: [northgate._id, riverside._id],
    driverStatus: 'AVAILABLE',
    passwordHash,
  });

  const driverTwo = await upsertUser({
    firstName: 'Elena',
    lastName: 'Kovač',
    email: 'elena@deliveryapp.test',
    phone: '+44 7700 900302',
    role: 'DRIVER',
    employeeCode: 'DRV-002',
    assignedPharmacyIds: [northgate._id],
    driverStatus: 'AVAILABLE',
    passwordHash,
  });

  const driverThree = await upsertUser({
    firstName: 'Tomas',
    lastName: 'Lindqvist',
    email: 'tomas@deliveryapp.test',
    phone: '+44 7700 900303',
    role: 'DRIVER',
    employeeCode: 'DRV-003',
    assignedPharmacyIds: [riverside._id],
    driverStatus: 'OFFLINE',
    passwordHash,
  });

  await Pharmacy.updateOne(
    { _id: northgate._id },
    { $set: { linkedDriverIds: [driverOne._id, driverTwo._id] } },
  );
  await Pharmacy.updateOne(
    { _id: riverside._id },
    { $set: { linkedDriverIds: [driverOne._id, driverThree._id] } },
  );

  /* ---------------- Customers ---------------- */
  const customers = await seedCustomers(northgate._id, riverside._id, companyAdmin._id);

  /* ---------------- Orders across every state ---------------- */
  await Order.deleteMany({ referenceNumber: { $regex: '^JD-' }, createdBy: companyAdmin._id });

  const today = startOfDay();
  const orders: unknown[] = [];

  // ACTION_REQUIRED
  orders.push(
    buildOrder({
      pharmacy: northgate,
      customer: customers[0]!,
      status: 'ACTION_REQUIRED',
      priority: 'NORMAL',
      amountDue: 0,
      deliveryDate: today,
      createdBy: companyAdmin._id,
      manifest: [{ name: 'Atorvastatin 20mg — 28 tablets', quantity: 1 }],
      notes: 'Patient asked for delivery after 2pm if possible.',
    }),
  );

  // PREPARING
  orders.push(
    buildOrder({
      pharmacy: riverside,
      customer: customers[3]!,
      status: 'PREPARING',
      priority: 'HIGH',
      amountDue: 9.65,
      deliveryDate: today,
      createdBy: companyAdmin._id,
      manifest: [
        { name: 'Insulin pen refill', quantity: 2, requiresColdChain: true },
        { name: 'Sharps bin', quantity: 1 },
      ],
    }),
  );

  // READY — unassigned open pool (Northgate)
  for (let i = 0; i < 4; i += 1) {
    orders.push(
      buildOrder({
        pharmacy: northgate,
        customer: customers[i % customers.length]!,
        status: 'READY',
        priority: i === 0 ? 'URGENT' : i === 1 ? 'HIGH' : 'NORMAL',
        amountDue: [0, 12.4, 7.5, 24][i] ?? 0,
        deliveryDate: today,
        timeWindow: i === 0 ? ['09:00', '12:00'] : ['12:00', '17:00'],
        createdBy: companyAdmin._id,
        manifest: [{ name: 'Repeat prescription pack', quantity: 1 }],
        notes: i === 0 ? 'Urgent — antibiotics course starts today.' : undefined,
      }),
    );
  }

  // READY — pre-assigned to driver two
  orders.push(
    buildOrder({
      pharmacy: northgate,
      customer: customers[1]!,
      status: 'READY',
      priority: 'NORMAL',
      amountDue: 15,
      deliveryDate: today,
      assignedDriverId: driverTwo._id,
      createdBy: companyAdmin._id,
      manifest: [{ name: 'Blood pressure monitor cuff', quantity: 1 }],
    }),
  );

  // READY — Riverside pool
  for (let i = 0; i < 3; i += 1) {
    orders.push(
      buildOrder({
        pharmacy: riverside,
        customer: customers[3 + (i % 2)]!,
        status: 'READY',
        priority: i === 0 ? 'URGENT' : 'NORMAL',
        amountDue: [0, 18.2, 5][i] ?? 0,
        deliveryDate: today,
        createdBy: companyAdmin._id,
        manifest: [{ name: 'Dosette box — week 34', quantity: 1 }],
      }),
    );
  }

  // ON_THE_WAY — driver one is carrying these
  for (let i = 0; i < 3; i += 1) {
    orders.push(
      buildOrder({
        pharmacy: northgate,
        customer: customers[i]!,
        status: 'ON_THE_WAY',
        priority: i === 0 ? 'HIGH' : 'NORMAL',
        amountDue: [11.5, 0, 32.75][i] ?? 0,
        deliveryDate: today,
        assignedDriverId: driverOne._id,
        claimed: true,
        createdBy: companyAdmin._id,
        manifest: [{ name: 'Monthly medication pack', quantity: 1 }],
      }),
    );
  }

  // RETURNING — failed delivery
  orders.push(
    buildOrder({
      pharmacy: northgate,
      customer: customers[2]!,
      status: 'RETURNING',
      priority: 'NORMAL',
      amountDue: 8.4,
      deliveryDate: today,
      assignedDriverId: driverOne._id,
      claimed: true,
      failed: 'CUSTOMER_ABSENT',
      createdBy: companyAdmin._id,
      manifest: [{ name: 'Inhaler — salbutamol', quantity: 2 }],
    }),
  );

  // RETURNING — customer pickup being brought back to the pharmacy
  orders.push(
    buildOrder({
      pharmacy: riverside,
      customer: customers[4]!,
      status: 'RETURNING',
      orderType: 'CUSTOMER_PICKUP',
      priority: 'NORMAL',
      amountDue: 0,
      deliveryDate: today,
      assignedDriverId: driverOne._id,
      claimed: true,
      createdBy: companyAdmin._id,
      manifest: [{ name: 'Unused medication for safe disposal', quantity: 1 }],
    }),
  );

  // COMPLETED — spread over the last 10 days for meaningful reports
  for (let day = 0; day < 10; day += 1) {
    const count = day === 0 ? 4 : 3;
    for (let i = 0; i < count; i += 1) {
      const pharmacy = i % 2 === 0 ? northgate : riverside;
      const driver = i % 3 === 0 ? driverTwo : driverOne;
      const amount = [0, 12.5, 6.25, 19.99][i % 4] ?? 0;
      orders.push(
        buildOrder({
          pharmacy,
          customer: customers[(day + i) % customers.length]!,
          status: 'COMPLETED',
          priority: 'NORMAL',
          amountDue: amount,
          amountCollected: day === 3 && i === 1 ? amount - 2 : amount, // one discrepancy
          deliveryDate: addDays(today, -day),
          assignedDriverId: driver._id,
          claimed: true,
          completedDaysAgo: day,
          createdBy: companyAdmin._id,
          manifest: [{ name: 'Repeat prescription pack', quantity: 1 }],
        }),
      );
    }
  }

  // CANCELLED
  orders.push(
    buildOrder({
      pharmacy: riverside,
      customer: customers[3]!,
      status: 'CANCELLED',
      priority: 'NORMAL',
      amountDue: 0,
      deliveryDate: addDays(today, -2),
      createdBy: companyAdmin._id,
      manifest: [{ name: 'Prescription pack', quantity: 1 }],
    }),
  );

  const inserted = await Order.insertMany(orders as never[]);
  console.log(`Seeded ${inserted.length} orders.`);

  /* ---------------- Recurring schedule ---------------- */
  await RecurringOrder.deleteMany({});
  await RecurringOrder.create({
    pharmacyId: northgate._id,
    customerId: customers[0]!._id,
    orderType: 'DELIVERY',
    frequency: 'SELECTED_WEEKDAYS',
    weekdays: [1, 4],
    startDate: addDays(today, -14),
    endDate: addDays(today, 60),
    timeWindowStart: '10:00',
    timeWindowEnd: '13:00',
    priority: 'NORMAL',
    amountDue: 0,
    packageCount: 1,
    manifestItems: [{ name: 'Weekly dosette box', quantity: 1 }],
    orderNotes: 'Leave with the neighbour at number 12 if no answer.',
    createdBy: companyAdmin._id,
  });

  /* ---------------- Driver last-known positions ---------------- */
  await User.updateOne(
    { _id: driverOne._id },
    {
      $set: {
        driverStatus: 'DELIVERING',
        shiftStartedAt: new Date(Date.now() - 3 * 3600_000),
        lastKnownLocation: { latitude: 51.5301, longitude: -0.1122, recordedAt: new Date() },
      },
    },
  );
  await User.updateOne(
    { _id: driverTwo._id },
    {
      $set: {
        driverStatus: 'AVAILABLE',
        shiftStartedAt: new Date(Date.now() - 1 * 3600_000),
        lastKnownLocation: { latitude: 51.5188, longitude: -0.0925, recordedAt: new Date() },
      },
    },
  );

  /* ---------------- Cash reconciliation ---------------- */
  await PaymentReconciliation.deleteMany({});
  await PaymentReconciliation.create({
    driverId: driverOne._id,
    date: addDays(today, -1),
    expectedAmount: 38.74,
    submittedAmount: 36.74,
    difference: -2,
    orderCount: 3,
    status: 'SUBMITTED',
    notes: 'Customer paid £2 short; agreed the pharmacy would invoice the balance.',
    breakdown: [
      { method: 'CASH', amount: 36.74, count: 3 },
      { method: 'CARD', amount: 12.5, count: 1 },
    ],
  });

  console.log('\n──────────────────────────────────────────────');
  console.log(' Seed complete. Demo accounts (password from SEED_PASSWORD):');
  console.log('──────────────────────────────────────────────');
  for (const [role, email] of [
    ['Company admin  ', 'admin@deliveryapp.test'],
    ['Dispatcher     ', 'dispatch@deliveryapp.test'],
    ['Finance        ', 'finance@deliveryapp.test'],
    ['Read-only      ', 'readonly@deliveryapp.test'],
    ['Pharmacy admin ', 'helen@northgate.test'],
    ['Pharmacy admin ', 'marcus@riversidecare.test'],
    ['Pharmacy staff ', 'sofia@northgate.test'],
    ['Driver         ', 'jamal@deliveryapp.test'],
    ['Driver         ', 'elena@deliveryapp.test'],
    ['Driver         ', 'tomas@deliveryapp.test'],
  ]) {
    console.log(`  ${role} ${email}`);
  }
  console.log('──────────────────────────────────────────────\n');

  await disconnectDatabase();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function upsertUser(data: Record<string, unknown>): Promise<UserDocument> {
  const existing = await User.findOne({ email: data.email });
  if (existing) {
    Object.assign(existing, { ...data, passwordHash: data.passwordHash });
    await existing.save();
    return existing;
  }
  return (await User.create(data as never)) as unknown as UserDocument;
}

async function upsertPharmacy(data: Record<string, unknown>): Promise<PharmacyDocument> {
  const existing = await Pharmacy.findOne({ code: data.code });
  if (existing) {
    Object.assign(existing, data);
    await existing.save();
    return existing;
  }
  return (await Pharmacy.create({
    openingHours: OPENING_HOURS,
    ...data,
  } as never)) as unknown as PharmacyDocument;
}

async function seedCustomers(
  northgateId: Types.ObjectId,
  riversideId: Types.ObjectId,
  createdBy: Types.ObjectId,
) {
  await Customer.deleteMany({});

  const definitions = [
    {
      pharmacyId: northgateId,
      firstName: 'Margaret',
      lastName: 'Ellis',
      phone: '+44 7700 900401',
      email: 'm.ellis@example.test',
      addresses: [
        {
          label: 'Home',
          line1: '42 Cavendish Lane',
          city: 'London',
          postalCode: 'N1 5RG',
          latitude: 51.5401,
          longitude: -0.0987,
          isDefault: true,
          accessInstructions: 'Second floor, no lift. Buzzer 4B.',
        },
      ],
      deliveryNotes: 'Hard of hearing — please knock loudly and wait.',
      tags: ['housebound', 'priority'],
      authorizedRecipients: [
        { name: 'Colin Ellis', relationship: 'Son', phone: '+44 7700 900411' },
      ],
    },
    {
      pharmacyId: northgateId,
      firstName: 'Idris',
      lastName: 'Rahman',
      phone: '+44 7700 900402',
      addresses: [
        {
          label: 'Home',
          line1: '9 Barnsbury Road',
          city: 'London',
          postalCode: 'N1 0EX',
          latitude: 51.5335,
          longitude: -0.1091,
          isDefault: true,
        },
      ],
      tags: ['regular'],
    },
    {
      pharmacyId: northgateId,
      firstName: 'Wei',
      lastName: 'Zhang',
      phone: '+44 7700 900403',
      preferredLanguage: 'en',
      addresses: [
        {
          label: 'Home',
          line1: '77 Highbury Grove',
          city: 'London',
          postalCode: 'N5 2AF',
          latitude: 51.5497,
          longitude: -0.0987,
          isDefault: true,
        },
        {
          label: 'Work',
          line1: '3 Angel Square',
          city: 'London',
          postalCode: 'EC1V 1NY',
          latitude: 51.5322,
          longitude: -0.1057,
          isDefault: false,
        },
      ],
      deliveryNotes: 'Prefers afternoon deliveries.',
      tags: ['regular'],
    },
    {
      pharmacyId: riversideId,
      firstName: 'Aoife',
      lastName: "O'Donnell",
      phone: '+44 7700 900404',
      addresses: [
        {
          label: 'Home',
          line1: '15 Union Street',
          city: 'London',
          postalCode: 'SE1 1SD',
          latitude: 51.5041,
          longitude: -0.0937,
          isDefault: true,
        },
      ],
      tags: ['cold-chain'],
      authorizedRecipients: [
        { name: 'Reception — Union House', relationship: 'Reception', phone: '+44 20 7946 0333' },
      ],
    },
    {
      pharmacyId: riversideId,
      firstName: 'Samuel',
      lastName: 'Adeyemi',
      phone: '+44 7700 900405',
      addresses: [
        {
          label: 'Care home',
          line1: 'Rosewood Care Home, 2 Long Lane',
          city: 'London',
          postalCode: 'SE1 4PG',
          latitude: 51.5017,
          longitude: -0.0891,
          isDefault: true,
          accessInstructions: 'Sign in at reception. Ask for the medication room.',
        },
      ],
      deliveryNotes: 'Care home staff must sign. Do not leave with the resident.',
      tags: ['care-home'],
      authorizedRecipients: [
        { name: 'Nurse in charge', relationship: 'Care home staff', phone: '+44 20 7946 0444' },
      ],
    },
  ];

  const created = [];
  for (const definition of definitions) {
    const customer = new Customer({ ...definition, createdBy });
    customer.defaultAddressId = customer.addresses.find((a) => a.isDefault)?._id ?? null;
    await customer.save();
    created.push(customer);
  }
  console.log(`Seeded ${created.length} customers.`);
  return created;
}

interface BuildOrderInput {
  pharmacy: { _id: Types.ObjectId; name: string; address: string; city?: string; postalCode?: string; latitude: number; longitude: number; pickupInstructions?: string; proofConfig?: unknown };
  customer: {
    _id: Types.ObjectId;
    firstName: string;
    lastName: string;
    phone: string;
    alternatePhone?: string;
    deliveryNotes?: string;
    addresses: { line1: string; line2?: string; city?: string; postalCode?: string; latitude?: number | null; longitude?: number | null; label?: string; accessInstructions?: string; isDefault: boolean }[];
    authorizedRecipients: { name: string; relationship: string; phone?: string }[];
  };
  status: string;
  orderType?: string;
  priority: string;
  amountDue: number;
  amountCollected?: number;
  deliveryDate: Date;
  timeWindow?: [string, string];
  assignedDriverId?: Types.ObjectId;
  claimed?: boolean;
  failed?: string;
  completedDaysAgo?: number;
  createdBy: Types.ObjectId;
  manifest: { name: string; quantity: number; requiresColdChain?: boolean }[];
  notes?: string;
}

function buildOrder(input: BuildOrderInput) {
  const address = input.customer.addresses.find((a) => a.isDefault) ?? input.customer.addresses[0]!;
  const isPickup = input.orderType === 'CUSTOMER_PICKUP';

  const pharmacyAddress = {
    label: input.pharmacy.name,
    line1: input.pharmacy.address,
    city: input.pharmacy.city,
    postalCode: input.pharmacy.postalCode,
    accessInstructions: input.pharmacy.pickupInstructions,
  };
  const customerAddress = {
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    postalCode: address.postalCode,
    accessInstructions: address.accessInstructions,
  };
  const pharmacyCoords = { latitude: input.pharmacy.latitude, longitude: input.pharmacy.longitude };
  const customerCoords =
    address.latitude && address.longitude
      ? { latitude: address.latitude, longitude: address.longitude }
      : null;

  const now = new Date();
  const daysAgo = input.completedDaysAgo ?? 0;
  const base = new Date(now.getTime() - daysAgo * 86_400_000);

  const timeline: Record<string, unknown>[] = [
    { action: 'ORDER_CREATED', status: 'ACTION_REQUIRED', at: new Date(base.getTime() - 4 * 3600_000), byUserId: input.createdBy, byRole: 'PHARMACY_ADMIN' },
  ];
  if (['READY', 'ON_THE_WAY', 'RETURNING', 'COMPLETED'].includes(input.status)) {
    timeline.push({ action: 'STATUS_READY', status: 'READY', at: new Date(base.getTime() - 3 * 3600_000), byUserId: input.createdBy, byRole: 'PHARMACY_ADMIN' });
  }
  if (input.claimed) {
    timeline.push({ action: 'DRIVER_TOOK_OWNERSHIP', status: 'ON_THE_WAY', at: new Date(base.getTime() - 2 * 3600_000), byUserId: input.assignedDriverId, byRole: 'DRIVER' });
  }
  if (input.status === 'COMPLETED') {
    timeline.push({ action: 'DELIVERY_COMPLETED', status: 'COMPLETED', at: new Date(base.getTime() - 3600_000), byUserId: input.assignedDriverId, byRole: 'DRIVER' });
  }
  if (input.failed) {
    timeline.push({ action: 'DELIVERY_FAILED', status: 'RETURNING', at: new Date(base.getTime() - 3600_000), byUserId: input.assignedDriverId, byRole: 'DRIVER', note: input.failed });
  }

  const amountCollected =
    input.status === 'COMPLETED' ? (input.amountCollected ?? input.amountDue) : 0;

  return {
    referenceNumber: generateOrderReference(),
    pharmacyId: input.pharmacy._id,
    customerId: input.customer._id,
    orderType: input.orderType ?? 'DELIVERY',
    status: input.status,
    assignedDriverId: input.assignedDriverId ?? null,
    claimedAt: input.claimed ? new Date(base.getTime() - 2 * 3600_000) : null,
    deliveryDate: input.deliveryDate,
    timeWindowStart: input.timeWindow?.[0],
    timeWindowEnd: input.timeWindow?.[1],
    priority: input.priority,
    amountDue: input.amountDue,
    amountCollected,
    paymentMethod:
      input.status === 'COMPLETED' ? (input.amountDue > 0 ? 'CASH' : 'NO_PAYMENT') : null,
    orderNotes: input.notes,
    customerNotesSnapshot: input.customer.deliveryNotes ?? '',
    pickupAddress: isPickup ? customerAddress : pharmacyAddress,
    deliveryAddress: isPickup ? pharmacyAddress : customerAddress,
    pickupCoordinates: isPickup ? customerCoords : pharmacyCoords,
    deliveryCoordinates: isPickup ? pharmacyCoords : customerCoords,
    customerSnapshot: {
      firstName: input.customer.firstName,
      lastName: input.customer.lastName,
      phone: input.customer.phone,
      alternatePhone: input.customer.alternatePhone,
      authorizedRecipients: input.customer.authorizedRecipients ?? [],
    },
    manifestItems: input.manifest.map((m) => ({ ...m, confirmed: input.status === 'COMPLETED' })),
    packageCount: input.manifest.length,
    proofConfigSnapshot: input.pharmacy.proofConfig ?? {
      signatureRequired: true,
      photoRequired: false,
      receiverIdentityRequired: true,
      authorizedRecipientRequired: false,
      manifestConfirmationRequired: true,
    },
    proofOfDelivery:
      input.status === 'COMPLETED'
        ? {
            receiverType: 'CUSTOMER',
            receiverName: `${input.customer.firstName} ${input.customer.lastName}`,
            receiverRelationship: 'Self',
            signatureUrl: null,
            photoUrls: [],
            photoMeta: [],
            manifestConfirmed: true,
            coordinates: customerCoords,
            capturedAt: new Date(base.getTime() - 3600_000),
            capturedByDriverId: input.assignedDriverId ?? null,
          }
        : null,
    failureDetails: input.failed
      ? {
          reason: input.failed,
          note: 'No answer after three attempts; no safe place available.',
          callAttempted: true,
          coordinates: customerCoords,
          failedAt: new Date(base.getTime() - 3600_000),
          failedByDriverId: input.assignedDriverId ?? null,
          attemptNumber: 1,
        }
      : null,
    returnDetails:
      input.status === 'RETURNING'
        ? {
            destinationPharmacyId: input.pharmacy._id,
            exceptionStatus: input.failed ? 'OPEN' : 'NONE',
            dispatcherNotes: [],
          }
        : null,
    readyAt: ['READY', 'ON_THE_WAY', 'RETURNING', 'COMPLETED'].includes(input.status)
      ? new Date(base.getTime() - 3 * 3600_000)
      : null,
    onTheWayAt: input.claimed ? new Date(base.getTime() - 2 * 3600_000) : null,
    completedAt: input.status === 'COMPLETED' ? new Date(base.getTime() - 3600_000) : null,
    failedAt: input.failed ? new Date(base.getTime() - 3600_000) : null,
    returningAt: input.status === 'RETURNING' ? new Date(base.getTime() - 3600_000) : null,
    cancelledAt: input.status === 'CANCELLED' ? new Date(base.getTime() - 3600_000) : null,
    cancellationDetails:
      input.status === 'CANCELLED'
        ? { reason: 'Patient no longer needs this delivery', cancelledAt: new Date(base.getTime() - 3600_000), cancelledBy: input.createdBy, requiredReturn: false }
        : null,
    distanceKm: customerCoords
      ? Math.round(haversineKm(pharmacyCoords, customerCoords) * 100) / 100
      : null,
    timeline,
    createdBy: input.createdBy,
    createdAt: new Date(base.getTime() - 4 * 3600_000),
  };
}

main().catch(async (error: unknown) => {
  console.error('\nSeeding failed:');
  console.error(error instanceof Error ? error.message : error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
