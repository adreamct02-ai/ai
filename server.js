const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 환경변수에서 비밀번호 읽기 (Render에서 설정)
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'supersecret';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24,
    secure: false 
  } // 24시간
}));

// 로그인 체크 미들웨어
function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

// 로그인 페이지
app.get('/login', (req, res) => {
  const error = req.query.error ? '비밀번호가 틀렸어요.' : '';
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>로그인</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f3; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 16px; padding: 40px; width: 340px; border: 0.5px solid #e0e0e0; }
    h1 { font-size: 20px; font-weight: 500; margin-bottom: 6px; }
    p { font-size: 13px; color: #888; margin-bottom: 28px; }
    input { width: 100%; padding: 10px 14px; border: 0.5px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 12px; outline: none; }
    input:focus { border-color: #999; }
    button { width: 100%; padding: 11px; background: #111; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
    button:hover { opacity: 0.85; }
    .error { color: #c93500; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AI 트렌드 레이더</h1>
    <p>나만의 트렌드 대시보드</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="비밀번호" autofocus required />
      <button type="submit">입장</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 메인 대시보드 (로그인 필요)
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 정적 파일
app.use('/public', requireAuth, express.static(path.join(__dirname, 'public')));

// Claude API 프록시 (API 키를 서버에서만 관리)
app.post('/api/summarize', requireAuth, async (req, res) => {
  const fetch = require('node-fetch');
  const { prompt } = req.body;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '요약 실패';

    // 디스코드로도 자동 전송
    await sendToDiscord(text);

    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: '요약 중 오류 발생' });
  }
});

// ─── 디스코드 웹훅 전송 ───────────────────────────────
async function sendToDiscord(summary) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return; // 웹훅 URL 없으면 그냥 스킵

  const fetch = require('node-fetch');
  const today = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `🤖 AI 트렌드 요약 — ${today}`,
        description: summary.slice(0, 4000), // 디스코드 글자 제한
        color: 0x5b7fdb,
        footer: { text: 'AI 트렌드 레이더' }
      }]
    })
  });
}

// ─── 매일 아침 9시 자동 수집 + 디스코드 전송 ─────────
async function dailyJob() {
  const fetch = require('node-fetch');
  console.log('자동 수집 시작...');

  try {
    // Reddit 수집
    const subs = 'MachineLearning+ChatGPT+artificial+LocalLLaMA';
    const redditRes = await fetch(`https://www.reddit.com/r/${subs}/hot.json?limit=20`);
    const redditJson = await redditRes.json();
    const reddit = redditJson.data.children
      .map(c => c.data).filter(p => !p.stickied).slice(0, 8)
      .map(p => `[r/${p.subreddit}] ${p.title}`);

    // GitHub 수집
    const ghRes = await fetch('https://api.github.com/search/repositories?q=ai+OR+llm+OR+claude&sort=stars&order=desc&per_page=8&created:>2024-01-01');
    const ghJson = await ghRes.json();
    const github = (ghJson.items || []).slice(0, 8)
      .map(r => `[GitHub] ${r.full_name}: ${r.description || ''} (★${r.stargazers_count})`);

    // Claude 요약
    const prompt = `다음 Reddit/GitHub 트렌드를 한국어로 요약해줘.\n\n[Reddit]\n${reddit.join('\n')}\n\n[GitHub]\n${github.join('\n')}\n\n1. 가장 뜨거운 트렌드 3가지 (각 2-3문장)\n2. 오늘의 핵심 한줄 요약\n\n친근하게 써줘.`;

    const claudeRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const claudeData = await claudeRes.json();
    const summary = claudeData.choices?.[0]?.message?.content || '요약 실패';

    await sendToDiscord(summary);
    console.log('자동 수집 완료 + 디스코드 전송');
  } catch (e) {
    console.error('자동 수집 오류:', e.message);
  }
}

// 매일 오전 9시 실행 (한국 시간 = UTC+9, 즉 UTC 0시)
function scheduleDailyJob() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0); // UTC 00:00 = KST 09:00
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntilNext = next - now;
  setTimeout(() => {
    dailyJob();
    setInterval(dailyJob, 24 * 60 * 60 * 1000); // 이후 24시간마다
  }, msUntilNext);
  console.log(`다음 자동 수집: ${next.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
}

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  scheduleDailyJob();
});
