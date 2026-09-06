import { z } from 'zod';
import { contractHash, creditsToUnits, ResearchError, type ProviderContext, type ProviderContract, type ReviewedCapability } from './agentKey';
import type { ResearchResult } from './store';

// Observed AgentKey 0.0.12 contracts (2026-09-06). No platform is enabled by exporting these.
export const SORSA_PROFILE = 'Sorsa/get_info';
export const SORSA_TWEETS = 'Sorsa/post_user_tweets';
export const sorsaSchemas = {
  [SORSA_PROFILE]: { properties: { user_id: { type: 'string' }, user_link: { type: 'string' }, username: { type: 'string' } }, type: 'object' },
  [SORSA_TWEETS]: { properties: {
    next_cursor: { description: 'Pagination cursor from a previous response.', type: 'string' },
    user_id: { description: 'Numeric Twitter/X user ID. Provide either `link` or `user_id`.', type: 'string' },
    user_link: { description: "Full URL of the user's profile. Provide either `link` or `user_id`.", type: 'string' },
    username: { description: 'Twitter/X handle of the user. Provide either `link` or `username`.', type: 'string' },
  }, type: 'object' },
} as const;
export const sorsaCapabilities: readonly ReviewedCapability[] = [
  { internalName: 'sorsa.profile', canonicalName: SORSA_PROFILE, schemaHash: contractHash(sorsaSchemas[SORSA_PROFILE]), parameterKeys: ['username', 'user_id', 'user_link'], maxQuoteCredits: 1 },
  { internalName: 'sorsa.tweets', canonicalName: SORSA_TWEETS, schemaHash: contractHash(sorsaSchemas[SORSA_TWEETS]), parameterKeys: ['username', 'user_id', 'user_link', 'next_cursor'], maxQuoteCredits: 1 },
];
const deny = (code = 'PROVIDER_CONTRACT_INVALID'): never => { throw new ResearchError(code); };
// Never expose a validation library's raw input / provider payload in exceptions.
function parse<T>(schema:z.ZodType<T>, value:unknown):T {
  const result = schema.safeParse(value);
  if (!result.success) return deny();
  return result.data;
}
function supported(name:string):keyof typeof sorsaSchemas {
  if (name !== SORSA_PROFILE && name !== SORSA_TWEETS) return deny('UNSUPPORTED_CAPABILITY');
  return name;
}
const id = z.string().regex(/^[1-9][0-9]{0,31}$/);
const handle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const text = z.string().max(20000);
const published = z.string().max(100).refine(v => Number.isFinite(Date.parse(v)));
const nullableText = text.nullable().optional();
const profileSchema = z.object({
  id, username:handle, protected:z.literal(false), created_at:published,
  display_name:nullableText, description:nullableText, followers_count:count, followings_count:count,
  tweets_count:count, verified:z.boolean().nullable().optional(), location:nullableText,
  pinned_tweet_ids:z.array(id).max(100).nullable().optional(), bio_urls:z.array(text).max(100).nullable().optional(),
});
const entitySchema = z.object({type:z.enum(['photo','video','animated_gif']),link:text,preview:text});
const tweetSchema = z.object({
  id, created_at:published, full_text:text, user:profileSchema,
  reply_count:count, retweet_count:count, likes_count:count, bookmark_count:count, quote_count:count, view_count:count,
  entities:z.array(entitySchema).max(100).nullable().optional(),
  retweeted_status:z.unknown().optional(), quoted_status:z.unknown().optional(),
});
const profileKeys = Object.keys(profileSchema.shape);
const tweetKeys = Object.keys(tweetSchema.shape);
type Identity = { id?:string; username?:string };
function identity(context:ProviderContext):Identity {
  const name = supported(context.canonicalName), p = context.params;
  const allowed = sorsaCapabilities.find(c=>c.canonicalName===name)!.parameterKeys;
  if (Object.keys(p).some(k=>!allowed.includes(k))) return deny('INVALID_PARAMETERS');
  const keys = ['username','user_id','user_link'].filter(k=>Object.hasOwn(p,k));
  if (keys.length !== 1) return deny('INVALID_PARAMETERS');
  if (Object.hasOwn(p,'next_cursor') && (typeof p.next_cursor !== 'string' || !p.next_cursor.length || p.next_cursor.length > 4096)) return deny('INVALID_PARAMETERS');
  if (keys[0] === 'user_id') return {id:parse(id,p.user_id)};
  if (keys[0] === 'username') return {username:parse(handle,p.username)};
  if (typeof p.user_link !== 'string') return deny('INVALID_PARAMETERS');
  let url:URL; try {url=new URL(p.user_link);} catch {return deny('INVALID_PARAMETERS');}
  if (url.protocol !== 'https:' || !['x.com','twitter.com'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return deny('INVALID_PARAMETERS');
  return {username:parse(handle,url.pathname.replace(/^\/([^/]+)\/?$/, '$1'))};
}
function matches(user:{id:string;username:string}, expected:Identity) {
  if (expected.id ? user.id !== expected.id : user.username.toLowerCase() !== expected.username!.toLowerCase()) deny('RESULT_IDENTITY_MISMATCH');
}
function missing(value:Record<string,unknown>, keys:string[]) { return keys.filter(k=>!Object.hasOwn(value,k)); }
function profile(value:unknown) {
  const p = parse(profileSchema,value);
  return {...p, missingFields:missing(p,profileKeys)};
}
function tweet(value:unknown, depth=0):Record<string,unknown> {
  if (depth>2) return deny();
  const t=parse(tweetSchema,value);
  const out:Record<string,unknown>={...t,user:profile(t.user),missingFields:missing(t,tweetKeys)};
  for (const key of ['retweeted_status','quoted_status'] as const) {
    if (t[key] === undefined) delete out[key];
    else out[key]=t[key]===null ? null : tweet(t[key],depth+1);
  }
  return out;
}
function object(value:Record<string,unknown>, kind:'profile'|'tweet'):ResearchResult['objects'][number] {
  const {id:objectId,missingFields,...fields}=value;
  // Upstream gives publication time, not observation time or an original source URL.
  return {id:objectId as string,fields:{kind,...fields},missingFields:missingFields as string[],observedAt:null};
}

export const sorsaContract:ProviderContract = {
  discovery(value) {
    const d=parse(z.object({tools:z.array(z.object({name:z.string().min(1).max(256),disabled:z.boolean().optional(),unavailable:z.boolean().optional()})).max(100)}),value);
    return {names:d.tools.filter(t=>!t.disabled&&!t.unavailable).map(t=>t.name)};
  },
  description(value) {
    const d=parse(z.object({name:z.string(),params:z.record(z.string(),z.unknown()),cost:z.object({credits_per_call:z.number()}).strict(),
      execute_as:z.object({name:z.string(),params:z.object({}).strict()}).strict(),
      category:z.literal('Social'),provider:z.literal('Sorsa'),health:z.object({healthy:z.literal(true)}).strict(),
      summary:text.optional(),description:text.optional(),tags:z.array(text).max(10).optional(),
    }).strict(),value);
    const name=supported(d.name);
    if (d.execute_as.name!==name) return deny('EXECUTION_TEMPLATE_CHANGED');
    if (contractHash(d.params)!==contractHash(sorsaSchemas[name])) return deny('SCHEMA_CHANGED');
    creditsToUnits(d.cost.credits_per_call);
    // Only this checked same-name, empty, closed template is normalized away.
    // The adapter still rechecks canonical name, raw schema hash and quote cap.
    return {name,schema:d.params,creditsPerCall:d.cost.credits_per_call};
  },
  validateInput(context) { identity(context); },
  result(value,context) {
    const expected=identity(context);
    const envelope=parse(z.object({category:z.literal('social'),provider:z.literal('Sorsa'),data:z.record(z.string(),z.unknown())}),value);
    if (context.canonicalName===SORSA_PROFILE) {
      if (Object.hasOwn(envelope.data,'tweets')) return deny('RESULT_TYPE_MISMATCH');
      const p=profile(envelope.data);matches(p,expected);
      return {objects:[object(p,'profile')],pagination:{complete:true,nextCursor:null},actualCredits:null};
    }
    const page=parse(z.object({tweets:z.array(z.unknown()).max(20),next_cursor:z.string().min(1).max(4096).nullable()}),envelope.data);
    const objects=page.tweets.map(raw=>{
      const t=tweet(raw);matches(t.user as {id:string;username:string},expected);return object(t,'tweet');
    });
    if (new Set(objects.map(o=>o.id)).size!==objects.length) return deny('DUPLICATE_RESULT_ID');
    return {objects,pagination:{complete:page.next_cursor===null,nextCursor:page.next_cursor},actualCredits:null};
  },
};
