import "express-session";
import "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      googleId: string;
      email: string;
      name: string;
      avatar: string | null;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    slackOAuthState?: string;
  }
}