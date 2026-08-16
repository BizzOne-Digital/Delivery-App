import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { denyReadOnlyWrites, requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../users/users.validation';
import * as controller from './customers.controller';
import {
  createCustomerSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from './customers.validation';

const router = Router();

router.use(authenticate, denyReadOnlyWrites);

const readers = requireRoles(
  'COMPANY_ADMIN',
  'DISPATCHER',
  'FINANCE',
  'READ_ONLY',
  'PHARMACY_ADMIN',
  'PHARMACY_STAFF',
);
const writers = requireRoles('COMPANY_ADMIN', 'PHARMACY_ADMIN', 'PHARMACY_STAFF');

router.get('/', readers, validate({ query: listCustomersQuerySchema }), controller.listCustomers);
router.get('/:id', readers, validate({ params: idParamSchema }), controller.getCustomer);

router.post('/', writers, validate({ body: createCustomerSchema }), controller.createCustomer);
router.patch(
  '/:id',
  writers,
  validate({ params: idParamSchema, body: updateCustomerSchema }),
  controller.updateCustomer,
);
router.post(
  '/:id/archive',
  writers,
  validate({ params: idParamSchema }),
  controller.archiveCustomer,
);
router.post(
  '/:id/restore',
  writers,
  validate({ params: idParamSchema }),
  controller.restoreCustomer,
);

export default router;
