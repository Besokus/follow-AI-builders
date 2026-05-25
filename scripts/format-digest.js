#!/usr/bin/env node

// ============================================================================
// Follow Builders — AI-Powered Bilingual Digest
// ============================================================================
// Reads feed JSON from stdin or local files, fetches additional sources
// (HN, Reddit, GitHub), filters trivial content, sends to DeepSeek AI for
// bilingual (Chinese + English) digest, outputs digest text.
//
// Usage:
//   node prepare-digest.js | node format-digest.js | node deliver.js
//   node format-digest.js                              (uses local files)
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = join(homedir(), '.follow-builders', '.env');
if (existsSync(envPath)) {
  loadEnv({ path: envPath });
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-chat';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const wds = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return y + '/' + m + '/' + day + ' (' + wds[d.getDay()] + ')';
}

function stripLinks(text) {
  return text.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

// ── Additional Source Fetchers ──────────────────────────────────────────────

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'deep learning',
  'llm', 'gpt', 'claude', 'gemini', 'openai', 'anthropic',
  'transformer', 'neural network', 'diffusion', 'embedding',
  'agent', 'copilot', 'chatbot', 'rag', 'fine.tun', 'rlhf',
  'pytorch', 'tensorflow', 'hugging face', 'langchain',
  'model', 'training', 'inference', 'quantization', 'lora',
  'meta ai', 'mistral', 'llama', 'mixtral', 'deepseek',
  'nvidia', 'gpu', 'cuda', 'rocm',
  'computer vision', 'nlp', 'speech', 'tts', 'stt',
  'autonomous', 'robot',
  'generative', 'aigi', 'image gen', 'video gen',
  'reasoning', 'alignment', 'safety', 'bias',
  'ai engineer', 'prompt', 'token', 'context window',
  'sonnet', 'opus', 'haiku', 'gpt-4', 'gpt-5',
  'invest', 'funding', 'valuation', 'startup', 'silicon valley',
  'semiconductor', 'chip', 'data center', 'compute',
  'agi', 'asi', 'frontier', 'capability',
  'open source', 'weights', 'open weight'
];

function isAIRelevant(text) {
  const lower = text.toLowerCase();
  return AI_KEYWORDS.some(kw => lower.includes(kw));
}

const FETCH_TIMEOUT = 15000;

async function fetchHN() {
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    });
    const ids = (await res.json()).slice(0, 30);
    const stories = await Promise.all(
      ids.map(id =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT)
        }).then(r => r.json())
      )
    );
    return stories
      .filter(s => s && s.title && !s.deleted)
      .map(s => ({
        title: s.title,
        url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        score: s.score || 0,
        by: s.by || 'unknown',
        comments: s.descendants || 0,
        time: s.time || 0
      }));
  } catch (e) {
    process.stderr.write('HN fetch failed: ' + e.message + '\n');
    return [];
  }
}

async function fetchReddit() {
  const subreddits = ['MachineLearning', 'LocalLLaMA', 'artificial', 'ArtificialIntelligence'];
  const all = [];
  for (const sub of subreddits) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=10`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'FollowBuilders/1.0' }
      });
      clearTimeout(timeout);
      const data = await res.json();
      const posts = data.data.children.map(c => c.data).map(p => ({
        title: p.title,
        url: p.url,
        score: p.score,
        comments: p.num_comments,
        subreddit: sub,
        author: p.author,
        created_utc: p.created_utc
      }));
      all.push(...posts);
    } catch (e) {
      process.stderr.write(`Reddit r/${sub} fetch failed: ${e.message}\n`);
    }
  }
  return all;
}

async function fetchGitHub() {
  try {
    const res = await fetch(
      'https://api.github.com/search/repositories?q=topic:artificial-intelligence&sort=stars&order=desc&per_page=10',
      {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: process.env.GITHUB_TOKEN
          ? { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
          : { 'Accept': 'application/vnd.github.v3+json' }
      }
    );
    if (!res.ok) {
      process.stderr.write('GitHub API error: ' + res.status + '\n');
      return [];
    }
    const data = await res.json();
    return (data.items || []).map(r => ({
      name: r.full_name,
      url: r.html_url,
      description: r.description || '',
      stars: r.stargazers_count || 0,
      language: r.language || 'unknown',
      topics: r.topics || []
    }));
  } catch (e) {
    process.stderr.write('GitHub fetch failed: ' + e.message + '\n');
    return [];
  }
}

// ── Content Filtering ───────────────────────────────────────────────────────

function filterTweets(builders) {
  return builders.map(b => {
    const tweets = (b.tweets || [])
      .map(t => ({ ...t, cleanText: stripLinks(t.text) }))
      // Remove trivial tweets: too short, or just links/mentions
      .filter(t => {
        if (t.cleanText.length < 40) return false;
        // Count meaningful characters (non-punctuation, non-whitespace)
        const meaningful = t.cleanText.replace(/[@#]\w+/g, '').replace(/[.,!?;:'"()\-]/g, '').trim();
        if (meaningful.length < 25) return false;
        return true;
      })
      // Sort by engagement (likes) descending, keep top 5 per builder
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 5)
      .map(t => ({ text: t.cleanText, url: t.url, likes: t.likes }));

    return { ...b, tweets };
  }).filter(b => b.tweets.length > 0);
}

// ── Build AI Prompt ──────────────────────────────────────────────────────────

function buildPrompt(data) {
  const now = new Date();
  const dateStr = fmtDate(now);
  const builders = data.x || [];
  const podcasts = data.podcasts || [];
  const blogs = data.blogs || [];
  const hn = data.hn || [];
  const reddit = data.reddit || [];
  const github = data.github || [];

  const input = {
    date: dateStr,
    stats: {
      builders: builders.length,
      tweets: builders.reduce((s, b) => s + b.tweets.length, 0),
      podcasts: podcasts.length,
      hn_stories: hn.length,
      reddit_posts: reddit.length,
      github_repos: github.length
    },
    builders: builders.map(b => ({
      name: b.name,
      handle: b.handle,
      bio: b.bio,
      tweets: (b.tweets || []).map(t => ({
        text: t.text ? t.text.substring(0, 500) : '',
        url: t.url,
        likes: t.likes
      }))
    })),
    podcasts: podcasts.map(p => ({
      name: p.name,
      title: p.title,
      url: p.url,
      transcript: p.transcript ? p.transcript.substring(0, 3000) : ''
    })),
    hackernews: hn.map(s => ({
      title: s.title,
      url: s.url,
      score: s.score,
      by: s.by,
      comments: s.comments
    })),
    reddit: reddit.map(p => ({
      title: p.title,
      subreddit: p.subreddit,
      url: p.url,
      score: p.score,
      comments: p.comments
    })),
    github_trending: github.map(r => ({
      repo: r.name,
      url: r.url,
      description: r.description,
      stars: r.stars,
      language: r.language,
      topics: r.topics
    }))
  };

  return {
    role: 'user',
    content: `You are an expert AI industry digest editor. Create a bilingual (Chinese + English) digest from the following data.

## Output Format

Start with a 2-3 sentence Chinese overview of today's most important developments.

Then organize content into these sections:

### 🔬 AI 前沿技术 (AI Frontier Tech)
New models, agents, infrastructure, research breakthroughs, technical deep-dives, open-source projects.

### 📡 行业动态 (Industry News)
Products, funding rounds, market moves, partnerships, regulation, company announcements.

### 💡 投资风向 (Investment Signals)
Funding rounds, valuations, market analysis, IPOs, strategic investments — useful for investment decisions.

### 🎙 播客 & 博客精选 (Podcast & Blog Highlights)
Key insights from podcast episodes and blog posts.

### 📊 社区热议 (Community Hot Discussions)
Notable discussions from Hacker News, Reddit — include title, score, and key talking points.

### 🏗 值得关注的开源项目 (Notable Open Source)
Interesting GitHub repositories — include repo name, description, stars.

## Content Rules
1. Write in Chinese with English mixed in where natural (technical terms, names, quotes stay in English)
2. For X/Twitter: 1-2 sentence Chinese summary per builder, then 1 representative English tweet excerpt with link
3. For each HN story or Reddit post: 1 sentence Chinese summary, include score
4. For GitHub repos: indicate what it does and why it matters, include star count
5. For podcasts: 3-5 sentence Chinese summary of key insights
6. Filter out trivial content — every included item should have clear value
7. Be opinionated about what's important — call out genuinely significant developments
8. Keep ALL URLs — every item must have its link
9. Format cleanly for email reading, use === and --- as section separators
10. Title: AI Builders Digest — ${dateStr}

## Input Data
${JSON.stringify(input, null, 2)}`
  };
}

// ── Call DeepSeek API ────────────────────────────────────────────────────────

async function callDeepSeek(prompt) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + DEEPSEEK_API_KEY
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a professional AI industry newsletter editor. Output clean text only, no markdown code blocks. Be discerning about what content is truly important.'
        },
        prompt
      ],
      max_tokens: 8192,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('DeepSeek API error: ' + res.status + ' ' + err);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY not found in .env');
    console.log(createFallbackDigest(await loadData()));
    return;
  }

  const data = await loadData();
  if (!data) {
    console.error('Failed to load feed data');
    process.exit(1);
  }

  // Filter trivial tweets
  data.x = filterTweets(data.x || []);

  // Check if there's content
  const hasTweets = data.x.some(b => b.tweets.length > 0);
  const hasOther = (data.podcasts || []).length > 0 || (data.hn || []).length > 0
    || (data.reddit || []).length > 0 || (data.github || []).length > 0;

  if (!hasTweets && !hasOther) {
    console.log('No new updates today. Check back tomorrow!');
    return;
  }

  process.stderr.write('⏳ Generating AI bilingual digest with expanded sources...\n');
  const prompt = buildPrompt(data);

  try {
    const digest = await callDeepSeek(prompt);
    console.log(digest);
  } catch (err) {
    console.error('AI generation failed, using fallback: ' + err.message);
    console.log(createFallbackDigest(data));
  }
}

// ── Fallback (no AI) ─────────────────────────────────────────────────────────

function createFallbackDigest(data) {
  const now = new Date();
  const dateStr = fmtDate(now);
  const lines = [];

  lines.push('');
  lines.push('  AI Builders Digest — ' + dateStr);
  lines.push('');
  lines.push('  ▸ ' + (data.x || []).reduce((s, b) => s + b.tweets.length, 0) + ' tweets | '
    + (data.podcasts || []).length + ' podcasts | '
    + (data.hn || []).length + ' hn stories');
  lines.push('');
  lines.push('='.repeat(54));
  lines.push('  X / TWITTER');
  lines.push('='.repeat(54));
  lines.push('');

  for (const builder of (data.x || [])) {
    const name = builder.name || builder.handle || 'Unknown';
    lines.push('│ ' + name);
    lines.push('');
    for (const tweet of (builder.tweets || [])) {
      if (tweet.text.length < 5) continue;
      lines.push('  ▸ ' + tweet.text.substring(0, 250));
      if (tweet.url) lines.push('    ' + tweet.url);
      lines.push('');
    }
  }

  if ((data.hn || []).length > 0) {
    lines.push('='.repeat(54));
    lines.push('  HACKER NEWS');
    lines.push('='.repeat(54));
    lines.push('');
    for (const s of data.hn) {
      lines.push('  ▸ ' + s.title + ' (' + s.score + ' pts)');
      if (s.url) lines.push('    ' + s.url);
      lines.push('');
    }
  }

  if ((data.reddit || []).length > 0) {
    lines.push('='.repeat(54));
    lines.push('  REDDIT');
    lines.push('='.repeat(54));
    lines.push('');
    for (const p of data.reddit) {
      lines.push('  ▸ [' + p.subreddit + '] ' + p.title + ' (' + p.score + ' pts)');
      if (p.url) lines.push('    ' + p.url);
      lines.push('');
    }
  }

  lines.push('='.repeat(54));
  lines.push('  PODCASTS');
  lines.push('='.repeat(54));
  lines.push('');
  for (const pod of (data.podcasts || [])) {
    lines.push('│ ' + pod.name);
    lines.push('  ▶ ' + (pod.title || ''));
    if (pod.url) lines.push('    ' + pod.url);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Load Data ────────────────────────────────────────────────────────────────

async function loadData() {
  let data;

  // Try stdin first
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString().trim();
    if (input) {
      data = JSON.parse(input);
    }
  } catch (_) { /* fall through */ }

  // Fallback: local files
  if (!data || !(data.x || data.podcasts)) {
    const skillDir = join(__dirname, '..');
    try {
      const feedX = JSON.parse(readFileSync(join(skillDir, 'feed-x.json'), 'utf-8'));
      const feedPodcasts = JSON.parse(readFileSync(join(skillDir, 'feed-podcasts.json'), 'utf-8'));
      const feedBlogs = JSON.parse(readFileSync(join(skillDir, 'feed-blogs.json'), 'utf-8'));
      data = {
        config: { language: 'bilingual' },
        podcasts: feedPodcasts.podcasts || [],
        x: feedX.x || [],
        blogs: feedBlogs.blogs || [],
        stats: {
          podcastEpisodes: (feedPodcasts.podcasts || []).length,
          xBuilders: (feedX.x || []).length,
          totalTweets: (feedX.x || []).reduce((s, a) => s + (a.tweets || []).length, 0),
          blogPosts: (feedBlogs.blogs || []).length
        }
      };
    } catch (e) {
      console.error('Failed to load feeds: ' + e.message);
      return null;
    }
  }

  // Fetch additional sources in parallel
  process.stderr.write('📡 Fetching HN, Reddit, GitHub...\n');
  const [hn, reddit, github] = await Promise.all([
    fetchHN(),
    fetchReddit(),
    fetchGitHub()
  ]);

  // Filter HN/Reddit by AI relevance, limit to top items
  data.hn = hn
    .filter(s => isAIRelevant(s.title))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10);

  data.reddit = reddit
    .filter(p => isAIRelevant(p.title))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10);

  data.github = github.slice(0, 5);

  process.stderr.write('   → ' + data.hn.length + ' HN stories, '
    + data.reddit.length + ' Reddit posts, '
    + data.github.length + ' GitHub repos\n');

  return data;
}

main().catch(err => {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
