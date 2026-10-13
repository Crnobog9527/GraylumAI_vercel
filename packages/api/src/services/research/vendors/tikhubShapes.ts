/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// TikHub passes each platform's own JSON through under `data` without a published schema, so items are
// located by their characteristic keys (ported from the RESEARCH-0 comparison tooling).
// Only whitelisted fields leave this module: no bios, contact details, avatars or commenter data.
import { bool, clip, count, displayCount, findAll, has, text, timestamp } from './fields';
import type { ResearchItem, SocialKind, SocialPlatform } from './types';

export const POST_FIELDS = [
  'id', 'title', 'author', 'authorId', 'publishedAt', 'views', 'likes', 'comments', 'shares',
] as const;
export const PROFILE_FIELDS = [
  'id', 'name', 'handle', 'followers', 'following', 'postsCount', 'likesTotal', 'verified',
] as const;
const TITLE_CHARS = 300;

type Raw = Record<string, unknown>;
type Values = Record<string, string | number | boolean | undefined>;

function toItem(values: Values, whitelist: readonly string[], url?: string): ResearchItem {
  const fields: ResearchItem['fields'] = {};
  const missing: string[] = [];
  for (const name of whitelist) {
    const value = values[name];
    if (value === undefined) missing.push(name);
    else fields[name] = value;
  }
  return url === undefined ? { fields, missing } : { url, fields, missing };
}

function aweme(item: Raw, platform: 'douyin' | 'tiktok') {
  const id = text(item, ['aweme_id']);
  const handle = text(item, ['author.unique_id']);
  const url = platform === 'tiktok' && handle && id ? `https://www.tiktok.com/@${handle}/video/${id}`
    : platform === 'douyin' && id ? `https://www.douyin.com/video/${id}` : text(item, ['share_url', 'share_info.share_url']);
  return toItem({
    id, title: clip(text(item, ['desc']), TITLE_CHARS),
    author: text(item, ['author.nickname', 'author.unique_id']),
    authorId: text(item, ['author.unique_id', 'author.sec_uid', 'author.uid']),
    publishedAt: timestamp(item, ['create_time']),
    views: count(item, ['statistics.play_count']), likes: count(item, ['statistics.digg_count']),
    comments: count(item, ['statistics.comment_count']), shares: count(item, ['statistics.share_count']),
  }, POST_FIELDS, url);
}

function xhsNote(item: Raw) {
  return toItem({
    id: text(item, ['id', 'note_id']), title: clip(text(item, ['title', 'display_title', 'desc']), TITLE_CHARS),
    author: text(item, ['user.nickname', 'user.name']), authorId: text(item, ['user.userid', 'user.user_id', 'user.id']),
    publishedAt: timestamp(item, ['timestamp', 'time', 'create_time']),
    views: count(item, ['view_count']), likes: count(item, ['liked_count', 'likes']),
    comments: count(item, ['comments_count']), shares: count(item, ['shared_count', 'share_count']),
  }, POST_FIELDS, text(item, ['share_info.link']));
}

function weiboPost(item: Raw) {
  const userId = text(item, ['user.idstr', 'user.id']);
  const blog = text(item, ['mblogid']);
  return toItem({
    id: text(item, ['idstr', 'mid', 'id']), title: clip(text(item, ['text_raw', 'text']), TITLE_CHARS),
    author: text(item, ['user.screen_name']), authorId: userId,
    publishedAt: timestamp(item, ['created_at']),
    views: count(item, ['reads_count', 'page_info.play_count']), likes: count(item, ['attitudes_count']),
    comments: count(item, ['comments_count']), shares: count(item, ['reposts_count']),
  }, POST_FIELDS, userId && blog ? `https://weibo.com/${userId}/${blog}` : undefined);
}

function youtubeVideo(item: Raw, channel: string | undefined) {
  const id = text(item, ['video_id', 'videoId', 'id']);
  return toItem({
    id, title: clip(text(item, ['title']), TITLE_CHARS),
    author: text(item, ['author', 'channel_name', 'channel.title']) ?? channel,
    authorId: text(item, ['channel_id', 'channelId']),
    // Only relative labels ("3 days ago") are documented; they are not a timestamp and stay missing.
    publishedAt: timestamp(item, ['published_at', 'publish_date', 'upload_date']),
    views: displayCount(item, ['view_count', 'views']), likes: count(item, ['like_count']),
    comments: count(item, ['comment_count']), shares: undefined,
  }, POST_FIELDS, id ? `https://www.youtube.com/watch?v=${id}` : undefined);
}

function instagramPost(item: Raw) {
  const code = text(item, ['code', 'shortcode']);
  return toItem({
    id: text(item, ['id', 'pk']), title: clip(text(item, ['caption.text', 'caption_text']), TITLE_CHARS),
    author: text(item, ['user.username', 'owner.username']), authorId: text(item, ['user.username', 'owner.username']),
    publishedAt: timestamp(item, ['taken_at', 'taken_at_timestamp']),
    views: count(item, ['play_count', 'ig_play_count', 'view_count', 'video_view_count']),
    likes: count(item, ['like_count', 'edge_liked_by.count']),
    comments: count(item, ['comment_count', 'edge_media_to_comment.count']),
    shares: count(item, ['reshare_count', 'share_count']),
  }, POST_FIELDS, code ? `https://www.instagram.com/p/${code}/` : undefined);
}

function tweet(item: Raw) {
  const legacy = (item.legacy ?? item) as Raw;
  const id = text(item, ['tweet_id', 'rest_id', 'id_str']) ?? text(legacy, ['id_str']);
  const handle = text(item, ['author.screen_name', 'user_info.screen_name', 'core.user_results.result.legacy.screen_name', 'screen_name']);
  return toItem({
    id, title: clip(text(item, ['text', 'full_text']) ?? text(legacy, ['full_text', 'text']), TITLE_CHARS),
    author: handle, authorId: handle,
    publishedAt: timestamp(item, ['created_at']) ?? timestamp(legacy, ['created_at']),
    views: count(item, ['views', 'view_count', 'views.count']),
    likes: count(item, ['favorites', 'favorite_count', 'likes']) ?? count(legacy, ['favorite_count']),
    comments: count(item, ['replies', 'reply_count']) ?? count(legacy, ['reply_count']),
    shares: count(item, ['retweets', 'retweet_count']) ?? count(legacy, ['retweet_count']),
  }, POST_FIELDS, id && handle ? `https://x.com/${handle}/status/${id}` : undefined);
}

function isTweet(object: Raw): boolean {
  const legacy = (object.legacy ?? null) as Raw | null;
  const own = has(object, 'text', 'full_text') && has(object, 'created_at');
  return own || (legacy !== null && has(legacy, 'full_text', 'text') && has(legacy, 'created_at'));
}

function bilibiliVerified(object: Raw): boolean | undefined {
  const official = object.official as Raw | undefined;
  return typeof official?.type === 'number' ? official.type >= 0 : undefined;
}

function profile(object: Raw) {
  return toItem({
    id: text(object, ['uid', 'mid', 'rest_id', 'id', 'idstr', 'user_id']),
    name: text(object, ['nickname', 'name', 'full_name', 'title', 'screen_name', 'legacy.name']),
    handle: text(object, ['unique_id', 'screen_name', 'username', 'legacy.screen_name']),
    followers: count(object, ['follower_count', 'followers_count', 'fans', 'follower', 'sub_count',
      'legacy.followers_count', 'edge_followed_by.count']) ?? displayCount(object, ['subscriber_count']),
    following: count(object, ['following_count', 'friends_count', 'following', 'attention', 'friends',
      'legacy.friends_count', 'edge_follow.count']),
    postsCount: count(object, ['aweme_count', 'statuses_count', 'archive_count', 'legacy.statuses_count',
      'edge_owner_to_timeline_media.count', 'media_count']) ?? displayCount(object, ['video_count']),
    likesTotal: count(object, ['total_favorited', 'likes', 'favourites_count']),
    verified: bool(object, ['verified', 'is_verified', 'is_blue_verified', 'blue_verified']) ?? bilibiliVerified(object),
  }, PROFILE_FIELDS);
}

const PROFILE_KEYS = ['follower_count', 'followers_count', 'unique_id', 'screen_name', 'mid', 'sign', 'legacy',
  'sub_count', 'edge_followed_by', 'subscriber_count'];

/** A profile needs an identity plus something describing it; a post needs its id plus real content or metrics. */
function usable(item: ResearchItem, kind: SocialKind): boolean {
  const f = item.fields;
  if (kind === 'account_profile') return (f.id !== undefined || f.handle !== undefined) && (f.followers !== undefined || f.name !== undefined);
  return f.id !== undefined && ['title', 'author', 'publishedAt', 'views', 'likes', 'comments', 'shares'].some(name => f[name] !== undefined);
}

/** Normalized items for a TikHub envelope; an unrecognized shape yields no items, never invented ones. */
export function normalizeTikhub(json: unknown, platform: SocialPlatform, kind: SocialKind): ResearchItem[] {
  const data = (json as Raw | null)?.data;
  if (kind === 'account_profile') {
    const found = findAll(data, object => has(object, ...PROFILE_KEYS), 20).map(profile).find(item => usable(item, kind));
    return found ? [found] : [];
  }
  return rawPosts(data, platform).filter(item => usable(item, kind));
}

function rawPosts(data: unknown, platform: SocialPlatform): ResearchItem[] {
  switch (platform) {
    case 'douyin':
    case 'tiktok':
      return findAll(data, o => has(o, 'aweme_id') && has(o, 'statistics', 'create_time')).map(item => aweme(item, platform));
    case 'xiaohongshu':
      return findAll(data, o => has(o, 'liked_count') && has(o, 'id', 'note_id')).map(xhsNote);
    case 'weibo':
      return findAll(data, o => has(o, 'attitudes_count') && has(o, 'created_at')).map(weiboPost);
    case 'youtube': {
      const channel = text(data, ['channel.name']);
      return findAll(data, o => has(o, 'video_id', 'videoId') && has(o, 'title')).map(item => youtubeVideo(item, channel));
    }
    case 'instagram': {
      // Some routes return the same posts twice (flat list and GraphQL edges). v3 posts have no
      // publication time, so a post is recognized by its shortcode plus content or metrics.
      const posts = findAll(data, o => has(o, 'code', 'shortcode')
        && has(o, 'taken_at', 'taken_at_timestamp', 'caption', 'like_count', 'edge_liked_by', 'play_count', 'comment_count')).map(instagramPost);
      return posts.filter((post, index) => post.fields.id === undefined
        || posts.findIndex(other => other.fields.id === post.fields.id) === index);
    }
    case 'x':
      // Tweets carry text and a creation time (directly or under `legacy`); user objects with rest_id do not.
      return findAll(data, o => has(o, 'tweet_id', 'rest_id', 'id_str') && isTweet(o)).map(tweet);
    default:
      return [];
  }
}

/**
 * Exact paths where each route's post list lives. Only an empty array at one of these paths is a real
 * "no results" answer; RT-7 confirms them against recorded responses before a platform is verified.
 */
const EMPTY_LIST_PATHS: Partial<Record<`${SocialPlatform}:${SocialKind}`, readonly string[]>> = {
  'douyin:keyword_posts': ['data.data', 'data.business_data'],
  'xiaohongshu:keyword_posts': ['data.items', 'data.data.items'],
  'weibo:account_posts': ['data.statuses', 'data.data.statuses', 'data.data.list'],
  'tiktok:keyword_posts': ['data.search_item_list', 'data.data'],
  'tiktok:account_posts': ['data.aweme_list'],
  'youtube:keyword_posts': ['data.videos', 'data.contents'],
  'youtube:account_posts': ['data.videos', 'data.contents'],
  'x:keyword_posts': ['data.timeline', 'data.tweets'],
  'x:account_posts': ['data.timeline', 'data.tweets'],
  'instagram:account_posts': ['data.edges', 'data.items', 'data.data.items'],
};

/** True when the route's own list path holds an empty array (as opposed to a missing or changed shape). */
export function hasEmptyPostList(json: unknown, platform: SocialPlatform, kind: SocialKind): boolean {
  const paths = EMPTY_LIST_PATHS[`${platform}:${kind}`] ?? [];
  return paths.some(path => {
    const value = path.split('.').reduce<unknown>((node, key) => (node as Raw | null)?.[key], json);
    return Array.isArray(value) && value.length === 0;
  });
}

/** TikHub reports failures in the body: HTTP 200 with a non-200 `code` is a failure it may still bill. */
export function tikhubBodyCode(json: unknown): number | undefined {
  const raw = json as Raw | null;
  const code = raw?.code ?? (raw?.detail as Raw | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}
