// tests/skills/probe.test.ts
import { beforeAll, describe, it, expect } from 'vitest';
import { probeRequests, writesIn } from './probe.js';

// Every write the probe sees, pinned: a write tool it stops reaching, or a new one, turns this red.
const WRITES = [
  'zendesk_create_ticket: POST /api/v2/tickets.json',
  'zendesk_update_ticket: PUT /api/v2/tickets/1.json',
  'zendesk_add_comment: PUT /api/v2/tickets/1.json',
  'zendesk_add_ticket_tags: PUT /api/v2/tickets/1/tags.json',
  'zendesk_create_tickets_bulk: POST /api/v2/tickets/create_many.json',
  'zendesk_update_tickets_bulk: PUT /api/v2/tickets/update_many.json',
  'zendesk_upload_attachment: POST /api/v2/uploads.json',
  'zendesk_upsert_user: POST /api/v2/users/create_or_update.json',
  'zendesk_update_user: PUT /api/v2/users/1.json',
  'zendesk_upsert_org: POST /api/v2/organizations/create_or_update.json',
  'zendesk_update_org: PUT /api/v2/organizations/1.json',
  'zendesk_apply_macro_to_ticket: PUT /api/v2/tickets/1.json',
  'zendesk_create_trigger: POST /api/v2/triggers.json',
  'zendesk_update_trigger: PUT /api/v2/triggers/1.json',
  'zendesk_create_automation: POST /api/v2/automations.json',
  'zendesk_update_automation: PUT /api/v2/automations/1.json',
  'zendesk_create_sla: POST /api/v2/slas/policies.json',
  'zendesk_update_sla: PUT /api/v2/slas/policies/1.json',
  'zendesk_create_article: POST /api/v2/help_center/sections/1/articles.json',
  'zendesk_update_article: PUT /api/v2/help_center/articles/1.json',
  'zendesk_create_article_translation: POST /api/v2/help_center/articles/1/translations.json',
  'zendesk_update_article_translation: PUT /api/v2/help_center/articles/1/translations/en-us.json',
  'zendesk_create_section: POST /api/v2/help_center/categories/1/sections.json',
  'zendesk_create_category: POST /api/v2/help_center/categories.json',
];

// The read-only verdicts in this suite are only worth something if the probe really drives every
// tool to Zendesk and really sees every write. Both are checked here, not assumed.
describe('skill-eval probe', () => {
  let requests: Record<string, string[]>;
  beforeAll(async () => {
    requests = await probeRequests();
  });

  it('drives every registered tool to at least one Zendesk request, except the local cache replay', () => {
    expect(Object.keys(requests).filter((n) => requests[n].length === 0)).toEqual(['zendesk_query']);
  });

  it('sees exactly the known write tools and their writes', () => {
    expect(writesIn(requests).sort()).toEqual([...WRITES].sort());
  });
});
