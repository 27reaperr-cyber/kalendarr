const tg = window.Telegram.WebApp;

const state = {
  initData: tg.initData || "",
  tasks: [],
  filtered: [],
  editingTaskId: null,
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
  editorSheet: document.getElementById("editorSheet"),
  sheetBackdrop: document.getElementById("sheetBackdrop"),
  sheetPanel: document.getElementById("sheetPanel"),
  editorTitle: document.getElementById("editorTitle"),
  taskText: document.getElementById("taskText"),
  taskDatetime: document.getElementById("taskDatetime"),
  timezoneInput: document.getElementById("timezoneInput"),
  saveTaskBtn: document.getElementById("saveTaskBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  deleteTaskBtn: document.getElementById("deleteTaskBtn"),
  toastStack: document.getElementById("toastStack"),
  taskRowTemplate: document.getElementById("taskRowTemplate"),
};

function requiredElement(element, id) {
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}

function showToast(message, type = "success") {
  const stack = requiredElement(els.toastStack, "toastStack");
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "toast-error" : "toast-success"}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function handleError(error, fallback = "Ошибка") {
  showToast(error?.message || fallback, "error");
}

function setBusy(value) {
  state.busy = value;
  requiredElement(els.saveTaskBtn, "saveTaskBtn").disabled = value;
  requiredElement(els.cancelEditBtn, "cancelEditBtn").disabled = value;
  requiredElement(els.deleteTaskBtn, "deleteTaskBtn").disabled = value;
  requiredElement(els.createTaskBtn, "createTaskBtn").disabled = value;
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

function normalizeDatetime(value) {
  return value ? value.slice(0, 16) : "";
}

function toApiDatetime(localInputValue) {
  return normalizeDatetime(localInputValue).replace("T", " ");
}

function toInputDatetime(apiValue) {
  return apiValue.replace(" ", "T");
}

function pickColor(seed) {
  const pairs = [
    ["#7f90ff", "#5c72dd"],
    ["#78d09c", "#48ab73"],
    ["#ffbc6c", "#de8f39"],
    ["#cd8bff", "#915fdb"],
    ["#7fd5ff", "#499dd9"],
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return pairs[Math.abs(hash) % pairs.length];
}

function renderUser() {
  const user = tg.initDataUnsafe?.user;
  const title = requiredElement(els.userTitle, "userTitle");
  const link = requiredElement(els.botLink, "botLink");
  const avatar = requiredElement(els.userAvatar, "userAvatar");
  const fallback = requiredElement(els.userAvatarFallback, "userAvatarFallback");

  const username = user?.username ? `@${user.username}` : "@username";
  title.textContent = username;
  link.href = user?.username ? `https://t.me/${user.username}` : "https://t.me/kolendarbot";

  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  const initials = (fullName || username)
    .replace("@", "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0].toUpperCase())
    .join("") || "TG";

  fallback.textContent = initials;

  if (user?.photo_url) {
    avatar.src = user.photo_url;
    avatar.hidden = false;
    fallback.hidden = true;
    avatar.onerror = () => {
      avatar.hidden = true;
      fallback.hidden = false;
    };
  } else {
    avatar.hidden = true;
    fallback.hidden = false;
  }
}

function pluralize(count) {
  if (count === 1) {
    return "задача";
  }
  if (count >= 2 && count <= 4) {
    return "задачи";
  }
  return "задач";
}

function renderCount() {
  const count = state.tasks.length;
  requiredElement(els.tasksCount, "tasksCount").textContent = `${count}`;
  requiredElement(els.createTaskBtn, "createTaskBtn").setAttribute(
    "aria-label",
    `Создать новую задачу. Сейчас ${count} ${pluralize(count)}`
  );
}

function applyFilter() {
  const query = requiredElement(els.searchInput, "searchInput").value.trim().toLowerCase();
  if (!query) {
    state.filtered = [...state.tasks];
    return;
  }

  state.filtered = state.tasks.filter((task) => {
    const hay = `${task.text} ${task.scheduled_local}`.toLowerCase();
    return hay.includes(query);
  });
}

function bindSwipeOpen(row, task) {
  let startX = 0;
  let deltaX = 0;

  row.addEventListener("touchstart", (event) => {
    if (!event.touches[0]) return;
    startX = event.touches[0].clientX;
    deltaX = 0;
  }, { passive: true });

  row.addEventListener("touchmove", (event) => {
    if (!event.touches[0]) return;
    deltaX = event.touches[0].clientX - startX;
    if (Math.abs(deltaX) > 6) {
      row.style.transform = `translateX(${Math.max(-42, Math.min(42, deltaX * 0.22))}px)`;
    }
  }, { passive: true });

  row.addEventListener("touchend", () => {
    row.style.transform = "translateX(0)";
    if (Math.abs(deltaX) > 72) {
      startEdit(task);
    }
  });
}

function renderList() {
  applyFilter();
  const list = requiredElement(els.tasksList, "tasksList");
  const empty = requiredElement(els.emptyState, "emptyState");
  const tpl = requiredElement(els.taskRowTemplate, "taskRowTemplate");

  list.innerHTML = "";

  if (!state.filtered.length) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  state.filtered.forEach((task) => {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const avatar = row.querySelector(".task-row-avatar");
    const title = row.querySelector(".task-row-title");
    const subtitle = row.querySelector(".task-row-subtitle");
    const mainBtn = row.querySelector(".task-row-main");
    const arrowBtn = row.querySelector(".task-row-arrow");

    title.textContent = task.text;
    subtitle.textContent = `${task.scheduled_local} • ${task.reminded ? "напомнено" : "ожидает"}`;

    const [c1, c2] = pickColor(task.text + task.id);
    avatar.textContent = (task.text.trim()[0] || "З").toUpperCase();
    avatar.style.background = `linear-gradient(140deg, ${c1}, ${c2})`;

    const open = () => startEdit(task);
    mainBtn.addEventListener("click", open);
    arrowBtn.addEventListener("click", open);

    bindSwipeOpen(row, task);
    list.appendChild(row);
  });
}

function openSheet() {
  const sheet = requiredElement(els.editorSheet, "editorSheet");
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("open"));
}

function closeSheet() {
  const sheet = requiredElement(els.editorSheet, "editorSheet");
  sheet.classList.remove("open");
  window.setTimeout(() => {
    sheet.hidden = true;
  }, 220);

  state.editingTaskId = null;
  requiredElement(els.editorTitle, "editorTitle").textContent = "Новая задача";
  requiredElement(els.taskText, "taskText").value = "";
  requiredElement(els.taskDatetime, "taskDatetime").value = "";
  requiredElement(els.timezoneInput, "timezoneInput").value = state.timezone;
  requiredElement(els.deleteTaskBtn, "deleteTaskBtn").hidden = true;
}

function startCreate() {
  state.editingTaskId = null;
  requiredElement(els.editorTitle, "editorTitle").textContent = "Новая задача";
  requiredElement(els.taskText, "taskText").value = "";
  requiredElement(els.taskDatetime, "taskDatetime").value = "";
  requiredElement(els.timezoneInput, "timezoneInput").value = state.timezone;
  requiredElement(els.deleteTaskBtn, "deleteTaskBtn").hidden = true;
  openSheet();
}

function startEdit(task) {
  state.editingTaskId = task.id;
  requiredElement(els.editorTitle, "editorTitle").textContent = "Редактирование задачи";
  requiredElement(els.taskText, "taskText").value = task.text;
  requiredElement(els.taskDatetime, "taskDatetime").value = toInputDatetime(task.scheduled_local);
  requiredElement(els.timezoneInput, "timezoneInput").value = state.timezone;
  requiredElement(els.deleteTaskBtn, "deleteTaskBtn").hidden = false;
  openSheet();
}

async function loadTimezone() {
  const data = await api("/api/user/timezone", { method: "GET" });
  state.timezone = data.timezone;
  requiredElement(els.timezoneInput, "timezoneInput").value = data.timezone;
}

async function maybeSaveTimezone() {
  const tzInput = requiredElement(els.timezoneInput, "timezoneInput");
  const timezone = tzInput.value.trim();
  if (!timezone || timezone === state.timezone) {
    return;
  }

  const data = await api("/api/user/timezone", {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  });

  state.timezone = data.timezone;
}

async function loadTasks() {
  const rows = await api("/api/tasks", { method: "GET" });
  state.tasks = [...rows].sort((a, b) => a.scheduled_utc.localeCompare(b.scheduled_utc));
  renderCount();
  renderList();
}

async function saveTask() {
  if (state.busy) return;

  const text = requiredElement(els.taskText, "taskText").value.trim();
  const datetime = normalizeDatetime(requiredElement(els.taskDatetime, "taskDatetime").value);

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
    await maybeSaveTimezone();

    const payload = {
      text,
      scheduled_local: toApiDatetime(datetime),
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
    closeSheet();
  } catch (error) {
    handleError(error, "Не удалось сохранить задачу");
  } finally {
    setBusy(false);
  }
}

async function deleteTask() {
  if (!state.editingTaskId || state.busy) return;

  try {
    setBusy(true);
    await api(`/api/tasks/${state.editingTaskId}`, { method: "DELETE" });
    await loadTasks();
    closeSheet();
    showToast("Задача удалена", "success");
  } catch (error) {
    handleError(error, "Не удалось удалить задачу");
  } finally {
    setBusy(false);
  }
}

async function init() {
  try {
    requiredElement(els.createTaskBtn, "createTaskBtn");
    requiredElement(els.searchInput, "searchInput");
    requiredElement(els.saveTaskBtn, "saveTaskBtn");
  } catch (error) {
    console.error(error);
    return;
  }

  tg.ready();
  tg.expand();
  tg.MainButton.hide();

  renderUser();

  if (!state.initData) {
    showToast("Откройте приложение внутри Telegram", "error");
    return;
  }

  els.searchInput.addEventListener("input", renderList);
  els.createTaskBtn.addEventListener("click", startCreate);
  els.saveTaskBtn.addEventListener("click", saveTask);
  els.cancelEditBtn.addEventListener("click", closeSheet);
  els.deleteTaskBtn.addEventListener("click", deleteTask);
  els.sheetBackdrop.addEventListener("click", closeSheet);

  try {
    setBusy(true);
    await Promise.all([loadTimezone(), loadTasks()]);
  } catch (error) {
    handleError(error, "Ошибка загрузки данных");
  } finally {
    setBusy(false);
  }
}

init();
