import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign-in went sideways",
};

type AuthErrorCode = string | undefined;

const ERROR_COPY: Record<string, { title: string; subtitle: string }> = {
  Configuration: {
    title: "The auth knobs are in a knot",
    subtitle:
      "Something in the OAuth wiring is arguing with itself. If you are the admin, peek at env vars and Google console settings—then we can all pretend this never happened.",
  },
  AccessDenied: {
    title: "The velvet rope stayed down",
    subtitle:
      "Google said “nope,” or you tapped cancel. No judgment—sometimes we all need a moment before letting an app see our spreadsheets.",
  },
  Verification: {
    title: "That magic link pulled a Cinderella",
    subtitle:
      "It expired, or it already had its one dance. Ask for a fresh sign-in link and try again before the clock strikes midnight (or five minutes—whichever comes first).",
  },
  OAuthSignin: {
    title: "We rang the OAuth doorbell—nobody answered",
    subtitle:
      "Starting the Google handshake failed. Networks glitch, tabs multiply; give it another shot in a clean window.",
  },
  OAuthCallback: {
    title: "Google sent a postcard—we couldn’t read the handwriting",
    subtitle:
      "The OAuth callback tripped on the way back. Usually a retry fixes it; if not, your IT gremlin may be hungry.",
  },
  OAuthCreateAccount: {
    title: "We tried to mint a new account and dropped the coin",
    subtitle:
      "Account creation via OAuth hiccuped. Retry sign-in; if it keeps happening, your email might already be in use another way.",
  },
  Callback: {
    title: "Callback? More like call-wrong",
    subtitle:
      "The sign-in round-trip didn’t finish. Refresh and try again—we promise we are not ghosting you on purpose.",
  },
  OAuthAccountNotLinked: {
    title: "This Google face doesn’t match our guest list",
    subtitle:
      "That account isn’t linked here yet. Sign in with the Google you used before, or ask an admin to invite the right address.",
  },
  EmailSignin: {
    title: "The email link got lost in the couch cushions",
    subtitle:
      "We couldn’t complete email sign-in. Request a new link and maybe check spam—where good intentions go to nap.",
  },
  CredentialsSignin: {
    title: "Username and password had a domestic dispute",
    subtitle:
      "Those credentials didn’t pass the vibe check. Double-check caps lock and try again—unless you enjoy drama.",
  },
  SessionRequired: {
    title: "You need to be logged in for this plot line",
    subtitle:
      "This page expects a session. Sign in and we will roll the opening credits for you.",
  },
};

function resolveCopy(error: AuthErrorCode): { title: string; subtitle: string } {
  if (!error) {
    return {
      title: "Authentication took an unscheduled coffee break",
      subtitle:
        "No error code—just vibes. If you were signing in, try again; if you were clicking random URLs, we respect the curiosity.",
    };
  }
  return (
    ERROR_COPY[error] ?? {
      title: "Something auth-shaped went splat",
      subtitle: `The server whispered “${error}.” We are not sure what it meant either—retry sign-in, or come back after a quick stretch.`,
    }
  );
}

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function AuthErrorPage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  const { title, subtitle } = resolveCopy(error);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200/80 bg-white/90 p-8 shadow-lg shadow-slate-200/60 backdrop-blur-sm">
        <p className="mb-2 text-center text-5xl" aria-hidden>
          🧤
        </p>
        <h1 className="mb-3 text-center text-2xl font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        <p className="mb-8 text-center text-[15px] leading-relaxed text-slate-600">
          {subtitle}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/api/auth/signin"
            className="inline-flex items-center justify-center rounded-lg bg-[#11074A] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-[#1a0b6e] focus:outline-none focus:ring-2 focus:ring-[#11074A] focus:ring-offset-2"
          >
            Try signing in again
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
          >
            Back to home
          </Link>
        </div>
        {error ? (
          <p className="mt-8 text-center font-mono text-xs text-slate-400">
            error={error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
