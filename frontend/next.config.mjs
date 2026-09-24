// next.config.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nextConfig = {
  // Development optimizations
  reactStrictMode: true,
  
  // Enable ESLint during builds with warnings instead of errors
  eslint: {
    // Convert errors to warnings to allow builds to succeed
    ignoreDuringBuilds: true,
  },
  
  // Improve Fast Refresh and development experience
  experimental: {
    // Enable optimized package imports
    optimizePackageImports: ['react-icons'],
    // Improve build performance
    webVitalsAttribution: ['CLS', 'LCP'],
    // Increase middleware body buffer to 35MB (client validates at 30MB; 5MB overhead buffer)
    // Middleware runs on all routes (matcher: '/:path*'), so this is required for file uploads
    middlewareClientMaxBodySize: '35mb',
  },
  
  // Enable compression for better performance
  compress: true,

  // Baseline security headers on all responses. frame-ancestors 'none' closes
  // clickjacking; the rest are zero-risk hardening.
  //
  // FE-TOKEN-001: add a conservative script-src CSP so a reflected/stored XSS
  // cannot load attacker script and exfiltrate the OAuth accessToken the session
  // still exposes. script-src is scoped to 'self'; 'unsafe-inline' is retained
  // ONLY because Next.js injects inline bootstrap/runtime scripts (and katex
  // needs inline styles) — a nonce-based CSP that drops 'unsafe-inline' should
  // be a follow-up. object-src 'none' + base-uri 'self' block plugin and
  // base-tag injection vectors.
  async headers() {
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
  
  // Optimize images. Restrict the optimizer to the only remote host the app
  // actually loads (Google profile avatars). A wildcard hostname turns
  // /_next/image into an open https fetch proxy (SSRF). Local imports and
  // blob:/data: URLs are unaffected by remotePatterns.
  images: {
    unoptimized: false,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.googleusercontent.com',
      },
    ],
  },
  
  // 1) Prevent native modules from being bundled into any client or server chunks.
  //    (Next's file-tracer will still copy the .node files into .next/server because of node-loader.)
  serverExternalPackages: ['dockerode', 'canvas', 'pg', 'mysql2', 'mssql', 'better-sqlite3', 'sharp', 'pdf2pic', 'pdfjs-dist'],

  webpack(config, { dev, isServer }) {
    // 2) Suppress specific warnings while keeping important ones
    config.ignoreWarnings = [
      { message: /Critical dependency: the request of a dependency is an expression/ },
      { message: /Module not found: Can't resolve 'canvas'/ },
    ];

    // 3) Development: avoid unnecessary webpack rebuilds / churn
    //    - Do NOT set `poll` by default (native FS events on macOS/Linux).
    //      Polling every N ms forces periodic scans and often feels like the
    //      dev server is “always restarting” or recompiling.
    //    - For Docker Desktop bind mounts where native watch is flaky, run:
    //        WEBPACK_USE_POLL=1 npm run dev
    //      Optional: WEBPACK_POLL_INTERVAL=2000
    if (dev) {
      const usePoll = process.env.WEBPACK_USE_POLL === '1';
      config.watchOptions = {
        ...config.watchOptions,
        ...(usePoll
          ? { poll: Number(process.env.WEBPACK_POLL_INTERVAL) || 1000 }
          : {}),
        aggregateTimeout: 500,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          // Root markdown / agent notes only — do NOT use `**/docs/**` (would skip `app/docs/`).
          `${path.join(__dirname, 'docs').replace(/\\/g, '/')}/**`,
          `${path.join(__dirname, '.cursor').replace(/\\/g, '/')}/**`,
        ],
      };

      // Optimize for better HMR
      config.optimization = {
        ...config.optimization,
        removeAvailableModules: false,
        removeEmptyChunks: false,
        splitChunks: false,
      };
    }

    // 4) Whenever Webpack sees a ".node" binary, hand it off to node-loader.
    //    That ensures the native addon ends up next to your server output, not in the browser bundle.
    config.module.rules.push({
      test: /\.node$/,
      use: {
        loader: 'node-loader',
        options: { name: '[name].[ext]' },
      },
    });

    if (isServer) {
      // 5) On the server build, mark `canvas` as external.
      //    This prevents Webpack from trying to statically bundle those modules.
      config.externals = [
        ...config.externals,
        'canvas',
      ];
    } else {
      // 6) On the client build, stub out canvas so any accidental import yields `false`.
      //    That way the browser bundle never tries to include native code.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        canvas: false,
      };
    }

    return config;
  },

  // 7) Ensure Next's file-tracer still picks up any `.node` files under /app/api/ocr
  outputFileTracingIncludes: {
    '/app/api/ocr': ['**/*.node'],
  },
};

export default nextConfig;
