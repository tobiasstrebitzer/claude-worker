/**
 * Absolute path to the built dashboard (`index.html` + content-hashed assets).
 *
 * Mount it at a **domain root** (the build sets no `base`, so assets resolve
 * from an absolute `/assets/...`) and serve the gateway on the **same origin**
 * under `/v1` — the app builds its client from `location.origin`, and
 * same-origin is what lets a browser authenticate the session WebSocket, since
 * a tab cannot set headers on an upgrade.
 *
 * The app uses hash history, so no SPA rewrite rules are needed: serve
 * `index.html` for every non-asset path, hashed assets `immutable`, and
 * `index.html` `no-cache`.
 */
export declare const dashboardDir: string

/** Absolute path to the entry document inside {@link dashboardDir}. */
export declare const dashboardIndexHtml: string
