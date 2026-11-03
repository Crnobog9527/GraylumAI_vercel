/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { buildPack } from '../../publishMonitor/coach/pack';
import { packRowsSchema } from '../../publishMonitor/coach/rows';
import type { TurnClients } from '../db';
import type { SourceRead } from './source';

/*
 * PUBLISH-MONITOR block E (Owner 2026-10-27, "用户主动要求复盘"): a review asked for in a free chat. read_source reads one brand's
 * saved coach rows (coach_pack_turn_read, a free read by the owner's key) and the host builds the same review pack as the scheduled
 * coach, cadence 'chat'. Nothing is fetched from a supplier and nothing is written: no experiment, diagnosis or profile is saved from a
 * chat. The turn is charged as an ordinary chat answer.
 */
export const COACH_REVIEW_ID = /^coach_review(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/;
export const COACH_REVIEW_ENTRY = { id: 'coach_review', kind: 'coach_review', name: '运营复盘',
  use: 'Code-computed operations review pack of the user\'s brand from saved data. Read it when the user asks for a review (复盘).' };

export const COACH_REVIEW_INSTRUCTIONS = '\nWhen the user asks for a review of their operations (复盘), or sends screenshots of a '
  + 'platform dashboard (the message starts with [截图] or [截图×N]) and asks for an analysis: when the Skill catalog lists an '
  + 'operations review Skill, load it first; read the coach_review entry from the owned-source index (when it lists several brands, '
  + 'read coach_review:<id> of the brand the user means, or ask which one). List the numbers you read from a screenshot so the user can '
  + 'correct them. The pack is saved data computed by code: never claim a refresh, never call research tools for it. Compare only the '
  + 'same platform and basis; too_new posts are not judged; missing is not zero; verdicts and basics_pass are code\'s, explain them '
  + 'without changing them. When mode is basics_only, talk only about the basics. Write the current performance, what worked (cite '
  + 'posts), the experiments, and next steps; suggestions are proposals only, nothing is created, published or saved. No coach_json block.';

const turnRead = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coach_rows'), businessId: z.string().uuid(), rows: packRowsSchema }),
  z.object({ kind: z.literal('coach_brands'), brands: z.array(z.object({ id: z.string().uuid(), name: z.string().nullable() })) }),
  z.object({ kind: z.literal('coach_review'), status: z.literal('no_brand') }),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);
const NO_BRAND = '还没有已连接作品账号的品牌，复盘需要先在『作品数据』里给品牌连接账号或导入数据。这次先按定位和资料回答。';

export async function readCoachReview(read: TurnClients['read'], actorId: string, sessionId: string, businessId: string | null,
  now = Date.now()): Promise<SourceRead> {
  const { data, error } = await read.rpc('coach_pack_turn_read', { p_actor_id: actorId, p_session_id: sessionId, p_business_id: businessId });
  if (error) throw new Error('TURN_SOURCE_UNAVAILABLE');
  const result = turnRead.parse(data);
  if (result.kind === 'coach_brands') return { text: JSON.stringify({ kind: 'coach_brands',
    brands: result.brands.map(brand => ({ id: `coach_review:${brand.id}`, name: brand.name })) }) };
  if (result.kind === 'coach_review') return { text: JSON.stringify({ kind: 'coach_review', status: 'no_brand', note: NO_BRAND }) };
  if (result.kind === 'unavailable') return { text: JSON.stringify(result) };
  const review = buildPack({ rows: result.rows, cadence: 'chat', businessId: result.businessId, now, handbooks: new Map() });
  return { text: JSON.stringify({ kind: 'coach_review', status: 'available', review }) };
}
