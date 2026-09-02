import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataFile = path.join(root, 'data.json');
const PORT = Number(process.env.PORT || 4399);
const lanIp = Object.values(os.networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address || '本机局域网 IP';
const sessions = new Map();
const rooms = new Map();
const clients = new Map();

const seedQuiz = {
  id: 'seed-science', title: '一起来玩科学', description: '轻松热身，适合聚会和课堂的 8 道题', cover: '⚡',
  questions: [
    { type: 'choice', text: '太阳系中最大的行星是？', answers: ['地球', '木星', '火星', '金星'], correct: 1, time: 20, points: true, image: '' },
    { type: 'choice', text: '水的化学式是什么？', answers: ['CO₂', 'O₂', 'H₂O', 'NaCl'], correct: 2, time: 20, points: true, image: '' },
    { type: 'truefalse', text: '闪电比雷声传播得更快。', answers: ['正确', '错误'], correct: 0, time: 20, points: true, image: '' },
    { type: 'fill', text: '地球上最大的海洋是？', answers: ['太平洋'], correct: 0, time: 30, points: true, image: '' }
  ]
};
const defaultData = { users: [], quizzes: [seedQuiz] };
let db = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : defaultData;
if (!db.quizzes?.length) db.quizzes = [seedQuiz];
function saveDb() { fs.writeFileSync(dataFile, JSON.stringify(db, null, 2)); }
function id(bytes = 12) { return crypto.randomBytes(bytes).toString('hex'); }
function hashPassword(password, salt = id(16)) { return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, key) => e ? reject(e) : resolve(`${salt}:${key.toString('hex')}`))); }
async function verifyPassword(password, stored) { const [salt, hex] = stored.split(':'); const hashed = await hashPassword(password, salt); return crypto.timingSafeEqual(Buffer.from(hashed.split(':')[1], 'hex'), Buffer.from(hex, 'hex')); }
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))]; })); }
function auth(req) { const token = parseCookies(req).session; return token ? sessions.get(token) : null; }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid json')); } }); }); }
function cleanUser(u) { return { id: u.id, name: u.name, email: u.email, avatar: u.avatar, createdAt: u.createdAt }; }
function sendEvent(code) { const set = clients.get(code); const room = rooms.get(code); if (!set || !room) return; for (const c of set) c.send(snapshot(room, c.role, c.playerId)); }
function snapshot(room, role, playerId) {
  const q = room.quiz.questions[room.currentQuestion];
  const players = [...room.players.values()].sort((a, b) => b.score - a.score).map((p, i) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, rank: i + 1, answered: Boolean(p.answer) }));
  const base = { code: room.code, title: room.quiz.title, phase: room.phase, currentQuestion: room.currentQuestion, totalQuestions: room.quiz.questions.length, deadline: room.deadline, players, question: null, answerCount: [...room.players.values()].filter(p => p.answer).length, hostName: room.hostName, networkUrl: `http://${lanIp}:${PORT}` };
  if (room.phase === 'question' || room.phase === 'reveal') {
    base.question = { type: q.type || 'choice', text: q.text, answers: q.answers, time: q.time, points: q.points, image: q.image || '', selected: role === 'player' ? room.players.get(playerId)?.answer?.value ?? null : null, correct: room.phase === 'reveal' ? q.correct : null };
  }
  if (role === 'player') base.me = room.players.get(playerId) ? { ...room.players.get(playerId), answer: undefined } : null;
  return base;
}
function createRoom(user, quiz) {
  let code; do code = String(Math.floor(100000 + Math.random() * 900000)); while (rooms.has(code));
  const room = { code, hostKey: id(18), hostName: user.name, ownerId: user.id, quiz, players: new Map(), phase: 'lobby', currentQuestion: -1, deadline: null, timer: null };
  rooms.set(code, room); clients.set(code, new Set()); return room;
}
function startQuestion(room, index) { clearTimeout(room.timer); room.currentQuestion = index; room.phase = 'question'; room.deadline = Date.now() + room.quiz.questions[index].time * 1000; for (const p of room.players.values()) p.answer = null; room.timer = setTimeout(() => reveal(room), room.quiz.questions[index].time * 1000); sendEvent(room.code); }
function isCorrect(q, answer) { if (!answer) return false; if ((q.type || 'choice') === 'fill') return String(answer.value || '').trim().toLowerCase() === String(q.answers[0] || '').trim().toLowerCase(); return Number(answer.value) === Number(q.correct); }
function reveal(room) { if (room.phase !== 'question') return; clearTimeout(room.timer); const q = room.quiz.questions[room.currentQuestion]; const startedAt = room.deadline - q.time * 1000; for (const p of room.players.values()) { if (isCorrect(q, p.answer)) { const elapsedSecond = Math.max(1, Math.min(q.time, Math.ceil((p.answer.at - startedAt) / 1000))); const base = Math.round(100 * (q.time - elapsedSecond + 1) / q.time); const multiplier = q.pointMode === 'double' || q.multiplier === 2 ? 2 : 1; p.score += q.points === false || q.pointMode === 'none' ? 0 : base * multiplier; p.streak = (p.streak || 0) + 1; } else if (p.answer) p.streak = 0; } room.phase = 'reveal'; room.deadline = null; sendEvent(room.code); }
function next(room) { if (room.phase === 'question') reveal(room); else if (room.phase === 'reveal') { room.phase = 'leaderboard'; sendEvent(room.code); } else if (room.phase === 'leaderboard') { const n = room.currentQuestion + 1; if (n < room.quiz.questions.length) startQuestion(room, n); else { room.phase = 'finished'; sendEvent(room.code); } } }

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`); const p = url.pathname; const method = req.method;
  if (method === 'GET' && p === '/api/me') { const u = auth(req); return u ? json(res, 200, { user: cleanUser(u) }) : json(res, 401, { error: '未登录' }); }
  if (method === 'POST' && p === '/api/register') { const b = await body(req); if (!b.name || !b.email || !b.password || b.password.length < 6) return json(res, 400, { error: '请填写昵称、邮箱和至少 6 位密码' }); if (db.users.some(u => u.email.toLowerCase() === b.email.toLowerCase())) return json(res, 409, { error: '这个邮箱已经注册过了' }); const u = { id: id(), name: b.name.trim().slice(0, 30), email: b.email.trim().toLowerCase(), password: await hashPassword(b.password), avatar: ['🦊', '🐼', '🐨', '🐯', '🐸'][Math.floor(Math.random() * 5)], createdAt: Date.now() }; db.users.push(u); saveDb(); const token = id(24); sessions.set(token, u); res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`); return json(res, 201, { user: cleanUser(u) }); }
  if (method === 'POST' && p === '/api/login') { const b = await body(req); const identifier = String(b.identifier || b.email || '').trim().toLowerCase(); const u = db.users.find(x => x.email === identifier || x.name.toLowerCase() === identifier); if (!u || !(await verifyPassword(b.password || '', u.password))) return json(res, 401, { error: '用户名或密码不正确' }); const token = id(24); sessions.set(token, u); res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`); return json(res, 200, { user: cleanUser(u) }); }
  if (method === 'POST' && p === '/api/logout') { const token = parseCookies(req).session; sessions.delete(token); res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  if (method === 'POST' && p === '/api/me/avatar') { if (!u) return json(res, 401, { error: '未登录' }); const b = await body(req); const allowed = ['🦊', '🐼', '🐨', '🐯', '🐸', '🦁', '🐵', '🐰', '🐙', '🦄']; if (!allowed.includes(b.avatar)) return json(res, 400, { error: '头像不可用' }); u.avatar = b.avatar; const stored = db.users.find(x => x.id === u.id); if (stored) stored.avatar = u.avatar; saveDb(); return json(res, 200, { user: cleanUser(u) }); }
  const u = auth(req);
  if (method === 'GET' && p === '/api/quizzes') { if (!u) return json(res, 401, { error: '未登录' }); return json(res, 200, { quizzes: db.quizzes.filter(q => q.ownerId === u.id || q.id === 'seed-science') }); }
  if (method === 'POST' && p === '/api/quizzes') { if (!u) return json(res, 401, { error: '未登录' }); const b = await body(req); if (!b.title || !Array.isArray(b.questions) || b.questions.length < 1) return json(res, 400, { error: '题库至少需要 1 道题' }); const normalized = { title: String(b.title).slice(0, 80), description: String(b.description || ''), cover: b.cover || '🎯', questions: b.questions.map(q => { const type = ['choice', 'truefalse', 'fill'].includes(q.type) ? q.type : 'choice'; const answers = type === 'truefalse' ? ['正确', '错误'] : type === 'fill' ? [String(q.answers?.[0] || q.answer || '')] : (q.answers || []).slice(0, 4).map(String); const pointMode = ['standard', 'double', 'none'].includes(q.pointMode) ? q.pointMode : q.points === false ? 'none' : q.multiplier === 2 ? 'double' : 'standard'; return { type, text: String(q.text).slice(0, 300), answers, correct: type === 'fill' ? 0 : Math.max(0, Math.min(answers.length - 1, Number(q.correct) || 0)), time: Math.min(120, Math.max(5, Number(q.time) || 20)), points: pointMode !== 'none', pointMode, multiplier: pointMode === 'double' ? 2 : 1, image: typeof q.image === 'string' && q.image.startsWith('data:image/') ? q.image.slice(0, 800000) : '' }; }) }; const existing = b.id && db.quizzes.find(q => q.id === b.id && q.ownerId === u.id); if (existing) { Object.assign(existing, normalized); saveDb(); return json(res, 200, { quiz: existing }); } const quiz = { id: id(), ownerId: u.id, ...normalized }; db.quizzes.push(quiz); saveDb(); return json(res, 201, { quiz }); }
  if (method === 'POST' && p === '/api/rooms') { if (!u) return json(res, 401, { error: '请先登录' }); const b = await body(req); const quiz = db.quizzes.find(q => q.id === b.quizId && (q.ownerId === u.id || q.id === 'seed-science')); if (!quiz) return json(res, 404, { error: '题库不存在' }); const room = createRoom(u, quiz); return json(res, 201, { code: room.code, hostKey: room.hostKey, room: snapshot(room, 'host') }); }
  const roomMatch = p.match(/^\/api\/rooms\/(\d+)(?:\/(join|events|start|action|answer))?$/); if (roomMatch) { const room = rooms.get(roomMatch[1]); if (!room) return json(res, 404, { error: '房间不存在或已关闭' }); const action = roomMatch[2];
    if (method === 'POST' && action === 'join') { const b = await body(req); if (room.phase !== 'lobby') return json(res, 400, { error: '这局游戏已经开始' }); const name = String(b.name || '').trim().slice(0, 18); if (!name) return json(res, 400, { error: '请输入昵称' }); const allowed = ['🦊', '🐼', '🐨', '🐯', '🐸', '🦁', '🐵', '🐰', '🐙', '🦄']; const playerId = id(10); room.players.set(playerId, { id: playerId, name, avatar: allowed.includes(b.avatar) ? b.avatar : '🦊', score: 0, streak: 0, answer: null }); sendEvent(room.code); return json(res, 201, { playerId, room: snapshot(room, 'player', playerId) }); }
    if (method === 'GET' && action === 'events') { const role = url.searchParams.get('role') || 'player'; const key = url.searchParams.get('key'); const playerId = url.searchParams.get('playerId'); if (role === 'host' && key !== room.hostKey) return json(res, 403, { error: '主持人密钥无效' }); if (role === 'player' && !room.players.has(playerId)) return json(res, 403, { error: '玩家身份无效' }); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }); const c = { role, playerId, send: data => res.write(`data: ${JSON.stringify(data)}\n\n`) }; clients.get(room.code).add(c); c.send(snapshot(room, role, playerId)); req.on('close', () => clients.get(room.code)?.delete(c)); return; }
    if (method === 'POST' && action === 'start') { if (req.headers['x-host-key'] !== room.hostKey) return json(res, 403, { error: '主持人密钥无效' }); if (!room.players.size) return json(res, 400, { error: '至少等待 1 位玩家加入' }); if (room.phase !== 'lobby') return json(res, 400, { error: '游戏已经开始' }); startQuestion(room, 0); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'action') { if (req.headers['x-host-key'] !== room.hostKey) return json(res, 403, { error: '主持人密钥无效' }); next(room); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'answer') { const b = await body(req); const pl = room.players.get(b.playerId); if (!pl || room.phase !== 'question') return json(res, 400, { error: '当前不能答题' }); if (pl.answer) return json(res, 409, { error: '已经提交过答案' }); const q = room.quiz.questions[room.currentQuestion]; const value = (q.type || 'choice') === 'fill' ? String(b.value || '').trim().slice(0, 120) : Number(b.value ?? b.index); if ((q.type || 'choice') === 'fill' ? !value : ![0, 1, 2, 3].includes(value)) return json(res, 400, { error: '答案无效' }); pl.answer = { value, at: Date.now() }; sendEvent(room.code); if ([...room.players.values()].every(p => p.answer)) reveal(room); return json(res, 200, { ok: true }); }
  }
  if (method === 'GET') { const file = p === '/' ? '/index.html' : p; const target = path.normalize(path.join(publicDir, file)); if (!target.startsWith(publicDir)) return json(res, 404, {}); try { const ext = path.extname(target); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }; res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); fs.createReadStream(target).pipe(res); } catch { json(res, 404, { error: 'not found' }); } return; }
  json(res, 404, { error: 'not found' });
}
const server = http.createServer((req, res) => { if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); } route(req, res).catch(e => json(res, 500, { error: e.message })); });
server.listen(PORT, () => console.log(`Quizly 免费版运行于 http://localhost:${PORT}，局域网地址 http://${lanIp}:${PORT}`));
