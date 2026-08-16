import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { denyReadOnlyWrites, requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../users/users.validation';
import * as controller from './orders.controller';
import * as driver from './orders.driver.controller';
import * as recurring from './recurring.controller';
import {
  assignOrderSchema,
  batchAssignSchema,
  cancelOrderSchema,
  claimBatchSchema,
  completeOrderSchema,
  createOrderSchema,
  createRecurringSchema,
  exceptionSchema,
  failOrderSchema,
  listOrdersQuerySchema,
  returnToPharmacySchema,
  statusChangeSchema,
  updateOrderSchema,
} from './orders.validation';

const router = Router();

router.use(authenticate, denyReadOnlyWrites);

const pharmacyWriters = requireRoles('COMPANY_ADMIN', 'DISPATCHER', 'PHARMACY_ADMIN', 'PHARMACY_STAFF');
const dispatchers = requireRoles('COMPANY_ADMIN', 'DISPATCHER');
const drivers = requireRoles('DRIVER');

/* ---------------- Driver workflow ---------------- */
router.get('/driver/ready', drivers, driver.readyFeed);
router.get('/driver/on-the-way', drivers, driver.onTheWayFeed);
router.get('/driver/returning', drivers, driver.returningFeed);
router.get('/driver/history', drivers, driver.driverHistory);
router.post('/driver/status', drivers, driver.setDriverStatus);
router.post('/driver/claim-batch', drivers, validate({ body: claimBatchSchema }), driver.claimBatch);

router.post('/:id/claim', drivers, validate({ params: idParamSchema }), driver.claimOrder);
router.post(
  '/:id/complete',
  drivers,
  validate({ params: idParamSchema, body: completeOrderSchema }),
  driver.completeOrder,
);
router.post(
  '/:id/fail',
  drivers,
  validate({ params: idParamSchema, body: failOrderSchema }),
  driver.failOrder,
);
router.post(
  '/:id/back-to-delivery',
  drivers,
  validate({ params: idParamSchema }),
  driver.backToDelivery,
);
router.post(
  '/:id/confirm-returned',
  drivers,
  validate({ params: idParamSchema, body: returnToPharmacySchema }),
  driver.confirmReturned,
);

/* ---------------- Recurring orders ---------------- */
router.get('/recurring', recurring.listRecurring);
router.post(
  '/recurring',
  pharmacyWriters,
  validate({ body: createRecurringSchema }),
  recurring.createRecurring,
);
router.post('/recurring/generate', pharmacyWriters, recurring.generateDueOrders);
router.patch(
  '/recurring/:id',
  pharmacyWriters,
  validate({ params: idParamSchema }),
  recurring.updateRecurring,
);
router.post(
  '/recurring/:id/skip',
  pharmacyWriters,
  validate({ params: idParamSchema }),
  recurring.skipOccurrence,
);
router.post(
  '/recurring/:id/cancel',
  pharmacyWriters,
  validate({ params: idParamSchema }),
  recurring.cancelRecurring,
);

/* ---------------- Boards + returns ---------------- */
router.get('/board/dispatch', controller.dispatchBoard);
router.get('/returns', controller.listReturns);

/* ---------------- CRUD ---------------- */
router.get('/', validate({ query: listOrdersQuerySchema }), controller.listOrders);
router.post('/', pharmacyWriters, validate({ body: createOrderSchema }), controller.createOrder);

router.get('/:id', validate({ params: idParamSchema }), controller.getOrder);
router.get('/:id/timeline', validate({ params: idParamSchema }), controller.getOrderTimeline);
router.get('/:id/tracking-link', validate({ params: idParamSchema }), controller.createTrackingLink);

router.patch(
  '/:id',
  pharmacyWriters,
  validate({ params: idParamSchema, body: updateOrderSchema }),
  controller.updateOrder,
);
router.post(
  '/:id/status',
  pharmacyWriters,
  validate({ params: idParamSchema, body: statusChangeSchema }),
  controller.changeStatus,
);
router.post(
  '/:id/cancel',
  pharmacyWriters,
  validate({ params: idParamSchema, body: cancelOrderSchema }),
  controller.cancelOrder,
);
router.post(
  '/:id/duplicate',
  pharmacyWriters,
  validate({ params: idParamSchema }),
  controller.duplicateOrder,
);
router.post('/:id/priority', pharmacyWriters, validate({ params: idParamSchema }), controller.setPriority);
router.post('/:id/eta', validate({ params: idParamSchema }), controller.updateEta);

/* ---------------- Dispatcher actions ---------------- */
router.post(
  '/:id/assign',
  dispatchers,
  validate({ params: idParamSchema, body: assignOrderSchema }),
  controller.assignOrder,
);
router.post('/batch-assign', dispatchers, validate({ body: batchAssignSchema }), controller.batchAssign);
router.post(
  '/:id/transfer',
  dispatchers,
  validate({ params: idParamSchema, body: assignOrderSchema }),
  controller.transferOrder,
);
router.post(
  '/:id/retry',
  dispatchers,
  validate({ params: idParamSchema }),
  controller.approveRetry,
);
router.post(
  '/:id/exception',
  dispatchers,
  validate({ params: idParamSchema, body: exceptionSchema }),
  controller.updateReturnException,
);
router.post(
  '/:id/clear-review',
  dispatchers,
  validate({ params: idParamSchema }),
  controller.flagForReview,
);
router.post(
  '/:id/acknowledge-return',
  pharmacyWriters,
  validate({ params: idParamSchema }),
  controller.acknowledgeReturn,
);

export default router;
