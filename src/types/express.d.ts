import type { UserDocument } from '../models/User';

declare global {
   
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      user?: UserDocument;
      /** Correlation id echoed back in error responses for support. */
      requestId?: string;
    }
  }
}

export {};
