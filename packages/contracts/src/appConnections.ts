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

export const AppConnectionAddInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("http"),
      url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
      /** Sent as `Authorization: Bearer <token>`. */
      bearerToken: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
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
});
export type AppConnectionAddInput = typeof AppConnectionAddInput.Type;

/** A connection as clients see it: never its secrets. */
export const AppConnectionSummary = Schema.Struct({
  id: AppConnectionId,
  name: Schema.String,
  /** The URL for an HTTP app, or the command for a local one. */
  target: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  /** Why the app could not be reached, when it could not. */
  error: Schema.NullOr(Schema.String),
});
export type AppConnectionSummary = typeof AppConnectionSummary.Type;

export const AppConnectionList = Schema.Struct({
  connections: Schema.Array(AppConnectionSummary),
});
export type AppConnectionList = typeof AppConnectionList.Type;

export const AppConnectionRemoveInput = Schema.Struct({ id: AppConnectionId });
export type AppConnectionRemoveInput = typeof AppConnectionRemoveInput.Type;

export class AppConnectionError extends Schema.TaggedError<AppConnectionError>()(
  "AppConnectionError",
  { message: Schema.String },
) {}
