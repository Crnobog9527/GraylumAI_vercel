// Field mapping for TikHub-style responses (TikHub direct and AIsa's TikHub
// resale). TikHub passes the platform's own JSON through under `data` without
// a published schema, so items are located by their characteristic keys.

import { bool, count, text, timestamp } from '../metrics.mjs';

/** Breadth-first search for objects matching `predicate`; matches are not descended into. */
export function findAll(root, predicate, max = 200) {
  const out = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && out.length < max && visited < 50_000) {
    const node = queue.shift();
    visited += 1;
    if (node === null || typeof node !== 'object') continue;
    if (!Array.isArray(node) && predicate(node)) {
      out.push(node);
      continue;
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) queue.push(value);
  }
  return out;
}

const has = (object, ...keys) => keys.some(key => Object.hasOwn(object, key));

/** "343,369 views" → 343369. Abbreviated values such as "1.2M" stay missing. */
export function displayCount(value, paths) {
  const exact = count(value, paths);
  if (exact !== undefined) return exact;
  const found = text(value, paths);
  const match = found?.match(/^\s*([\d,]+)\s*(views?|次观看)?\s*$/i);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function aweme(item, platform) {
  const id = text(item, ['aweme_id']);
  const handle = text(item, ['author.unique_id']);
  const url = platform === 'tiktok' && handle && id ? `https://www.tiktok.com/@${handle}/video/${id}`
    : platform === 'douyin' && id ? `https://www.douyin.com/video/${id}` : text(item, ['share_url', 'share_info.share_url']);
  return {
    id, url,
    title: text(item, ['desc']),
    author: text(item, ['author.nickname', 'author.unique_id']),
    publishedAt: timestamp(item, ['create_time']),
    views: count(item, ['statistics.play_count']),
    likes: count(item, ['statistics.digg_count']),
    comments: count(item, ['statistics.comment_count']),
    shares: count(item, ['statistics.share_count']),
  };
}

function xhsNote(item) {
  return {
    id: text(item, ['id', 'note_id']),
    url: text(item, ['share_info.link']),
    title: text(item, ['title', 'display_title', 'desc']),
    author: text(item, ['user.nickname', 'user.name']),
    publishedAt: timestamp(item, ['timestamp', 'time', 'create_time']),
    views: count(item, ['view_count']),
    likes: count(item, ['liked_count', 'likes']),
    comments: count(item, ['comments_count']),
    shares: count(item, ['shared_count', 'share_count']),
  };
}

function weiboPost(item) {
  return {
    id: text(item, ['idstr', 'mid', 'id']),
    url: text(item, ['mblogid']) && text(item, ['user.idstr', 'user.id'])
      ? `https://weibo.com/${text(item, ['user.idstr', 'user.id'])}/${text(item, ['mblogid'])}` : undefined,
    title: text(item, ['text_raw', 'text']),
    author: text(item, ['user.screen_name']),
    publishedAt: timestamp(item, ['created_at']),
    views: count(item, ['reads_count', 'page_info.play_count']),
    likes: count(item, ['attitudes_count']),
    comments: count(item, ['comments_count']),
    shares: count(item, ['reposts_count']),
  };
}

function youtubeVideo(item) {
  const id = text(item, ['video_id', 'videoId', 'id']);
  return {
    id,
    url: id ? `https://www.youtube.com/watch?v=${id}` : undefined,
    title: text(item, ['title']),
    author: text(item, ['author', 'channel_name', 'channel.title']),
    // Only relative labels ("3 days ago") are documented; they are not a timestamp.
    publishedAt: timestamp(item, ['published_at', 'publish_date', 'upload_date']),
    views: displayCount(item, ['view_count', 'views']),
    likes: count(item, ['like_count']),
    comments: count(item, ['comment_count']),
    shares: undefined,
  };
}

function instagramPost(item) {
  const code = text(item, ['code', 'shortcode']);
  return {
    id: text(item, ['id', 'pk']),
    url: code ? `https://www.instagram.com/p/${code}/` : undefined,
    title: text(item, ['caption.text']),
    author: text(item, ['user.username', 'owner.username']),
    publishedAt: timestamp(item, ['taken_at', 'taken_at_timestamp']),
    views: count(item, ['play_count', 'ig_play_count', 'view_count', 'video_view_count']),
    likes: count(item, ['like_count', 'edge_liked_by.count']),
    comments: count(item, ['comment_count', 'edge_media_to_comment.count']),
    shares: count(item, ['reshare_count', 'share_count']),
  };
}

function profile(object) {
  return {
    id: text(object, ['uid', 'mid', 'rest_id', 'id', 'idstr', 'user_id']),
    name: text(object, ['nickname', 'name', 'screen_name']),
    handle: text(object, ['unique_id', 'screen_name', 'username']),
    followers: count(object, ['follower_count', 'followers_count', 'fans', 'follower', 'sub_count', 'legacy.followers_count']),
    following: count(object, ['following_count', 'friends_count', 'following', 'attention', 'legacy.friends_count']),
    postsCount: count(object, ['aweme_count', 'statuses_count', 'archive_count', 'video_count', 'legacy.statuses_count']),
    likesTotal: count(object, ['total_favorited', 'likes', 'favourites_count']),
    bio: text(object, ['signature', 'sign', 'description', 'legacy.description']),
    verified: bool(object, ['verified', 'is_verified', 'is_blue_verified']),
  };
}

const PROFILE_KEYS = ['follower_count', 'followers_count', 'unique_id', 'screen_name', 'mid', 'sign', 'legacy'];

/** Maps a TikHub-envelope response for one of the RESEARCH-0 queries to normalized items. */
export function normalizeTikhub(json, query) {
  const data = json?.data;
  if (query.type === 'profile') {
    const found = findAll(data, object => has(object, ...PROFILE_KEYS), 1)[0];
    return found ? [profile(found)] : [];
  }
  switch (query.platform) {
    case 'douyin':
    case 'tiktok':
      return findAll(data, object => has(object, 'aweme_id') && has(object, 'statistics', 'create_time')).map(item => aweme(item, query.platform));
    case 'xiaohongshu':
      return findAll(data, object => has(object, 'liked_count') && has(object, 'id', 'note_id')).map(xhsNote);
    case 'weibo':
      return findAll(data, object => has(object, 'attitudes_count') && has(object, 'created_at')).map(weiboPost);
    case 'youtube':
      return findAll(data, object => has(object, 'video_id', 'videoId') && has(object, 'title')).map(youtubeVideo);
    case 'instagram':
      return findAll(data, object => has(object, 'taken_at', 'taken_at_timestamp') && has(object, 'code', 'shortcode', 'id')).map(instagramPost);
    default:
      return [];
  }
}

/** TikHub reports failures in-body; HTTP 200 with a non-200 `code` is a failure. */
export function tikhubFailed(json) {
  const code = json?.code ?? json?.detail?.code;
  return code !== 200;
}
