import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * An app a user connected for their bots: an MCP server MyBot connects to
 * and relays to every bot through its own tools. Secrets (a bearer token,
 * header values, environment values) never leave the server.
 */
export const AppConnectionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type AppConnectionId = typeof AppConnectionId.Type;

/**
 * The origin the user's browser reaches this server at, such as
 * `http://localhost:3773`. Sign-in returns to `<origin>/oauth/apps/callback`.
 */
const RedirectBaseUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));

export const AppConnectionAddInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  /** The app catalog preset the connection was made from, for display. */
  presetId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("http"),
      url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
      /** Sent as `Authorization: Bearer <token>`. */
      bearerToken: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
      /**
       * "oauth" signs in through the browser (MCP authorization). Without it,
       * an app that asks for sign-in when MyBot connects is switched to "oauth".
       */
      auth: Schema.optional(Schema.Literals(["none", "token", "oauth"])),
    }),
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
        Schema.isMaxLength(32),
      ),
      /** Environment for the command, such as an API key. */
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ]),
  /** Needed when the app signs in through the browser. */
  redirectBaseUrl: Schema.optional(RedirectBaseUrl),
});
export type AppConnectionAddInput = typeof AppConnectionAddInput.Type;

export const AppConnectionStatus = Schema.Literals(["ready", "needs-sign-in", "error"]);
export type AppConnectionStatus = typeof AppConnectionStatus.Type;

/** A connection as clients see it: never its secrets. */
export const AppConnectionSummary = Schema.Struct({
  id: AppConnectionId,
  name: Schema.String,
  /** The app catalog preset it was made from. */
  presetId: Schema.NullOr(Schema.String),
  /** Where the app runs, without secrets: a host, or a local command without its arguments. */
  target: Schema.String,
  status: AppConnectionStatus,
  toolCount: Schema.NullOr(Schema.Number),
  /** Why the app is not ready, when it is not. */
  error: Schema.NullOr(Schema.String),
});
export type AppConnectionSummary = typeof AppConnectionSummary.Type;

export const AppConnectionList = Schema.Struct({
  connections: Schema.Array(AppConnectionSummary),
});
export type AppConnectionList = typeof AppConnectionList.Type;

/** An added app that needs browser sign-in before it is ready. */
export const AppConnectionSignIn = Schema.Struct({
  connectionId: AppConnectionId,
  authorizationUrl: Schema.String,
});
export type AppConnectionSignIn = typeof AppConnectionSignIn.Type;

export const AppConnectionAddResult = Schema.Struct({
  connections: Schema.Array(AppConnectionSummary),
  signIn: Schema.optional(AppConnectionSignIn),
});
export type AppConnectionAddResult = typeof AppConnectionAddResult.Type;

/** Starts (or restarts) browser sign-in for a connected app. */
export const AppConnectionSignInInput = Schema.Struct({
  id: AppConnectionId,
  redirectBaseUrl: RedirectBaseUrl,
});
export type AppConnectionSignInInput = typeof AppConnectionSignInInput.Type;

export const AppConnectionSignInResult = Schema.Struct({ authorizationUrl: Schema.String });
export type AppConnectionSignInResult = typeof AppConnectionSignInResult.Type;

export const AppConnectionRemoveInput = Schema.Struct({ id: AppConnectionId });
export type AppConnectionRemoveInput = typeof AppConnectionRemoveInput.Type;

export class AppConnectionError extends Schema.TaggedError<AppConnectionError>()(
  "AppConnectionError",
  { message: Schema.String },
) {}
