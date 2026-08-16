import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  pushTokenSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.validation';

const router = Router();

router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', optionalAuthenticate, validate({ body: logoutSchema }), controller.logout);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

router.get('/me', authenticate, controller.me);
router.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
router.post(
  '/push-token',
  authenticate,
  validate({ body: pushTokenSchema }),
  controller.registerPushToken,
);

export default router;
