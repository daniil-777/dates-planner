/*
 * The one place an Anthropic client is constructed.
 *
 * Three features talk to Claude — the statement writer (`llm/anthropic.ts`), the receipt
 * reader (`documentai/llm-extractor.ts`) and the mood estimate (`mood.ts`) — and they
 * must all authenticate the same way, because the *key type* decides what a request has
 * to carry:
 *
 *  - A **workspace key** (created inside a workspace in the console) needs nothing but
 *    `ANTHROPIC_API_KEY`, which the SDK reads on its own.
 *  - An **identity-linked key** (tied to a person rather than a workspace) is refused with
 *    a 400 — "anthropic-workspace-id is required" — unless every request also names the
 *    workspace it acts in. The SDK has no option for that header, so it is a default
 *    header here, from `ANTHROPIC_WORKSPACE_ID`.
 *
 * Read on every call rather than cached, so a test — or a restart-free redeploy — can
 * change the environment and be believed. Nothing here is logged.
 */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'

/** The header an identity-linked key must send. Exact; the API matches it by name. */
export const WORKSPACE_HEADER = 'anthropic-workspace-id'

/** `ANTHROPIC_WORKSPACE_ID`, trimmed, or undefined when blank or unset. */
export function anthropicWorkspaceId(): string | undefined {
  const raw = (process.env.ANTHROPIC_WORKSPACE_ID ?? '').trim()
  return raw === '' ? undefined : raw
}

/**
 * A client with the workspace header applied when one is configured.
 *
 * Caller-supplied `defaultHeaders` win over the environment: a caller that names a
 * workspace explicitly knows something this file does not.
 */
export function createAnthropicClient(options: ClientOptions = {}): Anthropic {
  const workspace = anthropicWorkspaceId()
  const fromEnvironment = workspace === undefined ? {} : { [WORKSPACE_HEADER]: workspace }
  return new Anthropic({
    ...options,
    defaultHeaders: { ...fromEnvironment, ...(options.defaultHeaders ?? {}) },
  })
}
