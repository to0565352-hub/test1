const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const PORT = Number(process.env.PORT || 3000);
const sessions = new Map();

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], posts: [], communities: [], donations: [] }; }
}
let db = readDb();
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function id() { return crypto.randomUUID(); }
function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28); }
function cleanText(s, max=500) { return String(s ?? '').trim().slice(0, max); }
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function getBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) { reject(new Error('请求内容过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求格式无效')); } });
  });
}
function currentUser(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)creator_session=([a-f0-9-]+)/);
  const userId = match ? sessions.get(match[1]) : null;
  return db.users.find(u => u.id === userId) || null;
}
function publicUser(u) {
  if (!u) return null;
  const { id, username, displayName, bio, avatar, cover, paymentNote, tags, createdAt } = u;
  return { id, username, displayName, bio, avatar, cover, paymentNote, tags, createdAt, postCount: db.posts.filter(p => p.userId === id).length };
}
function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: '请先登录后再操作。' }); return null; }
  return u;
}
function tagsFrom(input) { return [...new Set(String(input || '').split(/[，,\s]+/).map(x => x.replace(/^#/, '').trim().slice(0, 24)).filter(Boolean))].slice(0, 8); }
function publicPost(p) {
  const u = db.users.find(x => x.id === p.userId);
  return { ...p, creator: u ? { username: u.username, displayName: u.displayName, avatar: u.avatar } : null };
}

async function api(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, mode: 'local-mvp' });
  if (req.method === 'GET' && route === '/api/me') return json(res, 200, { user: publicUser(currentUser(req)) });
  if (req.method === 'POST' && route === '/api/register') {
    const b = await getBody(req);
    const username = slugify(b.username);
    const displayName = cleanText(b.displayName || b.username, 40);
    const password = String(b.password || '');
    if (!/^[a-z0-9_-]{3,28}$/.test(username)) return json(res, 400, { error: '用户名需为 3–28 位英文、数字、下划线或连字符。' });
    if (password.length < 8) return json(res, 400, { error: '密码至少需要 8 位。' });
    if (db.users.some(u => u.username === username)) return json(res, 409, { error: '这个用户名已经被使用。' });
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = { id: id(), username, displayName: displayName || username, bio: '你好！这里是我的创作小角落。', avatar: '', cover: '', paymentNote: '感谢你的支持！真实支付渠道尚未配置。', tags: [], salt, passwordHash, createdAt: new Date().toISOString() };
    db.users.push(user); saveDb();
    const sid = id(); sessions.set(sid, user.id);
    res.setHeader('Set-Cookie', `creator_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    return json(res, 201, { user: publicUser(user) });
  }
  if (req.method === 'POST' && route === '/api/login') {
    const b = await getBody(req); const username = slugify(b.username); const password = String(b.password || '');
    const user = db.users.find(u => u.username === username);
    if (!user || !crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(password, user.salt, 64).toString('hex')), Buffer.from(user.passwordHash))) return json(res, 401, { error: '用户名或密码不正确。' });
    const sid = id(); sessions.set(sid, user.id);
    res.setHeader('Set-Cookie', `creator_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    return json(res, 200, { user: publicUser(user) });
  }
  if (req.method === 'POST' && route === '/api/logout') {
    const cookie = req.headers.cookie || ''; const m = cookie.match(/(?:^|;\s*)creator_session=([a-f0-9-]+)/); if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'creator_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && route === '/api/creators') {
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const creators = db.users.filter(u => !q || [u.username, u.displayName, u.bio, ...(u.tags || [])].join(' ').toLowerCase().includes(q)).map(publicUser);
    return json(res, 200, { creators });
  }
  if (req.method === 'GET' && route.startsWith('/api/creator/')) {
    const username = slugify(decodeURIComponent(route.slice('/api/creator/'.length)));
    const u = db.users.find(x => x.username === username);
    if (!u) return json(res, 404, { error: '没有找到这个创作者。' });
    return json(res, 200, { creator: publicUser(u), posts: db.posts.filter(p => p.userId === u.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(publicPost) });
  }
  if (req.method === 'GET' && route === '/api/posts') {
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const posts = db.posts.filter(p => !q || [p.title, p.body, ...(p.tags || []), p.communityName || ''].join(' ').toLowerCase().includes(q)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(publicPost);
    return json(res, 200, { posts });
  }
  if (req.method === 'POST' && route === '/api/posts') {
    const u = requireUser(req, res); if (!u) return;
    const b = await getBody(req); const title = cleanText(b.title, 100); const body = cleanText(b.body, 5000); const tags = tagsFrom(b.tags);
    if (!title || !body) return json(res, 400, { error: '标题和正文都需要填写。' });
    const community = b.communityId ? db.communities.find(c => c.id === b.communityId) : null;
    const post = { id: id(), userId: u.id, title, body, tags, communityId: community?.id || null, communityName: community?.name || '', createdAt: new Date().toISOString() };
    db.posts.push(post); saveDb(); return json(res, 201, { post: publicPost(post) });
  }
  if (req.method === 'GET' && route === '/api/communities') {
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const communities = db.communities.filter(c => !q || [c.name, c.description, ...(c.tags || [])].join(' ').toLowerCase().includes(q)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(c => ({ ...c, creator: (() => { const u = db.users.find(x => x.id === c.userId); return u ? { username: u.username, displayName: u.displayName } : null; })(), postCount: db.posts.filter(p => p.communityId === c.id).length }));
    return json(res, 200, { communities });
  }
  if (req.method === 'POST' && route === '/api/communities') {
    const u = requireUser(req, res); if (!u) return;
    const b = await getBody(req); const name = cleanText(b.name, 50); const description = cleanText(b.description, 300); const tags = tagsFrom(b.tags);
    if (!name || !description || tags.length === 0) return json(res, 400, { error: '请填写社区名称、介绍，并至少添加一个标签。' });
    if (db.communities.some(c => c.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: '这个社区名称已经存在。' });
    const c = { id: id(), userId: u.id, name, description, tags, createdAt: new Date().toISOString() }; db.communities.push(c); saveDb(); return json(res, 201, { community: c });
  }
  if (req.method === 'POST' && route === '/api/donations') {
    const b = await getBody(req); const creator = db.users.find(u => u.username === slugify(b.username));
    if (!creator) return json(res, 404, { error: '没有找到这位创作者。' });
    const amount = Number(b.amount); if (!Number.isFinite(amount) || amount < 1 || amount > 100000 || Math.round(amount * 100) !== amount * 100) return json(res, 400, { error: '金额需为 1–100000 之间、最多两位小数的数字。' });
    const donation = { id: id(), creatorId: creator.id, supporterName: cleanText(b.supporterName || '匿名支持者', 40), message: cleanText(b.message, 300), amount, status: 'awaiting_payment', paymentMode: 'not_configured', createdAt: new Date().toISOString() };
    db.donations.push(donation); saveDb();
    return json(res, 201, { donation: { id: donation.id, amount, status: donation.status }, notice: '已创建打赏意向记录。当前版本未接入真实支付，因此不会收款，也不会自动标记到账。' });
  }
  if (req.method === 'GET' && route === '/api/dashboard') {
    const u = requireUser(req, res); if (!u) return;
    return json(res, 200, { posts: db.posts.filter(p => p.userId === u.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), donations: db.donations.filter(d => d.creatorId === u.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), communities: db.communities.filter(c => c.userId === u.id), profile: publicUser(u) });
  }
  if (req.method === 'PATCH' && route === '/api/profile') {
    const u = requireUser(req, res); if (!u) return;
    const b = await getBody(req); u.displayName = cleanText(b.displayName || u.displayName, 40); u.bio = cleanText(b.bio, 300); u.avatar = cleanText(b.avatar, 500); u.cover = cleanText(b.cover, 500); u.paymentNote = cleanText(b.paymentNote, 300); u.tags = tagsFrom(b.tags); saveDb(); return json(res, 200, { user: publicUser(u) });
  }
  if (req.method === 'POST' && route === '/api/donations/mark-reviewed') {
    const u = requireUser(req, res); if (!u) return;
    const b = await getBody(req); const d = db.donations.find(x => x.id === b.id && x.creatorId === u.id);
    if (!d) return json(res, 404, { error: '记录不存在。' });
    d.status = 'manually_reviewed'; d.reviewedAt = new Date().toISOString(); saveDb(); return json(res, 200, { ok: true, note: '仅记录你已人工核对；平台并未验证支付到账。' });
  }
  return json(res, 404, { error: '接口不存在。' });
}

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message || '请求失败。' }); }
    return;
  }
  let pathname = decodeURIComponent(url.pathname); if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: '禁止访问。' });
  fs.readFile(file, (err, data) => {
    if (err) { fs.readFile(path.join(PUBLIC, 'index.html'), (e, fallback) => { if (e) { res.writeHead(404); res.end('Not found'); } else { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(fallback); } }); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Creator Hub is running: http://127.0.0.1:${PORT}`));
