const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-render';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
const DATA_DIR = path.join(__dirname, 'storage');
fs.mkdirSync(DATA_DIR, { recursive: true });

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const upload = multer({
  dest: DATA_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, /video\/(mp4|webm|quicktime)/.test(file.mimetype))
});

// Prototype store. Production persistence should be backed by Postgres before real sales.
const users = new Map();
const courses = new Map();
const sessions = new Map();

function seed() {
  if (users.size) return;
  const passwordHash = bcrypt.hashSync('demo12345', 12);
  users.set('demo', { id: uuid(), username: 'demo', passwordHash, role: 'student', deviceId: null, activeSession: null, courses: ['course-1'] });
  courses.set('course-1', {
    id: 'course-1', title: 'نمونه دوره', description: 'دوره نمونه برای تست پنل و سیستم محافظت محتواست.',
    lessons: [{ id: 'lesson-1', title: 'درس اول', description: 'ویدیوی نمونه را از پنل مدیریت اضافه کنید.', file: null }]
  });
}
seed();

function tokenFor(user, sessionId) { return jwt.sign({ sub: user.id, username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, { expiresIn: '12h' }); }
function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ورود لازم است' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = [...users.values()].find(u => u.id === payload.sub);
    const session = sessions.get(payload.sid);
    if (!user || !session || session.userId !== user.id || session.deviceId !== user.deviceId) return res.status(401).json({ error: 'جلسه معتبر نیست' });
    req.user = user; req.session = session; next();
  } catch { return res.status(401).json({ error: 'نشست منقضی شده است' }); }
}
function admin(req, res, next) { if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'دسترسی مدیر لازم است' }); next(); }

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = users.get(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  const presentedDevice = req.headers['x-device-id'];
  if (user.deviceId && presentedDevice !== user.deviceId) return res.status(403).json({ error: 'این حساب به دستگاه دیگری متصل است' });
  if (!user.deviceId) user.deviceId = presentedDevice || uuid();
  const sessionId = uuid();
  if (user.activeSession) sessions.delete(user.activeSession);
  const session = { id: sessionId, userId: user.id, deviceId: user.deviceId, createdAt: Date.now() };
  sessions.set(sessionId, session); user.activeSession = sessionId;
  res.json({ token: tokenFor(user, sessionId), deviceId: user.deviceId, user: { username: user.username, role: user.role } });
});

app.post('/api/logout', auth, (req, res) => { sessions.delete(req.session.id); req.user.activeSession = null; res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ username: req.user.username, role: req.user.role, courses: req.user.courses }));
app.get('/api/courses', auth, (req, res) => {
  const result = req.user.courses
    .map(id => courses.get(id))
    .filter(Boolean)
    .map(c => ({
      id: c.id,
      title: c.title,
      description: c.description,
      lessons: c.lessons.map(l => ({ id: l.id, title: l.title, description: l.description }))
    }));
  res.json(result);
});
app.get('/api/courses/:courseId', auth, (req, res) => {
  if (!req.user.courses.includes(req.params.courseId)) return res.status(403).json({ error: 'این دوره برای حساب شما فعال نیست' });
  const c = courses.get(req.params.courseId); if (!c) return res.status(404).json({ error: 'دوره پیدا نشد' });
  res.json({ ...c, lessons: c.lessons.map(l => ({ id: l.id, title: l.title, description: l.description })) });
});

// Media is never exposed as a public static directory. Authentication is required.
app.get('/api/media/:courseId/:lessonId', auth, (req, res) => {
  if (!req.user.courses.includes(req.params.courseId)) return res.sendStatus(403);
  const course = courses.get(req.params.courseId); const lesson = course?.lessons.find(x => x.id === req.params.lessonId);
  if (!lesson?.file || !fs.existsSync(lesson.file)) return res.status(404).json({ error: 'ویدیو هنوز آپلود نشده است' });
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Disposition', 'inline'); res.sendFile(path.resolve(lesson.file));
});

app.post('/api/admin/course', admin, (req, res) => {
  const id = uuid(); const course = { id, title: String(req.body.title || 'دوره جدید'), description: String(req.body.description || ''), lessons: [] };
  courses.set(id, course); res.json(course);
});
app.post('/api/admin/course/:courseId/lesson', admin, (req, res) => {
  const c = courses.get(req.params.courseId); if (!c) return res.status(404).json({ error: 'دوره پیدا نشد' });
  const lesson = { id: uuid(), title: String(req.body.title || 'درس جدید'), description: String(req.body.description || ''), file: null };
  c.lessons.push(lesson); res.json(lesson);
});
app.post('/api/admin/course/:courseId/lesson/:lessonId/video', admin, upload.single('video'), (req, res) => {
  const c = courses.get(req.params.courseId); const lesson = c?.lessons.find(x => x.id === req.params.lessonId);
  if (!lesson || !req.file) return res.status(400).json({ error: 'فایل ویدیو لازم است' });
  lesson.file = req.file.path; lesson.mime = req.file.mimetype; res.json({ ok: true, lessonId: lesson.id });
});
app.post('/api/admin/user', admin, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(); const password = String(req.body.password || '');
  if (!username || password.length < 8) return res.status(400).json({ error: 'نام کاربری و رمز حداقل ۸ کاراکتر لازم است' });
  if (users.has(username)) return res.status(409).json({ error: 'کاربر وجود دارد' });
  const user = { id: uuid(), username, passwordHash: await bcrypt.hash(password, 12), role: 'student', deviceId: null, activeSession: null, courses: [] };
  users.set(username, user); res.json({ username, message: 'حساب ساخته شد' });
});
app.post('/api/admin/user/:username/grant/:courseId', admin, (req, res) => {
  const user = users.get(req.params.username); if (!user || !courses.has(req.params.courseId)) return res.status(404).json({ error: 'یافت نشد' });
  if (!user.courses.includes(req.params.courseId)) user.courses.push(req.params.courseId); res.json({ ok: true });
});
app.post('/api/admin/user/:username/reset-device', admin, (req, res) => {
  const user = users.get(req.params.username); if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (user.activeSession) sessions.delete(user.activeSession); user.activeSession = null; user.deviceId = null; res.json({ ok: true });
});
app.get('/api/admin/stats', admin, (_, res) => res.json({ users: users.size, courses: courses.size, sessions: sessions.size }));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Behnazrostami running on ${PORT}`));
