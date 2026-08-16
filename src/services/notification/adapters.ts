import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { NotificationChannel, NotificationType } from '../../constants/enums';

export interface OutboundNotification {
  channel: NotificationChannel;
  type: NotificationType;
  /** Opaque recipient handle (push token, phone, email). Never logged. */
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  channel: NotificationChannel;
  delivered: boolean;
  /** True when no real provider was configured and the send was a stub. */
  simulated: boolean;
  providerId?: string;
  error?: string;
}

export interface NotificationAdapter {
  readonly channel: NotificationChannel;
  readonly providerName: string;
  send(message: OutboundNotification): Promise<DeliveryResult>;
}

/**
 * Development adapter.
 *
 * Logs ONLY non-sensitive metadata — channel, notification type and order id.
 * Recipient handles and message bodies (which can contain patient-adjacent
 * information) are never written to the log. Every result is flagged
 * `simulated: true` so the UI can be honest about what actually happened.
 */
class DevAdapter implements NotificationAdapter {
  constructor(readonly channel: NotificationChannel, readonly providerName = 'dev') {}

  async send(message: OutboundNotification): Promise<DeliveryResult> {
    logger.debug('notification (simulated)', {
      channel: this.channel,
      type: message.type,
      orderId: message.data?.orderId ?? null,
    });
    return { channel: this.channel, delivered: true, simulated: true, providerId: 'dev-stub' };
  }
}

/**
 * Adapter registry. To go live, implement a real adapter (Expo Push, Twilio,
 * SendGrid…) with the same interface and register it here keyed by the value of
 * PUSH_PROVIDER / SMS_PROVIDER / EMAIL_PROVIDER.
 */
const registry: Record<NotificationChannel, NotificationAdapter> = {
  IN_APP: new DevAdapter('IN_APP', 'in-app'),
  PUSH: new DevAdapter('PUSH', env.providers.push),
  SMS: new DevAdapter('SMS', env.providers.sms),
  EMAIL: new DevAdapter('EMAIL', env.providers.email),
};

export function getAdapter(channel: NotificationChannel): NotificationAdapter {
  return registry[channel];
}

export function registerAdapter(adapter: NotificationAdapter): void {
  registry[adapter.channel] = adapter;
}

/** True when every configured external channel is still a development stub. */
export function usingSimulatedProviders(): boolean {
  return [env.providers.push, env.providers.sms, env.providers.email].every((p) => p === 'dev');
}
