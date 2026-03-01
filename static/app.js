const tg = window.Telegram.WebApp;

const state = {
  tasks: [],
  filteredTasks: [],
  editingTaskId: null,
  initData: tg.initData || "",
  timezone: "UTC",
  busy: false,
};

const els = {
  userAvatar: document.getElementById("userAvatar"),
  userAvatarFallback: document.getElementById("userAvatarFallback"),
  userTitle: document.getElementById("userTitle"),
  botLink: document.getElementById("botLink"),
  tasksCount: document.getElementById("tasksCount"),
  searchInput: document.getElementById("searchInput"),
  createTaskBtn: document.getElementById("createTaskBtn"),
  tasksList: document.getElementById("tasksList"),
  emptyState: document.getElementById("emptyState"),
  editorCard: document.getElementById("editorCard"),
  editorTitle: document.getElementById("editorTitle"),
  taskText: document.getElementById("taskText"),
  taskDatetime: document.getElementById("taskDatetime"),
  timezoneInput: document.getElementById("timezoneInput"),
  saveTaskBtn: document.getElementById("saveTaskBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  deleteTaskBtn: document.getElementById("deleteTaskBtn"),
  timezoneCurrent: document.getElementById("timezoneCurrent"),
  toastStack: document.getElementById("toastStack"),
  taskRowTemplate: document.getElementById("taskRowTemplate"),
};

function setBusy(value) {
  state.busy = value;
  els.saveTaskBtn.disabled = value;
  els.cancelEditBtn.disabled = value;
  els.deleteTaskBtn.disabled = value;
  els.createTaskBtn.disabled = value;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "toast-error" : "toast-success"}`;
  toast.textContent = message;
  els.toastStack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3400);
}

function handleError(error, fallback = "Ошибка") {
  showToast(error?.message || fallback, "error");
}

function withAuthHeaders(extra = {}) {
  return {
    ...extra,
    "X-Telegram-Init-Data": state.initData,
    "Content-Type": "application/json",
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: withAuthHeaders(options.headers || {}),
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "Request failed");
  }
  return data;
}

function normalizeDatetimeValue(value) {
  return value.slice(0, 16);
}

function localInputToApi(value) {
  return normalizeDatetimeValue(value).replace("T", " ");
}

function apiToLocalInput(value) {
  return value.replace(" ", "T");
}

function pickAvatarColor(seed) {
  const colors = [
    ["#7b8dff", "#576ddc"],
    ["#69c58f", "#3d9f66"],
    ["#ffb56a", "#e18a32"],
    ["#be86ff", "#8758d4"],
    ["#7fd7ff", "#4298d8"],
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % colors.length;
  return colors[idx];
}

function renderUserInfo() {
  const user = tg.initDataUnsafe?.user;
  const username = user?.username ? `@${user.username}` : "@username";
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();

  els.userTitle.textContent = username;
  els.botLink.href = user?.username ? `https://t.me/${user.username}` : "https://t.me/kolendarbot";

  const fallbackText = (fullName || username || "TG")
    .replace("@", "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0].toUpperCase())
    .join("") || "TG";

  els.userAvatarFallback.textContent = fallbackText;

  if (user?.photo_url) {
    els.userAvatar.src = user.photo_url;
    els.userAvatar.hidden = false;
    els.userAvatarFallback.hidden = true;
  } else {
    els.userAvatar.hidden = true;
    els.userAvatarFallback.hidden = false;
  }
}

function filterTasks() {
  const query = els.searchInput.value.trim().toLowerCase();
  if (!query) {
    state.filteredTasks = [...state.tasks];
    return;
  }

  state.filteredTasks = state.tasks.filter((task) => {
    const haystack = `${task.text} ${task.scheduled_local}`.toLowerCase();
    return haystack.includes(query);
  });
}

function pluralizeTasks(count) {
  if (count === 1) {
    return "задача";
  }
  if (count >= 2 && count <= 4) {
    return "задачи";
  }
  return "задач";
}

function renderTasksCount() {
  const count = state.tasks.length;
  els.tasksCount.textContent = `${count} ${pluralizeTasks(count)}`;
}

function renderTasks() {
  filterTasks();
  els.tasksList.innerHTML = "";

  if (!state.filteredTasks.length) {
    els.emptyState.hidden = false;
    return;
  }

  els.emptyState.hidden = true;

  state.filteredTasks.forEach((task) => {
    const node = els.taskRowTemplate.content.firstElementChild.cloneNode(true);

    const avatar = node.querySelector(".task-avatar");
    const title = node.querySelector(".task-title");
    const sub = node.querySelector(".task-sub");
    const mainBtn = node.querySelector(".task-main");
    const editBtn = node.querySelector(".task-edit");

    title.textContent = task.text;
    sub.textContent = `${task.scheduled_local} • ${task.reminded ? "напомнено" : "ожидает"}`;

    const initials = task.text.trim().slice(0, 1).toUpperCase() || "З";
    const [c1, c2] = pickAvatarColor(task.text + String(task.id));
    avatar.textContent = initials;
    avatar.style.background = `linear-gradient(140deg, ${c1}, ${c2})`;

    const openEdit = () => startEdit(task);
    mainBtn.addEventListener("click", openEdit);
    editBtn.addEventListener("click", openEdit);

    els.tasksList.appendChild(node);
  });
}

function openEditor() {
  els.editorCard.hidden = false;
  els.editorCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeEditor() {
  state.editingTaskId = null;
  els.editorTitle.textContent = "Новая задача";
  els.taskText.value = "";
  els.taskDatetime.value = "";
  els.timezoneInput.value = state.timezone;
  els.deleteTaskBtn.hidden = true;
  els.editorCard.hidden = true;
}

function startCreate() {
  state.editingTaskId = null;
  els.editorTitle.textContent = "Новая задача";
  els.taskText.value = "";
  els.taskDatetime.value = "";
  els.timezoneInput.value = state.timezone;
  els.deleteTaskBtn.hidden = true;
  openEditor();
}

function startEdit(task) {
  state.editingTaskId = task.id;
  els.editorTitle.textContent = "Редактирование задачи";
  els.taskText.value = task.text;
  els.taskDatetime.value = apiToLocalInput(task.scheduled_local);
  els.timezoneInput.value = state.timezone;
  els.deleteTaskBtn.hidden = false;
  openEditor();
}

async function loadTimezone() {
  const data = await api("/api/user/timezone", { method: "GET" });
  state.timezone = data.timezone;
  els.timezoneCurrent.textContent = `Текущий пояс: ${state.timezone}`;
  if (!state.editingTaskId) {
    els.timezoneInput.value = state.timezone;
  }
}

async function saveTimezoneIfChanged() {
  const timezone = els.timezoneInput.value.trim();
  if (!timezone || timezone === state.timezone) {
    return;
  }

  const data = await api("/api/user/timezone", {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  });

  state.timezone = data.timezone;
  els.timezoneCurrent.textContent = `Текущий пояс: ${state.timezone}`;
}

async function loadTasks() {
  const tasks = await api("/api/tasks", { method: "GET" });
  state.tasks = [...tasks].sort((a, b) => a.scheduled_utc.localeCompare(b.scheduled_utc));
  renderTasksCount();
  renderTasks();
}

async function saveTask() {
  if (state.busy) {
    return;
  }

  const text = els.taskText.value.trim();
  const datetime = normalizeDatetimeValue(els.taskDatetime.value);

  if (!text) {
    showToast("Введите текст задачи", "error");
    return;
  }
  if (!datetime) {
    showToast("Укажите дату и время", "error");
    return;
  }

  try {
    setBusy(true);
    await saveTimezoneIfChanged();

    const payload = {
      text,
      scheduled_local: localInputToApi(datetime),
    };

    if (state.editingTaskId) {
      await api(`/api/tasks/${state.editingTaskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("Задача обновлена", "success");
    } else {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("Задача добавлена", "success");
    }

    await loadTasks();
    closeEditor();
  } catch (error) {
    handleError(error, "Ошибка сохранения задачи");
  } finally {
    setBusy(false);
  }
}

async function deleteTask() {
  if (!state.editingTaskId || state.busy) {
    return;
  }

  try {
    setBusy(true);
    await api(`/api/tasks/${state.editingTaskId}`, { method: "DELETE" });
    await loadTasks();
    closeEditor();
    showToast("Задача удалена", "success");
  } catch (error) {
    handleError(error, "Ошибка удаления задачи");
  } finally {
    setBusy(false);
  }
}

async function initialize() {
  tg.ready();
  tg.expand();
  tg.MainButton.hide();

  renderUserInfo();

  if (!state.initData) {
    showToast("Откройте приложение внутри Telegram", "error");
    return;
  }

  els.searchInput.addEventListener("input", renderTasks);
  els.createTaskBtn.addEventListener("click", startCreate);
  els.saveTaskBtn.addEventListener("click", saveTask);
  els.cancelEditBtn.addEventListener("click", closeEditor);
  els.deleteTaskBtn.addEventListener("click", deleteTask);

  try {
    setBusy(true);
    await Promise.all([loadTimezone(), loadTasks()]);
  } catch (error) {
    handleError(error, "Ошибка загрузки данных");
  } finally {
    setBusy(false);
  }
}

initialize();
