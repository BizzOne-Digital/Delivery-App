import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { denyReadOnlyWrites, requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../users/users.validation';
import * as controller from './pharmacies.controller';
import {
  createPharmacySchema,
  linkDriversSchema,
  listPharmaciesQuerySchema,
  toggleActiveSchema,
  updatePharmacySchema,
} from './pharmacies.validation';

const router = Router();

router.use(authenticate, denyReadOnlyWrites);

/** Driver-facing Ready-screen pharmacy board (live counts + distance). */
router.get('/driver-board', requireRoles('DRIVER'), controller.driverPharmacyBoard);

router.get('/', validate({ query: listPharmaciesQuerySchema }), controller.listPharmacies);
router.get('/:id', validate({ params: idParamSchema }), controller.getPharmacy);

const companyAdmin = requireRoles('COMPANY_ADMIN');

router.post('/', companyAdmin, validate({ body: createPharmacySchema }), controller.createPharmacy);

// Pharmacy admins may edit their own operational settings; guarded in the controller.
router.patch(
  '/:id',
  requireRoles('COMPANY_ADMIN', 'PHARMACY_ADMIN'),
  validate({ params: idParamSchema, body: updatePharmacySchema }),
  controller.updatePharmacy,
);

router.post(
  '/:id/active',
  companyAdmin,
  validate({ params: idParamSchema, body: toggleActiveSchema }),
  controller.setActive,
);
router.post(
  '/:id/archive',
  companyAdmin,
  validate({ params: idParamSchema }),
  controller.archivePharmacy,
);
router.post(
  '/:id/drivers',
  companyAdmin,
  validate({ params: idParamSchema, body: linkDriversSchema }),
  controller.linkDrivers,
);

export default router;
