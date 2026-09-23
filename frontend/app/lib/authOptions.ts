import { NextAuthOptions, Session as DefaultSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { refreshAccessToken, Token } from "./refreshAccessToken";
import { JWT } from "next-auth/jwt";
import { ACCESS_TOKEN_REFRESH_MARGIN_MS, isTerminalRefreshError } from './authSessionPolicy';

export interface Session extends DefaultSession {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number;
  error?: string;
  refreshRetryAt?: number;
}

export const authOptions: NextAuthOptions = {
  pages: {
    error: "/auth/error",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      httpOptions: {
        timeout: parseInt(process.env.OAUTH_TIMEOUT ?? '10000', 10),
      },
      authorization: {
        params: {
          scope: [
            "openid",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/gmail.send",
          ].join(" "),
          access_type: "offline", 
          prompt: "consent",
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET!,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, account, user, trigger, session }): Promise<JWT> {
      if (account) {
        token.error = undefined;
        token.refreshRetryAt = undefined;
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token ?? token.refreshToken;
        token.accessTokenExpires = account.expires_at
          ? account.expires_at * 1000
          : Date.now() + 3600 * 1000;
        token.name = user?.name;
        token.email = user?.email;
        token.picture = user?.image;
        token.token_uri = "https://oauth2.googleapis.com/token";
        token.client_id = process.env.GOOGLE_CLIENT_ID!;
        token.client_secret = process.env.GOOGLE_CLIENT_SECRET!;
        return token;
      }

      const forceRefresh = trigger === 'update' && session?.refresh === true;
      if (!forceRefresh) {
        if (isTerminalRefreshError(token.error)) return token;
        if (typeof token.refreshRetryAt === 'number' && Date.now() < token.refreshRetryAt) return token;
        if (
          !token.error && token.accessToken &&
          typeof token.accessTokenExpires === "number" &&
          Date.now() < token.accessTokenExpires - ACCESS_TOKEN_REFRESH_MARGIN_MS
        ) {
          return token;
        }
      }

      return refreshAccessToken(token as Token);
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.refreshToken = token.refreshToken;
      session.accessTokenExpires = token.accessTokenExpires;
      session.error = token.error;
      session.refreshRetryAt = token.refreshRetryAt;
      session.user = {
        ...session.user,
        name: token.name,
        email: token.email,
        image: token.picture,
      };
      return session as Session;
    },
  },
  logger: {
    error(code, metadata) {
      console.error("NextAuth error:", code, metadata);
    },
    warn(code) {
      console.warn("NextAuth warning:", code);
    },
    debug(code, metadata) {
      console.debug("NextAuth debug:", code, metadata);
    },
  },
};
