import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AppConnections from "./AppConnections.ts";
import { APP_SIGN_IN_CALLBACK_PATH } from "./mcpOAuth.ts";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const page = (status: number, title: string, detail: string) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color-scheme:light dark}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );

/**
 * Where an app's browser sign-in returns. It needs no MyBot session: the
 * single-use `state` from the sign-in it finishes is the credential. Untraced,
 * since its URL carries the authorization code.
 */
export const layer = HttpRouter.add(
  "GET",
  APP_SIGN_IN_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = Option.match(HttpServerRequest.toURL(request), {
      onNone: () => new URLSearchParams(),
      onSome: (url) => url.searchParams,
    });
    const apps = yield* AppConnections.AppConnections;
    return yield* apps
      .completeSignIn({
        state: params.get("state") ?? undefined,
        code: params.get("code") ?? undefined,
        error: params.get("error") ?? undefined,
      })
      .pipe(
        Effect.map((name) => page(200, `Signed in to ${name}`, "You can close this window.")),
        Effect.catch((error) => Effect.succeed(page(400, "Sign-in did not finish", error.message))),
      );
  }).pipe(Effect.withTracerEnabled(false)),
);
