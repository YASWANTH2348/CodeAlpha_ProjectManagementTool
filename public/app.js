const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const statuses = [
  { id: "todo", label: "To do", color: "lavender" },
  { id: "in_progress", label: "In progress", color: "blue" },
  { id: "done", label: "Done", color: "green" }
];
const state = {
  user: null,
  projects: [],
  project: null,
  currentProjectId: null,
  notifications: [],
  unreadCount: 0,
  comments: [],
  currentTask: null,
  view: "board",
  search: "",
  assigneeFilter: "all",
  socket: null,
  reconnectTimer: null,
  toastTimer: null
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function initials(user) {
  return (user?.displayName || user?.username || "?")
    .split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase();
}

function avatar(user, size = "") {
  const color = (Number(user?.id) || 0) % 5;
  return `<span class="avatar ${size} avatar-color-${color}" title="${escapeHtml(user?.displayName || "Team member")}" aria-hidden="true">${escapeHtml(initials(user))}</span>`;
}

function formatDate(value, options = { month: "short", day: "numeric" }) {
  if (!value) return "No due date";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "No due date" : new Intl.DateTimeFormat("en", options).format(date);
}

function relativeTime(value) {
  const minutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function showToast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("visible"), 2800);
}

function syncUser() {
  const user = state.user;
  $("#topbar-avatar").textContent = initials(user);
  $("#topbar-avatar").className = `topbar-avatar avatar-color-${(Number(user?.id) || 0) % 5}`;
  $("#sidebar-user").innerHTML = user
    ? `${avatar(user)}<span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span><button type="button" class="user-menu-button" id="sign-out" aria-label="Sign out">↗</button>`
    : `<button type="button" class="sidebar-sign-in" data-open-auth>Sign in to Kivo <span aria-hidden="true">↗</span></button>`;
}

function renderProjectList() {
  $("#project-list").innerHTML = state.projects.length
    ? state.projects.map((project, index) => `<button type="button" class="project-nav-item ${project.id === state.currentProjectId ? "active" : ""}" data-project-select="${project.id}">
        <span class="project-nav-dot tone-${index % 5}"></span><span>${escapeHtml(project.name)}</span><small>${project.taskCount}</small>
      </button>`).join("")
    : '<p class="project-list-empty">Your projects will appear here.</p>';
}

function renderProjectHeader() {
  const project = state.project;
  if (!project) return;
  $("#breadcrumb-project").textContent = state.view === "my-tasks" ? "My tasks" : project.name;
  $("#project-kicker").textContent = state.view === "my-tasks" ? "YOUR WORK" : "TEAM PROJECT";
  $("#project-name").textContent = state.view === "my-tasks" ? "My tasks" : project.name;
  $("#project-description").textContent = state.view === "my-tasks"
    ? "A clear view of the work you’re helping move forward."
    : project.description || "A shared place to make good work happen.";
  $("#project-due-date").textContent = project.dueDate
    ? `Target date · ${formatDate(project.dueDate, { month: "long", day: "numeric", year: "numeric" })}`
    : "No target date";
  $("#project-member-count").textContent = `${project.members.length} ${project.members.length === 1 ? "member" : "members"}`;
  $("#project-avatars").innerHTML = project.members.slice(0, 5).map((member) => avatar(member)).join("");
  const total = state.view === "my-tasks" ? state.project.tasks.filter((task) => task.assigneeId === state.user.id).length : state.project.tasks.length;
  const done = state.view === "my-tasks"
    ? state.project.tasks.filter((task) => task.assigneeId === state.user.id && task.status === "done").length
    : state.project.tasks.filter((task) => task.status === "done").length;
  const percentage = total ? Math.round((done / total) * 100) : 0;
  $("#progress-label").textContent = state.view === "my-tasks" ? "Your progress" : "Project progress";
  $("#progress-caption").textContent = `${done} of ${total} tasks complete`;
  $("#progress-bar").style.width = `${percentage}%`;
  $("#progress-value").textContent = `${percentage}%`;
  $("#invite-button").hidden = state.view === "my-tasks";
  $("#add-task-button").hidden = state.view === "my-tasks";
}

function filteredTasks() {
  if (!state.project) return [];
  return state.project.tasks.filter((task) => {
    const assignedToMe = state.view !== "my-tasks" || task.assigneeId === state.user.id;
    const matchesAssignee = state.assigneeFilter === "all" || String(task.assigneeId || "") === state.assigneeFilter;
    const matchesSearch = !state.search
      || `${task.title} ${task.description} ${task.assigneeName || ""}`.toLowerCase().includes(state.search);
    return assignedToMe && matchesAssignee && matchesSearch;
  });
}

function renderTaskCard(task) {
  const assignee = task.assigneeId
    ? avatar({ id: task.assigneeId, displayName: task.assigneeName })
    : '<span class="avatar avatar-unassigned" title="Unassigned">＋</span>';
  const overdue = task.dueDate && task.status !== "done" && new Date(`${task.dueDate}T23:59:59`) < new Date();
  return `<article class="task-card" draggable="true" data-task-card="${task.id}" data-task-id="${task.id}">
    <div class="task-card-top"><span class="priority-pill priority-${task.priority}"><i></i>${task.priority}</span><button type="button" class="task-more" data-open-task="${task.id}" aria-label="Open task options">···</button></div>
    <button class="task-card-title" type="button" data-open-task="${task.id}">${escapeHtml(task.title)}</button>
    ${task.description ? `<p class="task-card-description">${escapeHtml(task.description)}</p>` : ""}
    <div class="task-card-footer">
      <span class="task-due ${overdue ? "is-overdue" : ""}"><span aria-hidden="true">◷</span>${task.dueDate ? formatDate(task.dueDate) : "No date"}</span>
      <span class="task-card-foot-right">${task.commentsCount ? `<span class="comment-count" title="Comments">▤ ${task.commentsCount}</span>` : ""}${assignee}</span>
    </div>
  </article>`;
}

function renderBoard() {
  if (!state.project) return;
  const tasks = filteredTasks();
  $("#board-columns").innerHTML = statuses.map((status) => {
    const inColumn = tasks.filter((task) => task.status === status.id);
    return `<section class="board-column" data-status="${status.id}">
      <header class="column-header">
        <div class="column-title"><span class="column-dot ${status.color}"></span><h2>${status.label}</h2><span class="column-count">${inColumn.length}</span></div>
        <button type="button" class="column-add" data-add-task="${status.id}" aria-label="Add task to ${status.label}">＋</button>
      </header>
      <div class="task-stack">${inColumn.map(renderTaskCard).join("")}</div>
      <button type="button" class="add-task-inline" data-add-task="${status.id}"><span>＋</span> Add a task</button>
    </section>`;
  }).join("");
  $("#assignee-filter").innerHTML = `<option value="all">Everyone</option>${state.project.members.map((member) =>
    `<option value="${member.id}">${escapeHtml(member.displayName)}</option>`).join("")}`;
  $("#assignee-filter").value = state.assigneeFilter;
  renderProjectHeader();
  renderActivity();
}

function renderActivity() {
  const events = state.project?.activity || [];
  $("#activity-view").innerHTML = events.length
    ? `<div class="activity-card">${events.map((event) => `<div class="activity-row">
        ${avatar(event)}
        <p><strong>${escapeHtml(event.displayName)}</strong> ${escapeHtml(event.message)}<small>${relativeTime(event.createdAt)}</small></p>
      </div>`).join("")}</div>`
    : '<div class="activity-empty"><span>◷</span><strong>Updates will appear here</strong><p>Project changes and team conversations will be collected in this activity view.</p></div>';
}

async function loadProjects() {
  const { projects } = await request("/api/projects");
  state.projects = projects;
  if (!projects.some((project) => project.id === state.currentProjectId)) {
    state.currentProjectId = projects[0]?.id || null;
  }
  renderProjectList();
  if (state.currentProjectId) await loadProject(state.currentProjectId);
  else {
    state.project = null;
    $("#project-view").hidden = true;
    $("#welcome-state").hidden = false;
  }
}

async function loadProject(projectId) {
  const { project } = await request(`/api/projects/${projectId}`);
  state.project = project;
  state.currentProjectId = project.id;
  $("#welcome-state").hidden = true;
  $("#project-view").hidden = false;
  $("#board-columns").hidden = state.view === "activity";
  $("#activity-view").hidden = state.view !== "activity";
  $$(".project-nav-item").forEach((item) => item.classList.toggle("active", Number(item.dataset.projectSelect) === project.id));
  $$(".view-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === state.view));
  renderBoard();
}

async function loadNotifications() {
  const { notifications, unreadCount } = await request("/api/notifications");
  state.notifications = notifications;
  state.unreadCount = unreadCount;
  $("#notification-badge").hidden = unreadCount === 0;
  $("#notification-badge").textContent = unreadCount > 9 ? "9+" : unreadCount;
  $("#inbox-count").hidden = unreadCount === 0;
  $("#inbox-count").textContent = unreadCount > 9 ? "9+" : unreadCount;
  $("#notification-list").innerHTML = notifications.length
    ? notifications.map((notification) => `<button type="button" class="notification-item ${notification.isRead ? "" : "unread"}" data-notification="${notification.id}" data-project="${notification.projectId}" ${notification.taskId ? `data-task="${notification.taskId}"` : ""}>
        <span class="notification-dot"></span><span><strong>${escapeHtml(notification.message)}</strong><small>${escapeHtml(notification.projectName)} · ${relativeTime(notification.createdAt)}</small></span>
      </button>`).join("")
    : '<p class="notification-empty">You’re all caught up. New project updates will land here.</p>';
}

function renderComments() {
  $("#comment-list").innerHTML = state.comments.length
    ? state.comments.map((comment) => `<article class="comment-item">${avatar(comment)}<div><div class="comment-author-line"><strong>${escapeHtml(comment.displayName)}</strong><span>@${escapeHtml(comment.username)}</span><time>${relativeTime(comment.createdAt)}</time></div><p>${escapeHtml(comment.content)}</p></div></article>`).join("")
    : '<p class="comments-empty">No comments yet. Start the conversation.</p>';
  $("#discussion-count").textContent = `${state.comments.length} ${state.comments.length === 1 ? "comment" : "comments"}`;
}

function fillAssignees(selectedId = "") {
  $("#task-assignee").innerHTML = `<option value="">Unassigned</option>${(state.project?.members || []).map((member) =>
    `<option value="${member.id}">${escapeHtml(member.displayName)}</option>`).join("")}`;
  $("#task-assignee").value = selectedId ? String(selectedId) : "";
}

async function openTask(taskId = null, status = "todo") {
  const task = taskId ? state.project.tasks.find((item) => item.id === Number(taskId)) : null;
  state.currentTask = task;
  const form = $("#task-form");
  form.reset();
  form.elements.taskId.value = task?.id || "";
  form.elements.title.value = task?.title || "";
  form.elements.description.value = task?.description || "";
  form.elements.status.value = task?.status || status;
  form.elements.priority.value = task?.priority || "medium";
  form.elements.dueDate.value = task?.dueDate || "";
  fillAssignees(task?.assigneeId);
  $("#task-dialog-title").textContent = task ? "Task details" : "Create a task";
  $("#task-dialog-eyebrow").textContent = task ? "PROJECT TASK" : "ADD TO YOUR BOARD";
  $("#task-submit").innerHTML = task ? "Save changes <span aria-hidden=\"true\">↗</span>" : "Create task <span aria-hidden=\"true\">↗</span>";
  $("#delete-task-button").hidden = !task;
  $("#task-discussion").hidden = !task;
  $("#task-error").textContent = "";
  if (task) {
    try {
      const { comments } = await request(`/api/tasks/${task.id}/comments`);
      state.comments = comments;
      renderComments();
    } catch (error) {
      showToast(error.message);
    }
  } else {
    state.comments = [];
  }
  if (!$("#task-dialog").open) $("#task-dialog").showModal();
}

function openProjectDialog() {
  $("#project-form").reset();
  $("#project-error").textContent = "";
  $("#project-dialog").showModal();
}

function openInviteDialog() {
  $("#invite-form").reset();
  $("#invite-error").textContent = "";
  $("#invite-dialog").showModal();
}

function openAuth(mode = "login") {
  const registering = mode === "register";
  $("#auth-eyebrow").textContent = registering ? "START WITH A CLEAR PLAN" : "WELCOME BACK";
  $("#auth-title").textContent = registering ? "Make room for good work." : "Good to see you.";
  $("#auth-subtitle").textContent = registering ? "Create your account and bring your team together." : "Sign in to pick up where your team left off.";
  $("#auth-submit").innerHTML = `${registering ? "Create account" : "Sign in"} <span aria-hidden="true">↗</span>`;
  $("#display-name-field").hidden = !registering;
  $("#auth-form").elements.displayName.required = registering;
  $("#auth-form").elements.password.autocomplete = registering ? "new-password" : "current-password";
  $("#auth-switch").innerHTML = registering
    ? `Already have an account? <button type="button" data-auth="login">Sign in</button>`
    : `New to Kivo? <button type="button" data-auth="register">Create an account</button>`;
  $("#auth-error").textContent = "";
  if (!$("#auth-dialog").open) $("#auth-dialog").showModal();
}

function connectRealtime() {
  clearTimeout(state.reconnectTimer);
  if (!state.user || (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState))) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/updates`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    $("#connection-label").textContent = "Live updates on";
    $("#connection-dot").classList.add("connected");
  });
  socket.addEventListener("message", async (event) => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch {
      return;
    }
    if (update.type !== "project-update") return;
    if (update.projectId === state.currentProjectId) {
      try {
        await Promise.all([loadProject(update.projectId), loadProjects()]);
      } catch (error) {
        showToast(error.message);
      }
    }
    loadNotifications().catch((error) => showToast(error.message));
    if (update.message) showToast(update.message);
  });
  socket.addEventListener("close", () => {
    $("#connection-label").textContent = "Reconnecting…";
    $("#connection-dot").classList.remove("connected");
    if (state.user) state.reconnectTimer = setTimeout(connectRealtime, 2500);
  });
  socket.addEventListener("error", () => socket.close());
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form).entries());
  $("#auth-submit").disabled = true;
  $("#auth-error").textContent = "";
  const mode = $("#display-name-field").hidden ? "login" : "register";
  try {
    const { user } = await request(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(fields) });
    state.user = user;
    $("#auth-dialog").close();
    syncUser();
    await Promise.all([loadProjects(), loadNotifications()]);
    connectRealtime();
    showToast(`Welcome, ${user.displayName.split(" ")[0]}.`);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    $("#auth-submit").disabled = false;
  }
}

async function submitProject(event) {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form).entries());
  $("#project-error").textContent = "";
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { project } = await request("/api/projects", { method: "POST", body: JSON.stringify(fields) });
    $("#project-dialog").close();
    state.view = "board";
    await loadProjects();
    await loadProject(project.id);
    showToast("Your new project is ready.");
  } catch (error) {
    $("#project-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function submitTask(event) {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form).entries());
  const taskId = fields.taskId;
  delete fields.taskId;
  $("#task-error").textContent = "";
  const submit = $("#task-submit");
  submit.disabled = true;
  try {
    const url = taskId ? `/api/tasks/${taskId}` : `/api/projects/${state.currentProjectId}/tasks`;
    const result = await request(url, {
      method: taskId ? "PATCH" : "POST",
      body: JSON.stringify(fields)
    });
    $("#task-dialog").close();
    state.project = result.project;
    renderBoard();
    await loadProjects();
    showToast(taskId ? "Task changes saved." : "Task added to the board.");
  } catch (error) {
    $("#task-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function submitComment(event) {
  event.preventDefault();
  if (!state.currentTask) return;
  const form = event.target;
  const content = form.elements.content.value.trim();
  if (!content) return;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { comments } = await request(`/api/tasks/${state.currentTask.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
    state.comments = comments;
    form.reset();
    renderComments();
    const { project } = await request(`/api/projects/${state.currentProjectId}`);
    state.project = project;
    renderBoard();
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function submitInvite(event) {
  event.preventDefault();
  const form = event.target;
  $("#invite-error").textContent = "";
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { project } = await request(`/api/projects/${state.currentProjectId}/members`, {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
    });
    state.project = project;
    $("#invite-dialog").close();
    renderBoard();
    await loadProjects();
    showToast("Your teammate has been added.");
  } catch (error) {
    $("#invite-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function deleteTask() {
  if (!state.currentTask) return;
  try {
    const result = await request(`/api/tasks/${state.currentTask.id}`, { method: "DELETE" });
    state.project = result.project;
    $("#task-dialog").close();
    renderBoard();
    await loadProjects();
    showToast("Task removed.");
  } catch (error) {
    showToast(error.message);
  }
}

async function changeTaskStatus(taskId, status) {
  const task = state.project?.tasks.find((item) => item.id === Number(taskId));
  if (!task || task.status === status) return;
  try {
    const result = await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    state.project = result.project;
    renderBoard();
    await loadProjects();
  } catch (error) {
    showToast(error.message);
  }
}

async function selectNotification(notification) {
  const id = Number(notification.dataset.notification);
  const projectId = Number(notification.dataset.project);
  try {
    await request(`/api/notifications/${id}/read`, { method: "POST", body: "{}" });
    $("#notification-popover").hidden = true;
    $("#notification-toggle").setAttribute("aria-expanded", "false");
    if (projectId !== state.currentProjectId) {
      state.currentProjectId = projectId;
      state.view = "board";
      await loadProjects();
    }
    await loadNotifications();
    if (notification.dataset.task) await openTask(notification.dataset.task);
  } catch (error) {
    showToast(error.message);
  }
}

document.addEventListener("click", async (event) => {
  const authButton = event.target.closest("[data-open-auth], [data-auth]");
  if (authButton) {
    openAuth(authButton.dataset.auth || "login");
    return;
  }
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) {
    closeButton.closest("dialog").close();
    return;
  }
  const notification = event.target.closest("[data-notification]");
  if (notification) {
    await selectNotification(notification);
    return;
  }
  const projectButton = event.target.closest("[data-project-select]");
  if (projectButton) {
    state.view = "board";
    state.assigneeFilter = "all";
    await loadProject(Number(projectButton.dataset.projectSelect));
    return;
  }
  const addTaskButton = event.target.closest("[data-add-task]");
  if (addTaskButton) {
    await openTask(null, addTaskButton.dataset.addTask);
    return;
  }
  const taskButton = event.target.closest("[data-open-task]");
  if (taskButton) {
    await openTask(taskButton.dataset.openTask);
    return;
  }
  const navButton = event.target.closest("[data-nav]");
  if (navButton) {
    if (navButton.dataset.nav === "my-tasks") {
      if (!state.project) return;
      state.view = "my-tasks";
      state.assigneeFilter = "all";
      renderBoard();
      $$(".side-nav-link").forEach((item) => item.classList.toggle("active", item === navButton));
    } else {
      state.view = "board";
      renderBoard();
      $$(".side-nav-link").forEach((item) => item.classList.toggle("active", item === navButton));
    }
    return;
  }
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    state.view = viewButton.dataset.view;
    $("#board-columns").hidden = state.view !== "board";
    $("#activity-view").hidden = state.view !== "activity";
    $$(".view-tab").forEach((tab) => tab.classList.toggle("active", tab === viewButton));
    if (state.view === "activity") renderActivity();
    return;
  }
  if (event.target.closest("#sign-out")) {
    await signOut();
    return;
  }
  if (event.target.closest("#notification-toggle, #sidebar-inbox")) {
    const panel = $("#notification-popover");
    panel.hidden = !panel.hidden;
    $("#notification-toggle").setAttribute("aria-expanded", String(!panel.hidden));
    return;
  }
  if (event.target === $("#notification-popover")) return;
  if (!event.target.closest(".notification-wrap")) {
    $("#notification-popover").hidden = true;
    $("#notification-toggle").setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "auth-form") submitAuth(event);
  if (event.target.id === "project-form") submitProject(event);
  if (event.target.id === "task-form") submitTask(event);
  if (event.target.id === "comment-form") submitComment(event);
  if (event.target.id === "invite-form") submitInvite(event);
});

document.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-task-card]");
  if (!card) return;
  event.dataTransfer.setData("text/plain", card.dataset.taskId);
  event.dataTransfer.effectAllowed = "move";
  card.classList.add("is-dragging");
});
document.addEventListener("dragend", (event) => {
  event.target.closest("[data-task-card]")?.classList.remove("is-dragging");
  $$(".board-column").forEach((column) => column.classList.remove("drag-over"));
});
document.addEventListener("dragover", (event) => {
  const column = event.target.closest(".board-column");
  if (column) {
    event.preventDefault();
    column.classList.add("drag-over");
  }
});
document.addEventListener("dragleave", (event) => {
  const column = event.target.closest(".board-column");
  if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-over");
});
document.addEventListener("drop", async (event) => {
  const column = event.target.closest(".board-column");
  if (!column) return;
  event.preventDefault();
  column.classList.remove("drag-over");
  await changeTaskStatus(event.dataTransfer.getData("text/plain"), column.dataset.status);
});

$("#auth-dialog").addEventListener("click", (event) => {
  if (event.target === $("#auth-dialog")) $("#auth-dialog").close();
});
$("#project-dialog").addEventListener("click", (event) => {
  if (event.target === $("#project-dialog")) $("#project-dialog").close();
});
$("#task-dialog").addEventListener("click", (event) => {
  if (event.target === $("#task-dialog")) $("#task-dialog").close();
});
$("#invite-dialog").addEventListener("click", (event) => {
  if (event.target === $("#invite-dialog")) $("#invite-dialog").close();
});
$("#task-search").addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  renderBoard();
});
$("#assignee-filter").addEventListener("change", (event) => {
  state.assigneeFilter = event.target.value;
  renderBoard();
});
$("#filter-assignee-button").addEventListener("click", () => $("#assignee-filter").focus());
$("#sidebar-add-project").addEventListener("click", openProjectDialog);
$("#add-task-button").addEventListener("click", () => openTask());
$("#invite-button").addEventListener("click", openInviteDialog);
$("#delete-task-button").addEventListener("click", deleteTask);
$("#mark-all-read").addEventListener("click", async () => {
  try {
    await Promise.all(state.notifications.filter((item) => !item.isRead)
      .map((item) => request(`/api/notifications/${item.id}/read`, { method: "POST", body: "{}" })));
    await loadNotifications();
  } catch (error) {
    showToast(error.message);
  }
});
async function signOut() {
  try {
    await request("/api/auth/logout", { method: "POST", body: "{}" });
    state.socket?.close();
    state.socket = null;
    state.user = null;
    state.projects = [];
    state.project = null;
    syncUser();
    $("#project-view").hidden = true;
    $("#welcome-state").hidden = false;
    $("#project-list").innerHTML = "";
    $("#connection-label").textContent = "Offline";
    $("#connection-dot").classList.remove("connected");
    openAuth("login");
  } catch (error) {
    showToast(error.message);
  }
}
window.addEventListener("beforeunload", () => state.socket?.close());

async function start() {
  try {
    const { user } = await request("/api/me");
    state.user = user;
    syncUser();
    if (!user) {
      openAuth("login");
      return;
    }
    await Promise.all([loadProjects(), loadNotifications()]);
    connectRealtime();
  } catch (error) {
    $("#welcome-state").innerHTML = `<h1>We couldn’t open your workspace.</h1><p>${escapeHtml(error.message)}</p><button class="button button-primary" type="button" data-open-auth>Try again</button>`;
  }
}

start();
