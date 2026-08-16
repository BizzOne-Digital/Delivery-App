import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { denyReadOnlyWrites, requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import * as controller from './users.controller';
import {
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  resetCredentialsSchema,
  updatePreferencesSchema,
  updateUserSchema,
} from './users.validation';

const router = Router();

router.use(authenticate, denyReadOnlyWrites);

// Any signed-in user can update their own preferences.
router.patch('/me/preferences', validate({ body: updatePreferencesSchema }), controller.updatePreferences);
router.get('/roles', controller.listRoles);

const managers = requireRoles('COMPANY_ADMIN', 'DISPATCHER', 'PHARMACY_ADMIN', 'READ_ONLY', 'FINANCE');
const writers = requireRoles('COMPANY_ADMIN', 'PHARMACY_ADMIN');

router.get('/', managers, validate({ query: listUsersQuerySchema }), controller.listUsers);
router.get('/:id', managers, validate({ params: idParamSchema }), controller.getUser);

router.post('/', writers, validate({ body: createUserSchema }), controller.createUser);
router.patch(
  '/:id',
  writers,
  validate({ params: idParamSchema, body: updateUserSchema }),
  controller.updateUser,
);
router.post(
  '/:id/reset-credentials',
  writers,
  validate({ params: idParamSchema, body: resetCredentialsSchema }),
  controller.resetCredentials,
);

router.post(
  '/:id/archive',
  requireRoles('COMPANY_ADMIN'),
  validate({ params: idParamSchema }),
  controller.archiveUser,
);
router.post(
  '/:id/restore',
  requireRoles('COMPANY_ADMIN'),
  validate({ params: idParamSchema }),
  controller.restoreUser,
);

export default router;
