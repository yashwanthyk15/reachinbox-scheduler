import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { config } from "./config";
import { prisma } from "./db";
import { encryptSecret } from "./crypto";

if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    callbackURL: config.GOOGLE_CALLBACK_URL,
    state: true,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error("Google did not provide an email address."));
      const user = await prisma.user.upsert({
        where: { googleId: profile.id },
        update: {
          email,
          name: profile.displayName || email,
          avatar: profile.photos?.[0]?.value,
        },
        create: {
          googleId: profile.id,
          email,
          name: profile.displayName || email,
          avatar: profile.photos?.[0]?.value,
        },
      });
      done(null, user);
    } catch (error) {
      done(error as Error);
    }
  }));
}

passport.serializeUser((user, done) => done(null, (user as { id: string }).id));
passport.deserializeUser(async (id: string, done) => {
  try {
    done(null, await prisma.user.findUnique({ where: { id } }) ?? false);
  } catch (error) {
    done(error);
  }
});

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) {
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required." });
}

export const authRouter = Router();

authRouter.get("/google", (req, res, next) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google OAuth credentials are not configured." });
    return;
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

authRouter.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { failureRedirect: `${config.FRONTEND_URL}/?login=failed` }, (error: Error | null, user: Express.User | false) => {
    if (error || !user) {
      res.redirect(`${config.FRONTEND_URL}/?login=failed`);
      return;
    }
    req.logIn(user, (loginError) => {
      if (loginError) {
        next(loginError);
        return;
      }
      res.redirect(config.FRONTEND_URL);
    });
  })(req, res, next);
});

authRouter.get("/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);
    req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie("reachinbox.sid");
      res.redirect(config.FRONTEND_URL);
    });
  });
});

authRouter.get("/slack", requireAuth, (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    res.status(503).json({ error: "Slack OAuth credentials are not configured." });
    return;
  }
  const state = randomBytes(24).toString("hex");
  req.session.slackOAuthState = state;
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "chat:write,users:read,im:write",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

authRouter.get("/slack/callback", requireAuth, async (req, res, next) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!state || state !== req.session.slackOAuthState || !code) {
    res.status(400).send("Invalid Slack OAuth state.");
    return;
  }
  delete req.session.slackOAuthState;

  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.SLACK_CLIENT_ID!,
        client_secret: config.SLACK_CLIENT_SECRET!,
        redirect_uri: config.SLACK_CALLBACK_URL,
      }),
    });
    const result = await response.json() as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id?: string; name?: string };
      authed_user?: { id?: string };
    };
    if (!result.ok || !result.access_token || !result.team?.id || !result.authed_user?.id) {
      throw new Error(result.error || "Slack did not return a bot token and workspace.");
    }

    await prisma.slackIntegration.upsert({
      where: { userId: req.user!.id },
      update: {
        teamId: result.team.id,
        teamName: result.team.name || "Slack workspace",
        botToken: encryptSecret(result.access_token),
        slackUserId: result.authed_user.id,
      },
      create: {
        userId: req.user!.id,
        teamId: result.team.id,
        teamName: result.team.name || "Slack workspace",
        botToken: encryptSecret(result.access_token),
        slackUserId: result.authed_user.id,
      },
    });
    res.redirect(`${config.FRONTEND_URL}/?slack=connected`);
  } catch (error) {
    next(error);
  }
});