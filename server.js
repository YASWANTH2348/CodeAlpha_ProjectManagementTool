const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const cookie = require("cookie");
const cookieSignature = require("cookie-signature");
const Database = require("better-sqlite3");
const express = require("express");
const session = require("express-session");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 3002;
const sessionSecret = process.env.SESSION_SECRET || "local-kivo-session-secret-change-before-deploy";
const sessionCookieName = "kivo.sid";
const sessionStore = new session.MemoryStore();
const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(path.join(dataDirectory, "kivo.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    added_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id, project_id);
  CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status, due_date);
  CREATE INDEX IF NOT EXISTS comments_task_idx ON comments(task_id, created_at);
  CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS activity_project_idx ON activity_log(project_id, created_at DESC);
`);

const timestamp = () => new Date().toISOString();
const dateIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const seedPassword = bcrypt.hashSync("demo12345", 10);
const seedUsers = [
  ["alex", "Alex Morgan"],
  ["priya", "Priya Shah"],
  ["marcus", "Marcus Lee"],
  ["nina", "Nina Okafor"]
];
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (username, display_name, password_hash, created_at)
  VALUES (?, ?, ?, ?)
`);
const seedUserTransaction = db.transaction(() => {
  for (const [username, displayName] of seedUsers) {
    insertUser.run(username, displayName, seedPassword, timestamp());
  }
});
seedUserTransaction();

const userId = (username) => db.prepare("SELECT id FROM users WHERE username = ?").get(username).id;
const seedProjects = [
  [1, "Website relaunch", "A focused refresh of our website, from first sketches to launch day.", "alex", 18],
  [2, "Customer onboarding", "Make the first week with our product feel effortless.", "priya", 32]
];
const insertProject = db.prepare(`
  INSERT OR IGNORE INTO projects (id, name, description, owner_id, due_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const seedProjectTransaction = db.transaction(() => {
  for (const [id, name, description, owner, dueIn] of seedProjects) {
    const now = timestamp();
    insertProject.run(id, name, description, userId(owner), dateIn(dueIn), now, now);
  }
});
seedProjectTransaction();

const insertMember = db.prepare(`
  INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_at)
  VALUES (?, ?, ?, ?)
`);
[
  [1, "alex", "owner"], [1, "priya", "member"], [1, "marcus", "member"], [1, "nina", "member"],
  [2, "priya", "owner"], [2, "alex", "member"], [2, "nina", "member"]
].forEach(([projectId, username, role]) => insertMember.run(projectId, userId(username), role, timestamp()));

const seedTasks = [
  [1, 1, "Confirm launch goals", "Align on the audience, outcomes, and what success looks like.", "done", "medium", "alex", -5],
  [2, 1, "Explore visual directions", "Collect references and choose a clear creative direction.", "done", "high", "priya", -3],
  [3, 1, "Build the homepage", "Turn the approved direction into a responsive homepage.", "in_progress", "high", "marcus", 3],
  [4, 1, "Review product copy", "Make sure every page feels clear, useful, and consistent.", "in_progress", "medium", "nina", 5],
  [5, 1, "Prepare launch checklist", "Capture final QA, analytics, and release-day steps.", "todo", "low", "alex", 9],
  [6, 1, "Schedule team review", "Share the current build and collect final feedback.", "todo", "medium", "priya", 7],
  [7, 2, "Map the first-run journey", "Document each step from sign-up through the first successful action.", "done", "high", "priya", -2],
  [8, 2, "Draft welcome email", "Create a short, friendly message with one clear next step.", "in_progress", "medium", "alex", 6],
  [9, 2, "Plan helpful product tips", "Choose three small tips to introduce during the first week.", "todo", "low", "nina", 13]
];
const insertTask = db.prepare(`
  INSERT OR IGNORE INTO tasks
    (id, project_id, title, description, status, priority, assignee_id, created_by, due_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const seedTaskTransaction = db.transaction(() => {
  for (const [id, projectId, title, description, status, priority, assignee, dueIn] of seedTasks) {
    const now = timestamp();
    insertTask.run(id, projectId, title, description, status, priority, userId(assignee), userId("alex"), dateIn(dueIn), now, now);
  }
});
seedTaskTransaction();

const insertComment = db.prepare(`
  INSERT OR IGNORE INTO comments (id, task_id, user_id, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
[
  [1, 2, "marcus", "The softer palette feels right. I’ll share two options this afternoon."],
  [2, 3, "priya", "The layout is in a good place. Let’s check the mobile spacing next."],
  [3, 8, "nina", "I added a few subject-line ideas to the notes."]
].forEach(([id, taskId, username, content]) => insertComment.run(id, taskId, userId(username), content, timestamp()));

const insertActivity = db.prepare(`
  INSERT OR IGNORE INTO activity_log (id, project_id, user_id, task_id, message, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
[
  [1, 1, "alex", 1, "completed “Confirm launch goals”.", -2],
  [2, 1, "priya", 3, "shared feedback on the homepage layout.", -1],
  [3, 2, "nina", 8, "added notes to the welcome email.", -4]
].forEach(([id, projectId, username, taskId, message, hoursAgo]) => {
  insertActivity.run(id, projectId, userId(username), taskId, message, new Date(Date.now() + hoursAgo * 3600000).toISOString());
});

const wss = new WebSocketServer({ noServer: true });
const isMemberStatement = db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?");

function publicUser(user) {
  return user ? {
    id: user.id,
    username: user.username,
    displayName: user.display_name
  } : null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isProjectMember(projectId, userIdValue) {
  return Boolean(isMemberStatement.get(projectId, userIdValue));
}

function notifyProject(projectId, actorId, taskId, type, message) {
  const members = db.prepare("SELECT user_id AS id FROM project_members WHERE project_id = ?").all(projectId);
  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, project_id, task_id, type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const member of members) {
    if (member.id !== actorId) {
      insertNotification.run(member.id, projectId, taskId, type, message, timestamp());
    }
  }
  db.prepare(`
    INSERT INTO activity_log (project_id, user_id, task_id, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, actorId, taskId, message, timestamp());
  const event = JSON.stringify({ type: "project-update", projectId, message });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && isProjectMember(projectId, client.userId)) {
      client.send(event);
    }
  }
}

function getProject(projectId, viewerId) {
  if (!isProjectMember(projectId, viewerId)) return null;
  const project = db.prepare(`
    SELECT p.id, p.name, p.description, p.owner_id AS ownerId, p.due_date AS dueDate,
      p.created_at AS createdAt, p.updated_at AS updatedAt
    FROM projects p WHERE p.id = ?
  `).get(projectId);
  if (!project) return null;
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, pm.role
    FROM project_members pm JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ? ORDER BY CASE pm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name
  `).all(projectId);
  const tasks = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title, t.description, t.status, t.priority,
      t.assignee_id AS assigneeId, t.due_date AS dueDate, t.created_by AS createdBy,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      u.username AS assigneeUsername, u.display_name AS assigneeName,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS commentsCount
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? ORDER BY t.created_at DESC, t.id DESC
  `).all(projectId);
  const activity = db.prepare(`
    SELECT a.id, a.message, a.created_at AS createdAt,
      u.id AS userId, u.username, u.display_name AS displayName
    FROM activity_log a JOIN users u ON u.id = a.user_id
    WHERE a.project_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 20
  `).all(projectId);
  return { ...project, members, tasks, activity };
}

function getTaskForMember(taskId, userIdValue) {
  const task = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title, t.description, t.status, t.priority,
      t.assignee_id AS assigneeId, t.due_date AS dueDate, t.created_by AS createdBy,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      u.username AS assigneeUsername, u.display_name AS assigneeName
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = ?
  `).get(taskId);
  return task && isProjectMember(task.projectId, userIdValue) ? task : null;
}

function getComments(taskId) {
  return db.prepare(`
    SELECT c.id, c.content, c.created_at AS createdAt,
      u.id AS userId, u.username, u.display_name AS displayName
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at ASC, c.id ASC
  `).all(taskId);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

function requireProjectMember(req, res, next) {
  const projectId = positiveId(req.params.projectId);
  if (!projectId || !isProjectMember(projectId, req.session.userId)) {
    return res.status(404).json({ error: "Project not found." });
  }
  req.projectId = projectId;
  next();
}

const sessionMiddleware = session({
  name: sessionCookieName,
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/me", (req, res) => {
  const user = req.session.userId
    ? db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(req.session.userId)
    : null;
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/register", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3–24 letters, numbers, or underscores." });
  }
  if (displayName.length < 2 || displayName.length > 60) {
    return res.status(400).json({ error: "Name must be between 2 and 60 characters." });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const result = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(username, displayName, await bcrypt.hash(password, 10), timestamp());
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: publicUser(db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(req.session.userId)) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "That username is already in use." });
    }
    throw error;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", requireAuth, (req, res, next) => {
  const userIdValue = req.session.userId;
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(sessionCookieName);
    for (const client of wss.clients) {
      if (client.userId === userIdValue) client.close(1000, "Signed out");
    }
    res.json({ ok: true });
  });
});

app.get("/api/projects", requireAuth, (req, res) => {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.description, p.due_date AS dueDate, p.updated_at AS updatedAt,
      COUNT(t.id) AS taskCount,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completedCount
    FROM projects p JOIN project_members pm ON pm.project_id = p.id
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE pm.user_id = ?
    GROUP BY p.id ORDER BY p.updated_at DESC, p.id
  `).all(req.session.userId);
  res.json({ projects });
});

app.post("/api/projects", requireAuth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
  if (name.length < 3 || name.length > 80) {
    return res.status(400).json({ error: "Project name must be between 3 and 80 characters." });
  }
  if (description.length > 300) return res.status(400).json({ error: "Description is too long." });
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return res.status(400).json({ error: "Choose a valid project due date." });
  }
  const now = timestamp();
  const result = db.prepare(`
    INSERT INTO projects (name, description, owner_id, due_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, description, req.session.userId, dueDate, now, now);
  const projectId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)")
    .run(projectId, req.session.userId, now);
  notifyProject(projectId, req.session.userId, null, "project-created", `Created project “${name}”.`);
  res.status(201).json({ project: getProject(projectId, req.session.userId) });
});

app.get("/api/projects/:projectId", requireAuth, requireProjectMember, (req, res) => {
  res.json({ project: getProject(req.projectId, req.session.userId) });
});

app.post("/api/projects/:projectId/members", requireAuth, requireProjectMember, (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const target = db.prepare("SELECT id, username, display_name FROM users WHERE username = ?").get(username);
  if (!target) return res.status(404).json({ error: "No account found for that username." });
  if (isProjectMember(req.projectId, target.id)) {
    return res.status(409).json({ error: "That person is already on this project." });
  }
  db.prepare("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)")
    .run(req.projectId, target.id, timestamp());
  const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(req.projectId);
  db.prepare(`
    INSERT INTO notifications (user_id, project_id, type, message, created_at)
    VALUES (?, ?, 'invited', ?, ?)
  `).run(target.id, req.projectId, `You were added to “${project.name}”.`, timestamp());
  notifyProject(req.projectId, req.session.userId, null, "member-added", `${target.display_name} joined the project.`);
  res.status(201).json({ project: getProject(req.projectId, req.session.userId) });
});

app.post("/api/projects/:projectId/tasks", requireAuth, requireProjectMember, (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const status = String(req.body.status || "todo");
  const priority = String(req.body.priority || "medium");
  const assigneeId = req.body.assigneeId ? positiveId(req.body.assigneeId) : null;
  const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
  if (title.length < 2 || title.length > 120) {
    return res.status(400).json({ error: "Task title must be between 2 and 120 characters." });
  }
  if (description.length > 1000) return res.status(400).json({ error: "Task description is too long." });
  if (!["todo", "in_progress", "done"].includes(status)) return res.status(400).json({ error: "Choose a valid task status." });
  if (!["low", "medium", "high"].includes(priority)) return res.status(400).json({ error: "Choose a valid priority." });
  if (assigneeId && !isProjectMember(req.projectId, assigneeId)) {
    return res.status(400).json({ error: "Assignee must belong to this project." });
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: "Choose a valid due date." });
  const now = timestamp();
  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.projectId, title, description, status, priority, assigneeId, req.session.userId, dueDate, now, now);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, req.projectId);
  notifyProject(req.projectId, req.session.userId, Number(result.lastInsertRowid), "task-created", `Added task “${title}”.`);
  res.status(201).json({ project: getProject(req.projectId, req.session.userId) });
});

app.patch("/api/tasks/:taskId", requireAuth, (req, res) => {
  const taskId = positiveId(req.params.taskId);
  const task = taskId ? getTaskForMember(taskId, req.session.userId) : null;
  if (!task) return res.status(404).json({ error: "Task not found." });
  const updates = {};
  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (title.length < 2 || title.length > 120) return res.status(400).json({ error: "Task title must be between 2 and 120 characters." });
    updates.title = title;
  }
  if (req.body.description !== undefined) {
    const description = String(req.body.description).trim();
    if (description.length > 1000) return res.status(400).json({ error: "Task description is too long." });
    updates.description = description;
  }
  if (req.body.status !== undefined) {
    if (!["todo", "in_progress", "done"].includes(req.body.status)) return res.status(400).json({ error: "Choose a valid task status." });
    updates.status = req.body.status;
  }
  if (req.body.priority !== undefined) {
    if (!["low", "medium", "high"].includes(req.body.priority)) return res.status(400).json({ error: "Choose a valid priority." });
    updates.priority = req.body.priority;
  }
  if (req.body.assigneeId !== undefined) {
    const assigneeId = req.body.assigneeId === "" || req.body.assigneeId === null ? null : positiveId(req.body.assigneeId);
    if (req.body.assigneeId && !assigneeId) return res.status(400).json({ error: "Choose a valid assignee." });
    if (assigneeId && !isProjectMember(task.projectId, assigneeId)) {
      return res.status(400).json({ error: "Assignee must belong to this project." });
    }
    updates.assignee_id = assigneeId;
  }
  if (req.body.dueDate !== undefined) {
    const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: "Choose a valid due date." });
    updates.due_date = dueDate;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "There are no task changes to save." });
  updates.updated_at = timestamp();
  const assignments = Object.keys(updates).map((field) => `${field} = ?`).join(", ");
  db.prepare(`UPDATE tasks SET ${assignments} WHERE id = ?`).run(...Object.values(updates), taskId);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp(), task.projectId);
  notifyProject(task.projectId, req.session.userId, taskId, "task-updated", `Updated task “${updates.title || task.title}”.`);
  res.json({ project: getProject(task.projectId, req.session.userId) });
});

app.delete("/api/tasks/:taskId", requireAuth, (req, res) => {
  const taskId = positiveId(req.params.taskId);
  const task = taskId ? getTaskForMember(taskId, req.session.userId) : null;
  if (!task) return res.status(404).json({ error: "Task not found." });
  const membership = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(task.projectId, req.session.userId);
  if (membership.role !== "owner" && task.createdBy !== req.session.userId) {
    return res.status(403).json({ error: "Only the project owner or task creator can delete this task." });
  }
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp(), task.projectId);
  notifyProject(task.projectId, req.session.userId, null, "task-deleted", `Removed task “${task.title}”.`);
  res.json({ project: getProject(task.projectId, req.session.userId) });
});

app.get("/api/tasks/:taskId/comments", requireAuth, (req, res) => {
  const taskId = positiveId(req.params.taskId);
  const task = taskId ? getTaskForMember(taskId, req.session.userId) : null;
  if (!task) return res.status(404).json({ error: "Task not found." });
  res.json({ comments: getComments(taskId) });
});

app.post("/api/tasks/:taskId/comments", requireAuth, (req, res) => {
  const taskId = positiveId(req.params.taskId);
  const task = taskId ? getTaskForMember(taskId, req.session.userId) : null;
  const content = String(req.body.content || "").trim();
  if (!task) return res.status(404).json({ error: "Task not found." });
  if (!content || content.length > 600) return res.status(400).json({ error: "Comments must contain 1–600 characters." });
  db.prepare("INSERT INTO comments (task_id, user_id, content, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, req.session.userId, content, timestamp());
  const user = db.prepare("SELECT display_name FROM users WHERE id = ?").get(req.session.userId);
  notifyProject(task.projectId, req.session.userId, taskId, "comment-added", `${user.display_name} commented on “${task.title}”.`);
  res.status(201).json({ comments: getComments(taskId) });
});

app.get("/api/notifications", requireAuth, (req, res) => {
  const notifications = db.prepare(`
    SELECT n.id, n.project_id AS projectId, n.task_id AS taskId, n.type, n.message,
      n.is_read AS isRead, n.created_at AS createdAt, p.name AS projectName
    FROM notifications n JOIN projects p ON p.id = n.project_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 30
  `).all(req.session.userId).map((item) => ({ ...item, isRead: Boolean(item.isRead) }));
  const unreadCount = db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0")
    .get(req.session.userId).count;
  res.json({ notifications, unreadCount });
});

app.post("/api/notifications/:notificationId/read", requireAuth, (req, res) => {
  const notificationId = positiveId(req.params.notificationId);
  if (!notificationId) return res.status(404).json({ error: "Notification not found." });
  const result = db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?")
    .run(notificationId, req.session.userId);
  if (!result.changes) return res.status(404).json({ error: "Notification not found." });
  res.json({ ok: true });
});

const rejectUpgrade = (socket, status, message) => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://localhost").pathname !== "/updates") {
    return rejectUpgrade(socket, 404, "Not Found");
  }
  const rawCookie = cookie.parse(req.headers.cookie || "")[sessionCookieName];
  const sessionId = rawCookie && rawCookie.startsWith("s:")
    ? cookieSignature.unsign(rawCookie.slice(2), sessionSecret)
    : false;
  if (!sessionId) return rejectUpgrade(socket, 401, "Unauthorized");
  sessionStore.get(sessionId, (error, storedSession) => {
    if (error) {
      console.error(error);
      return rejectUpgrade(socket, 500, "Internal Server Error");
    }
    if (!storedSession || !storedSession.userId) return rejectUpgrade(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (websocket) => {
      websocket.userId = storedSession.userId;
      wss.emit("connection", websocket, req);
    });
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

server.listen(port, () => {
  console.log(`Kivo is ready at http://localhost:${port}`);
});
