import { SORSA_PROFILE, SORSA_TWEETS, sorsaSchemas } from '../../research/sorsaContract';
// Derived from observed AgentKey 0.0.12 response shapes (2026-09-06).
// All identities, text, dates, counts, URLs and cursors are fictional replacements;
// only field/envelope/schema shape and the reviewed canonical tool names are retained.
export const sampleProfile = {category:'social',provider:'Sorsa',took_ms:1,data:{
  id:'1234567890123456789',username:'sample_lab',protected:false,created_at:'Wed Jan 01 00:00:00 +0000 2020',
  display_name:'Synthetic lab',description:'Noncommercial test sample',followers_count:12,followings_count:2,
  tweets_count:3,verified:false,location:null,pinned_tweet_ids:null,bio_urls:null,
}};
const baseTweet = {id:'2234567890123456789',created_at:'Tue Sep 01 00:00:00 +0000 2026',full_text:'Fictional sample post',
  user:sampleProfile.data,reply_count:0,retweet_count:1,likes_count:2,bookmark_count:null,quote_count:0,view_count:10,
  entities:[],retweeted_status:null,quoted_status:null};
export const sampleTweets = {category:'social',provider:'Sorsa',took_ms:2,data:{tweets:[
  {...baseTweet,retweeted_status:{...baseTweet,id:'3234567890123456789',user:{...sampleProfile.data,id:'4234567890123456789',username:'sample_origin'},full_text:'Fictional original post',view_count:null}},
  {...baseTweet,id:'5234567890123456789',entities:[{type:'photo',link:'https://example.test/sample.jpg',preview:''}]},
],next_cursor:'synthetic-next-page'}};
export const sampleDiscovery = {count:3,mode:'keyword',query:'public profile and posts',tools:[
  {name:SORSA_PROFILE,cost:1,summary:'User Profile'},
  {name:SORSA_TWEETS,cost:1,summary:'User Tweets'},
  {name:'Unreviewed/Write',cost:0,summary:'Not admitted'},
]};
export const sampleDescription = (name:typeof SORSA_PROFILE|typeof SORSA_TWEETS)=>({
  name,params:structuredClone(sorsaSchemas[name]),cost:{credits_per_call:1},execute_as:{name,params:{}},
  category:'Social',provider:'Sorsa',health:{healthy:true},
});
