import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import usersRoutes from '../modules/users/users.routes';
import pharmaciesRoutes from '../modules/pharmacies/pharmacies.routes';
import customersRoutes from '../modules/customers/customers.routes';
import ordersRoutes from '../modules/orders/orders.routes';
import driversRoutes from '../modules/drivers/drivers.routes';
import routesRoutes from '../modules/routes/routes.routes';
import locationsRoutes from '../modules/locations/locations.routes';
import notificationsRoutes from '../modules/notifications/notifications.routes';
import reportsRoutes from '../modules/reports/reports.routes';
import reconciliationsRoutes from '../modules/reconciliations/reconciliations.routes';
import uploadsRoutes from '../modules/uploads/uploads.routes';
import auditRoutes from '../modules/audit/audit.routes';
import trackingRoutes from '../modules/tracking/tracking.routes';
import healthRoutes from '../modules/health/health.routes';

/** All API routes live under /api/v1. */
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/pharmacies', pharmaciesRoutes);
router.use('/customers', customersRoutes);
router.use('/orders', ordersRoutes);
router.use('/drivers', driversRoutes);
router.use('/routes', routesRoutes);
router.use('/locations', locationsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/reports', reportsRoutes);
router.use('/reconciliations', reconciliationsRoutes);
router.use('/uploads', uploadsRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/tracking', trackingRoutes);

export default router;
