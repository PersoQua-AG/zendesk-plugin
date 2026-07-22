// src/tools/business-rules/macros.ts
// M4 Macros: list, preview (read-only), and apply-to-ticket (preview→confirm→persist, PRD §5.2).
// Macro apply never auto-fires: without confirm:true it only previews. Persist reuses the shared
// safeUpdateWithConflict optimistic-concurrency mutation. Macro bodies (actions) are screened on
// every path — list, preview, and apply — via the field-agnostic deep screen.
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeScreener, screenRecordDeep, makeDescribe, SCREEN_WARNING } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
import { safeUpdateWithConflict, type MutationResult } from '../write-helpers.js';
import type { ReadResult } from '../result.js';

// A macro's actions carry the free-text body it would set (comment/html_body). Include them in
// the schema so the list path screens them too — otherwise list-page bodies would slip past the
// ingest screen (bodies are already screened on preview/apply, which parse the applied payload).
const MacroActionsSchema = z.array(z.record(z.unknown())).nullish();

const MacroSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  description: z.string().nullish(),
  actions: MacroActionsSchema,
  updated_at: z.string().nullish(),
});
type Macro = z.infer<typeof MacroSchema>;

const describeMacro = makeDescribe<Macro>('macro', (m) => `#${m.id} ${m.title ?? '(untitled)'}${m.active === false ? ' (inactive)' : ''}`);

export async function listMacros(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Macro>({
    client,
    cache,
    securityLevel,
    path: '/macros.json',
    key: 'macros',
    schema: MacroSchema,
    describe: describeMacro,
    handle: 'zendesk_list_macros',
    cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
    pageSize: params.pageSize,
    label: (n) => `${n} macro(s)`,
    errorLabel: '/macros',
  });
}

// The macro-apply result envelope: `result.ticket` is the would-be ticket payload (fields +
// the macro's comment). Kept permissive (record) since a macro can set arbitrary fields;
// screening walks it field-agnostically regardless of shape.
const MacroApplyResultSchema = z.object({ result: z.record(z.unknown()) });

export async function previewMacro(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { macroId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/macros/${params.macroId}/apply.json`);
  const parsed = MacroApplyResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /macros/{id}/apply response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `macro-${params.macroId}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_preview_macro', value);
  return {
    summary: `Preview of macro #${params.macroId} on a blank ticket — no changes persisted (read-only).${flagged ? SCREEN_WARNING : ''}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

// Preview arm plus the shared applied|conflict MutationResult (persist reuses safeUpdateWithConflict).
export type ApplyMacroResult = { status: 'preview'; summary: string; cacheHandle: string } | MutationResult;

// Ticket-scoped preview envelope: result.ticket is the ready-to-PUT payload for this ticket.
const TicketScopedMacroSchema = z.object({ result: z.object({ ticket: z.record(z.unknown()) }) });

export async function applyMacroToTicket(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; macroId: number; confirm?: boolean; updatedStamp?: string; force?: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<ApplyMacroResult> {
  // Preview is ALWAYS computed read-only first (GET, no mutation) — PRD §5.2 macro apply is
  // preview→confirm→persist and must never auto-fire.
  const rawPreview = await client.request<unknown>(`/tickets/${params.ticketId}/macros/${params.macroId}/apply.json`);
  const parsedPreview = TicketScopedMacroSchema.safeParse(rawPreview);
  if (!parsedPreview.success) throw new Error('Unexpected /tickets/{id}/macros/{id}/apply response shape.');
  const { value: safePreview, flagged } = screenRecordDeep(
    parsedPreview.data,
    (key) => `macro-apply-${params.ticketId}-${params.macroId}-${key}`,
    makeScreener(securityLevel),
  );

  // Phase 1 — no explicit confirmation: return the screened preview and STOP. Nothing persisted.
  if (params.confirm !== true) {
    const entry = cache.save('zendesk_apply_macro_to_ticket_preview', safePreview);
    return {
      status: 'preview',
      summary:
        `PREVIEW ONLY — macro #${params.macroId} would change ticket #${params.ticketId} (see cached result). Nothing was persisted. ` +
        `Re-invoke with confirm:true and the ticket's updatedStamp (from zendesk_get_ticket) to apply, or force:true to overwrite without a concurrency check.${flagged ? SCREEN_WARNING : ''}`,
      cacheHandle: entry.handle,
    };
  }

  // Phase 2 — explicit confirmation. Reuse the ticket safe_update contract (PRD §5.2): require
  // the last-known updatedStamp for optimistic concurrency, or an explicit force override.
  if (!params.updatedStamp && !params.force) {
    throw new Error(
      'Refusing to apply macro without an updatedStamp: pass the updatedStamp from a prior zendesk_get_ticket read to enable safe optimistic-concurrency (recommended), or set force:true to deliberately overwrite without a concurrency check.',
    );
  }
  // The preview's result.ticket is the ready-to-PUT payload (macro fields + comment).
  return safeUpdateWithConflict(client, cache, {
    path: `/tickets/${params.ticketId}.json`,
    envelopeKey: 'ticket',
    body: { ...parsedPreview.data.result.ticket },
    updatedStamp: params.updatedStamp,
    force: params.force,
    toolName: 'zendesk_apply_macro_to_ticket',
    seedPrefix: `macro-applied-${params.ticketId}`,
    securityLevel,
    appliedSummary: `Applied macro #${params.macroId} to ticket #${params.ticketId}`,
    conflictSummary: ({ status }) =>
      `Conflict: ticket #${params.ticketId} changed since the updatedStamp you passed (current status: ${status ?? 'unknown'}). Re-read the ticket, review, and confirm before re-applying.`,
  });
}
