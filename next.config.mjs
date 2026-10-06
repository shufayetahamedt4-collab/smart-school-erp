/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  async headers() {
    return [
      {
        // Never let browsers hold on to a stale service worker.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
      {
        source: "/manifest.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        // The sign-in screen is a pure function of the request HOST (plus the
        // deployment's APP_DOMAIN and the x-forwarded-proto scheme). It renders
        // no per-user, per-school, per-branch, per-role or per-session content,
        // never sets a cookie, and middleware deliberately serves it to
        // signed-in visitors too — so a shared cache may answer it.
        //
        // `max-age=0` keeps ordinary browser semantics unchanged (the browser
        // still revalidates; it can never hold a stale sign-in screen), while
        // `s-maxage` lets the CDN in front of this app answer the very first
        // page a user ever sees without a trip to the origin region.
        //
        // Deliberately NO `stale-while-revalidate`: a cached copy names the
        // content-hashed chunks of the build it was rendered from, and a new
        // rollout removes the previous build's per-route chunks. Keeping the
        // shared TTL at 60s bounds that window to a minute; adding
        // `stale-while-revalidate` would extend it to TTL + swr.
        source: "/login",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, s-maxage=60",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
